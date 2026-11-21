/* Copyright (c) Otrion contributors. Licensed under the MIT License. */

import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { access, open, mkdir, mkdtemp, rename, rm, stat } from 'node:fs/promises';
import * as path from 'node:path';
import { homedir } from 'node:os';
import { createRequire } from 'node:module';
import { promisify } from 'node:util';
import * as vscode from 'vscode';

import { antigravityVersion, configureAntigravityKeyProfile, installAntigravity } from './antigravity';
import { agents, agentIds, type AgentId } from './agentCatalog';
export { agents, isAgent, type AgentId } from './agentCatalog';

export function agentLocation() {
	if (vscode.env.remoteName === 'dev-container') { return 'in this container'; }
	return vscode.env.remoteAuthority ? 'on the SSH host' : 'on this computer';
}

function originalAgent(id: AgentId) { return id === 'codex' || id === 'claude'; }

export function supportsKey(id: AgentId) { return originalAgent(id) || !!agents[id].keyEnv; }

export function installIssue(id: AgentId) {
	const platforms = agents[id].platforms;
	const host = process.platform + '-' + process.arch;
	return platforms && !platforms.includes(host) ? 'The provider does not publish a binary for ' + host + '.' : undefined;
}

export function allowed(id: AgentId): boolean {
	const config = vscode.workspace.getConfiguration('otrion.chat');
	return originalAgent(id) ? config.get(id + 'Allowed', false) : config.get<string[]>('enabledAgents', []).includes(id);
}

export function configuredPath(id: AgentId) {
	const config = vscode.workspace.getConfiguration('otrion.chat');
	return originalAgent(id) ? config.get<string>(id + 'AcpPath') : config.get<Record<string, string>>('agentPaths', {})[id];
}

