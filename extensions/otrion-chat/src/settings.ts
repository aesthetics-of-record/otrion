/* Copyright (c) Otrion contributors. Licensed under the MIT License. */

import * as vscode from 'vscode';
import { agents, AgentStore, allowed, isAgent, type AgentId } from './agents';

export function registerSettings(context: vscode.ExtensionContext, store: AgentStore) {
	let panel: vscode.WebviewPanel | undefined;
	const installing = new Set<AgentId>();
	const errors = new Map<AgentId, string>();
	let revision = 0;

	async function refresh() {
		const current = panel;
		if (!current) { return; }
		const sequence = ++revision;
		const rows = await Promise.all((Object.keys(agents) as AgentId[]).map(async id => {
			const [launch, installed] = await Promise.all([store.launch(id), store.isInstalled(id)]);
			const setting = vscode.workspace.getConfiguration('otrion.chat').get<string>(id + 'AcpPath');
			const missing = setting && setting !== agents[id].binary ? 'Check otrion.chat.' + id + 'AcpPath in Editor Settings.' : installed ? 'Install Node.js and restart Otrion.' : 'Not installed';
			return { id, installed, source: launch?.source, availability: launch?.source ?? missing, allowed: allowed(id), installing: installing.has(id), error: errors.get(id) };
		}));
		if (panel === current && sequence === revision) {
			await current.webview.postMessage({ rows });
		}
	}

	async function handle(action: unknown, id: AgentId, value: unknown) {
		errors.delete(id);
		try {
			if (action === 'install') {
				if (installing.has(id)) { return; }
				installing.add(id);
				void refresh();
				try { await store.install(id); } finally { installing.delete(id); }
			} else if (action === 'allow' && typeof value === 'boolean') {
				await vscode.workspace.getConfiguration('otrion.chat').update(id + 'Allowed', value, vscode.ConfigurationTarget.Global);
			} else if (action === 'login') {
				await store.signIn(id);
			}
		} catch (error) {
			errors.set(id, error.message);
		}
		await refresh();
	}

	context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(e => {
		if (e.affectsConfiguration('otrion.chat')) { void refresh(); }
	}), vscode.commands.registerCommand('otrion.settings.open', () => {
		if (panel) { panel.reveal(); void refresh(); return; }
		const media = vscode.Uri.joinPath(context.extensionUri, 'media');
		const scripts = vscode.Uri.joinPath(context.extensionUri, 'out', 'webview');
		panel = vscode.window.createWebviewPanel('otrion.settings', 'Otrion Settings', vscode.ViewColumn.Active, {
			enableScripts: true, localResourceRoots: [media, scripts],
		});
		const web = panel.webview;
		const listener = web.onDidReceiveMessage(message => {
			if (message?.action === 'ready') { void refresh(); }
			else if (isAgent(message?.id)) { void handle(message.action, message.id, message.value); }
		});
		panel.onDidDispose(() => { listener.dispose(); panel = undefined; });
		const cards = (Object.entries(agents)).map(([id, agent]) => `
			<section id="${id}" aria-labelledby="${id}-name">
				<h2 id="${id}-name">${agent.name}</h2>
				<p class="availability" role="status">Checking installation…</p>
				<label><input type="checkbox" disabled> Allow ${agent.name} in chat</label>
				<div class="controls"><button data-action="install" disabled>Install</button><button data-action="login" disabled>Sign In</button></div>
				<p class="error" role="alert"></p>
			</section>`).join('');
		web.html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
			<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${web.cspSource}; script-src ${web.cspSource};">
			<link rel="stylesheet" href="${web.asWebviewUri(vscode.Uri.joinPath(media, 'settings.css'))}">
			</head><body><main><h1>Otrion Settings</h1><h2 class="group">Chat agents</h2>
			<p>Install an ACP adapter or use an existing installation. Allow an agent to send chat requests with your account.</p>
			${cards}</main><script src="${web.asWebviewUri(vscode.Uri.joinPath(scripts, 'settings.js'))}"></script></body></html>`;
	}), { dispose: () => panel?.dispose() });
}
