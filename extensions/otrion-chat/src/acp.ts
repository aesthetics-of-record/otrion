/* Copyright (c) Otrion contributors. Licensed under the MIT License. */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { isAbsolute } from 'node:path';
import { createInterface, type Interface } from 'node:readline';

import { agents, type AgentId } from './agents';

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

interface AcpResult {
	_meta?: { steering?: { supported?: boolean } };
	outcome?: string;
	sessions?: AgentSessionInfo[];
	nextCursor?: string | null;
	configOptions?: unknown;
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
	// Some adapters publish usage or settings before replying to session/new.
	#initialUpdates = new Map<string, SessionUpdate[]>();
	get closed() { return this.#closed; }

	#onUpdate: (update: SessionUpdate) => void;

	constructor(private readonly id: AgentId, command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, onUpdate: (update: SessionUpdate) => void) {
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

	async #initialize(version: string) {
		const result = await this.#request('initialize', {
			protocolVersion: 1,
			clientCapabilities: {
				_meta: { terminal_output: true, terminal_output_delta: true },
				session: { configOptions: { boolean: {} }, notices: {}, compaction: {} },
			},
			clientInfo: { name: 'otrion', title: 'Otrion', version },
		}, 30_000);
		if (result?.protocolVersion !== 1) {
			throw new Error('ACP agent did not negotiate protocol version 1.');
		}
		this.supportsSteering = result._meta?.steering?.supported === true;
		this.supportsImages = result.agentCapabilities?.promptCapabilities?.image === true;
		return result.agentCapabilities;
	}

	async listSessions(version: string, onPage: (sessions: AgentSessionInfo[]) => void) {
		const capabilities = await this.#initialize(version);
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
		const capabilities = await this.#initialize(version);
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
		if (session.configOptions) {
			this.#onUpdate({ sessionUpdate: 'config_option_update', configOptions: session.configOptions });
		}
		for (const update of this.#initialUpdates.get(sessionId) ?? []) {
			this.#onUpdate(update);
		}
		this.#initialUpdates.clear();
		return sessionId;
	}

	async setOption(configId: string, value: string | boolean) {
		const result = await this.#request('session/set_config_option', {
			sessionId: this.#sessionId, configId, value,
			...(typeof value === 'boolean' ? { type: 'boolean' } : {}),
		}, 30_000);
		if (Array.isArray(result?.configOptions)) {
			this.#onUpdate({ sessionUpdate: 'config_option_update', configOptions: result.configOptions });
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
					this.#onUpdate(update);
				} else if (!this.#sessionId && (update.sessionUpdate === 'usage_update' || update.sessionUpdate === 'config_option_update' || update.sessionUpdate === 'available_commands_update' || update.sessionUpdate === 'notice')) {
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
				const hint = message.error.code === -32000 ? ' Open Otrion Settings and sign in to ' + agents[this.id].name + '.' : '';
				pending.reject(new Error((message.error.message || 'ACP agent request failed.') + hint));
			} else {
				pending.resolve(message.result);
			}
		}
	}
}
