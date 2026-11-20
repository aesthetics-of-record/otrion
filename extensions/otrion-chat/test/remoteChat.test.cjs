/* Copyright (c) Otrion contributors. Licensed under the MIT License. */

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
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
				? { format: 'module', source: 'export const { env, workspace, Uri, window } = globalThis.__otrionTestVscode;', shortCircuit: true }
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
				if (method === 'initialize') result = { protocolVersion: 1 };
				if (method === 'session/new') {
					assert.equal(fs.realpathSync(params.cwd), fs.realpathSync(process.cwd()));
					result = { sessionId: 'fixture' };
				}
				if (method === 'session/prompt') {
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
			const environment = await store.agentEnvironment(agent);
			const context = { extension: { packageJSON: { version: '0.1.0' } }, globalState: { get: (_, fallback) => fallback, update: async () => {} } };
			const record = { id: agent, agent, messages: [] };
			const runtime = { launch: id => store.launch(id), agentEnvironment: async () => environment };
			mock.workspace.getConfiguration = () => ({ get: (key, fallback) => key.endsWith('Allowed') || fallback });
			const session = createSession(context, runtime, record, () => {}, () => {});
			try {
				// VS Code may encode the Windows drive colon. The ACP agent expects a standard file URL.
				const resource = pathToFileURL(attached).href.replace(/^file:\/\/\/([a-z]):/i, 'file:///$1%3A');
				await session.send([{ type: 'resource_link', uri: resource }]);
				assert.deepEqual(record.messages, [{ role: 'You', text: '@notes #1.md' }]);
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
	} finally {
		hooks.deregister();
		delete globalThis.__otrionTestVscode;
		if (envPath === undefined) { delete process.env.PATH; } else { process.env.PATH = envPath; }
		await fs.rm(root, { recursive: true, force: true, maxRetries: 5 });
	}
});
