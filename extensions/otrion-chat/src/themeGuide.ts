/* Copyright (c) Otrion contributors. Licensed under the MIT License. */

import { randomUUID } from 'node:crypto';
import * as vscode from 'vscode';

const themes = [
	{ id: 'otrion-dark', label: 'Otrion Dark', preview: 'otrion-dark.png' },
	{ id: 'otrion-light', label: 'Otrion Light', preview: 'otrion-light.png' },
	{ id: 'Dark 2026', label: 'VS Code Dark', preview: 'vscode-dark.png' },
	{ id: 'Light 2026', label: 'VS Code Light', preview: 'vscode-light.png' },
];

export function registerThemeGuide(context: vscode.ExtensionContext) {
	let guide: vscode.WebviewPanel | undefined;
	context.subscriptions.push(vscode.commands.registerCommand('otrion.showThemeGuide', () => {
		if (guide) { guide.reveal(); return; }
		const media = vscode.Uri.joinPath(context.extensionUri, 'media');
		const panel = vscode.window.createWebviewPanel('otrion.themeGuide', 'Welcome to Otrion', vscode.ViewColumn.Active,
			{ enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [media] });
		guide = panel;
		panel.onDidDispose(() => { guide = undefined; });
		const web = panel.webview;
		const asset = (file: string) => web.asWebviewUri(vscode.Uri.joinPath(media, file));
		const nonce = randomUUID();
		const settings = vscode.workspace.getConfiguration('workbench');
		const current = settings.get<string>('colorTheme');
		panel.iconPath = vscode.Uri.joinPath(media, 'orbit.svg');
		let pending = Promise.resolve();
		let latestChoice = '';
		web.onDidReceiveMessage(message => {
			if (message === 'done') { panel.dispose(); return; }
			if (!themes.some(theme => theme.id === message)) { return; }
			latestChoice = message;
			pending = pending.then(async () => {
				if (message === latestChoice) {
					await settings.update('colorTheme', message, vscode.ConfigurationTarget.Global);
				}
			}).catch(() => {
				if (guide === panel && message === latestChoice) {
					void web.postMessage({ failed: message, current: vscode.workspace.getConfiguration('workbench').get('colorTheme') });
				}
			});
		});
		web.html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${web.cspSource}; img-src ${web.cspSource}; script-src 'nonce-${nonce}'">
<link rel="stylesheet" href="${asset('themeGuide.css')}"></head><body><main>
<img class="orbit" alt="" src="${asset('orbit.svg')}"><h1>Welcome to Otrion</h1>
<fieldset><legend>Choose your editor theme</legend><div class="themes">
${themes.map(({ id, label, preview }) => `<label><input type="radio" name="theme" value="${id}" ${id === current ? 'checked' : ''}>
<span class="card"><img class="preview" src="${asset('themes/' + preview)}" alt=""><span class="caption">${label}<span class="mark" aria-hidden="true">✓</span></span></span></label>`).join('')}
</div></fieldset><p>You can change this later in Preferences → Color Theme.</p>
<footer><button type="button" class="primary">Done</button></footer>
<p role="alert" hidden>Couldn’t save your theme. Choose it again to retry.</p></main>
<script nonce="${nonce}">
const api = acquireVsCodeApi();
const choices = document.querySelector('fieldset');
const alert = document.querySelector('[role=alert]');
choices.onchange = event => {
	alert.hidden = true;
	api.postMessage(event.target.value);
};
document.querySelector('footer button').onclick = () => api.postMessage('done');
window.onmessage = ({ data }) => {
	if (choices.querySelector(':checked')?.value !== data.failed) { return; }
	for (const choice of choices.querySelectorAll('input')) { choice.checked = choice.value === data.current; }
	alert.hidden = false;
};
</script></body></html>`;
	}));
}
