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
		this.generation++;
		for (const client of this.clients) { client.dispose(); }
		this.clients.clear();
		this.entries.clear();
	}

	async refresh(publish: (status: string) => void) {
		this.dispose();
		const generation = this.generation;
		if (!vscode.workspace.isTrusted) { publish('Trust this workspace to view agent sessions.'); return; }
		const enabled = (Object.keys(agents) as AgentId[]).filter(allowed);
		if (!enabled.length) { publish('Allow an agent in Otrion Settings to view its sessions.'); return; }
		const errors: string[] = [];
		let remaining = enabled.length;
		const update = () => {
			if (generation === this.generation) {
				publish([remaining ? 'Loading sessions…' : '', ...errors].filter(Boolean).join('\n'));
			}
		};
		await Promise.all(enabled.map(async agent => {
			let client: AcpClient | undefined;
			try {
				const cwd = await workspaceDirectory(this.context);
				const launch = await this.store.launch(agent);
				if (generation !== this.generation || !allowed(agent)) { return; }
				if (!launch) { throw new Error('Install the adapter in Otrion Settings.'); }
				const env = await this.store.agentEnvironment(agent, launch);
				if (generation !== this.generation || !allowed(agent)) { return; }
				client = new AcpClient(agent, launch.command, launch.args, cwd, env, () => {});
				this.clients.add(client);
				await client.listSessions(this.context.extension.packageJSON.version, sessions => {
					if (generation !== this.generation) { return; }
					for (const info of sessions) {
						this.entries.set(agent + '/' + info.sessionId, { ...info, agent });
					}
					update();
				});
			} catch (error) {
				errors.push(agents[agent].name + ' · ' + error.message);
			} finally {
				if (client) { this.clients.delete(client); client.dispose(); }
				remaining--;
				update();
			}
		}));
	}
}
