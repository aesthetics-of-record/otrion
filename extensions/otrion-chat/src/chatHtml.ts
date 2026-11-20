/* Copyright (c) Otrion contributors. Licensed under the MIT License. */

import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';

export function chatHtml(web: vscode.Webview, media: vscode.Uri, scripts: vscode.Uri) {
	const nonce = randomBytes(16).toString('base64');
	const resource = (dir: vscode.Uri, file: string) => web.asWebviewUri(vscode.Uri.joinPath(dir, file));
	const icon = (path: string) => `<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="${path}"/></svg>`;
	const placeholder = 'Ask about your code, @ for context, / for commands…';
	const arrow = icon('M12 19V5m-6 6 6-6 6 6');
	return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${web.cspSource} https: data:; style-src ${web.cspSource} 'nonce-${nonce}'; script-src ${web.cspSource};">
<style nonce="${nonce}">
	body { margin: 0; background: var(--vscode-sideBar-background); }
	#chat-loading:not([hidden]) { position: fixed; inset: 0; display: grid; place-content: center; justify-items: center; gap: 8px; color: var(--vscode-descriptionForeground); font: 12px var(--vscode-font-family, system-ui); opacity: 0; animation: chat-loading-in 160ms ease-out 180ms forwards; }
	@keyframes chat-loading-in { to { opacity: 1; } }
	@media (prefers-reduced-motion: reduce) { #chat-loading:not([hidden]) { animation-duration: 0s; } }
</style>
<link rel="stylesheet" href="${resource(media, 'chat.css')}">
</head><body>
	<template id="copy-action"><button type="button" class="transcript-action">${icon('M10.5 3.5h7a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-7a2 2 0 0 1-2-2v-9a2 2 0 0 1 2-2Z M4.5 7.5v11a2 2 0 0 0 2 2h9')}${icon('m4.5 12 4.3 4.3q.7.7 1.4 0l9.3-9.3')}</button></template>
	<div id="chat-loading" role="status"><img src="${resource(media, 'orbit.svg')}" width="32" height="32" alt=""><span>Loading chat…</span></div>
	<main id="thread" hidden>
		<section id="welcome" aria-label="New conversation">
			<img src="${resource(media, 'orbit.svg')}" alt="">
			<h1 id="welcome-title"></h1>
			<div id="home" hidden>
				<div id="home-setup" hidden>
					<p id="home-instruction"></p>
					<button id="home-settings" type="button">Open Otrion Settings <span aria-hidden="true">→</span></button>
				</div>
				<div id="home-sessions" hidden>
					<button id="home-new" aria-controls="session-menu" aria-expanded="false" type="button"><span aria-hidden="true">＋</span> New chat</button>
					<h2>Recent conversations</h2>
					<div id="recent-list"></div>
					<p id="recent-status" role="status"></p>
					<button id="recent-settings" class="agent-settings-link" type="button" hidden>Open agent settings</button>
				</div>
			</div>
		</section>
		<section id="messages" aria-label="Conversation messages"></section>
	</main>
	<section id="session-menu" class="popover" aria-labelledby="session-menu-title" hidden>
		<h2 id="session-menu-title"></h2>
		<input id="history-search" type="search" aria-label="Filter session history" placeholder="Find a session…" hidden>
		<div id="session-choices" class="menu-choices"></div>
		<p id="history-status" role="status"></p>
		<button id="history-settings" class="agent-settings-link" type="button" hidden>Open agent settings</button>
		<p id="no-matches" hidden>No sessions found.</p>
	</section>
	<div id="agent-drop" hidden><span>Drop to add to agent</span></div>
	<footer hidden>
		<input id="image-picker" type="file" accept="image/png,image/jpeg,image/webp,image/gif" multiple hidden>
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
			<div id="attached-images" class="image-strip" role="group" aria-label="Attached images" hidden></div>
			<div class="composer-text">
				<div id="input" contenteditable="plaintext-only" role="textbox" aria-multiline="true" aria-label="Chat message" aria-controls="suggestions" aria-autocomplete="list" aria-placeholder="${placeholder}"></div>
				<span class="composer-placeholder" aria-hidden="true">${placeholder}</span>
			</div>
			<div class="controls">
				<button id="mode" type="button" aria-label="Agent mode" aria-controls="mode-panel" aria-expanded="false" title="Agent mode">Mode</button>
				<button id="model" type="button" aria-controls="model-panel" aria-expanded="false" aria-label="Model settings"><span id="model-name">Model</span></button>
				<button id="context" type="button" class="icon-button" aria-controls="context-panel" aria-expanded="false" aria-label="Session context">
					<svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="7" class="track"/><circle id="usage-ring" cx="10" cy="10" r="7" pathLength="100" stroke-dasharray="0 100" transform="rotate(-90 10 10)"/></svg>
				</button>
				<button id="attach-image" type="button" class="icon-button" aria-label="Attach images" title="Attach images">${icon('M3 5h18v14H3z M3 16l5-5 4 4 3-3 6 6 M16 9h.01')}</button>
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
