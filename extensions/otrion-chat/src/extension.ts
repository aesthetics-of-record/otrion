/* Copyright (c) Otrion contributors. Licensed under the MIT License. */

import * as vscode from 'vscode';
import { AcpClient } from './acp';
import { agents, AgentStore, allowed, isAgent, type AgentId } from './agents';
import { registerSettings } from './settings';

interface ChatMessage {
	role: string;
	text: string;
}

interface Turn {
	cancelled: boolean;
	prompting: boolean;
	reply?: ChatMessage;
	timer?: NodeJS.Timeout;
}

export function activate(context: vscode.ExtensionContext) {
	const media = vscode.Uri.joinPath(context.extensionUri, 'media');
	const scripts = vscode.Uri.joinPath(context.extensionUri, 'out', 'webview');
	const store = new AgentStore(vscode.Uri.joinPath(context.globalStorageUri, 'agents').fsPath);
	registerSettings(context, store);
	let selected: AgentId = allowed('claude') && !allowed('codex') ? 'claude' : 'codex';
	let view: vscode.WebviewView | undefined;
	let client: AcpClient | undefined;
	let turn: Turn | undefined;
	let messages: ChatMessage[] = [];
	let status = '';

	function snapshot() {
		view?.webview.postMessage({ type: 'state', messages, status, busy: !!turn, selected, enabled: allowed(selected) && vscode.workspace.isTrusted });
	}

	function reset() {
		client?.dispose();
		client = undefined;
		messages = [];
		status = '';
		snapshot();
	}

	async function send(input: unknown) {
		if (!allowed(selected) || !vscode.workspace.isTrusted || turn || typeof input !== 'string' || !input.trim()) {
			return;
		}
		const id = selected;
		const name = agents[id].name;
		const text = input.trim();
		const active: Turn = { cancelled: false, prompting: false };
		turn = active;
		messages.push({ role: 'You', text });
		status = client ? 'Waiting for ' + name + '…' : 'Connecting to ' + name + '…';
		snapshot();
		try {
			if (!client) {
				const folder = vscode.workspace.workspaceFolders?.[0];
				let cwd: string | undefined = folder?.uri.fsPath;
				if (folder && folder.uri.scheme !== 'file') {
					throw new Error('Open a local folder to use agent chat with this workspace.');
				}
				if (!cwd) {
					const empty = vscode.Uri.joinPath(context.globalStorageUri, 'empty-workspace');
					await vscode.workspace.fs.createDirectory(empty);
					cwd = empty.fsPath;
				}
				const launch = await store.launch(id);
				if (active.cancelled || !allowed(id)) {
					return;
				}
				if (!launch) { throw new Error('Open Otrion Settings to install ' + name + ' or configure its adapter path.'); }
				client = new AcpClient(id, launch.command, launch.args, cwd, update => {
					if (!turn?.prompting || update?.sessionUpdate !== 'agent_message_chunk' || update.content?.type !== 'text' || typeof update.content.text !== 'string') {
						return;
					}
					const chunk = update.content.text;
					if (!turn.reply) {
						turn.reply = { role: name, text: '' };
						messages.push(turn.reply);
					}
					turn.reply.text += chunk;
					view?.webview.postMessage({ type: 'chunk', index: messages.length - 1, role: name, text: chunk });
				});
				await client.initialize(cwd, context.extension.packageJSON.version);
			}
			if (active.cancelled || !allowed(id)) { return; }
			active.prompting = true;
			status = 'Waiting for ' + name + '…';
			snapshot();
			const result = await client.prompt(text);
			status = result?.stopReason === 'end_turn' ? '' : 'Turn ended (' + (result?.stopReason ?? 'unknown reason') + ').';
		} catch (error) {
			client?.dispose();
			client = undefined;
			if (!active.cancelled) {
				messages.push({ role: 'Connection', text: error.message + ' The next message starts a new session.' });
			}
			status = '';
		} finally {
			clearTimeout(active.timer);
			if (active.cancelled) {
				status = 'Stopped.';
			}
			turn = undefined;
			snapshot();
		}
	}

	function stop() {
		if (!turn || turn.cancelled) {
			return;
		}
		turn.cancelled = true;
		status = 'Stopping…';
		snapshot();
		if (turn.prompting) {
			client?.cancel();
			turn.timer = setTimeout(() => client?.dispose(), 5000);
		} else {
			client?.dispose();
		}
	}

	context.subscriptions.push(vscode.workspace.onDidGrantWorkspaceTrust(snapshot), vscode.workspace.onDidChangeConfiguration(e => {
		if (!e.affectsConfiguration('otrion.chat')) { return; }
		if (!allowed(selected)) {
			if (turn) { turn.cancelled = true; }
			client?.dispose();
			client = undefined;
		}
		snapshot();
	}), vscode.window.registerWebviewViewProvider('otrion.chat', {
		resolveWebviewView(resolved) {
			view = resolved;
			const webview = resolved.webview;
			webview.options = { enableScripts: true, localResourceRoots: [media, scripts] };
			const listener = webview.onDidReceiveMessage(message => {
				switch (message?.type) {
					case 'ready': snapshot(); break;
					case 'settings': void vscode.commands.executeCommand('otrion.settings.open'); break;
					case 'select':
						if (!turn && isAgent(message.id) && message.id !== selected) {
							selected = message.id;
							reset();
						}
						break;
					case 'send': void send(message.text); break;
					case 'stop': stop(); break;
					case 'new': if (!turn) { reset(); } break;
				}
			});
			resolved.onDidDispose(() => {
				listener.dispose();
				if (view === resolved) {
					view = undefined;
				}
			});
			const css = webview.asWebviewUri(vscode.Uri.joinPath(media, 'chat.css'));
			const js = webview.asWebviewUri(vscode.Uri.joinPath(scripts, 'chat.js'));
			webview.html = `<!doctype html>
<html lang="en">
<head>
	<meta charset="utf-8">
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src ${webview.cspSource};">
	<link rel="stylesheet" href="${css}">
</head>
<body>
	<header><select id="agent" aria-label="Chat agent"><option value="codex">Codex</option><option value="claude">Claude Code</option></select><button id="new" type="button">New chat</button></header>
	<div id="setup" hidden>Allow this agent in Otrion Settings and open a trusted workspace to chat.</div>
	<button id="settings" type="button">Otrion Settings</button>
	<main id="messages" aria-label="Conversation"></main>
	<div id="status" role="status"></div>
	<form>
		<textarea id="input" rows="3" aria-label="Chat message" placeholder="Ask a question…"></textarea>
		<div class="actions"><button id="stop" type="button" hidden>Stop</button><button id="send" type="submit" disabled>Send</button></div>
	</form>
	<script src="${js}"></script>
</body>
</html>`;
		}
	}), vscode.commands.registerCommand('otrion.chat.open', () => vscode.commands.executeCommand('otrion.chat.focus')),
	{ dispose: () => client?.dispose() });
}
