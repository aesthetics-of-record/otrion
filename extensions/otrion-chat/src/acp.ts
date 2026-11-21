/* Copyright (c) Otrion contributors. Licensed under the MIT License. */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { createInterface, type Interface } from 'node:readline';

import { agents, type AgentId } from './agentCatalog';

import type { ContentBlock, ToolContent, ChatMessage } from './transcript';

export interface SessionUpdate {
	_meta?: {
		terminal_output?: { data?: string };
		terminal_output_delta?: { data?: string };
		terminal_exit?: { exit_code?: number | null; signal?: string | null };
	};
	compactionId?: string;
	summary?: ContentBlock[] | null;
	error?: string | null;
	toolCallId?: string;
	title?: string;
	name?: string;
	kind?: string;
	status?: string;
	description?: string;
	severity?: string;
	locations?: ChatMessage['locations'];
	entries?: ChatMessage['entries'];
	rawInput?: unknown;
	rawOutput?: unknown;
	availableCommands?: { name: string; description?: string }[];
	configOptions?: unknown;
	currentModeId?: string;
	size?: number;
	used?: number;
	sessionUpdate: string;
	messageId?: string;
	content?: ContentBlock | ToolContent[];
}

export type PromptPart = { type: 'image'; mimeType: string; data: string } | { type: 'text'; text: string } | { type: 'resource_link'; uri: string; name: string };

export interface AgentSessionInfo {
	sessionId: string;
	cwd: string;
	title?: string;
	updatedAt?: string;
}

export interface AgentAuthMethod {
	id: string;
	name: string;
	description?: string;
	type?: string;
	args?: string[];
	env?: Record<string, string>;
}

export class AuthenticationRequired extends Error {}

class AcpRequestError extends Error {
	constructor(message: string, readonly code: number, readonly data?: { uri?: string; sessionId?: string }) {
		super(message);
	}
}

interface AcpResult {
	providerId?: string | null;
	modelId?: string | null;
	entries?: { providerId: string; configured: boolean }[];
	authMethods?: AgentAuthMethod[];
	cells?: { kind: string; status: string; detail?: { source?: string; hasToken?: boolean | 'unknown' } }[];
	_meta?: { steering?: { supported?: boolean }; defaultAuthMethodId?: string | null };
	outcome?: string;
	sessions?: AgentSessionInfo[];
	nextCursor?: string | null;
	configOptions?: unknown;
	modes?: { currentModeId: string; availableModes: { id: string; name: string; description?: string }[] };
	models?: { currentModelId: string; availableModels: { modelId: string; name: string; description?: string }[] };
	agentCapabilities?: { promptCapabilities?: { image?: boolean }; loadSession?: boolean; sessionCapabilities?: { list?: object } };
	protocolVersion?: number;
	sessionId?: string;
	stopReason?: string;
}

interface PendingRequest {
	resolve(value: AcpResult): void;
	reject(error: Error): void;
	timer?: NodeJS.Timeout;
}

