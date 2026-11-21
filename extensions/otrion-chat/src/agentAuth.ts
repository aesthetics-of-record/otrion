/* Copyright (c) Otrion contributors. Licensed under the MIT License. */

import { homedir } from 'node:os';
import * as vscode from 'vscode';
import { AcpClient } from './acp';
import { agents, type AgentId } from './agentCatalog';
import { allowed } from './agents';

interface AgentLaunch {
	command: string;
	args: string[];
	baseArgs: string[];
	env: NodeJS.ProcessEnv;
}

export async function signInWithAgent(id: AgentId, launch: AgentLaunch) {
	const agent = agents[id];
	const requireEnabled = () => {
		if (!vscode.workspace.isTrusted || !allowed(id)) { throw new Error('Enable the agent in a trusted workspace to sign in.'); }
	};
	requireEnabled();
	const terminal = (args: string[], env = launch.env) => {
		requireEnabled();
		return vscode.window.createTerminal({ name: agent.name + ' Sign In', shellPath: launch.command, shellArgs: args, env,
			message: id === 'qwen-code' ? 'In Qwen Code, enter /auth to sign in or configure a provider API key.' : undefined, cwd: vscode.Uri.file(homedir()) });
	};
	if (agent.loginArgs) {
		const args = [...launch.baseArgs, ...agent.loginArgs];
		if (id === 'grok' && vscode.env.remoteAuthority) { args.push('--device-auth'); }
		const env = id === 'cursor' && vscode.env.remoteAuthority ? { ...launch.env, NO_OPEN_BROWSER: '1' } : launch.env;
		const term = terminal(args, env);
		term.show();
		return term;
	}
	const client = new AcpClient(id, launch.command, launch.args, homedir(), { ...process.env, ...launch.env }, () => {});
	try {
		const methods = await client.authMethods(vscode.version);
		if (!methods.length) {
			const open = await vscode.window.showInformationMessage(agent.name + ' uses credentials configured on this host.', 'Open provider setup');
			if (open) { await vscode.env.openExternal(vscode.Uri.parse(agent.website)); }
			return;
		}
		const choice = await vscode.window.showQuickPick(methods.map(method => ({ label: method.name, detail: method.description, method })), { title: 'Sign in to ' + agent.name });
		if (!choice) { return; }
		requireEnabled();
		const method = choice.method;
		if (method.type === 'terminal') {
			const args = method.args ?? [];
			const env = method.env ?? {};
			if (!Array.isArray(args) || !args.every(arg => typeof arg === 'string') || typeof env !== 'object' || Array.isArray(env) || !Object.values(env).every(value => typeof value === 'string')) {
				throw new Error('The agent returned invalid terminal sign-in options.');
			}
			const details = [launch.command, ...launch.args, ...args].map(arg => JSON.stringify(arg)).join(' ')
				+ (Object.keys(env).length ? '\n' + JSON.stringify(env) : '');
			const run = await vscode.window.showInformationMessage('Open ' + agent.name + ' sign-in terminal?', { modal: true, detail: details }, 'Open Terminal');
			if (!run) { return; }
			const term = terminal([...launch.args, ...args], { ...launch.env, ...env });
			term.show();
			return term;
		} else {
			await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Signing in to ' + agent.name, cancellable: true }, async (_, token) => {
				const cancel = token.onCancellationRequested(() => client.dispose());
				try { await client.authenticate(method.id); } finally { cancel.dispose(); }
			});
		}
		return true;
	} finally { client.dispose(); }
}
