/* Copyright (c) Otrion contributors. Licensed under the MIT License. */

import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { access, mkdir, mkdtemp, rename, rm, stat } from 'node:fs/promises';
import * as path from 'node:path';
import { homedir } from 'node:os';
import { createRequire } from 'node:module';
import { promisify } from 'node:util';
import * as vscode from 'vscode';

export const agents = {
	codex: { name: 'Codex', binary: 'codex-acp', version: '2.7.0' },
	claude: { name: 'Claude Code', binary: 'claude-agent-acp', version: '0.108.0' },
} as const;
export type AgentId = keyof typeof agents;
export function isAgent(id: unknown): id is AgentId {
	return id === 'codex' || id === 'claude';
}
export function allowed(id: AgentId): boolean {
	return vscode.workspace.getConfiguration('otrion.chat').get(id + 'Allowed', false);
}

async function fileExists(file: string, mode = constants.F_OK) {
	try {
		await access(file, mode);
		return (await stat(file)).isFile();
	} catch { return false; }
}

async function executable(name: string) {
	const candidates = path.isAbsolute(name) ? [name] : (process.env.PATH ?? '').split(path.delimiter)
		.filter(dir => path.isAbsolute(dir))
		.map(dir => path.join(dir, process.platform === 'win32' && !path.extname(name) ? name + '.exe' : name));
	for (const file of candidates) {
		if (await fileExists(file, constants.X_OK)) { return file; }
	}
	return undefined;
}

export class AgentStore {
	constructor(private readonly root: string) {}

	private directory(id: AgentId) {
		return path.join(this.root, id + '-' + agents[id].version);
	}

	private entry(dir: string, id: AgentId) {
		return path.join(dir, 'node_modules', '@agentclientprotocol', agents[id].binary, 'dist', 'index.js');
	}

	isInstalled(id: AgentId) {
		return fileExists(this.entry(this.directory(id), id));
	}

	async launch(id: AgentId) {
		const agent = agents[id];
		const setting = vscode.workspace.getConfiguration('otrion.chat').get<string>(id + 'AcpPath', agent.binary);
		if (setting !== agent.binary) {
			const custom = await executable(setting);
			return custom ? { command: custom, args: [] as string[], source: 'External installation' } : undefined;
		}
		if (await this.isInstalled(id)) {
			const node = await executable('node');
			if (node) { return { command: node, args: [this.entry(this.directory(id), id)], source: 'Installed by Otrion' }; }
		}
		const command = await executable(agent.binary);
		return command ? { command, args: [] as string[], source: 'External installation' } : undefined;
	}

	async signIn(id: AgentId) {
		const launch = await this.launch(id);
		if (!launch || !allowed(id)) { throw new Error('Install and allow this agent first.'); }
		let command = launch.command;
		let args = [...launch.args, '--cli', 'auth', 'login'];
		if (id === 'codex') {
			if (launch.args.length) {
				const cli = createRequire(launch.args[0]).resolve('@openai/codex/bin/codex.js');
				args = [cli, 'login'];
			} else {
				const codex = await executable('codex');
				if (!codex) { throw new Error('Run codex login in your terminal, or install the Otrion-managed adapter.'); }
				command = codex;
				args = ['login'];
			}
		}
		vscode.window.createTerminal({ name: agents[id].name + ' Sign In', shellPath: command, shellArgs: args, cwd: homedir() }).show();
	}

	async install(id: AgentId) {
		const target = this.directory(id);
		if (await fileExists(this.entry(target, id))) { return; }
		await mkdir(this.root, { recursive: true });
		const staging = await mkdtemp(path.join(this.root, id + '-install-'));
		try {
			const args = ['install', '--prefix', staging, '--no-save', '--no-package-lock', '--no-audit', '--no-fund',
				'@agentclientprotocol/' + agents[id].binary + '@' + agents[id].version];
			const node = await executable('node');
			if (!node) { throw new Error('Install Node.js and npm, then restart Otrion.'); }
			// Windows npm.cmd is a shell shim. Run the npm CLI directly with Node.
			const npm = process.platform === 'win32' ? path.join(path.dirname(node), 'node_modules', 'npm', 'bin', 'npm-cli.js') : await executable('npm');
			if (!npm || !await fileExists(npm)) { throw new Error('Install npm alongside Node.js, then restart Otrion.'); }
			await promisify(execFile)(process.platform === 'win32' ? node : npm, process.platform === 'win32' ? [npm, ...args] : args, { cwd: staging, timeout: 300_000, windowsHide: true });
			if (!await fileExists(this.entry(staging, id))) { throw new Error('The downloaded adapter is missing its entry point.'); }
			try {
				await rename(staging, target);
			} catch (error) {
				// Another window can finish the same install first.
				if (!await fileExists(this.entry(target, id))) { throw error; }
			}
		} finally {
			await rm(staging, { recursive: true, force: true });
		}
	}
}
