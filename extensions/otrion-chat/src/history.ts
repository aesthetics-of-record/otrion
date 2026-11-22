/* Copyright (c) Otrion contributors. Licensed under the MIT License. */

import * as vscode from 'vscode';
import { AcpClient, type AgentSessionInfo } from './acp';
import { agents, AgentStore, allowed, type AgentId } from './agents';
import { workspaceDirectory } from './chatSession';

export class SessionHistory {
	readonly entries = new Map<string, AgentSessionInfo & { agent: AgentId }>();
	private clients = new Set<AcpClient>();
	private generation = 0;

	constructor(private readonly context: vscode.ExtensionContext, private readonly store: AgentStore) {}

	dispose() {
		this.entries.clear();
		this.cancel();
	}

	cancel() {
		this.generation++;
		for (const client of this.clients) { client.dispose(); }
		this.clients.clear();
	}

	async refresh(publish: (status: string, settingsTarget?: AgentId | 'agents') => void) {
		this.cancel();
		const generation = this.generation;
		if (!vscode.workspace.isTrusted) { this.entries.clear(); publish('Trust this workspace to view agent sessions.'); return; }
		const enabled = (Object.keys(agents) as AgentId[]).filter(allowed);
		if (!enabled.length) { this.entries.clear(); publish('Enable an agent to view its sessions.', 'agents'); return; }
		const errors = new Map<AgentId, string>();
		const next: typeof this.entries = new Map();
		await Promise.all(enabled.map(async agent => {
			let client: AcpClient | undefined;
			try {
				const cwd = await workspaceDirectory(this.context);
				const launch = await this.store.launch(agent);
				if (generation !== this.generation || !allowed(agent)) { return; }
				if (!launch) { throw new Error('Install the adapter in Otrion Settings.'); }
				const command = await this.store.sessionCommand(agent, launch);
				if (generation !== this.generation || !allowed(agent)) { return; }
				client = new AcpClient(agent, command.command, command.args, cwd, command.env, () => {});
				this.clients.add(client);
				await client.listSessions(this.context.extension.packageJSON.version, sessions => {
					if (generation !== this.generation) { return; }
					for (const info of sessions) {
						next.set(agent + '/' + info.sessionId, { ...info, agent });
					}
				});
			} catch (error) {
				errors.set(agent, agents[agent].name + ' · ' + error.message);
				for (const [id, info] of this.entries) {
					if (info.agent === agent && !next.has(id)) { next.set(id, info); }
				}
			} finally {
				if (client) { this.clients.delete(client); client.dispose(); }
			}
		}));
		if (generation !== this.generation) { return; }
		this.entries.clear();
		for (const [id, info] of next) { this.entries.set(id, info); }
		publish(enabled.flatMap(agent => errors.get(agent) ?? []).join('\n'), errors.size > 1 ? 'agents' : errors.keys().next().value);
	}
}
