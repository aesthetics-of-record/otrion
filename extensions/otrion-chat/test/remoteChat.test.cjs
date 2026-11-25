/* Copyright (c) Otrion contributors. Licensed under the MIT License. */

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { execFile } = require('node:child_process');
const { createServer } = require('node:http');
const { promisify } = require('node:util');
const { registerHooks } = require('node:module');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { pathToFileURL } = require('node:url');

const extension = path.resolve(process.env.OTRION_CHAT_TEST_EXTENSION ?? path.join(__dirname, '..'));
const windows = process.platform === 'win32';

test('Managed versions retain prior installations and order Pi and Cursor releases', () => {
	const { agentIds } = require(path.join(extension, 'out', 'agentCatalog.js'));
	const { bundledVersion, parseInstalledVersion, versionKey, isNewer } = require(path.join(extension, 'out', 'agentUpdates.js'));
	for (const id of agentIds) {
		const release = bundledVersion(id);
		assert.deepEqual(parseInstalledVersion(id, versionKey(release)), release);
		assert.equal(parseInstalledVersion(id, 'install-tmp'), undefined);
		assert.equal(isNewer(id, release, release), false);
	}
	assert.equal(isNewer('pi', { version: '0.0.34', runtime: '1.10.0' }, { version: '0.0.34', runtime: '1.9.0' }), true);
	assert.equal(isNewer('pi', { version: '0.0.35', runtime: '1.5.0' }, { version: '0.0.34', runtime: '1.6.0' }), false);
	assert.equal(isNewer('grok', { version: '1.0.92' }, { version: '1.0.93' }), false);
	assert.equal(isNewer('cursor', { version: '2026.11.20-00aabbb' }, { version: '2026.11.19-fffffff' }), true);
});

test('Antigravity checks the native download and isolates Gemini key settings', async () => {
	const { configureAntigravityKeyProfile, installAntigravity } = require(path.join(extension, 'out', 'antigravity.js'));
	const home = await fs.mkdtemp(path.join(os.tmpdir(), 'otrion-agy-test-'));
	try {
		const defaultProfile = path.join(home, '.gemini', 'antigravity-cli');
		await fs.mkdir(defaultProfile, { recursive: true });
		await fs.writeFile(path.join(defaultProfile, 'settings.json'), '{"theme":"dark"}');
		const [profile, same] = await Promise.all([configureAntigravityKeyProfile('store', home), configureAntigravityKeyProfile('store', home)]);
		assert.equal(same, profile);
		const settings = path.join(home, '.gemini', profile, 'settings.json');
		assert.deepEqual(JSON.parse(await fs.readFile(settings, 'utf8')), { modelProvider: 'gemini' });
		assert.equal(await fs.readFile(path.join(defaultProfile, 'settings.json'), 'utf8'), '{"theme":"dark"}');
		await assert.rejects(installAntigravity(home, async url => {
			assert.equal(new URL(url).hostname, 'storage.googleapis.com');
			return new Response('incomplete binary');
		}), /SHA-512/);
		assert.equal((await fs.readdir(home)).includes(windows ? 'agy.exe' : 'agy'), false);
	} finally { await fs.rm(home, { recursive: true, force: true }); }
});

