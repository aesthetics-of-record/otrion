/* Copyright (c) Otrion contributors. Licensed under the MIT License. */

import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import * as vscode from 'vscode';
import { agents, agentLocation, AgentStore, allowed, configuredPath, installIssue, isAgent, setAllowed, supportsKey, type AgentId } from './agents';
import { agentIds } from './agentCatalog';

export function registerSettings(context: vscode.ExtensionContext, store: AgentStore, onSetup: (id: AgentId) => void) {
	const remote = !!vscode.env.remoteAuthority;
	let panel: vscode.WebviewPanel | undefined;
	let currentPage: 'general' | 'agents' = 'general';
	let focusAgent: AgentId | 'agents' | undefined;
	const installing = new Set<AgentId>();
	const changingAuth = new Set<AgentId>();
	const loginTerminals = new Map<AgentId, vscode.Terminal>();
	let loginRefresh: ReturnType<typeof setTimeout> | undefined;
	const errors = new Map<AgentId, string>();
	let revision = 0;
	let enableChange = Promise.resolve();

	async function refresh(ids = agentIds) {
		clearTimeout(loginRefresh);
		const current = panel;
		if (!current || currentPage !== 'agents') { return; }
		const sequence = ++revision;
		const rows = await Promise.all(ids.map(async id => {
			const [launch, installed] = await Promise.all([store.launch(id), store.isInstalled(id)]);
			const setting = configuredPath(id);
			const missingRuntime = 'Install Node.js and restart Otrion.';
			const missing = setting && setting !== agents[id].binary ? 'Check the configured executable: ' + setting : installed ? missingRuntime : 'Not installed';
			const choice = await store.authChoice(id);
			const auth = choice.mode === 'cli' && launch && allowed(id) ? await store.authStatus(id, launch) : undefined;
			const authenticated = auth === 'Signed in' || auth === 'Provider configured' || auth === 'CLI credentials configured' || auth === 'CLI API key';
			return { id, auth, authenticated, ...choice, installed, source: launch?.source, availability: launch?.source ?? missing, installIssue: installIssue(id), allowed: allowed(id), installing: installing.has(id), signingIn: changingAuth.has(id) || loginTerminals.has(id), error: errors.get(id) };
		}));
		if (panel === current && currentPage === 'agents' && sequence === revision) {
			for (const row of rows) {
				if (!loginTerminals.has(row.id)) { continue; }
				if (row.authenticated) {
					loginTerminals.delete(row.id);
					onSetup(row.id);
				} else if (!row.allowed || row.mode !== 'cli') {
					loginTerminals.delete(row.id);
				}
			}
			if (loginTerminals.size && current.visible) {
				loginRefresh = setTimeout(() => {
					if (current.visible) { void refresh([...loginTerminals.keys()]); }
				}, 4000);
			}
			await current.webview.postMessage({ rows, remote, location: agentLocation() });
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
				try {
					await store.install(id);
					onSetup(id);
				} finally { installing.delete(id); }
			} else if (action === 'allow' && typeof value === 'boolean') {
				const change = enableChange.then(() => setAllowed(id, value));
				enableChange = change.catch(() => {});
				await change;
			} else if (action === 'login') {
				if (changingAuth.has(id) || loginTerminals.has(id)) { return; }
				changingAuth.add(id);
				void refresh();
				try {
					const result = await store.signIn(id);
					if (result === true) { onSetup(id); }
					else if (result && !result.exitStatus) { loginTerminals.set(id, result); }
					else if (result && result.exitStatus?.code === 0) { onSetup(id); }
				} finally { changingAuth.delete(id); }
			} else if (action === 'guide') {
				await vscode.env.openExternal(vscode.Uri.parse(agents[id].website));
			}
		} catch (error) {
			errors.set(id, error.message);
		}
		await refresh();
	}

	context.subscriptions.push(store.onAuthChange(() => { void refresh(); }), vscode.window.onDidCloseTerminal(t => {
		const pending = agentIds.find(id => loginTerminals.get(id) === t);
		if (pending) {
			loginTerminals.delete(pending);
			if (t.exitStatus?.code === 0) { onSetup(pending); }
			void refresh();
			return;
		}
	}), vscode.window.onDidChangeWindowState(state => {
		if (state.focused && panel?.visible) { void refresh(); }
	}), vscode.workspace.onDidChangeConfiguration(e => {
		if (e.affectsConfiguration('otrion.chat')) { void refresh(); }
	}), vscode.commands.registerCommand('otrion.settings.open', async (agent?: unknown) => {
		focusAgent = isAgent(agent) || agent === 'agents' ? agent : undefined;
		if (focusAgent) { currentPage = 'agents'; }
		else if (!panel) { currentPage = 'general'; }
		if (panel) {
			panel.reveal();
			if (focusAgent) { void panel.webview.postMessage({ focusAgent }); }
			void refresh();
			return;
		}
		panel = vscode.window.createWebviewPanel('otrion.settings', 'Otrion Settings', vscode.ViewColumn.Active, {
			enableScripts: true, localResourceRoots: [], retainContextWhenHidden: true,
		});
		const web = panel.webview;
		const listener = web.onDidReceiveMessage(message => {
			if (message?.action === 'ready') {
				void web.postMessage({ focusAgent, gallery: vscode.workspace.getConfiguration().get('otrion.marketplace') });
				void refresh();
			} else if (message?.action === 'navigate' && (message.page === 'general' || message.page === 'agents')) {
				currentPage = message.page;
				if (currentPage === 'agents') { void refresh(); }
			} else if (message?.action === 'focusedAgent' && message.id === focusAgent) {
				focusAgent = undefined;
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
		panel.onDidDispose(() => { listener.dispose(); clearTimeout(loginRefresh); panel = undefined; });
		// Inline host-local assets so the webview also works over SSH.
		const current = panel;
		const asset = (file: string) => readFile(context.asAbsolutePath(file), 'utf8');
		const iconUrl = async (name: string) => 'url("data:image/svg+xml;base64,' + Buffer.from(await asset('media/' + name + '.svg')).toString('base64') + '")';
		const [css, script, orbit, agentIcons] = await Promise.all([
			asset('media/settings.css'), asset('out/webview/settings.js'), iconUrl('orbit'),
			Promise.all(agentIds.map(async id => '#' + id + ' .agent-icon { mask-image: ' + await iconUrl(id) + '; }')),
		]);
		if (panel !== current) { return; }
		const nonce = randomBytes(16).toString('base64');
		const cards = agentIds.map(id => {
			const agent = agents[id];
			const keySupported = supportsKey(id);
			return `
			<section id="${id}" data-provider="${agent.npm?.package ?? agent.binary}" tabindex="-1" aria-labelledby="${id}-name">
				<span class="agent-icon" aria-hidden="true"></span>
				<div class="agent-info">
					<h3 id="${id}-name">${agent.name}</h3><p class="agent-description" title="${agent.description}">${agent.description}</p><span class="auth" role="status"></span>
				</div>
				<button class="primary" disabled>Checking…</button>
				<span class="enabled" hidden>Enabled</span>
				<button class="more" popovertarget="${id}-menu" aria-label="More actions for ${agent.name}" title="More actions" disabled>•••</button>
				<div class="menu" id="${id}-menu" popover>
					<button data-action="install">Install Otrion-managed adapter</button>
					${keySupported ? '<button data-action="key">Set up API key</button>' : ''}
					<button data-action="guide">Provider setup guide</button>
					<button data-action="disable">Disable</button>
				</div>
				<div class="auth-options" hidden>
					${keySupported ? `<div class="auth-method" role="group" aria-label="Authentication for ${agent.name}">
						<button data-action="cli" title="Use the CLI configuration ${agentLocation()}" disabled>CLI account</button><button data-action="key" disabled>API key</button>
					</div>` : ''}
					<button class="auth-action" data-action="login" hidden>${id === 'goose' || id === 'pi' ? 'Configure provider' : 'Sign in'}</button>
					${keySupported ? `<button class="auth-action" data-action="replaceKey" hidden>Replace key</button>
					<button class="auth-action" data-action="removeKey" hidden>Remove key</button>
					<p class="auth-note" hidden>Provider API billing applies.</p>` : ''}
				</div>
				<p class="error" role="alert"></p>
			</section>`;
		}).join('');
		const icon = (path: string) => `<svg aria-hidden="true" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="${path}"/></svg>`;
		const navigation = [
			{ page: 'general', label: 'General', symbol: 'M2 5h7m3 0h2M2 11h2m3 0h7M9 3.5h3v3H9zM4 9.5h3v3H4z' },
			{ page: 'agents', label: 'Agents', symbol: 'M3 2.5h10a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1ZM4.5 6l2 2-2 2m4.5 0h2.5' }
		].map(({ page, label, symbol }) =>
			`<button type="button" aria-label="${label}" title="${label}" aria-controls="page-${page}" aria-current="${currentPage === page ? 'page' : 'false'}">${icon(symbol)}<span>${label}</span></button>`
		).join('');
		web.html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
			<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
			<style nonce="${nonce}">${css}
.brand-mark { mask-image: ${orbit}; }
${agentIcons.join('\n')}</style>
			</head><body>
			<nav aria-label="Otrion Settings"><div class="nav-title" title="Otrion Settings"><span class="brand-mark" aria-hidden="true"></span><span>Otrion Settings</span></div>${navigation}</nav>
			<main><div id="page-general" ${currentPage === 'general' ? '' : 'hidden'}>
			<h1>General</h1><h2>Extension marketplace</h2>
			<form id="gallery" class="catalog" inert aria-busy="true">
			<label for="serviceUrl">Gallery service URL</label><input type="url" id="serviceUrl" required>
			<label for="itemUrl">Extension page URL</label><input type="url" id="itemUrl" required>
			<div class="gallery-actions"><button class="primary" type="submit">Save</button><button type="button" id="reset">Reset to Open VSX</button>
			<button type="button" id="reload" hidden>Reload Window</button></div><p id="gallery-status" role="status"></p></form></div>
			<div id="page-agents" ${currentPage === 'agents' ? '' : 'hidden'}><h1>Agents</h1>
			${remote ? `<p class="agent-host">${vscode.l10n.t('Agents run {0}.', agentLocation())}</p>` : ''}
			<div class="catalog agent-catalog"><div class="agent-search">${icon('M11 11l3 3M12 7a5 5 0 1 1-10 0 5 5 0 1 1 10 0Z')}<input id="search" type="search" placeholder="Search agents…" aria-label="Search agents"></div>
			<div class="agents">${cards}</div><p id="empty" hidden>No matching agents.</p></div></div></main><script nonce="${nonce}">${script}</script></body></html>`;
	}), { dispose: () => { clearTimeout(loginRefresh); loginTerminals.clear(); panel?.dispose(); } });
}
