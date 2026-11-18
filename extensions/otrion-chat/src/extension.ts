/* Copyright (c) Otrion contributors. Licensed under the MIT License. */

import * as vscode from 'vscode';
import { CodexAcp } from './acp';

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
	let view: vscode.WebviewView | undefined;
	let client: CodexAcp | undefined;
	let turn: Turn | undefined;
	let messages: ChatMessage[] = [];
	let status = '';

	function snapshot() {
		view?.webview.postMessage({ type: 'state', messages, status, busy: !!turn });
	}

	function reset() {
		client?.dispose();
		client = undefined;
		messages = [];
		status = '';
		snapshot();
	}

	async function send(input: unknown) {
		if (turn || typeof input !== 'string' || !input.trim()) {
			return;
		}
		const text = input.trim();
		const active: Turn = { cancelled: false, prompting: false };
		turn = active;
		messages.push({ role: 'You', text });
		status = client ? 'Waiting for Codex…' : 'Connecting to Codex…';
		snapshot();
		try {
			if (!client) {
				const folder = vscode.workspace.workspaceFolders?.[0];
				let cwd: string | undefined = folder?.uri.fsPath;
				if (folder && folder.uri.scheme !== 'file') {
					throw new Error('Open a local folder to use Codex ACP with this workspace.');
				}
				if (!cwd) {
					const empty = vscode.Uri.joinPath(context.globalStorageUri, 'empty-workspace');
					await vscode.workspace.fs.createDirectory(empty);
					cwd = empty.fsPath;
				}
				if (active.cancelled) {
					return;
				}
				const executable = vscode.workspace.getConfiguration('otrion.chat').get<string>('codexAcpPath', 'codex-acp');
				client = new CodexAcp(executable, cwd, update => {
					if (!turn?.prompting || update?.sessionUpdate !== 'agent_message_chunk' || update.content?.type !== 'text' || typeof update.content.text !== 'string') {
						return;
					}
					const chunk = update.content.text;
					if (!turn.reply) {
						turn.reply = { role: 'Codex', text: '' };
						messages.push(turn.reply);
					}
					turn.reply.text += chunk;
					view?.webview.postMessage({ type: 'chunk', index: messages.length - 1, text: chunk });
				});
				await client.initialize(cwd, context.extension.packageJSON.version);
			}
			active.prompting = true;
			status = 'Waiting for Codex…';
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

	context.subscriptions.push(vscode.window.registerWebviewViewProvider('otrion.chat', {
		resolveWebviewView(resolved) {
			view = resolved;
			const webview = resolved.webview;
			webview.options = { enableScripts: true, localResourceRoots: [media, scripts] };
			const listener = webview.onDidReceiveMessage(message => {
				switch (message?.type) {
					case 'ready': snapshot(); break;
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
	<header><button id="new" type="button">New chat</button></header>
	<main id="messages" aria-label="Conversation"></main>
	<div id="status" role="status"></div>
	<form>
		<textarea id="input" rows="3" aria-label="Message to Codex" placeholder="Ask Codex…"></textarea>
		<div class="actions"><button id="stop" type="button" hidden>Stop</button><button id="send" type="submit" disabled>Send</button></div>
	</form>
	<script src="${js}"></script>
</body>
</html>`;
		}
	}), vscode.commands.registerCommand('otrion.chat.open', () => vscode.commands.executeCommand('otrion.chat.focus')),
	{ dispose: () => client?.dispose() });
}