test('Settings probes use the authentication signal for each ACP agent', async () => {
	const { AcpClient } = require(path.join(extension, 'out', 'acp.js'));
	const adapter = `
		const replies = JSON.parse(process.argv[1]);
		require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
			const { method, id, params } = JSON.parse(line);
			const reply = JSON.stringify(replies[method] ?? { error: { code: -32601, message: 'Method not found' } });
			console.log(JSON.stringify({ jsonrpc: '2.0', id, ...JSON.parse(reply.replaceAll('$session', params.sessionId ?? '')) }));
		});`;
	async function probe(id, init, list, extraReplies = {}) {
		const replies = { initialize: { result: { protocolVersion: 1, ...init } }, 'session/list': list, ...extraReplies };
		const client = new AcpClient(id, process.execPath, ['-e', adapter, JSON.stringify(replies)], os.tmpdir(), {}, () => {});
		try { return await client.accountStatus('test'); } finally { client.dispose(); }
	}
	const capabilities = { agentCapabilities: { sessionCapabilities: { list: {} } } };
	const success = { result: { sessions: [] } };
	const status = await Promise.all([
		probe('antigravity', capabilities, { error: { code: -32000, message: 'Authentication required' } }),
		probe('antigravity', capabilities, success),
		probe('antigravity', capabilities, { error: { code: -32603, message: 'Service unavailable' } }),
		// Grok can return a session list and advertise interactive login even when signed out.
		...[null, 'cached_token', 'xai.api_key', undefined].map(defaultAuthMethodId =>
			probe('grok', { ...capabilities, authMethods: [{ id: 'grok.com', name: 'Grok' }], _meta: { defaultAuthMethodId } }, success)),
	]);
	assert.deepEqual(status, ['Signed out', 'Signed in', 'Unknown', 'Signed out', 'Signed in', 'CLI API key', 'Unknown']);
	const loadable = { agentCapabilities: { loadSession: true } };
	for (const [id, code, data, message] of [
		['cline', -32002, { uri: '$session' }, 'Resource not found'],
		['github-copilot-cli', -32002, { uri: 'Session $session not found' }, 'Resource not found'],
		['kimi-code', -32602, { sessionId: '$session' }, 'Invalid params: Unknown sessionId: $session'],
	]) {
		const lookup = error => probe(id, loadable, success, { 'session/load': { error } });
		assert.deepEqual(await Promise.all([
			lookup({ code, data, message }),
			lookup({ code: -32000, message: 'Authentication required' }),
			lookup({ code, data: {}, message: 'Unrelated error' }),
		]), ['Signed in', 'Signed out', 'Unknown']);
	}
	const goose = (defaults, entries) => probe('goose', {}, success, {
		'_goose/unstable/defaults/read': { result: defaults }, '_goose/unstable/providers/list': { result: { entries } },
	});
	const defaults = { providerId: 'openai', modelId: 'gpt-4o' };
	assert.deepEqual(await Promise.all([goose({}, []), goose(defaults, [{ providerId: 'openai', configured: true }]),
		goose(defaults, [{ providerId: 'openai', configured: false }]), goose(defaults, [])]),
		['Provider setup required', 'Provider configured', 'Provider setup required', 'Unknown']);
	const preflight = (state, hasToken) => probe('qwen-code', {}, success, { 'qwen/status/workspace/preflight': {
		result: { cells: [{ kind: 'auth', status: state, detail: { hasToken } }] }
	} });
	assert.deepEqual(await Promise.all([preflight('ok', true), preflight('warning', false), preflight('unknown', 'unknown')]),
		['CLI credentials configured', 'Signed out', 'Check account with /doctor']);
});

test('ACP agents can offer legacy session options and protocol sign-in methods', async () => {
	const { AcpClient, AuthenticationRequired } = require(path.join(extension, 'out', 'acp.js'));
	const adapter = `
		const assert = require('node:assert/strict');
		let signedIn = false;
		require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
			const { id, method, params } = JSON.parse(line);
			let result = {};
			let error;
			if (method === 'initialize') {
				const authMethods = [{ id: 'account', name: 'Sign in' }];
				if (params.clientCapabilities.auth?.terminal) {
					authMethods.push({ type: 'terminal', id: 'terminal', name: 'Terminal', args: ['--login'] });
				}
				result = { protocolVersion: 1, authMethods };
			} else if (method === 'authenticate') {
				assert.equal(params.methodId, 'account');
				signedIn = true;
			} else if (method === 'session/new') {
				if (signedIn) {
					result = { sessionId: 'legacy', modes: { currentModeId: 'plan', availableModes: [{ id: 'plan', name: 'Plan' }, { id: 'edit', name: 'Edit' }] },
						models: { currentModelId: 'small', availableModels: [{ modelId: 'small', name: 'Small' }, { modelId: 'large', name: 'Large' }] } };
				} else { error = { code: -32000, message: 'Authentication required' }; }
			} else if (method === 'session/set_mode') {
				assert.equal(params.modeId, 'edit');
			} else if (method === 'session/set_model') {
				assert.equal(params.modelId, 'large');
			} else { throw new Error('Unexpected method ' + method); }
			console.log(JSON.stringify({ jsonrpc: '2.0', id, ...(error ? { error } : { result }) }));
		});`;
	const updates = [];
	const client = new AcpClient('opencode', process.execPath, ['-e', adapter], os.tmpdir(), {}, update => updates.push(update));
	try {
		await assert.rejects(client.initialize(os.tmpdir(), 'test'), AuthenticationRequired);
		const methods = await client.authMethods('test');
		assert.deepEqual(methods.map(method => method.id), ['account', 'terminal']);
		await client.authenticate('account');
		assert.equal(await client.initialize(os.tmpdir(), 'test'), 'legacy');
		for (const option of updates.at(-1).configOptions) {
			await client.setOption(option.id, option.options[1].value);
		}
		assert.deepEqual(updates.at(-1).configOptions.map(o => o.currentValue), ['edit', 'large']);
	} finally { client.dispose(); }
});

