/* Copyright (c) Otrion contributors. Licensed under the MIT License. */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface, type Interface } from 'node:readline';

import { agents, type AgentId } from './agents';

interface SessionUpdate {
	sessionUpdate: string;
	content?: { type: string; text?: string };
}

interface AcpResult {
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
	#onUpdate: (update: SessionUpdate) => void;

	constructor(private readonly id: AgentId, command: string, args: string[], cwd: string, onUpdate: (update: SessionUpdate) => void) {
		this.#onUpdate = onUpdate;
		this.#process = spawn(command, args, {
			cwd,
			env: id === 'codex' ? { ...process.env, INITIAL_AGENT_MODE: 'read-only', NO_BROWSER: '1' } : process.env,
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

	async initialize(cwd: string, version: string) {
		const result = await this.#request('initialize', {
			protocolVersion: 1,
			clientCapabilities: {},
			clientInfo: { name: 'otrion', title: 'Otrion', version },
		}, 30_000);
		if (result?.protocolVersion !== 1) {
			throw new Error('ACP agent did not negotiate protocol version 1.');
		}
		const session = await this.#request('session/new', { cwd, mcpServers: [] }, 60_000);
		if (typeof session?.sessionId !== 'string' || !session.sessionId) {
			throw new Error('ACP agent did not return a session ID.');
		}
		this.#sessionId = session.sessionId;
	}

	prompt(text: string) {
		return this.#request('session/prompt', {
			sessionId: this.#sessionId,
			prompt: [{ type: 'text', text }],
		});
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
					this.#write({ id: message.id, result: { outcome: { outcome: 'cancelled' } } });
				} else {
					this.#write({ id: message.id, error: { code: -32601, message: 'Client method not supported' } });
				}
			} else if (message.method === 'session/update' && message.params?.sessionId === this.#sessionId) {
				this.#onUpdate(message.params.update);
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
