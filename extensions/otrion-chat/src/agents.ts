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
	constructor(private readonly root: string, private readonly secrets: vscode.SecretStorage) {}

	private authKey(id: AgentId) { return 'agent-auth.' + id; }

	onAuthChange(listener: (id: AgentId) => void) {
		return this.secrets.onDidChange(({ key }) => {
			for (const id of ['codex', 'claude'] as const) {
				if (key === this.authKey(id)) { listener(id); }
			}
		});
	}

	private async credentials(id: AgentId): Promise<{ mode: 'cli' | 'key'; key?: string }> {
		const saved = await this.secrets.get(this.authKey(id));
		return saved ? JSON.parse(saved) : { mode: 'cli' };
	}

	async authChoice(id: AgentId) {
		const { mode, key } = await this.credentials(id);
		return { mode, hasKey: !!key };
	}

	async changeAuth(id: AgentId, action: 'cli' | 'key' | 'replaceKey' | 'removeKey') {
		const auth = await this.credentials(id);
		if (action === 'cli') {
			auth.mode = 'cli';
		} else if (action === 'removeKey') {
			delete auth.key;
		} else {
			if (!auth.key || action === 'replaceKey') {
				const provider = id === 'codex' ? 'OpenAI' : 'Anthropic';
				const key = await vscode.window.showInputBox({
					title: provider + ' API key', password: true, ignoreFocusOut: true,
					prompt: 'Store your key in Otrion’s protected credential storage.',
					validateInput: value => /^\S+$/.test(value.trim()) ? undefined : 'Enter an API key without spaces.'
				});
				if (!key?.trim()) { return; }
				auth.key = key.trim();
			}
			auth.mode = 'key';
		}
		await this.secrets.store(this.authKey(id), JSON.stringify(auth));
	}

	async agentEnvironment(id: AgentId): Promise<NodeJS.ProcessEnv> {
		const { mode, key } = await this.credentials(id);
		const env = { ...process.env };
		if (mode === 'cli') { return env; }
		if (!key) { throw new Error('Add an API key or choose CLI account in Otrion Settings.'); }
		if (id === 'claude') {
			for (const name of ['ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_CUSTOM_HEADERS', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY']) { delete env[name]; }
			env.ANTHROPIC_BASE_URL = 'https://api.anthropic.com';
			env.ANTHROPIC_API_KEY = key;
		} else {
			// Use the adapter's session provider override to preserve the CLI's saved account.
			const provider = 'otrion_openai';
			let config;
			try { config = env.CODEX_CONFIG ? JSON.parse(env.CODEX_CONFIG) : {}; }
			catch { throw new Error('CODEX_CONFIG must contain a valid JSON object.'); }
			if (!config || typeof config !== 'object' || Array.isArray(config)) { throw new Error('CODEX_CONFIG must contain a JSON object.'); }
			delete env.DEFAULT_AUTH_REQUEST;
			env.MODEL_PROVIDER = provider;
			env.OTRION_OPENAI_API_KEY = key;
			env.CODEX_CONFIG = JSON.stringify({ ...config, model_provider: provider, model_providers: {
				...config.model_providers, [provider]: { name: 'OpenAI', base_url: 'https://api.openai.com/v1', wire_api: 'responses', env_key: 'OTRION_OPENAI_API_KEY' }
			} });
		}
		return env;
	}

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

	private async authCommand(id: AgentId, launch: NonNullable<Awaited<ReturnType<AgentStore['launch']>>>) {
		if (id === 'claude') { return { command: launch.command, args: [...launch.args, '--cli', 'auth'] }; }
		if (launch.args.length) {
			const cli = createRequire(launch.args[0]).resolve('@openai/codex/bin/codex.js');
			return { command: launch.command, args: [cli, 'login'] };
		}
		const command = await executable('codex');
		if (!command) { throw new Error('Install the Codex CLI or the Otrion-managed adapter.'); }
		return { command, args: ['login'] };
	}

	async authStatus(id: AgentId, launch: NonNullable<Awaited<ReturnType<AgentStore['launch']>>>) {
		let output: string;
		try {
			const cli = await this.authCommand(id, launch);
			const args = [...cli.args, 'status'];
			if (id === 'claude') { args.push('--json'); }
			const result = await promisify(execFile)(cli.command, args, { cwd: homedir(), timeout: 5000, maxBuffer: 65536, windowsHide: true });
			output = id === 'claude' ? result.stdout : result.stdout + result.stderr;
		} catch (error) {
			if (error.code !== 1) { return 'Unknown'; }
			output = id === 'claude' ? error.stdout ?? '' : (error.stdout ?? '') + (error.stderr ?? '');
		}
		if (id === 'codex') {
			if (/not logged in/i.test(output)) { return 'Signed out'; }
			return /logged in/i.test(output) ? 'Signed in' : 'Unknown';
		}
		try {
			const { loggedIn } = JSON.parse(output);
			return loggedIn === true ? 'Signed in' : loggedIn === false ? 'Signed out' : 'Unknown';
		} catch { return 'Unknown'; }
	}

	async signIn(id: AgentId) {
		const launch = await this.launch(id);
		if (!launch || !allowed(id)) { throw new Error('Install and allow this agent first.'); }
		const cli = await this.authCommand(id, launch);
		const args = id === 'claude' ? [...cli.args, 'login'] : cli.args;
		vscode.window.createTerminal({ name: agents[id].name + ' Sign In', shellPath: cli.command, shellArgs: args, cwd: homedir() }).show();
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
