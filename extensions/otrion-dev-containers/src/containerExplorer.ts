/* Copyright (c) Otrion contributors. Licensed under the MIT License. */

import * as vscode from 'vscode';
import { canStart, listContainers, type ContainerTarget } from './container';
import type { DockerHost } from './host';

export function registerContainerExplorer(context: vscode.ExtensionContext, getHost: () => Promise<DockerHost>, currentId: string | undefined, log: vscode.OutputChannel) {
	const change = new vscode.EventEmitter<void>();
	context.subscriptions.push(change);
	const view = vscode.window.createTreeView<ContainerTarget>('otrion.devContainers.containers', {
		treeDataProvider: {
			onDidChangeTreeData: change.event,
			async getChildren(element) {
				if (element) { return []; }
				if (!vscode.workspace.isTrusted) {
					view.message = vscode.l10n.t("Trust this workspace to view its containers.");
					return [];
				}
				try {
					const containers = await listContainers(await getHost(), log, true);
					view.message = containers.length ? undefined : vscode.l10n.t("No containers on this Docker host.");
					return containers;
				} catch (error) {
					log.appendLine(String(error));
					view.message = error instanceof Error && error.message === 'spawn docker ENOENT'
						? vscode.l10n.t("Docker CLI not found. Check the project host’s PATH and refresh.")
						: vscode.l10n.t("Could not list containers. Check Docker on the project host and refresh.");
					return [];
				}
			},
			getTreeItem(container) {
				const item = new vscode.TreeItem(container.label);
				item.id = container.id;
				if (container.state === 'running') {
					const current = container.id === currentId;
					item.contextValue = current ? 'current' : 'running';
					item.description = current ? vscode.l10n.t("Current") : container.description;
					item.iconPath = new vscode.ThemeIcon(current ? 'vm-active' : 'vm-running');
				} else {
					item.contextValue = canStart(container) ? 'stopped' : 'unavailable';
					item.description = container.status;
					item.iconPath = new vscode.ThemeIcon('vm');
				}
				item.tooltip = [container.label, container.description, container.status].join('\n');
				return item;
			}
		}
	});
	context.subscriptions.push(view,
		vscode.commands.registerCommand('otrion.devContainers.explorer.refresh', () => change.fire()),
		vscode.workspace.onDidGrantWorkspaceTrust(() => change.fire()),
		view.onDidChangeVisibility(({ visible }) => { if (visible) { change.fire(); } })
	);
}
