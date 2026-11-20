/* Copyright (c) Otrion contributors. Licensed under the MIT License. */

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { boot, canStart, listContainers, prepare, type ContainerTarget } from './container';
import { registerContainerExplorer } from './containerExplorer';
import { dockerHost, result, type DockerHost, type HostLog } from './host';

interface Session {
	origin?: string;
	parent?: string;
	id: string;
	user?: string;
	folder: string;
	attached?: boolean;
}

const prefix = 'dev-container+';
const namespace = 'otrion.devContainers.';
function hostPath(uri: vscode.Uri) {
	return uri.scheme === 'file' ? uri.fsPath : uri.path;
}

function sessionKey(session: Session) {
	const source = (session.origin ?? session.parent ?? 'local') + (session.attached ? ':' + session.id : '');
	return prefix + createHash('sha256').update(source).digest('hex');
}

async function workspaceHost(parent?: string) {
	if (!parent) { return dockerHost(vscode.env.appRoot); }
	if (!parent.startsWith('ssh-remote+')) { throw new Error('Open a local folder or an Otrion Remote SSH folder first.'); }
	const remote = await vscode.workspace.getRemoteExecServer(parent);
	if (!remote) { throw new Error('The SSH connection does not provide host execution.'); }
	return dockerHost(vscode.env.appRoot, remote);
}

async function chooseContainer(host: DockerHost, log: HostLog, state: vscode.Memento, parent?: string, origin?: string, target?: ContainerTarget): Promise<Session | undefined> {
	const containers = await listContainers(host, log, !!target);
	let selected: ContainerTarget | undefined;
	if (target) {
		selected = containers.find(container => container.id === target.id);
		if (!selected || (selected.state !== 'running' && !(canStart(target) && canStart(selected)))) {
			throw new Error(vscode.l10n.t("This container is no longer available to open. Refresh the container list."));
		}
		const records = state.keys().filter(key => key.startsWith(prefix))
			.map(key => state.get<Session>(key))
			.filter((record): record is Session => !!record && record.parent === parent && record.id === target.id);
		const sameProject = records.find(record => record.origin === origin && !record.attached);
		if (sameProject) { return sameProject; }
		const known = records.find(record => record.origin === origin) ?? records[0];
		if (known) { return { id: selected.id, folder: known.folder, user: known.user, origin, parent, attached: true }; }
	} else {
		const running = containers.filter(container => container.state === 'running');
		if (!running.length) { throw new Error(vscode.l10n.t("No running Docker containers on this host.")); }
		selected = await vscode.window.showQuickPick(running, { title: vscode.l10n.t("Attach to Running Container") });
		if (!selected) { return; }
	}
	const folder = await vscode.window.showInputBox({
		title: vscode.l10n.t("Open Folder in {0}", selected.label),
		value: '/',
		validateInput: value => path.posix.isAbsolute(value) ? undefined : vscode.l10n.t("Enter an absolute path.")
	});
	return folder ? { id: selected.id, folder, origin, parent, attached: true } : undefined;
}

