/* Copyright (c) Otrion contributors. Licensed under the MIT License. */

import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { access, mkdir, mkdtemp, rename, rm, stat } from 'node:fs/promises';
import * as path from 'node:path';
import { homedir } from 'node:os';
import { createRequire } from 'node:module';
import { promisify } from 'node:util';
import * as vscode from 'vscode';

export function agentLocation() {
	if (vscode.env.remoteName === 'dev-container') { return 'in this container'; }
	return vscode.env.remoteAuthority ? 'on the SSH host' : 'on this computer';
}

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
	const candidates = path.isAbsolute(name) ? [name] : pathDirectories()
		.map(dir => path.join(dir, process.platform === 'win32' && !path.extname(name) ? name + '.exe' : name));
	for (const file of candidates) {
		if (await fileExists(file, constants.X_OK)) { return file; }
	}
	return undefined;
}

function pathDirectories() {
	return (process.env.PATH ?? '').split(path.delimiter)
		.map(dir => process.platform === 'win32' ? dir.replace(/^"(.*)"$/, '$1') : dir)
		.filter(dir => path.isAbsolute(dir));
}

interface Command {
	command: string;
	args: string[];
}

// The SSH extension host is forked by the copy of Node shipped in the Otrion server.
function remoteRuntimePath(): NodeJS.ProcessEnv {
	const key = process.platform === 'win32' ? Object.keys(process.env).find(name => name.toUpperCase() === 'PATH') ?? 'Path' : 'PATH';
	return { [key]: [path.dirname(process.execPath), process.env[key]].filter(Boolean).join(path.delimiter) };
}

async function resolveCommand(name: string, npmPackage: string, entryPoint: string): Promise<Command | undefined> {
	const extension = path.extname(name).toLowerCase();
	if (process.platform !== 'win32' || !extension || extension === '.exe') {
		const command = await executable(name);
		if (command) { return { command, args: [] }; }
	}
	if (process.platform !== 'win32') { return undefined; }

	const node = await executable('node');
	if (!node) { return undefined; }
	if (path.isAbsolute(name) && ['.js', '.cjs', '.mjs'].includes(extension) && await fileExists(name)) {
		return { command: node, args: [name] };
	}
	if (!extension || extension === '.cmd') {
		// npm's Windows launchers are shell scripts. Run the installed package entry directly.
		const shim = await executable(extension ? name : name + '.cmd');
		if (shim) {
			const entry = path.join(path.dirname(shim), 'node_modules', npmPackage, entryPoint);
			if (await fileExists(entry)) { return { command: node, args: [entry] }; }
		}
	}
	return undefined;
}

async function localNpmCommand(node: string): Promise<Command | undefined> {
	if (process.platform !== 'win32') {
		const command = await executable('npm');
		return command ? { command, args: [] } : undefined;
	}
	// The npm installation can be on a different PATH entry from node.exe.
	for (const dir of new Set([path.dirname(node), ...pathDirectories()])) {
		const cli = path.join(dir, 'node_modules', 'npm', 'bin', 'npm-cli.js');
		if (await fileExists(cli)) { return { command: node, args: [cli] }; }
	}
	return undefined;
}

export class AgentStore {
	constructor(private readonly root: string, private readonly secrets: vscode.SecretStorage) {}

	private authKey(id: AgentId) {
		// SecretStorage belongs to the client even when the adapter runs on a remote host.
		const authority = vscode.env.remoteAuthority;
		return authority ? 'agent-auth.remote.' + authority + '.' + id : 'agent-auth.' + id;
	}

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

	async agentEnvironment(id: AgentId, launch: { env?: NodeJS.ProcessEnv }): Promise<NodeJS.ProcessEnv> {
		const { mode, key } = await this.credentials(id);
		const env = { ...process.env, ...launch.env };
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
		if (setting === agent.binary && await this.isInstalled(id)) {
			const remote = !!vscode.env.remoteAuthority;
			const node = remote ? process.execPath : await executable('node');
			if (node) {
				return { command: node, args: [this.entry(this.directory(id), id)], source: 'Installed by Otrion', env: remote ? remoteRuntimePath() : undefined };
			}
		}
		const external = await resolveCommand(setting, '@agentclientprotocol/' + agent.binary, 'dist/index.js');
		return external ? { ...external, source: 'External installation' } : undefined;
	}

	private async authCommand(id: AgentId, launch: NonNullable<Awaited<ReturnType<AgentStore['launch']>>>) {
		if (id === 'claude') { return { command: launch.command, args: [...launch.args, '--cli', 'auth'] }; }
		if (launch.args.length) {
			try {
				const cli = createRequire(launch.args[0]).resolve('@openai/codex/bin/codex.js');
				return { command: launch.command, args: [cli, 'login'] };
			} catch (error) {
				if (error.code !== 'MODULE_NOT_FOUND') { throw error; }
			}
		}
		const cli = await resolveCommand('codex', '@openai/codex', 'bin/codex.js');
		if (!cli) { throw new Error('Install the Codex CLI or the Otrion-managed adapter.'); }
		return { command: cli.command, args: [...cli.args, 'login'] };
	}

	async authStatus(id: AgentId, launch: NonNullable<Awaited<ReturnType<AgentStore['launch']>>>) {
		let output: string;
		try {
			const cli = await this.authCommand(id, launch);
			const args = [...cli.args, 'status'];
			if (id === 'claude') { args.push('--json'); }
			const result = await promisify(execFile)(cli.command, args, { cwd: homedir(), env: { ...process.env, ...launch.env }, timeout: 5000, maxBuffer: 65536, windowsHide: true });
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
		const args = [...cli.args];
		if (id === 'claude') { args.push('login'); }
		else if (vscode.env.remoteName) { args.push('--device-auth'); }
		vscode.window.createTerminal({ name: agents[id].name + ' Sign In', shellPath: cli.command, shellArgs: args, env: launch.env, cwd: vscode.Uri.file(homedir()) }).show();
	}

	async install(id: AgentId) {
		const target = this.directory(id);
		if (await fileExists(this.entry(target, id))) { return; }
		await mkdir(this.root, { recursive: true });
		const staging = await mkdtemp(path.join(this.root, id + '-install-'));
		try {
			const remote = !!vscode.env.remoteAuthority;
			let npm: Command | undefined;
			if (remote) {
				const cli = path.join(vscode.env.appRoot, 'agent-tools', 'npm', 'bin', 'npm-cli.js');
				if (!await fileExists(cli)) {
					throw new Error('The agent installer is missing from the Otrion server. Update Otrion and reconnect to this host.');
				}
				npm = { command: process.execPath, args: [cli] };
			} else {
				const node = await executable('node');
				npm = node ? await localNpmCommand(node) : undefined;
				if (!npm) { throw new Error('Install Node.js and npm, then restart Otrion.'); }
			}
			const args = [...npm.args, 'install', '--prefix', staging, '--global=false', '--no-save', '--no-package-lock', '--no-audit', '--no-fund'];
			if (remote) { args.push('--cache', path.join(this.root, 'npm-cache')); }
			args.push('@agentclientprotocol/' + agents[id].binary + '@' + agents[id].version);
			await promisify(execFile)(npm.command, args, { cwd: staging, env: remote ? { ...process.env, ...remoteRuntimePath() } : process.env,
				timeout: 300_000, windowsHide: true });
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
