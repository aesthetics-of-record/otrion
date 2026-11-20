/* Copyright (c) Otrion contributors. Licensed under the MIT License. */

import * as vscode from 'vscode';
import { randomUUID } from 'node:crypto';
import { agents, AgentStore, allowed, isAgent, type AgentId } from './agents';
import { SessionHistory } from './history';
import { registerSettings } from './settings';
import { chatHtml } from './chatHtml';
import { createSession, type SessionRecord } from './chatSession';
import { registerThemeGuide } from './themeGuide';

export function activate(context: vscode.ExtensionContext) {
	const media = vscode.Uri.joinPath(context.extensionUri, 'media');
	const scripts = vscode.Uri.joinPath(context.extensionUri, 'out', 'webview');
	const store = new AgentStore(vscode.Uri.joinPath(context.globalStorageUri, 'agents').fsPath, context.secrets);
	registerSettings(context, store);
	registerThemeGuide(context);
	const history = new SessionHistory(context, store);
	const recent = new SessionHistory(context, store);
	context.subscriptions.push(history, recent);
	const key = 'chatSessions.v1';
	const saved = context.workspaceState.get<{ records: SessionRecord[]; tabs: string[]; active: string }>(key);
	const records = new Map((saved?.records ?? []).map(record => [record.id, record]));
	const tabs = new Map<string, ReturnType<typeof createSession>>();
	const editors = new Map<string, vscode.WebviewPanel>();
	const drafts = new Map<string, unknown[]>();
	const sideIds = () => [...tabs.keys()].filter(id => !editors.has(id));
	const isSaved = (id: string) => !drafts.get(id)?.length && !tabs.get(id)?.busy;
	let active = '';
	let view: vscode.WebviewView | undefined;
	let header = '';
	let pendingMenu: { menu: 'new' | 'history'; home: boolean } | undefined;
	let ready = false;
	let restoreDrafts = true;

	function empty() {
		active = '';
		save();
		void view?.webview.postMessage({ type: 'empty' });
	}

	function presentMenu() {
		if (!ready || !view || !pendingMenu) { return; }
		const { menu, home } = pendingMenu;
		pendingMenu = undefined;
		const items = menu === 'new' ? (Object.keys(agents) as AgentId[]).map(id => ({ id, label: agents[id].name })) : [];
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
	function save() {
		void context.workspaceState.update(key, { records: [...records.values()], tabs: sideIds(), active });
		for (const [id, panel] of editors) {
			const name = title(records.get(id)!);
			if (panel.title !== name) { panel.title = name; }
		}
		const strip = sideIds().map(id => ({ id, title: title(records.get(id)!), agent: agents[records.get(id)!.agent].name, active: id === active, saved: isSaved(id) }));
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
			else if (active === record.id || ('type' in message && message.type === 'restoreDraft')) { void view?.webview.postMessage(message); }
		}, save);
		tabs.set(record.id, controller);
	}
	function open(id: string) {
		const record = records.get(id);
		if (!record) { return; }
		const panel = editors.get(id);
		if (panel) { panel.reveal(); return; }
		if (!tabs.has(id)) { mount(record); }
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
						if (record && initial[id]?.length && !tabs.has(id)) {
							drafts.set(id, initial[id]);
							mount(record);
						}
					}
				}
				if (tab) { tab.snapshot(); } else { empty(); }
				presentMenu();
				return;
			}
			if (!editorId && message?.type === 'endHistory') { history.dispose(); return; }
			if (message?.tabId !== current) { return; }
			if (!editorId && message.type === 'newSession' && isAgent(message.id)) { add(message.id); return; }
			if (!editorId && message.type === 'chooseAgent') { void requestMenu('new', !active); return; }
			if (!editorId && message.type === 'listHistory') {
				const source = message.home && !active ? recent : history;
				void source.refresh(status => {
					const items = [...source.entries.entries()]
						.sort(([, a], [, b]) => (Date.parse(b.updatedAt ?? '') || 0) - (Date.parse(a.updatedAt ?? '') || 0))
						.map(([id, info]) => ({ id, label: info.title || info.sessionId, detail: agents[info.agent].name, cwd: info.cwd }));
					void webview.postMessage({ type: 'historyPage', request: message.request, home: source === recent, items: source === recent ? items.slice(0, 5) : items, status });
				});
				return;
			}
			if (!editorId && message.type === 'openHistory') { openHistory(message.id, message.home ? recent : history); history.dispose(); return; }
			if (!tab) { return; }
			switch (message?.type) {
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
					if (typeof message.text === 'string') { void vscode.env.clipboard.writeText(message.text); }
					break;
				case 'settings': void vscode.commands.executeCommand('otrion.settings.open'); break;
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
		for (const [id, session] of tabs) {
			if (records.get(id)?.agent === agent) { session.invalidateAuth(); }
		}
	}));
	context.subscriptions.push(vscode.commands.registerCommand('otrion.chat.new', () => requestMenu('new')),
	vscode.commands.registerCommand('otrion.chat.history', () => requestMenu('history')),
	vscode.commands.registerCommand('otrion.chat.activateTab', open),
	vscode.commands.registerCommand('otrion.chat.closeTab', close),
	vscode.workspace.onDidGrantWorkspaceTrust(() => {
		for (const id of editors.keys()) { void tabs.get(id)?.configure(); }
		if (active) { void tabs.get(active)?.configure(); } else { empty(); }
	}), vscode.workspace.onDidChangeConfiguration(e => {
		if (!e.affectsConfiguration('otrion.chat')) { return; }
		history.dispose();
		void view?.webview.postMessage({ type: 'dismissHistory' });
		for (const [id, tab] of tabs) {
			if (!allowed(records.get(id)!.agent)) { tab.suspend(); }
			if (editors.has(id)) {
				if (allowed(records.get(id)!.agent) && e.affectsConfiguration('otrion.chat.' + records.get(id)!.agent + 'Allowed')) { void tab.configure(); }
				else { tab.snapshot(); }
			}
		}
		const record = records.get(active);
		if (record && allowed(record.agent) && e.affectsConfiguration('otrion.chat.' + record.agent + 'Allowed')) {
			void tabs.get(active)?.configure();
		} else {
			if (active) { tabs.get(active)?.snapshot(); } else { empty(); }
		}
	}), vscode.window.registerCustomEditorProvider('otrion.chat.session', {
		openCustomDocument(uri) {
			if (uri.scheme !== 'otrion-session' || !records.has(uri.path.slice(1))) { throw new Error('Chat session unavailable in this workspace.'); }
			return { uri, dispose() {} };
		},
		resolveCustomEditor(document, panel) {
			const id = document.uri.path.slice(1);
			const record = records.get(id)!;
			if (!tabs.has(id)) { mount(record); }
			editors.set(id, panel);
			panel.title = title(record);
			panel.iconPath = vscode.Uri.joinPath(media, 'orbit.svg');
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
			resolved.onDidDispose(() => {
				listener.dispose();
				if (view === resolved) {
					history.dispose();
					recent.dispose();
					view = undefined;
				}
			});
		}
	}), vscode.commands.registerCommand('otrion.chat.open', () => vscode.commands.executeCommand('otrion.chat.focus')),
	{ dispose: () => { for (const tab of tabs.values()) { tab.dispose(); } } });
}
