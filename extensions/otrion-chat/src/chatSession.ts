/* Copyright (c) Otrion contributors. Licensed under the MIT License. */

import { basename, isAbsolute, relative, resolve, sep } from 'node:path';
import * as vscode from 'vscode';
import { AcpClient, type PromptPart, type SessionUpdate } from './acp';
import { agents, AgentStore, allowed, type AgentId } from './agents';
import { readSessionOptions, type SessionOption } from './sessionOptions';
import { applyTranscriptUpdate, type ChatMessage } from './transcript';

interface Turn {
	cancelled: boolean;
	prompting: boolean;
	start: number;
	timer?: NodeJS.Timeout;
}

export interface SessionRecord {
	id: string;
	agent: AgentId;
	messages: ChatMessage[];
	remoteId?: string;
	pendingFirstPrompt?: boolean;
	ordinal?: number;
	cwd?: string;
	title?: string;
}

export async function workspaceDirectory(context: vscode.ExtensionContext) {
	const folder = vscode.workspace.workspaceFolders?.[0];
	if (folder) {
		if (folder.uri.scheme !== 'file') { throw new Error('Open a local folder to use agent chat with this workspace.'); }
		return folder.uri.fsPath;
	}
	const dir = vscode.Uri.joinPath(context.globalStorageUri, 'empty-workspace');
	await vscode.workspace.fs.createDirectory(dir);
	return dir.fsPath;
}

