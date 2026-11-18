/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Otrion contributors. Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/
const vscode = require('vscode');

/** @param {import('vscode').ExtensionContext} context */
function activate(context) {
	context.subscriptions.push(vscode.commands.registerCommand('otrion.context.copySelection', async () => {
		const editor = vscode.window.activeTextEditor;
		if (!editor) {
			return;
		}
		const selections = editor.selections.filter(selection => !selection.isEmpty);
		if (!selections.length) {
			return;
		}

		const file = vscode.workspace.asRelativePath(editor.document.uri);
		const excerpts = selections.map(selection => {
			const firstLine = selection.start.line + 1;
			// A selection ending at column zero excludes the text of its final line.
			const lastLine = selection.end.line + (selection.end.character === 0 ? 0 : 1);
			const location = firstLine === lastLine ? firstLine : `${firstLine}-${lastLine}`;
			return `${file}:${location}\n${editor.document.getText(selection)}`;
		});
		await vscode.env.clipboard.writeText(excerpts.join('\n\n'));
	}));
}

module.exports = { activate };