export function activate(context: vscode.ExtensionContext) {
	const log = vscode.window.createOutputChannel('Otrion Dev Containers');
	context.subscriptions.push(log);
	const current = vscode.env.remoteAuthority?.replace(/%40/gi, '@');
	const currentKey = current?.split('@')[0];
	const existing = currentKey?.startsWith(prefix) ? context.globalState.get<Session>(currentKey) : undefined;
	const parent = existing ? existing.parent : current;
	const getHost = () => workspaceHost(parent);
	registerContainerExplorer(context, getHost, existing?.id, log);
	let opening = false;

	async function open(mode: 'open' | 'attach' | 'rebuild', target?: ContainerTarget, newWindow = false) {
		if (opening) { return; }
		if (!vscode.workspace.isTrusted) { throw new Error('Trust this workspace before opening a development container.'); }
		const folders = vscode.workspace.workspaceFolders ?? [];
		const multiRoot = !existing && folders.length > 1;
		if (multiRoot && mode !== 'attach') { throw new Error('Open a single project folder first.'); }
		let origin = existing ? (existing.origin ? vscode.Uri.parse(existing.origin) : undefined) : (multiRoot ? vscode.workspace.workspaceFile : folders[0]?.uri);
		if (multiRoot && origin?.scheme === 'untitled') { newWindow = true; origin = undefined; }
		if (origin && origin.scheme !== 'file' && origin.scheme !== 'vscode-remote') { throw new Error('Open a local or SSH workspace folder.'); }
		opening = true;
		try {
			const host = await getHost();
			const engine = await result(await host.docker(['version', '--format', '{{.Server.Os}}']), log).catch(error => {
				log.appendLine(String(error));
				throw new Error('Start Docker and make its CLI available on the project host, then try again.');
			});
			if (engine !== 'linux') { throw new Error('Switch Docker to Linux containers on the project host, then try again.'); }
			let session: Session;
			if (mode === 'attach') {
				const selected = await chooseContainer(host, log, context.globalState, parent, origin?.toString(), target);
				if (!selected) { return; }
				session = selected;
			} else {
				if (!origin) { throw new Error('Open a project folder first.'); }
				if (mode === 'rebuild') {
					if (!existing || existing.attached) { throw new Error('Rebuild a workspace opened from a devcontainer.json configuration.'); }
					const confirm = await vscode.window.showWarningMessage('Rebuild this container? Files outside mounted volumes may be lost.', { modal: true }, 'Rebuild');
					if (confirm !== 'Rebuild') { return; }
				}
				const location = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Preparing development container…' },
					() => prepare(host, hostPath(origin), mode === 'rebuild', log));
				session = { origin: origin.toString(), parent, ...location };
			}
			if (!/^[0-9a-f]{12,64}$/.test(session.id) || !path.posix.isAbsolute(session.folder)) { throw new Error('Invalid container or workspace path.'); }
			const key = sessionKey(session);
			await context.globalState.update(key, session);
			const authority = key + (parent ? '@' + parent : '');
			if (!newWindow && current === authority && vscode.workspace.workspaceFolders?.[0]?.uri.path === session.folder) {
				await vscode.commands.executeCommand('workbench.action.reloadWindow');
			} else {
				await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.from({ scheme: 'vscode-remote', authority, path: session.folder }), { forceReuseWindow: !newWindow, forceNewWindow: newWindow });
			}
		} finally { opening = false; }
	}

	function register(name: string, action: (target?: ContainerTarget) => unknown) {
		context.subscriptions.push(vscode.commands.registerCommand(namespace + name, async (target?: ContainerTarget) => {
			try { await action(target); } catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				log.appendLine(message);
				if (await vscode.window.showErrorMessage(message, 'Show Log') === 'Show Log') { log.show(); }
			}
		}));
	}
	register('reopen', () => open('open'));
	register('attach', () => open('attach'));
	register('explorer.open', target => target && open('attach', target));
	register('explorer.start', target => target && open('attach', target));
	register('explorer.openInNewWindow', target => target && open('attach', target, true));
	register('rebuild', () => open('rebuild'));
	register('showLog', () => log.show());
	register('returnToHost', async () => {
		if (existing?.origin) {
			await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.parse(existing.origin), { forceReuseWindow: true, forceLocalWindow: !existing.parent });
		} else if (existing) {
			await vscode.commands.executeCommand('vscode.newWindow', { reuseWindow: true, remoteAuthority: existing.parent ?? null });
		}
	});
	context.subscriptions.push(vscode.workspace.registerRemoteAuthorityResolver('dev-container', {
		async resolve(key, resolver) {
			// Only resolve records created by an explicit user action in a trusted workspace.
			const session = context.globalState.get<Session>(key);
			if (!session || current !== key + (session.parent ? '@' + session.parent : '') || !!session.parent !== !!resolver.execServer) {
				throw vscode.RemoteAuthorityResolverError.NotAvailable('Open the project on its original host and choose Reopen in Container.');
			}
			try {
				const host = await dockerHost(vscode.env.appRoot, resolver.execServer);
				const script = await readFile(context.asAbsolutePath('resources/start-server.sh'), 'utf8');
				const product = JSON.parse(await readFile(path.join(vscode.env.appRoot, 'product.json'), 'utf8'));
				const workspace = !session.attached && session.origin ? hostPath(vscode.Uri.parse(session.origin)) : undefined;
				const windowKey = createHash('sha256').update(vscode.env.sessionId + key).digest('hex');
				const server = await boot(host, { ...session, workspace, windowKey }, script, product, log);
				return new vscode.ManagedResolvedAuthority(async () => {
					const proc = await server.connect();
					const closed = new vscode.EventEmitter<Error | undefined>();
					const ended = new vscode.EventEmitter<void>();
					void Promise.resolve(proc.stdout.onEnd).then(() => { ended.fire(); ended.dispose(); });
					void Promise.resolve(proc.onExit).then(exit => closed.fire(exit.status ? new Error(exit.message || 'Container connection closed') : undefined))
						.finally(() => closed.dispose());
					return {
						onDidReceiveMessage: proc.stdout.onDidReceiveMessage,
						onDidEnd: ended.event,
						onDidClose: closed.event,
						send: bytes => proc.stdin.write(bytes),
						end: () => proc.stdin.end()
					};
				}, server.token);
			} catch (error) {
				log.appendLine(String(error));
				log.show(true);
				throw vscode.RemoteAuthorityResolverError.NotAvailable('Could not connect to the container. ' + (error instanceof Error ? error.message : String(error)));
			}
		}
	}));
	if (!existing && (!current || current.startsWith('ssh-remote+')) && vscode.workspace.isTrusted && vscode.workspace.workspaceFolders?.length === 1) {
		const root = vscode.workspace.workspaceFolders[0].uri;
		void Promise.all(['.devcontainer/devcontainer.json', '.devcontainer.json'].map(config =>
			vscode.workspace.fs.stat(vscode.Uri.joinPath(root, config)).then(() => true, () => false))).then(async found => {
			if (!found.includes(true) || context.workspaceState.get('suggested')) { return; }
			await context.workspaceState.update('suggested', true);
			if (await vscode.window.showInformationMessage('This project has a development container.', 'Reopen in Container') === 'Reopen in Container') {
				await vscode.commands.executeCommand(namespace + 'reopen');
			}
		});
	}
}
