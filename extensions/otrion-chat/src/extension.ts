/* Copyright (c) Otrion contributors. Licensed under the MIT License. */

import * as vscode from 'vscode';
import { randomUUID } from 'node:crypto';
import { agents, agentLocation, AgentStore, allowed, isAgent, type AgentId } from './agents';
import { agentIds } from './agentCatalog';
import { SessionHistory } from './history';
import { registerSettings } from './settings';
import { chatHtml } from './chatHtml';
import { createSession, type SessionRecord } from './chatSession';
import { registerThemeGuide } from './themeGuide';

export function activate(context: vscode.ExtensionContext) {
	const media = vscode.Uri.joinPath(context.extensionUri, 'media');
	const scripts = vscode.Uri.joinPath(context.extensionUri, 'out', 'webview');
	const store = new AgentStore(vscode.Uri.joinPath(context.globalStorageUri, 'agents').fsPath, context.secrets);
	registerThemeGuide(context);
	const history = new SessionHistory(context, store);
	const recent = new SessionHistory(context, store);
	const sidebar = new SessionHistory(context, store);
	let enabledAgents = new Set(agentIds.filter(allowed));
	context.subscriptions.push(history, recent, sidebar);
	const key = 'chatSessions.v1';
	const saved = context.workspaceState.get<{ records: SessionRecord[]; tabs: string[]; active: string }>(key);
	const records = new Map((saved?.records ?? []).map(record => [record.id, record]));
	const tabs = new Map<string, ReturnType<typeof createSession>>();
	const editors = new Map<string, vscode.WebviewPanel>();
	const drafts = new Map<string, unknown[]>();
	const sideIds = () => [...tabs.keys()].filter(id => !editors.has(id));
	const isSaved = (id: string) => !drafts.get(id)?.length && !records.get(id)?.queue?.length && !tabs.get(id)?.busy;
	let active = '';
	let setupTab: string | undefined;
	registerSettings(context, store, agent => {
		if (!active) { void refreshHome(); }
		if (setupTab && records.get(setupTab)?.agent === agent) { tabs.get(setupTab)?.retrySetup(); }
	});
	let view: vscode.WebviewView | undefined;
	let header = '';
	let pendingMenu: { menu: 'new' | 'history'; home: boolean } | undefined;
	let ready = false;
	let restoreDrafts = true;

	const tabLogos = new Map<AgentId, string>();
	void Promise.all(agentIds.map(async id => {
		const bytes = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(media, id + '.svg'));
		tabLogos.set(id, Buffer.from(bytes).toString('base64'));
	})).then(() => { if (tabs.size) { save(); } }, error => console.error('Could not load session icons', error));

	let homeRevision = 0;
	let publishSidebar: (() => void) | undefined;

	async function agentChoices() {
		const adapters = await Promise.all(agentIds.map(async id => ({
			id, installed: !!await store.launch(id), enabled: allowed(id)
		})));
		return {
			available: adapters.filter(adapter => adapter.installed && adapter.enabled),
			installed: adapters.some(adapter => adapter.installed)
		};
	}

	async function refreshHome() {
		if (!ready || active || !view) { return; }
		const current = view;
		const revision = ++homeRevision;
		const { available, installed } = await agentChoices();
		if (current !== view || active || revision !== homeRevision) { return; }
		await current.webview.postMessage({
			type: 'empty', needsSetup: !available.length, installed, location: agentLocation()
		});
	}

	function empty() {
		active = '';
		save();
		return refreshHome();
	}

	async function presentMenu() {
		if (!ready || !view || !pendingMenu) { return; }
		const request = pendingMenu;
		const current = view;
		const { menu, home } = request;
		const items = menu === 'new' ? (await agentChoices()).available.map(({ id }) => ({ id, label: agents[id].name })) : [];
		if (pendingMenu !== request || view !== current) { return; }
		pendingMenu = undefined;
		if (menu === 'new' && !items.length) {
			await vscode.commands.executeCommand('otrion.settings.open', 'agents');
			return;
		}
		void view.webview.postMessage({ type: 'sessionMenu', menu, items, home });
	}

	async function requestMenu(menu: 'new' | 'history', home = false) {
		pendingMenu = { menu, home };
		if (!view?.visible) { await vscode.commands.executeCommand('otrion.chat.focus'); }
		presentMenu();
	}

	function title(record: SessionRecord) {
		return record.title || record.messages.find(m => m.role === 'You')?.text.split(/\r?\n/)[0].slice(0, 80) || agents[record.agent].name + ' Session';
	}
	function historyItems(source: SessionHistory) {
		const known = new Map([...records.values()].filter(record => record.remoteId).map(record => [record.agent + '/' + record.remoteId, record]));
		const items = [...source.entries].filter(([, info]) => enabledAgents.has(info.agent)).map(([id, info]) => ({
			id, label: info.title || info.sessionId, agent: info.agent, detail: agents[info.agent].name,
			cwd: info.cwd, updatedAt: known.get(id)?.pendingFirstPrompt ? undefined : known.get(id)?.updatedAt ?? info.updatedAt, active: known.get(id)?.id === active
		}));
		if (vscode.workspace.isTrusted) {
			for (const record of records.values()) {
				if (!enabledAgents.has(record.agent) || (!tabs.has(record.id) && !record.messages.length)
					|| (record.remoteId && source.entries.has(record.agent + '/' + record.remoteId))) { continue; }
				items.push({ id: record.id, label: title(record), agent: record.agent, detail: agents[record.agent].name,
					cwd: record.cwd ?? '', updatedAt: record.updatedAt, active: record.id === active });
			}
		}
		items.sort((a, b) => (Date.parse(b.updatedAt ?? '') || 0) - (Date.parse(a.updatedAt ?? '') || 0) || a.id.localeCompare(b.id));
		return items;
	}

	function save() {
		publishSidebar?.();
		void context.workspaceState.update(key, { records: [...records.values()], tabs: sideIds(), active });
		for (const [id, panel] of editors) {
			const name = title(records.get(id)!);
			if (panel.title !== name) { panel.title = name; }
		}
		const strip = sideIds().map(id => ({ id, title: title(records.get(id)!), agent: agents[records.get(id)!.agent].name, logo: tabLogos.get(records.get(id)!.agent), active: id === active, saved: isSaved(id) }));
		const serialized = JSON.stringify(strip);
		if (serialized !== header) {
			header = serialized;
			void vscode.commands.executeCommand('setContext', 'otrion.chat.tabs', strip);
		}
	}
	function mount(record: SessionRecord) {
		records.set(record.id, record);
		const controller = createSession(context, store, record, message => {
			if (tabs.get(record.id) !== controller) { return; }
			const panel = editors.get(record.id);
			if (panel) { void panel.webview.postMessage(message); }
			else if (active === record.id || message.type === 'restoreDraft') { void view?.webview.postMessage(message); }
		}, save);
		tabs.set(record.id, controller);
	}
	function open(id: string) {
		const record = records.get(id);
		if (!record || !isAgent(record.agent)) { return; }
		const panel = editors.get(id);
		if (panel) { panel.reveal(); return; }
		if (!tabs.has(id)) { mount(record); }
		if (record.remoteId && !record.updatedAt) {
			const key = record.agent + '/' + record.remoteId;
			record.updatedAt = (sidebar.entries.get(key) ?? history.entries.get(key) ?? recent.entries.get(key))?.updatedAt;
		}
		recent.dispose();
		active = id;
		tabs.get(id)!.select();
	}
	function openHistory(key: string, source: SessionHistory) {
		const info = source.entries.get(key);
		if (!info || !allowed(info.agent) || !vscode.workspace.isTrusted) { return; }
		let record = [...records.values()].find(r => r.agent === info.agent && r.remoteId === info.sessionId);
		if (!record) {
			record = { id: randomUUID(), agent: info.agent, remoteId: info.sessionId, messages: [] };
			mount(record);
		}
		record.updatedAt ??= info.updatedAt;
		record.pendingFirstPrompt = false;
		record.cwd = info.cwd;
		record.title = info.title;
		open(record.id);
	}

	function add(agent: AgentId) {
		const record = { id: randomUUID(), agent, pendingFirstPrompt: true, messages: [] };
		mount(record);
		open(record.id);
	}
	function disposeSession(id: string, keepRecord = false) {
		tabs.get(id)?.dispose();
		tabs.delete(id);
		drafts.delete(id);
		if (!keepRecord && !records.get(id)?.messages.length) { records.delete(id); }
	}
	function showRemaining() {
		const next = sideIds().at(-1);
		if (next) { open(next); } else { empty(); }
	}
	function close(id: string, mode = 'one') {
		const ids = sideIds();
		const index = ids.indexOf(id);
		if (index < 0) { return; }
		const targets = mode === 'others' ? ids.filter(other => other !== id) : mode === 'right' ? ids.slice(index + 1)
			: mode === 'saved' ? ids.filter(isSaved) : mode === 'all' ? ids : [id];
		for (const target of targets) {
			disposeSession(target);
			void view?.webview.postMessage({ type: 'forgetDraft', tabId: target });
		}
		if (targets.includes(active)) { showRemaining(); } else { save(); }
	}
	function bindWebview(webview: vscode.Webview, editorId?: string) {
		webview.options = { enableScripts: true, localResourceRoots: [media, scripts] };
		const listener = webview.onDidReceiveMessage(message => {
			const current = editorId ?? active;
			const tab = tabs.get(current);
			if (message?.type === 'ready') {
				const initial = message.drafts ?? {};
				if (editorId) {
					const movedDraft = drafts.get(editorId);
					if (!movedDraft && Array.isArray(initial[editorId])) { drafts.set(editorId, initial[editorId]); }
					tab?.select();
					if (movedDraft?.length) { void webview.postMessage({ type: 'restoreDraft', tabId: editorId, parts: movedDraft }); }
					return;
				}
				ready = true;
				if (restoreDrafts) {
					restoreDrafts = false;
					for (const id of saved?.tabs ?? []) {
						const record = records.get(id);
						if (record && isAgent(record.agent) && initial[id]?.length && !tabs.has(id)) {
							drafts.set(id, initial[id]);
							mount(record);
						}
					}
				}
				if (tab) { tab.snapshot(); void presentMenu(); } else { void empty().then(presentMenu); }
				return;
			}
			if (!editorId && message?.type === 'sessionsSidebarVisible') {
				void vscode.commands.executeCommand('setContext', 'otrion.chat.sessionsSidebarOpen', message.open === true);
				return;
			}
			if (!editorId && message?.type === 'endHistory') {
				if (message.sidebar) { publishSidebar = undefined; sidebar.cancel(); } else { history.dispose(); }
				return;
			}
			if (message?.tabId !== current && !(message?.type === 'listHistory' && message.sidebar && !editorId)) { return; }
			if (!editorId && message.type === 'newSession' && isAgent(message.id)) { add(message.id); return; }
			if (!editorId && message.type === 'chooseAgent') { void requestMenu('new', !active); return; }
			if (!editorId && message.type === 'listHistory') {
				const source = message.sidebar ? sidebar : message.home && !active ? recent : history;
				let previous = '';
				void source.refresh((status, settingsTarget) => {
					const publish = () => {
						const items = historyItems(source);
						const result = source === recent ? items.slice(0, 5) : items;
						const serialized = JSON.stringify(result);
						if (serialized === previous) { return; }
						previous = serialized;
						void webview.postMessage({ type: 'historyPage', request: message.request, home: source === recent, sidebar: source === sidebar, items: result, status, settingsTarget });
					};
					if (source === sidebar) { publishSidebar = publish; }
					publish();
				});
				return;
			}
			if (!editorId && message.type === 'openHistory') {
				const record = records.get(message.id);
				if (record && allowed(record.agent) && vscode.workspace.isTrusted) { open(record.id); }
				else { openHistory(message.id, message.sidebar ? sidebar : message.home ? recent : history); }
				history.dispose();
				return;
			}
			if (message.type === 'settings') {
				const target = isAgent(message.target) || message.target === 'agents' ? message.target : records.get(current)?.agent ?? 'agents';
				setupTab = tab && target === records.get(current)?.agent ? current : undefined;
				void vscode.commands.executeCommand('otrion.settings.open', target);
				return;
			}
			if (!tab) { return; }
			switch (message?.type) {
				case 'previewImages':
					void vscode.commands.executeCommand('workbench.action.chat.openImageInCarousel', {
						attachments: message.images, startIndex: message.startIndex
					}).then(undefined, () => vscode.window.showErrorMessage(vscode.l10n.t('Could not open the image preview.')));
					break;
				case 'fileIcon':
					if (typeof message.uri === 'string' && message.uri.startsWith('file:') && Number.isSafeInteger(message.request)) {
						void vscode.commands.executeCommand<string>('_otrion.chat.fileIcon', vscode.Uri.parse(message.uri), message.folder === true).then(
							src => webview.postMessage({ type: 'fileIcon', request: message.request, src }),
							() => webview.postMessage({ type: 'fileIcon', request: message.request })
						);
					}
					break;
				case 'draft':
					if (Array.isArray(message.parts)) {
						const savedBefore = isSaved(current);
						drafts.set(current, message.parts);
						if (savedBefore !== isSaved(current)) { save(); }
					}
					break;
				case 'trust': void vscode.commands.executeCommand('workbench.trust.manage'); break;
				case 'openChatLink':
					if (typeof message.href === 'string') { void tab.openLink(message.href, false); }
					break;
				case 'openChatFile':
					if (typeof message.path === 'string') { void tab.openLink(message.path, true, message.line); }
					break;
				case 'copyCode':
					if (typeof message.text === 'string') {
						void vscode.env.clipboard.writeText(message.text).then(
							() => webview.postMessage({ type: 'copied', request: message.request }),
							() => vscode.window.showErrorMessage(vscode.l10n.t('Could not copy to the clipboard.'))
						);
					}
					break;
				case 'options': void tab.configure(); break;
				case 'setOption': void tab.configure({ id: message.id, value: message.value }); break;
				case 'findContext':
					if (typeof message.query === 'string') { void tab.findContext(message.query, message.request); }
					break;
				case 'addResources':
					if (Array.isArray(message.uris)) {
						const files: vscode.Uri[] = [];
						const authority = vscode.env.remoteAuthority;
						for (const value of message.uris) {
							if (typeof value !== 'string') { continue; }
							const uri = vscode.Uri.parse(value);
							if (authority ? uri.scheme === 'vscode-remote' && uri.authority === authority : uri.scheme === 'file') {
								files.push(authority ? uri.with({ scheme: 'file', authority: '' }) : uri);
							}
						}
						void tab.describeResources(files).then(parts => webview.postMessage({ type: 'insertResources', tabId: message.tabId, request: message.request, parts }));
					}
					break;
				case 'attach':
					void tab.attach(message.folder === true).then(parts => webview.postMessage({ type: 'insertResources', tabId: message.tabId, request: message.request, parts: parts ?? [] }));
					break;
				case 'sendQueued': void tab.sendQueued(message.id); break;
				case 'discardQueued': tab.discardQueued(message.id); break;
				case 'send': void tab.send(message.parts); break;
				case 'stop': tab.stop(); break;
			}
		});
		webview.html = chatHtml(webview, media, scripts);
		return listener;
	}
	context.subscriptions.push(vscode.commands.registerCommand('_otrion.chat.refreshIcons', () => {
		void view?.webview.postMessage({ type: 'refreshIcons' });
		for (const panel of editors.values()) { void panel.webview.postMessage({ type: 'refreshIcons' }); }
	}));
	context.subscriptions.push(store.onAuthChange(agent => {
		history.dispose();
		recent.dispose();
		publishSidebar = undefined;
		sidebar.dispose();
		void view?.webview.postMessage({ type: 'dismissHistory' });
		for (const [id, session] of tabs) {
			if (records.get(id)?.agent === agent) { session.invalidateAuth(); }
		}
	}));
	context.subscriptions.push(vscode.commands.registerCommand('otrion.chat.new', () => requestMenu('new')),
	vscode.commands.registerCommand('otrion.chat.toggleSessions', () => view?.webview.postMessage({ type: 'toggleSessions' })),
	vscode.commands.registerCommand('otrion.chat.history', () => requestMenu('history')),
	vscode.commands.registerCommand('otrion.chat.activateTab', open),
	vscode.commands.registerCommand('otrion.chat.closeTab', close),
	vscode.workspace.onDidGrantWorkspaceTrust(() => {
		for (const id of editors.keys()) { void tabs.get(id)?.configure(); }
		if (active) { void tabs.get(active)?.configure(); } else { empty(); }
	}), vscode.workspace.onDidChangeConfiguration(e => {
		if (!e.affectsConfiguration('otrion.chat')) { return; }
		const previousEnabled = enabledAgents;
		enabledAgents = new Set(agentIds.filter(allowed));
		history.dispose();
		void view?.webview.postMessage({ type: 'dismissHistory' });
		for (const [id, tab] of tabs) {
			const agent = records.get(id)!.agent;
			if (!enabledAgents.has(agent)) { tab.suspend(); }
			if (editors.has(id)) {
				if (enabledAgents.has(agent) && !previousEnabled.has(agent)) { void tab.configure(); }
				else { tab.snapshot(); }
			}
		}
		const record = records.get(active);
		if (record && enabledAgents.has(record.agent) && !previousEnabled.has(record.agent)) {
			void tabs.get(active)?.configure();
		} else {
			if (active) { tabs.get(active)?.snapshot(); } else { empty(); }
		}
	}), vscode.window.registerCustomEditorProvider('otrion.chat.session', {
		openCustomDocument(uri) {
			if (uri.scheme !== 'otrion-session' || !isAgent(records.get(uri.path.slice(1))?.agent)) { throw new Error('Chat session unavailable in this workspace.'); }
			return { uri, dispose() {} };
		},
		resolveCustomEditor(document, panel) {
			const id = document.uri.path.slice(1);
			const record = records.get(id)!;
			if (!tabs.has(id)) { mount(record); }
			editors.set(id, panel);
			panel.title = title(record);
			panel.iconPath = vscode.Uri.joinPath(media, record.agent + '.svg');
			const listener = bindWebview(panel.webview, id);
			panel.onDidDispose(() => {
				listener.dispose();
				if (editors.get(id) !== panel) { return; }
				editors.delete(id);
				disposeSession(id, true);
				save();
			});
			void view?.webview.postMessage({ type: 'forgetDraft', tabId: id });
			if (active === id) { showRemaining(); } else { save(); }
		}
	}, { webviewOptions: { retainContextWhenHidden: true }, supportsMultipleEditorsPerDocument: false }),
	vscode.window.registerWebviewViewProvider('otrion.chat', {
		resolveWebviewView(resolved) {
			view = resolved;
			ready = false;
			const listener = bindWebview(resolved.webview);
			const visibility = resolved.onDidChangeVisibility(() => { if (resolved.visible) { void refreshHome(); } });
			resolved.onDidDispose(() => {
				visibility.dispose();
				listener.dispose();
				if (view === resolved) {
					void vscode.commands.executeCommand('setContext', 'otrion.chat.sessionsSidebarOpen', false);
					history.dispose();
					recent.dispose();
					sidebar.dispose();
					publishSidebar = undefined;
					view = undefined;
				}
			});
		}
	}), vscode.commands.registerCommand('otrion.chat.open', () => vscode.commands.executeCommand('otrion.chat.focus')),
	{ dispose: () => { for (const tab of tabs.values()) { tab.dispose(); } } });
}