test('Agent edits open against the live file or their recorded snapshots', async () => {
	class Uri {
		constructor(scheme, fsPath, query = '') { Object.assign(this, { scheme, fsPath, query }); }
		static file(fsPath) { return new Uri('file', fsPath); }
		with(change) { return new Uri(change.scheme ?? this.scheme, this.fsPath, change.query ?? this.query); }
		toString() { return this.scheme + '://' + this.fsPath + (this.query ? '?' + this.query : ''); }
	}
	const files = new Map([['/work/lib.rs', 'fn a() {}\nfn b() { 2 }\nfn c() {}\n']]);
	const calls = [];
	let provider;
	const mock = {
		Uri,
		Position: class { constructor(line, character) { Object.assign(this, { line, character }); } },
		Range: class { constructor(start, end) { Object.assign(this, { start, end }); } },
		l10n: { t: (message, ...args) => message.replace(/\{(\d+)\}/g, (_, index) => args[index]) },
		window: { showWarningMessage: message => calls.push({ warning: message }) },
		workspace: {
			registerTextDocumentContentProvider: (scheme, value) => { provider = value; return { dispose() {} }; },
			openTextDocument: async uri => {
				if (!files.has(uri.fsPath)) { throw new Error('missing'); }
				return { getText: () => files.get(uri.fsPath) };
			},
		},
		commands: { executeCommand: async (command, ...args) => { calls.push({ command, args }); } },
	};
	const hooks = registerHooks({
		resolve: (specifier, context, next) => specifier === 'vscode' ? { url: 'otrion-test:vscode-edit-review', shortCircuit: true } : next(specifier, context),
		load: (url, context, next) => url === 'otrion-test:vscode-edit-review'
			? { format: 'module', source: 'export const { Uri, Position, Range, l10n, window, workspace, commands } = globalThis.__otrionTestVscode;', shortCircuit: true }
			: next(url, context),
	});
	globalThis.__otrionTestVscode = mock;
	const modulePath = path.join(extension, 'out', 'editReview.js');
	try {
		const { registerEditReview, reviewEdit } = require(modulePath);
		registerEditReview({ subscriptions: [] });
		const describe = ({ command, args, warning }) => warning ? { warning } : {
			command,
			sides: args.slice(0, command === 'vscode.diff' ? 2 : 1).map(uri => uri.scheme === 'file' ? uri.fsPath : provider.provideTextDocumentContent(uri)),
			line: args.at(-1).selection?.start.line,
		};
		const file = Uri.file('/work/lib.rs');
		await reviewEdit(file, 'fn b() { 1 }\n', 'fn b() { 2 }\n', true);
		await reviewEdit(file, 'fn b() { 1 }\n', 'fn b() { 2 }\n', false);
		await reviewEdit(file, 'old\n', 'replaced later\n', true);
		await reviewEdit(Uri.file('/work/gone.rs'), '', 'new\n', false);
		assert.deepStrictEqual(calls.map(describe), [
			{ command: 'vscode.diff', sides: ['fn a() {}\nfn b() { 1 }\nfn c() {}\n', '/work/lib.rs'], line: 1 },
			{ command: 'vscode.open', sides: ['/work/lib.rs'], line: 1 },
			{ command: 'vscode.diff', sides: ['old\n', 'replaced later\n'], line: undefined },
			{ warning: 'gone.rs no longer exists.' },
		]);
	} finally {
		// Later tests load these modules through their own vscode mock; Node caches `vscode` per requiring folder.
		for (const key of Object.keys(require.cache)) {
			if (key === modulePath || key.includes('vscode-edit-review')) { delete require.cache[key]; }
		}
		hooks.deregister();
		delete globalThis.__otrionTestVscode;
	}
});

