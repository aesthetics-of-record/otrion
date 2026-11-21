/* Copyright (c) Otrion contributors. Licensed under the MIT License. */

import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { access, open, mkdir, mkdtemp, readdir, rename, rm, stat } from 'node:fs/promises';
import * as path from 'node:path';
import { homedir } from 'node:os';
import { createRequire } from 'node:module';
import { promisify, stripVTControlCharacters } from 'node:util';
import * as vscode from 'vscode';

import { AcpClient } from './acp';
import { configureAntigravityKeyProfile, installAntigravity } from './antigravity';
import { nativeEntry, installNative } from './nativeAgents';
import { agents, agentIds, piRuntime, type AgentId } from './agentCatalog';
import { bundledVersion, compareVersions, isNewer, latestRelease, parseInstalledVersion, versionKey, type AgentRelease, type AgentVersion } from './agentUpdates';
export { agents, isAgent, type AgentId } from './agentCatalog';

export function agentLocation() {
	if (vscode.env.remoteName === 'dev-container') { return 'in this container'; }
	return vscode.env.remoteAuthority ? 'on the SSH host' : 'on this computer';
}

function originalAgent(id: AgentId) { return id === 'codex' || id === 'claude'; }

export function supportsKey(id: AgentId) { return originalAgent(id) || !!agents[id].keyEnv; }