export class AcpClient {
	#process: ChildProcessWithoutNullStreams;
	#lines: Interface;
	#pending = new Map<number, PendingRequest>();
	#nextId = 0;
	#closed = false;
	#sessionId?: string;
	#configOptions: { category?: string; id?: string }[] = [];
	#legacyOptions = new Map<'mode' | 'model', { currentValue: string; options: { value: string; name: string; description?: string }[] }>();
	// Some adapters publish usage or settings before replying to session/new.
	#initialUpdates = new Map<string, SessionUpdate[]>();
	get closed() { return this.#closed; }

	#onUpdate: (update: SessionUpdate) => void;

	constructor(private readonly id: AgentId, command: string, args: string[], private readonly cwd: string, env: NodeJS.ProcessEnv, onUpdate: (update: SessionUpdate) => void) {
		this.#onUpdate = onUpdate;
		this.#process = spawn(command, args, {
			cwd,
			env: id === 'codex' ? { ...env, INITIAL_AGENT_MODE: 'read-only', NO_BROWSER: '1' } : env,
			stdio: ['pipe', 'pipe', 'pipe'],
			windowsHide: true,
		});
		this.#process.stderr.resume();
		this.#lines = createInterface({ input: this.#process.stdout });
		this.#lines.on('line', line => this.#receive(line));
		this.#process.on('error', (error: NodeJS.ErrnoException) => this.dispose(error.code === 'ENOENT'
			? new Error('Agent executable not found. Open Otrion Settings to install it.')
			: error));
		this.#process.stdin.on('error', () => this.dispose(new Error('The ACP agent connection closed.')));
		this.#process.on('close', code => this.dispose(new Error(`ACP agent disconnected (${code ?? 'terminated'}).`)));
	}

	supportsImages = false;
	supportsSteering = false;

	async #initialize(version: string, terminalAuth = false, timeout = 30_000) {
		const result = await this.#request('initialize', {
			protocolVersion: 1,
			clientCapabilities: {
				...(terminalAuth ? { auth: { terminal: true } } : {}),
				_meta: { terminal_output: true, terminal_output_delta: true },
				session: { configOptions: { boolean: {} }, notices: {}, compaction: {} },
			},
			clientInfo: { name: 'otrion', title: 'Otrion', version },
		}, timeout);
		if (result?.protocolVersion !== 1) {
			throw new Error('ACP agent did not negotiate protocol version 1.');
		}
		this.supportsSteering = result._meta?.steering?.supported === true;
		this.supportsImages = result.agentCapabilities?.promptCapabilities?.image === true;
		return result;
	}

	async accountStatus(version: string) {
		try {
			const result = await this.#initialize(version, false, 5000);
			if (this.id === 'grok') {
				// Grok lists sessions even while signed out. Only the selected credential is meaningful.
				const method = result._meta?.defaultAuthMethodId;
				if (method === 'cached_token') { return 'Signed in'; }
				if (method === 'xai.api_key') { return 'CLI API key'; }
				return method === null ? 'Signed out' : 'Unknown';
			}
			if (this.id === 'goose') {
				const defaults = await this.#request('_goose/unstable/defaults/read', {}, 5000);
				if (!defaults.providerId || !defaults.modelId) { return 'Provider setup required'; }
				const { entries } = await this.#request('_goose/unstable/providers/list', { providerIds: [defaults.providerId] }, 5000);
				const provider = entries?.find(entry => entry.providerId === defaults.providerId);
				if (provider?.configured === true) { return 'Provider configured'; }
				return provider?.configured === false ? 'Provider setup required' : 'Unknown';
			}
			if (this.id === 'qwen-code') {
				const preflight = await this.#request('qwen/status/workspace/preflight', {}, 5000);
				const auth = preflight.cells?.find(cell => cell.kind === 'auth');
				if (auth?.status === 'ok' && auth.detail?.hasToken === true) { return 'CLI credentials configured'; }
				if (auth?.status === 'warning' && auth.detail?.hasToken === false) { return 'Signed out'; }
				return 'Check account with /doctor';
			}
			if (result.agentCapabilities?.loadSession && (this.id === 'cline' || this.id === 'github-copilot-cli' || this.id === 'kimi-code')) {
				// These adapters check auth before looking up a session. A fresh ID never opens a real conversation.
				const sessionId = randomUUID();
				try {
					await this.#request('session/load', { sessionId, cwd: this.cwd, mcpServers: [] }, 5000);
				} catch (error) {
					if (!(error instanceof AcpRequestError)) { throw error; }
					const missing = error.code === -32002 && (error.data?.uri === sessionId || error.data?.uri === 'Session ' + sessionId + ' not found');
					const missingKimi = this.id === 'kimi-code' && error.code === -32602 && error.data?.sessionId === sessionId && error.message.endsWith('Unknown sessionId: ' + sessionId);
					if (missing || missingKimi) { return 'Signed in'; }
				}
			}
			if (this.id === 'antigravity' && result.agentCapabilities?.sessionCapabilities?.list) {
				// This read-only request requires authentication. Only inspect the first response.
				const page = await this.#request('session/list', {}, 5000);
				if (Array.isArray(page.sessions)) { return 'Signed in'; }
			}
		} catch (error) {
			if (error instanceof AuthenticationRequired) { return 'Signed out'; }
		}
		return 'Unknown';
	}

	async authMethods(version: string) {
		const result = await this.#initialize(version, true);
		return (result.authMethods ?? []).filter(method => typeof method?.id === 'string' && typeof method.name === 'string'
			&& (!method.type || method.type === 'agent' || method.type === 'terminal'));
	}

	authenticate(methodId: string) {
		return this.#request('authenticate', { methodId }, 300_000);
	}

	async listSessions(version: string, onPage: (sessions: AgentSessionInfo[]) => void) {
		const { agentCapabilities: capabilities } = await this.#initialize(version);
		if (!capabilities?.sessionCapabilities?.list) {
			throw new Error('This adapter does not support session history.');
		}
		let cursor: string | undefined;
		const seen = new Set<string>();
		do {
			const page = await this.#request('session/list', { cursor }, 30_000);
			if (!Array.isArray(page?.sessions)) { throw new Error('Invalid session list from the adapter.'); }
			onPage(page.sessions.filter(info => typeof info?.sessionId === 'string' && info.sessionId
				&& typeof info.cwd === 'string' && isAbsolute(info.cwd)));
			cursor = page.nextCursor ?? undefined;
			if (cursor && seen.has(cursor)) { throw new Error('The adapter repeated a history page.'); }
			if (cursor) { seen.add(cursor); }
		} while (cursor);
	}

	async initialize(cwd: string, version: string, previousId?: string) {
		const { agentCapabilities: capabilities } = await this.#initialize(version);
		if (previousId && !capabilities?.loadSession) {
			throw new Error('This adapter cannot resume archived sessions. Start a new tab to continue.');
		}
		// session/load replays messages before the response arrives.
		this.#sessionId = previousId;
		const session = previousId
			? await this.#request('session/load', { sessionId: previousId, cwd, mcpServers: [] }, 60_000)
			: await this.#request('session/new', { cwd, mcpServers: [] }, 60_000);
		const sessionId = previousId ?? session?.sessionId;
		if (typeof sessionId !== 'string' || !sessionId) {
			throw new Error('ACP agent did not return a session ID.');
		}
		this.#sessionId = sessionId;
		if (Array.isArray(session.modes?.availableModes)) {
			this.#legacyOptions.set('mode', { currentValue: session.modes.currentModeId,
				options: session.modes.availableModes.map(({ id, name, description }) => ({ value: id, name, description })) });
		}
		if (Array.isArray(session.models?.availableModels)) {
			this.#legacyOptions.set('model', { currentValue: session.models.currentModelId,
				options: session.models.availableModels.map(({ modelId, name, description }) => ({ value: modelId, name, description })) });
		}
		if (Array.isArray(session.configOptions)) { this.#configOptions = session.configOptions; }
		if (this.#configOptions.length || this.#legacyOptions.size) { this.#publishOptions(); }
		for (const update of this.#initialUpdates.get(sessionId) ?? []) {
			this.#update(update);
		}
		this.#initialUpdates.clear();
		return sessionId;
	}

	async setOption(configId: string, value: string | boolean) {
		for (const [kind, option] of this.#legacyOptions) {
			if (configId === 'acp.' + kind && typeof value === 'string' && !this.#hasConfig(kind)) {
				await this.#request('session/set_' + kind, { sessionId: this.#sessionId, [kind + 'Id']: value }, 30_000);
				option.currentValue = value;
				this.#publishOptions();
				return;
			}
		}
		const result = await this.#request('session/set_config_option', {
			sessionId: this.#sessionId, configId, value,
			...(typeof value === 'boolean' ? { type: 'boolean' } : {}),
		}, 30_000);
		if (Array.isArray(result?.configOptions)) {
			this.#update({ sessionUpdate: 'config_option_update', configOptions: result.configOptions });
		}
	}

	#hasConfig(kind: string) {
		return this.#configOptions.some(option => option?.category === kind || option?.id === 'acp.' + kind);
	}

	#publishOptions() {
		const configOptions: unknown[] = [...this.#configOptions];
		for (const [kind, option] of this.#legacyOptions) {
			if (!this.#hasConfig(kind)) { configOptions.push({ id: 'acp.' + kind, category: kind, type: 'select', ...option }); }
		}
		this.#onUpdate({ sessionUpdate: 'config_option_update', configOptions });
	}

	#update(update: SessionUpdate) {
		if (update.sessionUpdate === 'config_option_update' && Array.isArray(update.configOptions)) {
			this.#configOptions = update.configOptions;
			this.#publishOptions();
		} else if (update.sessionUpdate === 'current_mode_update' && typeof update.currentModeId === 'string') {
			const option = this.#legacyOptions.get('mode');
			if (option) { option.currentValue = update.currentModeId; this.#publishOptions(); }
		} else {
			this.#onUpdate(update);
		}
	}

	prompt(prompt: PromptPart[]) {
		return this.#request('session/prompt', {
			sessionId: this.#sessionId,
			prompt,
		});
	}

	async steer(prompt: PromptPart[]) {
		const result = await this.#request('_session/steering', {
			sessionId: this.#sessionId, prompt, _meta: { steering: { idleBehavior: 'promptRequired' } }
		}, 30_000);
		if (result.outcome !== 'injected' && result.outcome !== 'promptRequired') {
			throw new Error('The agent did not confirm delivery.');
		}
		return result.outcome;
	}

	cancel() {
		if (!this.#closed && this.#sessionId) {
			this.#write({ method: 'session/cancel', params: { sessionId: this.#sessionId } });
		}
	}

	dispose(error = new Error('The ACP agent session ended.')) {
		if (this.#closed) {
			return;
		}
		this.#closed = true;
		this.#lines.close();
		this.#process.stdin.end();
		this.#process.kill();
		for (const { reject, timer } of this.#pending.values()) {
			clearTimeout(timer);
			reject(error);
		}
		this.#pending.clear();
	}

	#write(message: object) {
		this.#process.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
	}

	#request(method: string, params: object, timeout?: number): Promise<AcpResult> {
		if (this.#closed) {
			return Promise.reject(new Error('The ACP agent connection closed. Start a new chat.'));
		}
		return new Promise((resolve, reject) => {
			const id = ++this.#nextId;
			const timer = timeout ? setTimeout(() => this.dispose(new Error(`ACP agent timed out during ${method}.`)), timeout) : undefined;
			this.#pending.set(id, { resolve, reject, timer });
			this.#write({ id, method, params });
		});
	}

	#receive(line: string) {
		if (!line.trim() || this.#closed) {
			return;
		}
		let message;
		try {
			message = JSON.parse(line);
		} catch {
			this.dispose(new Error('ACP agent returned invalid JSON.'));
			return;
		}
		if (message?.jsonrpc !== '2.0') {
			return;
		}
		if (typeof message.method === 'string') {
			if (message.id !== undefined) {
				if (message.method === 'session/request_permission') {
					if (message.params?.sessionId === this.#sessionId) {
						this.#onUpdate({ sessionUpdate: 'notice', title: 'Tool permission declined', description: message.params.toolCall?.title });
					}
					this.#write({ id: message.id, result: { outcome: { outcome: 'cancelled' } } });
				} else {
					this.#write({ id: message.id, error: { code: -32601, message: 'Client method not supported' } });
				}
			} else if (message.method === 'session/update' && typeof message.params?.sessionId === 'string' && message.params.update) {
				const { sessionId, update } = message.params;
				if (sessionId === this.#sessionId) {
					this.#update(update);
				} else if (!this.#sessionId && (update.sessionUpdate === 'usage_update' || update.sessionUpdate === 'config_option_update' || update.sessionUpdate === 'current_mode_update' || update.sessionUpdate === 'available_commands_update' || update.sessionUpdate === 'notice')) {
					const updates = this.#initialUpdates.get(sessionId) ?? [];
					updates.push(update);
					this.#initialUpdates.set(sessionId, updates);
				}
			}
			return;
		}
		const pending = this.#pending.get(message.id);
		if (pending) {
			this.#pending.delete(message.id);
			clearTimeout(pending.timer);
			if (message.error) {
				const hint = message.error.code === -32000 ? ' Check the authentication settings for ' + agents[this.id].name + ' in Otrion Settings.' : '';
				const reason = (message.error.message || 'ACP agent request failed.') + hint;
				pending.reject(hint ? new AuthenticationRequired(reason) : new AcpRequestError(reason, message.error.code, message.error.data));
			} else {
				pending.resolve(message.result);
			}
		}
	}
}