test('Remote SSH agents use the host runtime, credentials and file paths', async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), 'otrion remote chat '));
	const workspace = path.join(root, 'Workspace #1');
	const attached = path.join(workspace, 'notes #1.md');
	const bin = path.join(root, 'bin');
	const managed = path.join(root, 'managed');
	const envPath = process.env.PATH;
	const uri = { scheme: 'file', fsPath: workspace };
	let terminal;
	let opened;
	const mock = {
		env: { remoteAuthority: 'ssh-remote+test', remoteName: 'ssh-remote' },
		workspace: {
			isTrusted: true,
			workspaceFolders: [{ uri }],
			getConfiguration: () => ({ get: (_, fallback) => fallback }),
		},
		Uri: {
			parse: () => ({ scheme: 'file', fsPath: attached }),
			file: fsPath => ({ scheme: 'file', fsPath }),
		},
		Position: class { constructor(line, character) { Object.assign(this, { line, character }); } },
		Range: class { constructor(start, end) { Object.assign(this, { start, end }); } },
		commands: { executeCommand: (command, uri, options) => { opened = { command, uri, ...options }; } },
		window: {
			createTerminal: options => { terminal = options; return { show() {} }; },
		},
	};
	const hooks = registerHooks({
		resolve(specifier, context, next) {
			return specifier === 'vscode'
				? { url: 'otrion-test:vscode', shortCircuit: true }
				: next(specifier, context);
		},
		load(url, context, next) {
			return url === 'otrion-test:vscode'
				? { format: 'module', source: 'export const { env, workspace, Uri, window, commands, Position, Range } = globalThis.__otrionTestVscode;', shortCircuit: true }
				: next(url, context);
		},
	});
	globalThis.__otrionTestVscode = mock;
	try {
		await fs.mkdir(workspace);
		await fs.mkdir(bin);
		process.env.PATH = [windows ? '"' + bin + '"' : bin, path.dirname(process.execPath), ...(windows ? [] : ['/usr/bin', '/bin'])].join(path.delimiter);
		await fs.writeFile(attached, 'fixture');
		const { AgentStore, agents, isAgent, allowed, installIssue, supportsKey } = require(path.join(extension, 'out', 'agents.js'));
		const { createSession } = require(path.join(extension, 'out', 'chatSession.js'));
		const credentials = new Map();
		const store = new AgentStore(managed, { get: async key => {
			assert.match(key, /^agent-auth\.remote\.ssh-remote\+test\./);
			return credentials.get(key);
		} });
		assert.equal(isAgent('toString'), false);
		assert.equal(isAgent('gemini'), false);
		assert.equal(allowed('grok'), false);
		assert.deepEqual(Object.keys(agents).filter(supportsKey).sort(), ['antigravity', 'claude', 'cline', 'codex', 'cursor', 'grok']);
		credentials.set('agent-auth.remote.ssh-remote+test.opencode', JSON.stringify({ mode: 'key', key: 'old-key' }));
		assert.deepEqual(await store.authChoice('opencode'), { mode: 'cli', hasKey: false });
		for (const [id, output, expected] of [
			['cursor', '{"status":"unauthenticated","isAuthenticated":false}', 'Signed out'],
			['cursor', '{"status":"authenticated","isAuthenticated":true}', 'Signed in'],
			['cursor', 'Service unavailable', 'Unknown'],
			['opencode', '[]', 'No provider credentials'],
			['opencode', '[{"connections":[{"type":"credential","method":"oauth"}]}]', 'Signed in'],
			['opencode', '[{"connections":[{"type":"env","name":"OPENAI_API_KEY"}]}]', 'Provider configured'],
			['opencode', '{}', 'Unknown'],
			['kilo', '└  0 credentials', 'No provider credentials'],
			['kilo', '●  OpenAI oauth\n└  1 credentials', 'Signed in'],
			['kilo', '└  0 credentials\n└  1 environment variable', 'Provider configured'],
			['kilo', 'Unexpected output', 'Unknown'],
		]) {
			const cli = { command: process.execPath, args: [], baseArgs: ['-e', 'console.log(process.env.FIXTURE)', '--'], env: { FIXTURE: output, CURSOR_API_KEY: '' } };
			assert.equal(await store.authStatus(id, cli), expected);
		}
		const executable = `
			const assert = require('node:assert/strict');
			const fs = require('node:fs');
			const { fileURLToPath } = require('node:url');
			let held;
			const finishHeld = reason => {
				console.log(JSON.stringify({ jsonrpc: '2.0', id: held, result: { stopReason: reason } }));
				held = undefined;
			};
			const values = { model: 'sol', effort: 'medium', fast: false, mode: 'read-only' };
			const choices = { model: ['sol', 'astra'], effort: ['medium', 'high'], mode: ['read-only', 'plan'] };
			const configOptions = () => Object.entries(values).map(([id, currentValue]) => ({
				id, currentValue, category: id === 'effort' ? 'thought_level' : id,
				type: id === 'fast' ? 'boolean' : 'select',
				options: choices[id]?.map(value => ({ value, name: value }))
			}));
			require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
				const { id, method, params } = JSON.parse(line);
				let result = { stopReason: 'end_turn' };
				if (method === 'initialize') result = { protocolVersion: 1, _meta: { steering: { supported: true } }, agentCapabilities: { loadSession: true, promptCapabilities: { image: true } } };
				if (method === 'session/new') {
					assert.equal(fs.realpathSync(params.cwd), fs.realpathSync(process.cwd()));
					result = { sessionId: 'fixture' };
				}
				if (method === 'session/load') {
					if (params.sessionId === 'codex-history') {
						const title = ${JSON.stringify('This session was recorded with model `astra` but is resuming with `sol`.')};
						for (const message of [title, 'Unrelated warning']) {
							console.log(JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: params.sessionId,
								update: { sessionUpdate: 'notice', severity: 'warning', title: message } } }));
						}
					}
					result = { configOptions: configOptions() };
				}
				if (method === 'session/set_config_option') {
					values[params.configId] = params.value;
					if (params.configId === 'model') { values.effort = 'medium'; values.fast = false; }
					result = { configOptions: configOptions() };
				}
				if (method === 'session/prompt' && params.prompt[0]?.text === 'hold') {
					held = id;
					return;
				}
				if (method === 'session/cancel') { finishHeld('cancelled'); return; }
				if (method === '_session/steering') {
					assert.equal(params._meta.steering.idleBehavior, 'promptRequired');
					assert.equal(params.prompt[0].text, 'inject');
					result = { outcome: 'injected' };
					finishHeld('end_turn');
				}
				if (method === 'session/prompt' && params.prompt[0]?.type === 'resource_link') {
					assert.deepEqual(params.prompt[1], { type: 'image', mimeType: 'image/png', data: 'aW1n' });
					assert.equal(fs.realpathSync(fileURLToPath(params.prompt[0].uri)), fs.realpathSync('notes #1.md'));
					assert.equal(params.prompt[0].name, 'notes #1.md');
				}
				process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\\n');
			});`;

		// On Windows, exercise the npm-installed .cmd layout. On POSIX, exercise the PATH entry directly.
		for (const agent of ['codex', 'claude', 'grok', 'qwen-code', 'cline', 'github-copilot-cli']) {
			const profile = agents[agent];
			const binary = profile.binary;
			const script = '#!/usr/bin/env node\n' +
				'const { deepEqual } = require("node:assert/strict");\n' +
				'deepEqual(process.argv.slice(2), ' + JSON.stringify(profile.args ?? []) + ');\n' +
				Object.entries(profile.env ?? {}).map(([key, value]) =>
					'deepEqual(process.env[' + JSON.stringify(key) + '], ' + JSON.stringify(value) + ');').join('\n') +
				executable;
			if (windows) {
				const entry = path.join(bin, 'node_modules', profile.npm.package, profile.npm.entry);
				await fs.mkdir(path.dirname(entry), { recursive: true });
				const commonJs = path.join(path.dirname(entry), 'fixture.cjs');
				await fs.writeFile(commonJs, script);
				await fs.writeFile(entry, '#!/usr/bin/env node\nimport("./fixture.cjs")');
				await fs.writeFile(path.join(bin, binary + '.cmd'), '@exit /b 1');
			} else {
				await fs.writeFile(path.join(bin, binary), script, { mode: 0o755 });
			}
			const context = { extension: { packageJSON: { version: '0.1.0' } }, globalState: { get: (_, fallback) => fallback, update: async () => {} } };
			const record = { id: agent, agent, messages: [] };
			const runtime = { launch: id => store.launch(id), sessionCommand: (id, launch) => store.sessionCommand(id, launch) };
			mock.workspace.getConfiguration = () => ({ get: (key, fallback) => key === 'enabledAgents' ? Object.keys(agents) : key.endsWith('Allowed') || fallback });
			let available = false;
			const states = [];
			const session = createSession(context, { ...runtime, launch: id => available ? runtime.launch(id) : undefined }, record, msg => states.push(msg), () => {});
			try {
				for (const [href, line, character] of [
					[path.join(workspace, 'server.ts') + ':11', 10, 0],
					['server.ts%3A11%3A3', 10, 2],
					['server.ts#L7-L10', 6, 0],
				]) {
					await session.openLink(href, false);
					assert.equal(opened.uri.fsPath, path.join(workspace, 'server.ts'));
					assert.equal(opened.selection.start.line, line);
					assert.equal(opened.selection.start.character, character);
				}
				for (const name of ['fault-draw.wav', 'clip.mp4', 'image.png']) {
					await session.openLink(name, false);
					assert.deepEqual(opened, { command: 'vscode.open', uri: mock.Uri.file(path.join(workspace, name)), preview: true });
				}
				await session.configure();
				assert.equal(states.at(-1).connectionIssue, 'setup');
				assert.match(states.at(-1).status, /SSH host/);
				available = true;
				await session.retrySetup();
				assert.equal(states.at(-1).connectionIssue, undefined);
				assert.equal(states.at(-1).connected, true);
				// VS Code may encode the Windows drive colon. The ACP agent expects a standard file URL.
				const resource = pathToFileURL(attached).href.replace(/^file:\/\/\/([a-z]):/i, 'file:///$1%3A');
				await session.send([{ type: 'resource_link', uri: resource }, { type: 'image', mimeType: 'image/png', data: 'aW1n' }]);
				assert.deepEqual(record.messages, [{ role: 'You', text: '@notes #1.md', artifacts: [{ label: 'Image', image: 'data:image/png;base64,aW1n' }] }]);
				assert.equal(record.remoteId, 'fixture');
				const text = value => [{ type: 'text', text: value }];
				const live = session.send(text('hold'));
				await new Promise(resolve => setImmediate(resolve));
				for (const value of ['first', 'remove', 'inject', 'last']) { await session.send(text(value)); }
				assert.deepEqual(record.queue.map(item => item.label), ['first', 'remove', 'inject', 'last']);
				session.discardQueued(record.queue[1].id);
				await session.sendQueued(record.queue[1].id);
				await live;
				assert.deepEqual(record.messages.slice(1).map(row => row.text), ['hold', 'inject', 'first', 'last']);
				assert.deepEqual(record.queue, []);

				const stopped = session.send(text('hold'));
				await new Promise(resolve => setImmediate(resolve));
				await session.send(text('keep'));
				session.stop();
				await stopped;
				assert.equal(record.queue[0].label, 'keep');
				await session.sendQueued(record.queue[0].id);
				assert.equal(record.messages.at(-1).text, 'keep');
			} finally {
				session.dispose();
			}
			const resumed = { id: agent, agent, remoteId: agent + '-history', messages: [],
				options: agent === 'codex' ? { effort: 'high', fast: true, mode: 'plan' } : { model: 'astra', effort: 'high' } };
			const resume = () => createSession(context, runtime, resumed, msg => states.push(msg), () => {});
			let reopened = resume();
			try {
				await reopened.configure();
				assert.equal(states.at(-1).connectionIssue, undefined);
				assert.deepEqual(Object.fromEntries(states.at(-1).options.map(o => [o.id, o.current])), {
					model: 'astra', effort: 'high', fast: agent === 'codex', mode: agent === 'codex' ? 'plan' : 'read-only'
				});
				if (agent === 'codex') {
					assert.equal(states.at(-1).recordedModel, 'astra');
					assert.deepEqual(resumed.messages.map(m => m.title), ['Unrelated warning']);
				}
				await reopened.configure({ id: 'model', value: 'sol' });
				reopened.dispose();
				reopened = resume();
				await reopened.configure();
				assert.equal(states.at(-1).options.find(o => o.kind === 'model').current, 'sol');
				await reopened.configure({ id: 'model', value: 'astra' });
				assert.equal(states.at(-1).options.find(o => o.kind === 'model').current, 'astra');
			} finally {
				reopened.dispose();
			}
		}

		if (windows) {
			const codex = path.join(bin, 'node_modules', '@openai', 'codex', 'bin');
			await fs.mkdir(codex, { recursive: true });
			await fs.writeFile(path.join(codex, 'codex.js'), '');
			await fs.writeFile(path.join(bin, 'codex.cmd'), '@exit /b 1');
		} else {
			await fs.writeFile(path.join(bin, 'codex'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
		}
		const agy = path.join(bin, windows ? 'agy.exe' : 'agy');
		await fs.writeFile(agy, '', { mode: 0o755 });
		assert.equal(await store.isInstalled('antigravity'), false);
		const external = await store.launch('antigravity');
		assert.equal(external.command, agy);
		assert.deepEqual(external.args, ['acp']);
		await store.signIn('antigravity');
		assert.deepEqual(terminal.shellArgs, ['acp', '--login']);
		await store.signIn('codex');
		assert.deepEqual(terminal.shellArgs.slice(-2), ['login', '--device-auth']);
		assert.equal(terminal.cwd.fsPath, os.homedir());

		await store.signIn('github-copilot-cli');
		assert.deepEqual(terminal.shellArgs.slice(windows ? 1 : 0), ['login']);
		assert.equal(terminal.cwd.fsPath, os.homedir());
		await store.signIn('grok');
		assert.deepEqual(terminal.shellArgs.slice(windows ? 1 : 0), ['login', '--device-auth']);
		credentials.set('agent-auth.remote.ssh-remote+test.grok', JSON.stringify({ mode: 'key', key: 'fixture-grok-key' }));
		const grokLaunch = await store.launch('grok');
		const { env } = await store.sessionCommand('grok', grokLaunch);
		assert.equal(env.XAI_API_KEY, 'fixture-grok-key');
		assert.equal(env.GROK_HOME, path.join(managed, 'grok-api-key'));
		assert.notEqual((await store.sessionCommand('cline', grokLaunch)).env.XAI_API_KEY, 'fixture-grok-key');
		await testManagedInstall(root, store, agents, mock, installIssue);
	} finally {
		hooks.deregister();
		delete globalThis.__otrionTestVscode;
		if (envPath === undefined) { delete process.env.PATH; } else { process.env.PATH = envPath; }
		await fs.rm(root, { recursive: true, force: true, maxRetries: 5 });
	}
});

