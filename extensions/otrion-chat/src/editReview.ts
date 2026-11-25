/* Copyright (c) Otrion contributors. Licensed under the MIT License. */

import { createHash } from 'node:crypto';
import { basename } from 'node:path';
import * as vscode from 'vscode';

const scheme = 'otrion-edit';
const maxSnapshots = 100;
const snapshots = new Map<string, string>();

/** Serve read-only file versions recorded from agent edits to the diff editor. */
export function registerEditReview(context: vscode.ExtensionContext) {
	context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider(scheme, {
		provideTextDocumentContent: uri => snapshots.get(uri.query) ?? '',
	}));
}

function snapshot(file: vscode.Uri, text: string) {
	const id = createHash('sha256').update(file.toString()).update('\0').update(text).digest('hex').slice(0, 24);
	snapshots.delete(id);
	snapshots.set(id, text);
	for (const key of snapshots.keys()) {
		if (snapshots.size <= maxSnapshots) { break; }
		snapshots.delete(key);
	}
	// Keep the original path so the diff editor picks the file's language and label.
	return file.with({ scheme, query: id });
}

async function currentText(file: vscode.Uri) {
	try {
		return (await vscode.workspace.openTextDocument(file)).getText();
	} catch {
		return undefined;
	}
}

/** Locate where an edit's new text sits in the current file, when it can be found unambiguously. */
function locate(current: string, before: string, after: string) {
	if (!after) { return before ? undefined : 0; }
	const start = current.indexOf(after);
	return start >= 0 && start === current.lastIndexOf(after) ? start : undefined;
}

function positionAt(text: string, offset: number) {
	const preceding = text.slice(0, offset).split('\n');
	return new vscode.Position(preceding.length - 1, 0);
}

/**
 * Open an agent edit either in the file itself at the changed lines, or in a diff editor. When the edited text is
 * still present in the file the diff compares the reconstructed original against the live, editable file; otherwise
 * it compares the recorded before and after snapshots.
 */
export async function reviewEdit(file: vscode.Uri, before: string, after: string, diff: boolean) {
	const current = await currentText(file);
	const start = current === undefined ? undefined : locate(current, before, after);
	const position = current !== undefined && start !== undefined ? positionAt(current, start) : undefined;
	const selection = position && new vscode.Range(position, position);
	if (!diff) {
		if (current === undefined) {
			void vscode.window.showWarningMessage(vscode.l10n.t('{0} no longer exists.', basename(file.fsPath)));
			return;
		}
		await vscode.commands.executeCommand('vscode.open', file, { preview: true, selection });
		return;
	}
	const title = vscode.l10n.t('{0} (Agent Edit)', basename(file.fsPath));
	if (current !== undefined && start !== undefined) {
		const original = current.slice(0, start) + before + current.slice(start + after.length);
		await vscode.commands.executeCommand('vscode.diff', snapshot(file, original), file, title, { preview: true, selection });
	} else {
		await vscode.commands.executeCommand('vscode.diff', snapshot(file, before), snapshot(file, after), title, { preview: true });
	}
}