export function installIssue(id: AgentId) {
	if (id === 'cursor' && process.platform === 'linux') {
		const report = process.report.getReport() as { header: { glibcVersionRuntime?: string } };
		if (!report.header.glibcVersionRuntime) { return 'Cursor CLI requires a glibc-based Linux host.'; }
	}
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

function providerAccountStatus(id: 'opencode' | 'kilo', stdout: string, stderr: string) {
	if (id === 'opencode') {
		const entries: unknown = JSON.parse(stdout);
		if (!Array.isArray(entries) || !entries.every(entry => Array.isArray(entry?.connections))) { return 'Unknown'; }
		const connections = entries.flatMap(entry => entry.connections as { type: string; method?: string }[]);
		if (connections.some(connection => connection.type === 'credential' && connection.method === 'oauth')) { return 'Signed in'; }
		return connections.length ? 'Provider configured' : 'No provider credentials';
	}
	const lines = stripVTControlCharacters(stdout + '\n' + stderr);
	const count = lines.match(/^\s*└\s+(\d+) credentials?\s*$/m);
	if (!count) { return 'Unknown'; }
	if (Number(count[1]) > 0 && /^●\s+.+\s+oauth\s*$/m.test(lines)) { return 'Signed in'; }
	const environment = lines.match(/^\s*└\s+(\d+) environment variables?\s*$/m);
	return Number(count[1]) > 0 || Number(environment?.[1]) > 0 ? 'Provider configured' : 'No provider credentials';
}

export class AgentStore {
	constructor(private readonly root: string, private readonly secrets: vscode.SecretStorage, private readonly lookupRelease = latestRelease) {}

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
			} else if (id === 'cursor') {
				delete env.CURSOR_AUTH_TOKEN;
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

	private installation(id: AgentId, release: AgentVersion) {
		const npm = agents[id].npm;
		const directory = path.join(this.root, id + '-' + versionKey(release));
		const binary = agents[id].binary + (process.platform === 'win32' ? '.exe' : '');
		const entry = id === 'goose' || id === 'cursor' ? nativeEntry(id)
			: id === 'grok' || !npm ? binary : path.join('node_modules', npm.package, npm.entry);
		return { directory, entry, release };
	}

	private async installed(id: AgentId) {
		let dirs;
		try { dirs = await readdir(this.root, { withFileTypes: true }); }
		catch (error) { if (error.code === 'ENOENT') { return undefined; } throw error; }
		const prefix = id + '-';
		const candidates = await Promise.all(dirs.map(async dir => {
			if (!dir.isDirectory() || !dir.name.startsWith(prefix)) { return undefined; }
			const release = parseInstalledVersion(id, dir.name.slice(prefix.length));
			if (!release) { return undefined; }
			const install = this.installation(id, release);
			if (!await fileExists(path.join(install.directory, install.entry))) { return undefined; }
			const time = id === 'cursor' ? (await stat(install.directory)).mtimeMs : 0;
			return { ...install, time };
		}));
		return candidates.filter(item => !!item).sort((a, b) => compareVersions(b.release, a.release) || b.time - a.time)[0];
	}

	async isInstalled(id: AgentId) { return !!await this.installed(id); }

	private readonly releases = new Map<AgentId, { until: number; result: Promise<AgentRelease> }>();

	async availableUpdate(id: AgentId, current: AgentVersion, force = false) {
		let cached = this.releases.get(id);
		if (force || !cached || cached.until <= Date.now()) {
			const result = this.lookupRelease(id);
			cached = { result, until: Date.now() + 3_600_000 };
			this.releases.set(id, cached);
			const entry = cached;
			void result.catch(() => { entry.until = Date.now() + 60_000; });
		}
		const next = await cached.result;
		if (!isNewer(id, next, current)) { return undefined; }
		if (id === 'cursor' && compareVersions(next, current) === 0) {
			const prior = this.installation(id, next);
			if (await fileExists(path.join(prior.directory, prior.entry))) { return undefined; }
		}
		return next;
	}

	async launch(id: AgentId) {
		const agent = agents[id];
		const setting = configuredPath(id) || agent.binary;
		const install = setting === agent.binary ? await this.installed(id) : undefined;
		const remote = !!vscode.env.remoteAuthority;
		const env: NodeJS.ProcessEnv = { ...(remote ? remoteRuntimePath() : {}), ...agent.env };
		let base: Command | undefined;
		if (install) {
			base = await this.managedCommand(id, install.directory, install.entry, remote, env);
		} else {
			base = await resolveCommand(setting, agent.npm?.package, agent.npm?.entry);
			if (!base && id === 'cursor' && process.platform === 'win32') {
				const script = setting === agent.binary
					? path.join(process.env.LOCALAPPDATA || path.join(homedir(), 'AppData', 'Local'), 'cursor-agent', 'cursor-agent.ps1')
					: path.isAbsolute(setting) && /cursor-agent\.(cmd|ps1)$/i.test(setting) ? setting.replace(/\.cmd$/i, '.ps1') : undefined;
				if (script && await fileExists(script)) {
					const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
					base = { command: powershell, args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script] };
				}
			}
			if (!base && (id === 'cursor' || id === 'goose') && setting === agent.binary && process.platform !== 'win32') {
				base = await resolveCommand(path.join(homedir(), '.local', 'bin', agent.binary));
			}
			if (!base && id === 'antigravity' && setting === agent.binary) {
				const installedPath = process.platform === 'win32'
					? path.join(process.env.LOCALAPPDATA || path.join(homedir(), 'AppData', 'Local'), 'agy', 'bin', 'agy.exe')
					: path.join(homedir(), '.local', 'bin', 'agy');
				base = await resolveCommand(installedPath);
			}
		}
		if (!base) { return undefined; }
		return { ...base, baseArgs: base.args, args: [...base.args, ...(agent.args ?? [])], env,
			release: install?.release, directory: install?.directory, source: install ? 'Installed by Otrion' : 'External installation' };
	}

	private async managedCommand(id: AgentId, directory: string, relativeEntry: string, remote: boolean, env: NodeJS.ProcessEnv) {
		let base: Command | undefined;
		const entry = path.join(directory, relativeEntry);
		if (id === 'cursor' && process.platform === 'win32') {
			base = { command: entry, args: [path.join(path.dirname(entry), 'index.js')] };
			env.CURSOR_INVOKED_AS = 'cursor-agent.cmd';
		} else {
			base = await packageCommand(entry, remote);
		}
		if (id === 'cursor' && base) { base.args.push('--disable-auto-update'); }
		if (id === 'antigravity') { env.AGY_CLI_DISABLE_AUTO_UPDATE = '1'; }
		if (id === 'pi') {
			const shim = process.platform === 'win32' ? 'pi.cmd' : 'pi';
			env.PI_ACP_PI_COMMAND = path.join(directory, 'node_modules', '.bin', shim);
		}
		return base;
	}

	private async piCommand(launch: NonNullable<Awaited<ReturnType<AgentStore['launch']>>>) {
		if (launch.directory) {
			const entry = path.join(launch.directory, 'node_modules', piRuntime.package, piRuntime.entry);
			return { command: launch.command, args: [entry] };
		}
		return resolveCommand(process.env.PI_ACP_PI_COMMAND || 'pi', piRuntime.package, piRuntime.entry);
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
		if (id === 'cursor' || id === 'pi') {
			if (id === 'cursor' && (launch.env.CURSOR_API_KEY ?? process.env.CURSOR_API_KEY)?.trim()) { return 'CLI API key'; }
			const cli = id === 'pi' ? await this.piCommand(launch) : { command: launch.command, args: launch.baseArgs };
			if (!cli) { return 'Pi runtime required'; }
			const args = id === 'pi' ? [...cli.args, '--list-models'] : [...cli.args, 'status', '--format', 'json'];
			let output: string;
			try {
				const result = await promisify(execFile)(cli.command, args, { cwd: homedir(), env: { ...process.env, ...launch.env, NO_COLOR: '1' }, timeout: 10_000, windowsHide: true });
				output = id === 'cursor' ? result.stdout : result.stdout + '\n' + result.stderr;
			} catch (error) {
				if (error.code !== 1) { return 'Unknown'; }
				output = id === 'cursor' ? error.stdout ?? '' : (error.stdout ?? '') + '\n' + (error.stderr ?? '');
			}
			output = stripVTControlCharacters(output);
			if (id === 'pi') {
				if (/^provider\s+model\s+context\s+/im.test(output)) { return 'Provider configured'; }
				return /No models available/i.test(output) ? 'No provider credentials' : 'Unknown';
			}
			try {
				const account = JSON.parse(output);
				if (account.status === 'authenticated' && account.isAuthenticated === true) { return 'Signed in'; }
				return account.status === 'unauthenticated' && account.isAuthenticated === false ? 'Signed out' : 'Unknown';
			} catch { return 'Unknown'; }
		}
		if (id === 'kilo' || id === 'opencode') {
			const args = [...launch.baseArgs, 'auth', 'list'];
			if (id === 'opencode') { args.push('--format', 'json', '--standalone'); }
			try {
				const { stdout, stderr } = await promisify(execFile)(launch.command, args, { cwd: homedir(),
					env: { ...process.env, ...launch.env, NO_COLOR: '1' }, timeout: 10000, maxBuffer: 1_048_576, windowsHide: true });
				return providerAccountStatus(id, stdout, stderr);
			} catch { return 'Unknown'; }
		}
		if (!originalAgent(id)) {
			const client = new AcpClient(id, launch.command, launch.args, homedir(), { ...process.env, ...launch.env }, () => {});
			try { return await client.accountStatus(vscode.version); } finally { client.dispose(); }
		}
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
		if (id === 'pi') {
			if (!vscode.workspace.isTrusted) { throw new Error('Open a trusted workspace to configure Pi.'); }
			const cli = await this.piCommand(launch);
			if (!cli) { throw new Error('Install the Pi runtime or use the Otrion-managed adapter.'); }
			const terminal = vscode.window.createTerminal({ name: 'Pi provider setup', shellPath: cli.command, shellArgs: cli.args, env: launch.env,
				message: 'In Pi, enter /login to configure a model provider.', cwd: vscode.Uri.file(homedir()) });
			terminal.show();
			return terminal;
		}
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

	private async installNpm(id: AgentId, staging: string, release: AgentVersion) {
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
		args.push(agents[id].npm!.package + '@' + release.version);
		if (id === 'pi') { args.push('--engine-strict', piRuntime.package + '@' + release.runtime); }
		const env = { ...process.env, ...(remote ? remoteRuntimePath() : {}) };
		if (id === 'grok') { env.GROK_HOME = path.join(staging, 'cli'); }
		await promisify(execFile)(npm.command, args, { cwd: staging, env,
			timeout: 300_000, windowsHide: true });
		if (id === 'grok') {
			// The npm installer extracts a standalone executable. Keep just that pinned binary.
			const entry = process.platform === 'win32' ? 'grok.exe' : 'grok';
			await rename(path.join(staging, 'cli', 'bin', 'grok-' + release.version + path.extname(entry)), path.join(staging, entry));
			await rm(path.join(staging, 'cli'), { recursive: true });
			await rm(path.join(staging, 'node_modules'), { recursive: true });
		}
	}

	async install(id: AgentId) {
		if (await this.isInstalled(id)) { return; }
		await this.installRelease(id, bundledVersion(id), false);
	}

	async update(id: AgentId, target: string) {
		const launch = await this.launch(id);
		if (!vscode.workspace.isTrusted || !launch?.release) { throw new Error('Updates require an Otrion-managed agent in a trusted workspace.'); }
		if (versionKey(launch.release) === target) { return; }
		const release = await this.availableUpdate(id, launch.release);
		if (!release || versionKey(release) !== target) { throw new Error('The available release changed. Check for updates again.'); }
		await this.installRelease(id, release, true);
	}

	private async installRelease(id: AgentId, release: AgentRelease, update: boolean) {
		const install = this.installation(id, release);
		const issue = installIssue(id);
		if (issue) { throw new Error(issue); }
		await mkdir(this.root, { recursive: true });
		const staging = await mkdtemp(path.join(this.root, id + '-install-'));
		try {
			if (agents[id].npm) { await this.installNpm(id, staging, release); }
			else if (id === 'cursor' || id === 'goose') { await installNative(id, staging, release.archive); }
			else { await installAntigravity(staging, fetch, release.archive); }
			if (!await fileExists(path.join(staging, install.entry))) { throw new Error('The downloaded adapter is missing its entry point.'); }
			if (update) {
				const remote = !!vscode.env.remoteAuthority;
				const env = { ...process.env, ...(remote ? remoteRuntimePath() : {}), ...agents[id].env };
				const cli = await this.managedCommand(id, staging, install.entry, remote, env);
				if (!cli) { throw new Error('The updated agent could not be launched.'); }
				if (id === 'pi') {
					// The adapter negotiates ACP before starting the separate Pi runtime.
					const runtime = path.join(staging, 'node_modules', piRuntime.package, piRuntime.entry);
					await promisify(execFile)(cli.command, [runtime, '--version'], { cwd: homedir(), env, timeout: 15_000, windowsHide: true });
				}
				const client = new AcpClient(id, cli.command, [...cli.args, ...(agents[id].args ?? [])], homedir(), env, () => {});
				await client.checkProtocol(vscode.version);
			}
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
