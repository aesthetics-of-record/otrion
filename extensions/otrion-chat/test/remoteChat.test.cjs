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
			openTextDocument: async uri => ({ uri, lineCount: 20, validatePosition: p => p }),
			getConfiguration: () => ({ get: (_, fallback) => fallback }),
		},
		Uri: {
			parse: () => ({ scheme: 'file', fsPath: attached }),
			file: fsPath => ({ scheme: 'file', fsPath }),
		},
		Position: class { constructor(line, character) { Object.assign(this, { line, character }); } },
		Range: class { constructor(start, end) { Object.assign(this, { start, end }); } },
		window: {
			showTextDocument: (doc, options) => { opened = { doc, ...options.selection.start }; },
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
				? { format: 'module', source: 'export const { env, workspace, Uri, window, Position, Range } = globalThis.__otrionTestVscode;', shortCircuit: true }
				: next(url, context);
		},
	});
	globalThis.__otrionTestVscode = mock;
	try {
		await fs.mkdir(workspace);
		await fs.mkdir(bin);
		process.env.PATH = [windows ? '"' + bin + '"' : bin, path.dirname(process.execPath), ...(windows ? [] : ['/usr/bin', '/bin'])].join(path.delimiter);
		await fs.writeFile(attached, 'fixture');
		const { AgentStore, agents } = require(path.join(extension, 'out', 'agents.js'));
		const { createSession } = require(path.join(extension, 'out', 'chatSession.js'));
		const store = new AgentStore(managed, { get: async key => {
			assert.match(key, /^agent-auth\.remote\.ssh-remote\+test\./);
			return undefined;
		} });
		const executable = `
			const assert = require('node:assert/strict');
			const fs = require('node:fs');
			const { fileURLToPath } = require('node:url');
			require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
				const { id, method, params } = JSON.parse(line);
				let result = { stopReason: 'end_turn' };
				if (method === 'initialize') result = { protocolVersion: 1, agentCapabilities: { promptCapabilities: { image: true } } };
				if (method === 'session/new') {
					assert.equal(fs.realpathSync(params.cwd), fs.realpathSync(process.cwd()));
					result = { sessionId: 'fixture' };
				}
				if (method === 'session/prompt') {
					assert.deepEqual(params.prompt[1], { type: 'image', mimeType: 'image/png', data: 'aW1n' });
					assert.equal(fs.realpathSync(fileURLToPath(params.prompt[0].uri)), fs.realpathSync('notes #1.md'));
					assert.equal(params.prompt[0].name, 'notes #1.md');
				}
				process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\\n');
			});`;

		// On Windows, exercise the npm-installed .cmd layout. On POSIX, exercise the PATH entry directly.
		for (const [agent, { binary }] of Object.entries(agents)) {
			if (windows) {
				const pkg = path.join(bin, 'node_modules', '@agentclientprotocol', binary, 'dist');
				await fs.mkdir(pkg, { recursive: true });
				await fs.writeFile(path.join(pkg, 'index.js'), executable);
				await fs.writeFile(path.join(bin, binary + '.cmd'), '@exit /b 1');
			} else {
				await fs.writeFile(path.join(bin, binary), '#!/usr/bin/env node\n' + executable, { mode: 0o755 });
			}
			const context = { extension: { packageJSON: { version: '0.1.0' } }, globalState: { get: (_, fallback) => fallback, update: async () => {} } };
			const record = { id: agent, agent, messages: [] };
			const runtime = { launch: id => store.launch(id), agentEnvironment: (id, launch) => store.agentEnvironment(id, launch) };
			mock.workspace.getConfiguration = () => ({ get: (key, fallback) => key.endsWith('Allowed') || fallback });
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
					assert.equal(opened.doc.uri.fsPath, path.join(workspace, 'server.ts'));
					assert.equal(opened.line, line);
					assert.equal(opened.character, character);
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
			} finally {
				session.dispose();
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
		await store.signIn('codex');
		assert.deepEqual(terminal.shellArgs.slice(-2), ['login', '--device-auth']);
		assert.equal(terminal.cwd.fsPath, os.homedir());

		await testManagedInstall(root, store, agents, mock);
	} finally {
		hooks.deregister();
		delete globalThis.__otrionTestVscode;
		if (envPath === undefined) { delete process.env.PATH; } else { process.env.PATH = envPath; }
		await fs.rm(root, { recursive: true, force: true, maxRetries: 5 });
	}
});

// Use the real packaged npm against a loopback registry. Each fixture's install script
// spawns "node" by name, just like dependencies that need the host runtime during setup.
async function testManagedInstall(root, store, agents, mock) {
	const appRoot = process.env.OTRION_CHAT_TEST_EXTENSION ? path.resolve(extension, '../..') : path.join(root, 'server');
	const npmDir = path.join(appRoot, 'agent-tools', 'npm');
	if (!process.env.OTRION_CHAT_TEST_EXTENSION) {
		await fs.cp(await fs.realpath(path.join(extension, '../../build/node_modules/otrion-npm-cli')), npmDir, { recursive: true, dereference: true });
	}
	mock.env.appRoot = appRoot;
	const npm = path.join(npmDir, 'bin', 'npm-cli.js');
	const files = new Map();
	for (const agent of Object.values(agents)) {
		const pkg = path.join(root, agent.binary);
		await fs.mkdir(path.join(pkg, 'dist'), { recursive: true });
		const name = '@agentclientprotocol/' + agent.binary;
		await fs.writeFile(path.join(pkg, 'package.json'), JSON.stringify({ name, version: agent.version,
			scripts: { postinstall: 'node record-runtime.js' } }));
		await fs.writeFile(path.join(pkg, 'record-runtime.js'), "require('node:fs').writeFileSync('install-runtime', process.execPath)");
		await fs.writeFile(path.join(pkg, 'dist/index.js'), 'console.log(process.execPath)');
		const { stdout } = await promisify(execFile)(process.execPath, [npm, 'pack', '--json', '--ignore-scripts', '--cache', path.join(root, 'cache')], { cwd: pkg });
		const [{ filename, integrity }] = JSON.parse(stdout);
		files.set(name, { version: agent.version, integrity, tar: await fs.readFile(path.join(pkg, filename)) });
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
			await store.install(id);
			const launch = await store.launch(id);
			assert.equal(launch.source, 'Installed by Otrion');
			assert.equal(launch.command, process.execPath);
			assert.equal(await fs.readFile(path.resolve(launch.args[0], '../../install-runtime'), 'utf8'), process.execPath);
			const env = await store.agentEnvironment(id, launch);
			const result = await promisify(execFile)(launch.command, launch.args, { env });
			assert.equal(result.stdout.trim(), process.execPath);
			await store.install(id); // already installed
		}
	} finally {
		if (oldRegistry === undefined) { delete process.env.npm_config_registry; } else { process.env.npm_config_registry = oldRegistry; }
		await new Promise(resolve => registry.close(resolve));
	}
}