// Use the real packaged npm against a loopback registry. Each fixture's install script
// spawns "node" by name, just like dependencies that need the host runtime during setup.
async function testManagedInstall(root, store, agents, mock, installIssue) {
	const appRoot = process.env.OTRION_CHAT_TEST_EXTENSION ? path.resolve(extension, '../..') : path.join(root, 'server');
	const npmDir = path.join(appRoot, 'agent-tools', 'npm');
	if (!process.env.OTRION_CHAT_TEST_EXTENSION) {
		await fs.cp(await fs.realpath(path.join(extension, '../../build/node_modules/otrion-npm-cli')), npmDir, { recursive: true, dereference: true });
	}
	mock.env.appRoot = appRoot;
	const npm = path.join(npmDir, 'bin', 'npm-cli.js');
	const files = new Map();
	const { piRuntime } = require(path.join(extension, 'out', 'agentCatalog.js'));
	const packages = [...Object.values(agents).filter(agent => agent.npm), { binary: 'pi', npm: piRuntime }];
	for (const agent of packages) {
		const pkg = path.join(root, agent.binary);
		const entry = path.join(pkg, agent.npm.entry);
		await fs.mkdir(path.dirname(entry), { recursive: true });
		const name = agent.npm.package;
		await fs.writeFile(path.join(pkg, 'package.json'), JSON.stringify({ name, version: agent.npm.version, bin: { [agent.binary]: agent.npm.entry },
			scripts: { postinstall: 'node record-runtime.js' } }));
		const record = "require('node:fs').writeFileSync('install-runtime', process.execPath)";
		const install = agent.binary === 'grok' ? `
			const fs = require('node:fs'), path = require('node:path');
			const bin = path.join(process.env.GROK_HOME, 'bin');
			fs.mkdirSync(bin, {recursive: true});
			fs.copyFileSync('bin/grok', path.join(bin, 'grok-${agent.npm.version}${windows ? '.exe' : ''}'));` : '';
		await fs.writeFile(path.join(pkg, 'record-runtime.js'), record + ';' + install);
		const probe = agent.binary === 'cline' ? `if (process.env.OTRION_TEST_UPDATE_PROBE) {
			require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
				const { id } = JSON.parse(line);
				console.log(JSON.stringify({ jsonrpc: '2.0', id, result: { protocolVersion: 1 } }));
			});
		} else ` : '';
		await fs.writeFile(entry, '#!/usr/bin/env node\n' + probe + 'console.log(process.execPath)');
		const { stdout } = await promisify(execFile)(process.execPath, [npm, 'pack', '--json', '--ignore-scripts', '--cache', path.join(root, 'cache')], { cwd: pkg });
		const [{ filename, integrity }] = JSON.parse(stdout);
		files.set(name, { version: agent.npm.version, integrity, tar: await fs.readFile(path.join(pkg, filename)) });
	}
	const registry = createServer((req, res) => {
		const name = decodeURIComponent(req.url.slice(1)).replace(/\.tgz$/, '');
		const entry = files.get(name);
		if (!entry) { res.writeHead(404).end(); return; }
		if (req.url.endsWith('.tgz')) { res.end(entry.tar); return; }
		const { version, integrity } = entry;
		res.setHeader('Content-Type', 'application/json');
		res.end(JSON.stringify({ name, 'dist-tags': { latest: version }, versions: { [version]: {
			name, version, hasInstallScript: true, dist: { tarball: registryUrl + encodeURIComponent(name) + '.tgz', integrity }
		} } }));
	});
	await new Promise((resolve, reject) => registry.once('error', reject).listen(0, '127.0.0.1', resolve));
	const registryUrl = 'http://127.0.0.1:' + registry.address().port + '/';
	const oldRegistry = process.env.npm_config_registry;
	try {
		process.env.npm_config_registry = registryUrl;
		const shellDir = path.join(root, 'shell-only');
		await fs.mkdir(shellDir);
		if (!windows) { await fs.symlink('/bin/sh', path.join(shellDir, 'sh')); }
		process.env.PATH = windows ? path.dirname(process.env.ComSpec || 'C:\\Windows\\System32\\cmd.exe') : shellDir;
		for (const id of Object.keys(agents)) {
			if (!agents[id].npm) { continue; }
			if (installIssue(id)) {
				await assert.rejects(store.install(id), { message: installIssue(id) });
				continue;
			}
			await store.install(id);
			const launch = await store.launch(id);
			assert.equal(launch.source, 'Installed by Otrion');
			assert.equal(launch.command, process.execPath);
			const profile = agents[id];
			assert.deepEqual(launch.args.slice(1), profile.args ?? []);
			if (id !== 'grok') {
				const directory = id + '-' + profile.npm.version + (id === 'pi' ? '-' + piRuntime.version : '');
				const pkg = path.join(root, 'managed', directory, 'node_modules', profile.npm.package);
				assert.equal(await fs.readFile(path.join(pkg, 'install-runtime'), 'utf8'), process.execPath);
			}
			const { env } = await store.sessionCommand(id, launch);
			const result = await promisify(execFile)(launch.command, launch.args, { env });
			assert.equal(result.stdout.trim(), process.execPath);
			await store.install(id); // already installed
		}
		if (!installIssue('cline')) {
			const { AgentStore } = require(path.join(extension, 'out', 'agents.js'));
			const managed = path.join(root, 'managed');
			const version = agents.cline.npm.version;
			const current = path.join(managed, 'cline-' + version);
			const old = path.join(managed, 'cline-0.0.1');
			await fs.rename(current, old);
			const updates = new AgentStore(managed, {}, async () => ({ version }));
			const before = await updates.launch('cline');
			assert.deepEqual(await updates.availableUpdate('cline', before.release), { version });
			await assert.rejects(fs.access(current), { code: 'ENOENT' });
			await assert.rejects(updates.update('cline', version), /invalid JSON/);
			assert.equal((await updates.launch('cline')).directory, old);
			const originalProbe = process.env.OTRION_TEST_UPDATE_PROBE;
			try {
				process.env.OTRION_TEST_UPDATE_PROBE = '1';
				await Promise.all([updates.update('cline', version), updates.update('cline', version)]);
			} finally {
				if (originalProbe === undefined) { delete process.env.OTRION_TEST_UPDATE_PROBE; }
				else { process.env.OTRION_TEST_UPDATE_PROBE = originalProbe; }
			}
			assert.equal((await store.launch('cline')).directory, current);
			await fs.access(before.args[0]);
		}
	} finally {
		if (oldRegistry === undefined) { delete process.env.npm_config_registry; } else { process.env.npm_config_registry = oldRegistry; }
		await new Promise(resolve => registry.close(resolve));
	}
}
