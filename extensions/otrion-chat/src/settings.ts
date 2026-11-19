/* Copyright (c) Otrion contributors. Licensed under the MIT License. */

import * as vscode from 'vscode';
import { agents, AgentStore, allowed, isAgent, type AgentId } from './agents';

export function registerSettings(context: vscode.ExtensionContext, store: AgentStore) {
	let panel: vscode.WebviewPanel | undefined;
	const installing = new Set<AgentId>();
	const changingAuth = new Set<AgentId>();
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
			const choice = await store.authChoice(id);
			const auth = choice.mode === 'cli' && launch && allowed(id) ? await store.authStatus(id, launch) : undefined;
			return { id, auth, ...choice, installed, source: launch?.source, availability: launch?.source ?? missing, allowed: allowed(id), installing: installing.has(id), error: errors.get(id) };
		}));
		if (panel === current && sequence === revision) {
			await current.webview.postMessage({ rows });
		}
	}

	async function handle(action: unknown, id: AgentId, value: unknown) {
		errors.delete(id);
		try {
			if (action === 'cli' || action === 'key' || action === 'replaceKey' || action === 'removeKey') {
				if (changingAuth.has(id)) { return; }
				changingAuth.add(id);
				try { await store.changeAuth(id, action); } finally { changingAuth.delete(id); }
			} else if (action === 'install') {
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

	context.subscriptions.push(store.onAuthChange(() => { void refresh(); }), vscode.window.onDidCloseTerminal(t => {
		if (panel?.visible && Object.values(agents).some(agent => t.name === agent.name + ' Sign In')) { void refresh(); }
	}), vscode.window.onDidChangeWindowState(state => {
		if (state.focused && panel?.visible) { void refresh(); }
	}), vscode.workspace.onDidChangeConfiguration(e => {
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
			if (message?.action === 'ready') {
				void web.postMessage({ gallery: vscode.workspace.getConfiguration().get('otrion.marketplace') });
				void refresh();
			} else if (message?.action === 'saveGallery' || message?.action === 'resetGallery') {
				void (async () => {
					try {
						const config = vscode.workspace.getConfiguration();
						const normalize = (value: unknown) => {
							if (typeof value !== 'string' || !URL.canParse(value)) { throw new Error('Enter a valid URL.'); }
							const url = new URL(value);
							if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
								throw new Error('Use an HTTP or HTTPS base URL without credentials, query, or fragment.');
							}
							return url.href.replace(/\/+$/, '');
						};
						const value = message.action === 'resetGallery' ? undefined : {
							serviceUrl: normalize(message.serviceUrl), itemUrl: normalize(message.itemUrl)
						};
						await config.update('otrion.marketplace', value, vscode.ConfigurationTarget.Global);
						await web.postMessage({ gallery: vscode.workspace.getConfiguration().get('otrion.marketplace'), notice: 'Saved. Reload the window to apply.', saved: true });
					} catch (error) { await web.postMessage({ notice: error.message }); }
				})();
			} else if (message?.action === 'reload') { void vscode.commands.executeCommand('workbench.action.reloadWindow'); }
			else if (isAgent(message?.id)) { void handle(message.action, message.id, message.value); }
		});
		panel.onDidChangeViewState(e => { if (e.webviewPanel.active) { void refresh(); } });
		panel.onDidDispose(() => { listener.dispose(); panel = undefined; });
		const cards = Object.entries(agents).map(([id, agent]) => `
			<section id="${id}" aria-labelledby="${id}-name">
				<span class="agent-icon" aria-hidden="true"></span>
				<div class="agent-info">
					<h3 id="${id}-name">${agent.name}</h3><span class="auth" role="status"></span>
					<p>${id === 'codex' ? 'OpenAI coding agent' : 'Anthropic coding agent'}</p>
				</div>
				<button class="primary" disabled>Checking…</button>
				<span class="enabled" hidden>Enabled</span>
				<button class="more" popovertarget="${id}-menu" aria-label="More actions for ${agent.name}" title="More actions" disabled>···</button>
				<div class="menu" id="${id}-menu" popover>
					<button data-action="install">Install Otrion-managed adapter</button>
					<button data-action="disable">Disable</button>
				</div>
				<div class="auth-options">
					<div class="auth-method" role="group" aria-label="Authentication for ${agent.name}">
						<button data-action="cli" disabled>CLI account</button><button data-action="key" disabled>API key</button>
					</div>
					<button class="auth-action" data-action="login" hidden>Sign in</button>
					<button class="auth-action" data-action="replaceKey" hidden>Replace key</button>
					<button class="auth-action" data-action="removeKey" hidden>Remove key</button>
					<p class="auth-note"></p>
				</div>
				<p class="error" role="alert"></p>
			</section>`).join('');
		web.html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
			<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${web.cspSource}; style-src ${web.cspSource}; script-src ${web.cspSource};">
			<link rel="stylesheet" href="${web.asWebviewUri(vscode.Uri.joinPath(media, 'settings.css'))}">
			</head><body><main><h1>Otrion Settings</h1><h2>Extensions</h2>
			<form id="gallery" class="catalog"><label>Marketplace service URL<input type="url" id="serviceUrl" required></label>
			<p>Used to search for and install extensions.</p>
			<label>Marketplace item URL<input type="url" id="itemUrl" required></label><p>Used to open extension pages.</p>
			<div class="gallery-actions"><button class="primary" type="submit">Save</button><button type="button" id="reset">Restore Open VSX defaults</button>
			<button type="button" id="reload" hidden>Reload Window</button></div><p id="gallery-status" role="status"></p></form>
			<h2>Agents</h2>
			<div class="catalog"><input id="search" type="search" placeholder="Search agents…" aria-label="Search agents">
			<div class="agents">${cards}</div><p id="empty" hidden>No matching agents.</p></div></main><script src="${web.asWebviewUri(vscode.Uri.joinPath(scripts, 'settings.js'))}"></script></body></html>`;
	}), { dispose: () => panel?.dispose() });
}
