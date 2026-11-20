/* Copyright (c) Otrion contributors. Licensed under the MIT License. */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import * as path from 'node:path';
import type { Readable } from 'node:stream';
import type * as vscode from 'vscode';

export type HostLog = Pick<vscode.OutputChannel, 'append'>;

export interface DockerHost {
	node(args: string[]): Promise<vscode.SpawnedCommand>;
	cli(args: string[]): Promise<vscode.SpawnedCommand>;
	docker(args: string[]): Promise<vscode.SpawnedCommand>;
}

function output(stream: Readable): vscode.ReadStream {
	return {
		onDidReceiveMessage(listener) {
			stream.on('data', listener);
			return { dispose: () => stream.off('data', listener) };
		},
		onEnd: new Promise<void>(resolve => stream.once('end', resolve))
	};
}

/** GUI and non-interactive SSH sessions can omit Homebrew and Docker Desktop from PATH. */
function macDockerPath(env: NodeJS.ProcessEnv): string {
	const directories = (env.PATH ?? '/usr/bin:/bin:/usr/sbin:/sbin').split(':');
	directories.push('/opt/homebrew/bin', '/usr/local/bin');
	if (env.HOME) { directories.push(path.posix.join(env.HOME, '.docker', 'bin')); }
	directories.push('/Applications/Docker.app/Contents/Resources/bin');
	return [...new Set(directories)].join(':');
}

async function localProcess(command: string, args: string[], node = false): Promise<vscode.SpawnedCommand> {
	const env = { ...process.env };
	if (process.platform === 'darwin') { env.PATH = macDockerPath(env); }
	if (node) {
		env.ELECTRON_RUN_AS_NODE = '1';
		delete env.NODE_OPTIONS;
		delete env.VSCODE_INSPECTOR_OPTIONS;
	}
	const p = spawn(command, args, { stdio: 'pipe', windowsHide: true, env });
	p.stdin.on('error', () => { /* The exit result carries the failure. */ });
	const onExit = new Promise<vscode.ProcessExit>(resolve => {
		p.once('error', error => resolve({ status: 1, message: error.message }));
		p.once('close', code => resolve({ status: code ?? 1 }));
	});
	return { stdin: { write: bytes => { p.stdin.write(bytes); }, end: () => p.stdin.end() },
		stdout: output(p.stdout), stderr: output(p.stderr), onExit };
}

export async function dockerHost(root: string, remote?: vscode.ExecServer): Promise<DockerHost> {
	const entry = ['@devcontainers', 'cli', 'devcontainer.js'];
	if (remote) {
		const { env, osPlatform } = await remote.env();
		const root = env.OTRION_SERVER_ROOT;
		if (!root) { throw new Error('Update the SSH host to the matching Otrion server.'); }
		const windows = osPlatform === 'win32';
		const paths = windows ? path.win32 : path.posix;
		const node = paths.join(root, windows ? 'node.exe' : 'node');
		const options = osPlatform === 'darwin' ? { env: { PATH: macDockerPath(env) } } : undefined;
		return {
			node: async args => remote.spawn(node, args, options),
			cli: async args => {
				const index = args.indexOf('--workspace-folder') + 1;
				const argv = [...args];
				if (windows && index) {
					argv[index] = path.win32.normalize(argv[index].replace(/^\/(?=[a-z]:\/)/i, ''));
				}
				return remote.spawn(node, [paths.join(root, 'node_modules', ...entry), ...argv], options);
			},
			docker: async args => remote.spawn('docker', args, options)
		};
	}
	const cli = ['node_modules.asar.unpacked', 'node_modules'].map(dir => path.join(root, dir, ...entry)).find(existsSync);
	if (!cli) { throw new Error('The Dev Container CLI is missing from this Otrion installation.'); }
	return { node: args => localProcess(process.execPath, args, true), cli: args => localProcess(process.execPath, [cli, ...args], true), docker: args => localProcess('docker', args) };
}

export async function result(proc: vscode.SpawnedCommand, log: HostLog): Promise<string> {
	const stdout: Buffer[] = [];
	let error = '';
	const out = proc.stdout.onDidReceiveMessage(bytes => stdout.push(Buffer.from(bytes)));
	const err = proc.stderr.onDidReceiveMessage(bytes => {
		const text = Buffer.from(bytes).toString();
		error = (error + text).slice(-2000);
		log.append(text);
	});
	try {
		proc.stdin.end();
		const [exit] = await Promise.all([proc.onExit, proc.stdout.onEnd, proc.stderr.onEnd]);
		if (exit.status !== 0) { throw new Error(exit.message || error.trim() || 'Container command failed. See Otrion Dev Containers output.'); }
		return Buffer.concat(stdout).toString().trim();
	} finally { out.dispose(); err.dispose(); }
}