export async function setAllowed(id: AgentId, enabled: boolean) {
	const config = vscode.workspace.getConfiguration('otrion.chat');
	if (originalAgent(id)) { return config.update(id + 'Allowed', enabled, vscode.ConfigurationTarget.Global); }
	const ids = new Set(config.get<string[]>('enabledAgents', []));
	if (enabled) { ids.add(id); } else { ids.delete(id); }
	await config.update('enabledAgents', [...ids], vscode.ConfigurationTarget.Global);
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

async function resolveCommand(name: string, npmPackage?: string, entryPoint?: string): Promise<Command | undefined> {
	const extension = path.extname(name).toLowerCase();
	if (path.isAbsolute(name) && ['.js', '.cjs', '.mjs'].includes(extension) && await fileExists(name)) {
		return packageCommand(name, !!vscode.env.remoteAuthority);
	}
	if (process.platform !== 'win32' || !extension || extension === '.exe') {
		const command = await executable(name);
		if (command) { return { command, args: [] }; }
	}
	if (process.platform !== 'win32') { return undefined; }

	if (npmPackage && entryPoint && (!extension || extension === '.cmd')) {
		// npm's Windows launchers are shell scripts. Run the installed package entry directly.
		const shim = await executable(extension ? name : name + '.cmd');
		if (shim) {
			const entry = path.join(path.dirname(shim), 'node_modules', npmPackage, entryPoint);
			if (await fileExists(entry)) { return packageCommand(entry, !!vscode.env.remoteAuthority); }
		}
	}
	return undefined;
}

// npm bins can be JS entry points, platform executables, or POSIX launch scripts.
async function packageCommand(entry: string, remote: boolean): Promise<Command | undefined> {
	let js = /\.[cm]?js$/i.test(entry);
	if (!js) {
		const file = await open(entry, 'r');
		try {
			const header = Buffer.alloc(256);
			await file.read(header);
			js = /^#![^\n]*\bnode\b/.test(header.toString());
		} finally { await file.close(); }
	}
	if (!js) { return { command: entry, args: [] }; }
	const node = remote ? process.execPath : await executable('node');
	return node ? { command: node, args: [entry] } : undefined;
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
			for (const id of agentIds) {
				if (key === this.authKey(id)) { listener(id); }
			}
		});
	}

	private async credentials(id: AgentId): Promise<{ mode: 'cli' | 'key'; key?: string }> {
		if (!supportsKey(id)) { return { mode: 'cli' }; }
		const saved = await this.secrets.get(this.authKey(id));
		return saved ? JSON.parse(saved) : { mode: 'cli' };
	}

	async authChoice(id: AgentId) {
		const { mode, key } = await this.credentials(id);
		return { mode, hasKey: !!key };
	}

	async changeAuth(id: AgentId, action: 'cli' | 'key' | 'replaceKey' | 'removeKey') {
		if (!supportsKey(id)) { return; }
		const auth = await this.credentials(id);
		if (action === 'cli') {
			auth.mode = 'cli';
		} else if (action === 'removeKey') {
			delete auth.key;
		} else {
			if (!auth.key || action === 'replaceKey') {
				const provider = id === 'codex' ? 'OpenAI' : id === 'claude' ? 'Anthropic' : agents[id].name;
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

	async sessionCommand(id: AgentId, launch: Command & { env?: NodeJS.ProcessEnv }) {
		const { mode, key } = await this.credentials(id);
		const env = { ...process.env, ...launch.env };
		const args = [...launch.args];
		const command = { command: launch.command, args, env };
		if (mode === 'cli') { return command; }
		if (!key) { throw new Error('Add an API key or choose CLI account in Otrion Settings.'); }
		const keyEnv = agents[id].keyEnv;
		if (keyEnv) {
			env[keyEnv] = key;
			if (id === 'antigravity') {
				args.push('--app-data-dir', await configureAntigravityKeyProfile(this.root));
				delete env.GOOGLE_GEMINI_BASE_URL;
				delete env.AGY_ADC_AUTH;
			} else if (id === 'grok') {
				env.GROK_HOME = path.join(this.root, 'grok-api-key');
			} else if (id === 'cline') {
				env.CLINE_PROVIDER = 'cline';
			}
			return command;
		}
		if (id === 'claude') {
			for (const name of ['ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_CUSTOM_HEADERS', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY']) { delete env[name]; }
			env.ANTHROPIC_BASE_URL = 'https://api.anthropic.com';
			env.ANTHROPIC_API_KEY = key;
		} else if (id === 'codex') {
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
		return command;
	}

	private installation(id: AgentId) {
		const npm = agents[id].npm;
		const version = id === 'antigravity' ? antigravityVersion : npm!.version;
		const directory = path.join(this.root, id + '-' + version);
		const binary = agents[id].binary + (process.platform === 'win32' ? '.exe' : '');
		const entry = id === 'grok' || !npm ? binary : path.join('node_modules', npm.package, npm.entry);
		return { directory, entry };
	}

	async isInstalled(id: AgentId) {
		const install = this.installation(id);
		return fileExists(path.join(install.directory, install.entry));
	}

	async launch(id: AgentId) {
		const agent = agents[id];
		const setting = configuredPath(id) || agent.binary;
		const install = setting === agent.binary && await this.isInstalled(id) ? this.installation(id) : undefined;
		const remote = !!vscode.env.remoteAuthority;
		const env: NodeJS.ProcessEnv = { ...(remote ? remoteRuntimePath() : {}), ...agent.env };
		let base: Command | undefined;
		if (install) {
			base = await packageCommand(path.join(install.directory, install.entry), remote);
		} else {
			base = await resolveCommand(setting, agent.npm?.package, agent.npm?.entry);
			if (!base && id === 'antigravity' && setting === agent.binary) {
				const installedPath = process.platform === 'win32'
					? path.join(process.env.LOCALAPPDATA || path.join(homedir(), 'AppData', 'Local'), 'agy', 'bin', 'agy.exe')
					: path.join(homedir(), '.local', 'bin', 'agy');
				base = await resolveCommand(installedPath);
			}
		}
		if (!base) { return undefined; }
		return { ...base, baseArgs: base.args, args: [...base.args, ...(agent.args ?? [])], env,
			directory: install?.directory, source: install ? 'Installed by Otrion' : 'External installation' };
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
		if (!vscode.workspace.isTrusted) { return 'Unknown'; }
		if (!originalAgent(id)) { return undefined; }
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
		if (!originalAgent(id)) {
			const { signInWithAgent } = await import('./agentAuth');
			return signInWithAgent(id, launch);
		}
		const cli = await this.authCommand(id, launch);
		const args = [...cli.args];
		if (id === 'claude') { args.push('login'); }
		else if (vscode.env.remoteName) { args.push('--device-auth'); }
		const terminal = vscode.window.createTerminal({ name: agents[id].name + ' Sign In', shellPath: cli.command, shellArgs: args, env: launch.env, cwd: vscode.Uri.file(homedir()) });
		terminal.show();
		return terminal;
	}

	private async installNpm(id: AgentId, staging: string) {
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
		const args = [...npm.args, 'install', '--prefix', staging, '--global=false', '--include=optional', '--no-save', '--no-package-lock', '--no-audit', '--no-fund'];
		if (remote) { args.push('--cache', path.join(this.root, 'npm-cache')); }
		args.push(agents[id].npm!.package + '@' + agents[id].npm!.version);
		const env = { ...process.env, ...(remote ? remoteRuntimePath() : {}) };
		if (id === 'grok') { env.GROK_HOME = path.join(staging, 'cli'); }
		await promisify(execFile)(npm.command, args, { cwd: staging, env,
			timeout: 300_000, windowsHide: true });
		if (id === 'grok') {
			// The npm installer extracts a standalone executable. Keep just that pinned binary.
			const entry = process.platform === 'win32' ? 'grok.exe' : 'grok';
			await rename(path.join(staging, 'cli', 'bin', 'grok-' + agents[id].npm!.version + path.extname(entry)), path.join(staging, entry));
			await rm(path.join(staging, 'cli'), { recursive: true });
			await rm(path.join(staging, 'node_modules'), { recursive: true });
		}
	}

	async install(id: AgentId) {
		if (await this.isInstalled(id)) { return; }
		const install = this.installation(id);
		const issue = installIssue(id);
		if (issue) { throw new Error(issue); }
		await mkdir(this.root, { recursive: true });
		const staging = await mkdtemp(path.join(this.root, id + '-install-'));
		try {
			if (agents[id].npm) { await this.installNpm(id, staging); }
			else { await installAntigravity(staging); }
			if (!await fileExists(path.join(staging, install.entry))) { throw new Error('The downloaded adapter is missing its entry point.'); }
			try {
				await rename(staging, install.directory);
			} catch (error) {
				// Another window can finish the same install first.
				if (!await fileExists(path.join(install.directory, install.entry))) { throw error; }
			}
		} finally {
			await rm(staging, { recursive: true, force: true, maxRetries: 5 });
		}
	}
}