export function createSession(context: vscode.ExtensionContext, store: AgentStore, record: SessionRecord,
	emit: (message: object) => void, changed: () => void) {
	const selected = record.agent;
	record.pendingFirstPrompt ??= !!record.ordinal && !record.messages.length && !record.title;
	let client: AcpClient | undefined;
	let authRevision = 0;
	let connectedRevision = -1;
	let turn: Turn | undefined;
	const messages = record.messages;
	let disposed = false;
	let status = '';
	let connectionFailed = false;

	let options: SessionOption[] = [];
	let usage: { used: number; size: number } | undefined;
	let configuring = false;
	let commands: { name: string; description?: string }[] = [];
	const preferenceKey = 'sessionOptions.v1.' + selected;
	function rememberOptions() {
		if (!options.length) { return; }
		return context.globalState.update(preferenceKey, Object.fromEntries(options.map(option => [option.id, option.current])));
	}

	function supports(option: SessionOption, value: unknown): value is string | boolean {
		return typeof option.current === 'boolean' ? typeof value === 'boolean' : option.choices.some(choice => choice.value === value);
	}

	function metadata() {
		return { options, commands, usage, configuring, connected: !!client && !client.closed,
			workspace: record.cwd ? basename(record.cwd) : vscode.workspace.workspaceFolders?.[0]?.name };
	}

	function publishMetadata() {
		void emit({ type: 'metadata', ...metadata() });
	}

	const dirtyRows = new Set<number>();
	let flushTimer: NodeJS.Timeout | undefined;
	function clearUpdates() {
		clearTimeout(flushTimer);
		flushTimer = undefined;
		dirtyRows.clear();
	}
	function publishRow(index: number) {
		dirtyRows.add(index);
		flushTimer ??= setTimeout(() => {
			const rows = [...dirtyRows].map(index => ({ index, message: messages[index] }));
			clearUpdates();
			emit({ type: 'transcript', tabId: record.id, rows, status });
		}, 40);
	}

	function snapshot() {
		clearUpdates();
		changed();
		void emit({ type: 'state', tabId: record.id, messages, status, connectionFailed, busy: !!turn, selected,
			allowed: allowed(selected), trusted: vscode.workspace.isTrusted, ...metadata() });
	}

	function disconnect() {
		client?.dispose();
		client = undefined;
		options = [];
		commands = [];
		usage = undefined;
	}

	function onUpdate(name: string, update: SessionUpdate) {
		if (update.sessionUpdate === 'available_commands_update' && Array.isArray(update.availableCommands)) {
			commands = update.availableCommands.filter(command => typeof command?.name === 'string');
			publishMetadata();
		} else if (update.sessionUpdate === 'config_option_update') {
			options = readSessionOptions(update.configOptions);
			publishMetadata();
		} else if (update.sessionUpdate === 'usage_update') {
			const { used, size } = update;
			if (typeof used === 'number' && Number.isSafeInteger(used) && used >= 0
				&& typeof size === 'number' && Number.isSafeInteger(size) && size > 0) {
				usage = { used, size };
				publishMetadata();
			}
		} else {
			const backgroundTool = update.sessionUpdate === 'tool_call_update' && update.toolCallId
				&& messages.some(row => row.toolCallId === update.toolCallId);
			if (!(turn?.prompting && !turn.cancelled && update.sessionUpdate !== 'user_message_chunk') && !backgroundTool
				&& update.sessionUpdate !== 'notice' && !update.compactionId) { return; }
			const index = applyTranscriptUpdate(messages, name, update);
			if (index !== undefined) {
				const row = messages[index];
				if (turn?.prompting && !turn.cancelled) {
					status = '';
				}
				publishRow(index);
				if (!turn && (update._meta?.terminal_exit || update.status || row.kind === 'notice')) { changed(); }
			}
		}
	}

	async function connect(id: AgentId, pendingMessage?: ChatMessage) {
		if (client && !client.closed && authRevision === connectedRevision) { return client; }
		const revision = authRevision;
		disconnect();
		const workspace = await workspaceDirectory(context);
		const cwd = record.cwd ?? workspace;
		const launch = await store.launch(id);
		const env = await store.agentEnvironment(id);
		if (disposed || turn?.cancelled || !allowed(id) || !vscode.workspace.isTrusted) {
			throw new Error('Agent session cancelled.');
		}
		if (!launch) { throw new Error('Open Agent settings to install ' + agents[id].name + ' or configure its adapter path.'); }
		// Codex may only persist a thread after its first prompt. Older local tabs have an ordinal.
		const previousId = record.pendingFirstPrompt ? undefined : record.remoteId;
		let replay: ChatMessage[] | undefined = previousId ? [] : undefined;
		const session: AcpClient = new AcpClient(id, launch.command, launch.args, cwd, env, update => {
			if (client !== session) { return; }
			if (replay && applyTranscriptUpdate(replay, agents[id].name, update) !== undefined) { return; }
			onUpdate(agents[id].name, update);
		});
		client = session;
		connectedRevision = revision;
		try {
			const isNew = !previousId;
			record.remoteId = await session.initialize(cwd, context.extension.packageJSON.version, previousId);
			record.pendingFirstPrompt = isNew;
			record.cwd = cwd;
			if (isNew) {
				const preferences = context.globalState.get<Record<string, string | boolean>>(preferenceKey, {});
				for (const kind of ['mode', 'model', 'reasoning', 'fast']) {
					const option = options.find(item => item.kind === kind);
					if (!option) { continue; }
					const saved = preferences[option.id];
					if (saved !== option.current && supports(option, saved)) {
						try { await session.setOption(option.id, saved); }
						catch (error) { if (session.closed) { throw error; } }
					}
				}
			}
			if (replay?.length) {
				messages.length = 0;
				for (const message of replay) { messages.push(message); }
				if (pendingMessage) { messages.push(pendingMessage); }
			}
			replay = undefined;
			changed();
			return session;
		} catch (error) {
			disconnect();
			throw error;
		}
	}

	async function configure(change?: { id: string; value: unknown }) {
		if (turn || configuring || !allowed(selected) || !vscode.workspace.isTrusted) { snapshot(); return; }
		configuring = true;
		connectionFailed = false;
		status = client ? '' : record.remoteId ? 'Loading conversation…' : 'Loading session options…';
		snapshot();
		try {
			const session = await connect(selected);
			status = '';
			if (change) {
				const option = options.find(o => o.id === change.id);
				const value = change.value;
				if (!option || !supports(option, value)) {
					throw new Error('This option has changed. Choose an available value.');
				}
				await session.setOption(option.id, value);
				await rememberOptions();
			}
		} catch (error) {
			status = error.message;
			connectionFailed = !client || client.closed;
			if (client?.closed) { disconnect(); }
		} finally {
			configuring = false;
			snapshot();
		}
	}

	async function attach(folder = false) {
		if (!allowed(selected) || !vscode.workspace.isTrusted || disposed || turn) { return; }
		const files = await vscode.window.showOpenDialog({ canSelectFiles: !folder, canSelectFolders: folder, canSelectMany: true,
			openLabel: 'Attach', defaultUri: record.cwd ? vscode.Uri.file(record.cwd) : vscode.workspace.workspaceFolders?.[0]?.uri });
		return describeResources(files ?? []);
	}

	async function describeResources(files: readonly vscode.Uri[]) {
		if (disposed || turn || !allowed(selected) || !vscode.workspace.isTrusted) { return []; }
		return Promise.all(files.filter(uri => uri.scheme === 'file').map(async uri => {
			const stat = await vscode.workspace.fs.stat(uri).then(result => result.type, () => 0);
			return { type: 'resource_link', uri: uri.toString(), name: basename(uri.fsPath) || uri.fsPath, folder: !!(stat & vscode.FileType.Directory) };
		}));
	}

	let search: vscode.CancellationTokenSource | undefined;
	async function findContext(query: string, request: number) {
		search?.cancel();
		if (!allowed(selected) || !vscode.workspace.isTrusted || disposed) { return; }
		const token = new vscode.CancellationTokenSource();
		search = token;
		const items = new Map<string, { label: string; uri: string }>();
		try {
			const roots = record.cwd ? [vscode.Uri.file(record.cwd)] : (vscode.workspace.workspaceFolders ?? []).map(f => f.uri);
			for (const root of roots) {
				const slash = query.lastIndexOf('/');
				const directory = vscode.Uri.joinPath(root, query.slice(0, slash + 1));
				const prefix = relative(root.fsPath, directory.fsPath);
				if (prefix === '..' || prefix.startsWith('..' + sep) || isAbsolute(prefix)) { continue; }
				const add = (uri: vscode.Uri, folder: boolean) => {
					const label = relative(root.fsPath, uri.fsPath).split(sep).join('/') + (folder ? '/' : '');
					if (label.toLowerCase().includes(query.toLowerCase())) { items.set(uri.toString(), { label, uri: uri.toString() }); }
				};
				try {
					for (const [name, type] of await vscode.workspace.fs.readDirectory(directory)) {
						add(vscode.Uri.joinPath(directory, name), !!(type & vscode.FileType.Directory));
					}
				} catch { /* The typed directory may not exist. */ }
				if (query && items.size < 40 && !token.token.isCancellationRequested) {
					const literal = query.replace(/[?*{}[\]]/g, c => '[' + c + ']');
					const matches = await vscode.workspace.findFiles(new vscode.RelativePattern(root, '**/*' + literal + '*'), undefined, 40, token.token);
					for (const uri of matches) { add(uri, false); }
				}
			}
		} catch { /* Keep directory matches if file search is unavailable. */ } finally {
			if (!token.token.isCancellationRequested && !disposed) {
				emit({ type: 'contextMatches', tabId: record.id, request, items: [...items.values()].slice(0, 40) });
			}
			if (search === token) { search = undefined; }
			token.dispose();
		}
	}

	async function send(input: unknown) {
		if (!allowed(selected) || !vscode.workspace.isTrusted || turn || configuring || !Array.isArray(input)) {
			snapshot();
			return;
		}
		const parts: PromptPart[] = [];
		for (const part of input) {
			if (part?.type === 'text' && typeof part.text === 'string') {
				parts.push({ type: 'text', text: part.text });
			} else if (part?.type === 'resource_link' && typeof part.uri === 'string' && part.uri.startsWith('file://')) {
				const uri = vscode.Uri.parse(part.uri);
				parts.push({ type: 'resource_link', uri: uri.toString(), name: basename(uri.fsPath) || uri.fsPath });
			}
		}
		const text = parts.map(part => part.type === 'text' ? part.text : '@' + part.name).join('');
		if (!text.trim()) { snapshot(); return; }
		const id = selected;
		const name = agents[id].name;
		const active: Turn = { cancelled: false, prompting: false, start: messages.length };
		turn = active;
		connectionFailed = false;
		const pendingMessage = { role: 'You', text };
		messages.push(pendingMessage);
		status = client ? 'Waiting for ' + name + '…' : 'Connecting to ' + name + '…';
		snapshot();
		try {
			const session = await connect(id, pendingMessage);
			if (active.cancelled || !allowed(id)) { return; }
			record.pendingFirstPrompt = false;
			active.start = messages.length;
			active.prompting = true;
			status = 'Waiting for ' + name + '…';
			snapshot();
			void rememberOptions();
			const result = await session.prompt(parts);
			status = result?.stopReason === 'end_turn' ? '' : 'Turn ended (' + (result?.stopReason ?? 'unknown reason') + ').';
		} catch (error) {
			disconnect();
			emit({ type: 'restoreDraft', tabId: record.id, parts: input });
			if (!active.cancelled) {
				messages.push({ role: 'Connection', text: error.message });
			}
			status = '';
		} finally {
			clearTimeout(active.timer);
			if (active.cancelled || !client || client.closed) {
				for (const row of messages.slice(active.start)) {
					if (row.kind === 'tool' && (row.status === 'pending' || row.status === 'in_progress')) {
						row.status = active.cancelled ? 'cancelled' : 'ended';
					}
				}
			}
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

	async function openLink(href: string, fileOnly: boolean, line?: number) {
		try {
			if (!fileOnly && /^(?:https?:\/\/|mailto:)/i.test(href)) {
				await vscode.env.openExternal(vscode.Uri.parse(href));
				return;
			}
			if (!vscode.workspace.isTrusted) { return; }
			let file = href;
			if (!fileOnly) {
				const match = /^(.*?)(?:#L(\d+)(?:-L?\d+)?)?$/.exec(href);
				if (!match?.[1]) { return; }
				file = match[1];
				line = match[2] ? Number(match[2]) : undefined;
				if (file.startsWith('file:///')) { file = vscode.Uri.parse(file).fsPath; }
				else {
					if ((!isAbsolute(file) && /^[a-z][a-z0-9+.-]*:/i.test(file)) || file.startsWith('//')) { return; }
					file = decodeURIComponent(file);
				}
			}
			const cwd = record.cwd ?? await workspaceDirectory(context);
			const uri = vscode.Uri.file(resolve(cwd, file));
			const doc = await vscode.workspace.openTextDocument(uri);
			const position = new vscode.Position(Math.min(doc.lineCount, Math.max(1, Number.isSafeInteger(line) ? line! : 1)) - 1, 0);
			await vscode.window.showTextDocument(doc, { preview: true, selection: new vscode.Range(position, position) });
		} catch (error) {
			void vscode.window.showWarningMessage('Could not open link: ' + error.message);
		}
	}

	function suspend() {
		clearUpdates();
		if (turn) { turn.cancelled = true; clearTimeout(turn.timer); }
		disconnect();
	}
	function select() {
		if (!client || client.closed || authRevision !== connectedRevision) { void configure(); }
		else { snapshot(); }
	}
	return { invalidateAuth() { authRevision++; }, get busy() { return !!turn; }, select, snapshot, send, openLink, stop, configure, attach, describeResources, findContext, suspend, dispose() { disposed = true; search?.cancel(); suspend(); } };
}
