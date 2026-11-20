/* Copyright (c) Otrion contributors. Licensed under the MIT License. */

import * as vscode from 'vscode';

export function chatHtml(web: vscode.Webview, media: vscode.Uri, scripts: vscode.Uri) {
	const resource = (dir: vscode.Uri, file: string) => web.asWebviewUri(vscode.Uri.joinPath(dir, file));
	const icon = (path: string) => `<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="${path}"/></svg>`;
	const arrow = icon('M12 19V5m-6 6 6-6 6 6');
	return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${web.cspSource} https: data:; style-src ${web.cspSource}; script-src ${web.cspSource};">
<link rel="stylesheet" href="${resource(media, 'chat.css')}">
</head><body>
	<main id="thread">
		<section id="welcome" aria-label="New conversation">
			<img src="${resource(media, 'orbit.svg')}" alt="">
			<h1 id="welcome-title">Otrion Chat</h1>
			<div id="home" hidden>
				<button id="home-new" aria-controls="session-menu" aria-expanded="false" type="button"><span aria-hidden="true">＋</span> New chat</button>
				<h2>Recent conversations</h2>
				<div id="recent-list"></div>
				<p id="recent-status" role="status"></p>
			</div>
		</section>
		<section id="messages" aria-label="Conversation messages"></section>
	</main>
	<section id="session-menu" class="popover" aria-labelledby="session-menu-title" hidden>
		<h2 id="session-menu-title"></h2>
		<input id="history-search" type="search" aria-label="Filter session history" placeholder="Find a session…" hidden>
		<div id="session-choices" class="menu-choices"></div>
		<p id="history-status" role="status"></p>
		<p id="no-matches" hidden>No sessions found.</p>
	</section>
	<div id="agent-drop" hidden><span>Drop to add to agent</span></div>
	<footer hidden>
		<div id="status" role="status"></div>
		<section id="setup" aria-labelledby="setup-title" hidden>
			<div role="status"><strong id="setup-title"></strong><p id="setup-text"></p></div>
			<div class="setup-actions"><button id="configure" type="button"></button><button type="button" id="retry-connection" hidden>Retry connection</button></div>
		</section>
		<section id="model-panel" tabindex="-1" class="popover" aria-label="Model settings" hidden>
			<h2>Model</h2>
			<div id="model-options"></div>
			<p id="option-note" role="status"></p>
		</section>
		<section id="choice-panel" class="popover menu-choices" aria-label="Option choices" hidden></section>
		<section id="mode-panel" class="popover" aria-label="Agent mode" hidden>
			<h2>Agent mode</h2>
			<div id="mode-options" class="menu-choices"></div>
			<p id="mode-note" role="status"></p>
		</section>
		<section id="suggestions" class="popover menu-choices" role="listbox" aria-label="Composer suggestions" hidden></section>
		<form aria-label="Message composer">
			<div id="input" contenteditable="true" role="textbox" aria-multiline="true" aria-label="Chat message" aria-controls="suggestions" aria-autocomplete="list" data-placeholder="Ask about your code, @ for context, / for commands…"></div>
			<div class="controls">
				<button id="mode" type="button" aria-label="Agent mode" aria-controls="mode-panel" aria-expanded="false" title="Agent mode">Mode</button>
				<button id="model" type="button" aria-controls="model-panel" aria-expanded="false" aria-label="Model settings"><span id="model-name">Model</span></button>
				<button id="context" type="button" class="icon-button" aria-controls="context-panel" aria-expanded="false" aria-label="Session context">
					<svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="7" class="track"/><circle id="usage-ring" cx="10" cy="10" r="7" pathLength="100" stroke-dasharray="0 100" transform="rotate(-90 10 10)"/></svg>
				</button>
				<button id="attach" type="button" class="icon-button" aria-label="Attach files" title="Attach files">${icon('M8 13l7-7a3 3 0 0 1 4.2 4.2l-9 9a5 5 0 0 1-7.1-7.1l9.2-9.2m-6.2 12.2a1.4 1.4 0 0 0 2 2l8.4-8.4')}</button>
				<button id="send" class="primary" type="submit" aria-label="Send message" title="Send message (Enter)" disabled>${arrow}</button>
				<button id="stop" class="primary" type="button" aria-label="Stop response" title="Stop response" hidden><span class="square"></span></button>
			</div>
		</form>
		<section id="context-panel" class="popover" aria-label="Session context" hidden>
			<h2>Session context</h2>
			<div class="context-row"><span>Workspace</span><strong id="workspace"></strong></div>
			<div class="context-row"><span>Context window</span><strong id="context-percent"></strong></div>
			<progress id="usage-bar" max="100" hidden></progress>
			<p id="context-info"></p>
		</section>
	</footer>
	<script src="${resource(media, 'markdown.js')}"></script>
	<script src="${resource(scripts, 'composer.js')}"></script>
	<script src="${resource(scripts, 'transcriptView.js')}"></script>
	<script src="${resource(scripts, 'chat.js')}"></script>
</body></html>`;
}
