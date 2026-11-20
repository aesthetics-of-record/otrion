/* Copyright (c) Otrion contributors. Licensed under the MIT License. */

import * as path from 'node:path';
import { type DockerHost, type HostLog, result } from './host';

export interface ContainerProduct {
	commit?: string;
	otrionVersion: string;
	serverApplicationName: string;
	serverDownloadUrlTemplate: string;
}

export interface ContainerTarget {
	id: string;
	label: string;
	description: string;
	state: string;
	status: string;
}

export async function listContainers(host: DockerHost, log: HostLog, includeStopped: boolean): Promise<ContainerTarget[]> {
	const output = await result(await host.docker(['ps', ...(includeStopped ? ['--all'] : []), '--no-trunc', '--format', '{{json .}}']), log);
	if (!output) { return []; }
	return output.split(/\r?\n/).map(line => {
		const { ID, Names, Image, State, Status } = JSON.parse(line);
		if (typeof ID !== 'string' || !/^[0-9a-f]{12,64}$/.test(ID) || typeof Names !== 'string' || typeof Image !== 'string' || typeof State !== 'string' || typeof Status !== 'string') {
			throw new Error('Docker returned an invalid container listing.');
		}
		return { id: ID, label: Names, description: Image, state: State, status: Status };
	}).sort((a, b) => Number(b.state === 'running') - Number(a.state === 'running') || a.label.localeCompare(b.label));
}

export function canStart(target: ContainerTarget): boolean {
	return target.state === 'exited' || target.state === 'created';
}

export async function prepare(host: DockerHost, folder: string, rebuild: boolean, log: HostLog) {
	const args = ['up', '--workspace-folder', folder];
	if (rebuild) { args.push('--remove-existing-container'); }
	const data = JSON.parse(await result(await host.cli(args), log));
	if (data.outcome !== 'success' || !/^[0-9a-f]{12,64}$/.test(data.containerId) || typeof data.remoteWorkspaceFolder !== 'string' || !path.posix.isAbsolute(data.remoteWorkspaceFolder)) {
		throw new Error(data.description || 'The Dev Container CLI did not return a valid workspace.');
	}
	return { id: String(data.containerId), user: data.remoteUser as string | undefined, folder: String(data.remoteWorkspaceFolder) };
}

const relay = `
const socket = require('node:net').connect(Number(process.argv[1]), '127.0.0.1');
process.stdin.pipe(socket).pipe(process.stdout);
socket.on('close', () => process.stdin.destroy());
socket.on('error', error => { console.error(error.message); process.exitCode = 1; });
`;

export async function boot(host: DockerHost, session: { id: string; user?: string; workspace?: string; windowKey?: string }, script: string, product: ContainerProduct, log: HostLog) {
	const url = product.serverDownloadUrlTemplate.replace('${otrionVersion}', product.otrionVersion).replace('${os}', 'linux').replace('${arch}', '{arch}');
	const dockerExec = ['exec', '-i', ...(session.user ? ['--user', session.user] : []), session.id];
	const state = await result(await host.docker(['inspect', '--format', '{{.State.Running}}', session.id]), log);
	if (state === 'false') { await result(await host.docker(['start', session.id]), log); }
	const run = (archive: string) => {
		const command = ['sh', '-c', script, 'otrion-server', product.commit ?? '', product.otrionVersion, product.serverApplicationName, archive, session.windowKey ?? ''];
		return session.workspace ? host.cli(['exec', '--workspace-folder', session.workspace, '--container-id', session.id, ...command])
			: host.docker([...dockerExec, ...command]);
	};
	const probe = await result(await run('probe'), log);
	let archive = '';
	try {
		if (probe !== 'ready') {
			const [arch, file] = probe.split(/\r?\n/);
			if (!['x64', 'arm64'].includes(arch) || !file || !path.posix.isAbsolute(file)) { throw new Error('Invalid container platform probe.'); }
			archive = file;
			// Download on the Docker host. Minimal images need no downloader, and a
			// remote build never transfers the server archive through the desktop.
			log.append('Downloading the Otrion server for linux-' + arch + '…\n');
			await result(await host.node(['--input-type=module', '-e', download, '--', url.replace('{arch}', arch), ...dockerExec,
				'sh', '-c', 'cat > "$1"', 'otrion-download', archive]), log);
		}
		const server = JSON.parse(await result(await run(archive), log)) as { node: string; port: number; token: string };
		return connector(host, dockerExec, server, log);
	} finally {
		if (archive) {
			try { await result(await host.docker([...dockerExec, 'rm', '-f', '--', archive]), log); }
			catch (error) { log.append('Could not remove the temporary server archive: ' + String(error) + '\n'); }
		}
	}
}

const download = `
import { spawn } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import { once } from 'node:events';
const [url, ...args] = process.argv.slice(1);
const response = await fetch(url, { signal: AbortSignal.timeout(300000) });
if (!response.ok || !response.body) throw Error('Server download failed: HTTP ' + response.status);
const child = spawn('docker', args, { stdio: ['pipe', 'ignore', 'inherit'], windowsHide: true });
try {
	const [[code]] = await Promise.all([once(child, 'close'), pipeline(response.body, child.stdin)]);
	if (code !== 0) throw Error('Copying the server archive into the container failed.');
} catch (error) {
	child.kill();
	throw error;
}
`;

function connector(host: DockerHost, dockerExec: string[], server: { node: string; port: number; token: string }, log: HostLog) {
	if (!path.posix.isAbsolute(server.node) || !Number.isInteger(server.port) || server.port < 1 || server.port > 65535 || !server.token) {
		throw new Error('The Otrion server returned an invalid address.');
	}

	return { token: server.token, connect: async () => {
		const proc = await host.docker([...dockerExec, server.node, '-e', relay, String(server.port)]);

		const stderr = proc.stderr.onDidReceiveMessage(bytes => log.append(Buffer.from(bytes).toString()));
		void Promise.resolve(proc.onExit).finally(() => stderr.dispose());
		return proc;
	} };
}

