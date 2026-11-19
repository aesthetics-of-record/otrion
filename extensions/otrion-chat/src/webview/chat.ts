/* Copyright (c) Otrion contributors. Licensed under the MIT License. */

declare function acquireVsCodeApi(): {
	postMessage(message: object): void;
	setState(state: { drafts: Record<string, Draft> }): void;
	getState(): { drafts: Record<string, Draft> } | undefined;
};

const api = acquireVsCodeApi();
const element = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
let tabId = '';
const drafts = api.getState()?.drafts ?? {};
function post(message: object) { api.postMessage({ ...message, tabId }); }
const thread = element('thread');
const welcome = element('welcome');
const messages = element('messages');
const input = element<HTMLElement>('input');
const send = element<HTMLButtonElement>('send');
const stopButton = element<HTMLButtonElement>('stop');

let agentName = '';
const statusLabel = element('status');
let allowed = false;
let trusted = false;
let busy = false;
let loaded = false;
type ChatOption = import('../sessionOptions').SessionOption;
interface SessionMetadata {
	options: ChatOption[];
	commands?: { name: string; description?: string }[];
	usage?: { used: number; size: number };
	configuring: boolean;
	connected: boolean;
	workspace?: string;
}
let metadata: SessionMetadata = { options: [], configuring: false, connected: false };
const modelButton = element<HTMLButtonElement>('model');
const contextButton = element<HTMLButtonElement>('context');
const optionRows = element('model-options');
let renderedOptions = '';

const modeButton = element<HTMLButtonElement>('mode');
const choicePanel = element('choice-panel');
let choiceTrigger: HTMLButtonElement | undefined;

function choiceButtons(option: ChatOption, trigger: HTMLElement) {
	return option.choices.map(choice => {
		const button = document.createElement('button');
		button.type = 'button';
		button.textContent = choice.name;
		if (choice.description) { button.title = choice.description; }
		button.setAttribute('aria-pressed', String(choice.value === option.current));
		button.addEventListener('click', () => {
			beginConfiguration();
			post({ type: 'setOption', id: option.id, value: choice.value });
			if (choicePanel.contains(button)) {
				closeChoices();
				element('model-panel').focus();
			} else {
				showPanel();
				trigger.focus();
			}
		});
		return button;
	});
}

function closeChoices() {
	choicePanel.hidden = true;
	choiceTrigger?.setAttribute('aria-expanded', 'false');
	choiceTrigger?.classList.remove('choice-anchor');
	choiceTrigger = undefined;
}

function updateMetadata(data: SessionMetadata) {
	const commandsChanged = metadata.commands !== data.commands && JSON.stringify(metadata.commands) !== JSON.stringify(data.commands);
	metadata = data;
	if (commandsChanged && !suggestions.hidden && input.textContent.startsWith('/')) { suggest(); }
	const { options, usage, workspace, connected, configuring } = data;
	const model = options.find(option => option.kind === 'model');
	const modelLabel = model?.choices.find(choice => choice.value === model.current)?.name ?? 'Model';
	element('model-name').textContent = modelLabel;
	modelButton.title = modelLabel + ' · Model settings';
	// Usage notifications should preserve menu focus.
	const key = JSON.stringify(options);
	if (key !== renderedOptions) {
		renderedOptions = key;
		closeChoices();
		optionRows.replaceChildren();
		const mode = options.find(item => item.kind === 'mode');
		modeButton.textContent = mode?.choices.find(choice => choice.value === mode.current)?.name ?? 'Mode';
		element('mode-options').replaceChildren(...(mode ? choiceButtons(mode, modeButton) : []));
		for (const kind of ['model', 'reasoning', 'fast']) {
			const option = options.find(item => item.kind === kind);
			if (!option) { continue; }
			const isSwitch = typeof option.current === 'boolean' || (kind === 'fast' && ['on', 'off'].every(value => option.choices.some(choice => choice.value === value)));
			if (!isSwitch) {
				const list = document.createElement('div');
				list.className = 'model-list menu-choices';
				list.setAttribute('role', 'group');
				list.setAttribute('aria-label', option.kind);
				if (kind === 'model') {
					list.append(...choiceButtons(option, modelButton));
					optionRows.append(list);
				} else {
					const row = document.createElement('button');
					row.type = 'button';
					row.className = 'option-row';
					row.setAttribute('aria-controls', 'choice-panel');
					row.setAttribute('aria-expanded', 'false');
					const value = document.createElement('span');
					value.textContent = (option.choices.find(c => c.value === option.current)?.name ?? '') + ' ›';
					row.append(kind === 'reasoning' ? 'Reasoning' : 'Fast mode', value);
					row.addEventListener('click', () => {
						const opening = choiceTrigger !== row;
						closeChoices();
						if (!opening) { return; }
						choiceTrigger = row;
						row.classList.add('choice-anchor');
						row.setAttribute('aria-expanded', 'true');
						choicePanel.setAttribute('aria-label', kind === 'reasoning' ? 'Reasoning' : 'Fast mode');
						choicePanel.replaceChildren(...choiceButtons(option, modelButton));
						choicePanel.hidden = false;
						choicePanel.querySelector<HTMLElement>('button[aria-pressed=true]')?.focus();
					});
					optionRows.append(row);
				}
				continue;
			}
			const label = document.createElement('label');
			label.textContent = kind === 'reasoning' ? 'Reasoning' : 'Fast mode';
			label.title = option.description ?? '';
			const control = document.createElement('input');
			control.type = 'checkbox';
			control.checked = option.current === true || option.current === 'on';
			control.setAttribute('role', 'switch');
			control.setAttribute('aria-label', label.textContent);
			control.addEventListener('change', () => {
				const value = typeof option.current === 'boolean' ? control.checked : control.checked ? 'on' : 'off';
				beginConfiguration();
				renderedOptions = '';
				post({ type: 'setOption', id: option.id, value });
			});
			label.append(control);
			optionRows.append(label);
		}
	}
	for (const field of Array.from(document.querySelectorAll<HTMLInputElement | HTMLButtonElement>('#model-options :is(input, button), #mode-options button, #choice-panel button'))) {
		field.disabled = busy || configuring;
	}
	const note = element('option-note');
	note.textContent = configuring ? 'Loading settings…' : !allowed || !trusted ? 'Enable the agent in a trusted workspace to see its options.'
		: !connected ? 'Open model settings to connect to the agent.' : !options.length ? 'This session has no model options.' : '';
	if (!configuring && document.activeElement === element('model-panel')) {
		optionRows.querySelector<HTMLButtonElement>('.option-row')?.focus();
	}
	note.hidden = !note.textContent;
	const modeNote = element('mode-note');
	modeNote.textContent = configuring ? 'Loading modes…' : !allowed || !trusted ? 'Enable the agent in a trusted workspace.'
		: connected && !options.some(o => o.kind === 'mode') ? 'This agent exposes no session modes.' : '';
	modeNote.hidden = !modeNote.textContent;
	element('workspace').textContent = workspace || 'Empty workspace';
	const pct = usage ? Math.min(100, Math.round(100 * usage.used / usage.size)) : 0;
	element('context-percent').textContent = usage ? pct + '%' : 'Awaiting usage';
	element('context-info').textContent = usage
		? usage.used.toLocaleString() + ' of ' + usage.size.toLocaleString() + ' tokens used'
		: 'Usage appears when the agent reports its context window.';
	const bar = element<HTMLProgressElement>('usage-bar');
	bar.hidden = !usage;
	bar.value = pct;
	document.getElementById('usage-ring')!.setAttribute('stroke-dasharray', pct + ' 100');
	contextButton.setAttribute('aria-label', usage ? 'Session context, ' + pct + '% used' : 'Session context');
}

function beginConfiguration() {
	updateMetadata({ ...metadata, configuring: true });
	updateComposer();
}

type SessionChoice = { id: string; label: string; detail?: string; cwd?: string };
const sessionMenu = element('session-menu');
const historySearch = element<HTMLInputElement>('history-search');
let menuKind: 'new' | 'history' = 'new';
let historyRequest = 0;
const historyStatus = element('history-status');
let sessionChoices: SessionChoice[] = [];

function renderSessionChoices() {
	const list = element('session-choices');
	const focusedId = document.activeElement instanceof HTMLButtonElement ? document.activeElement.dataset.choice : undefined;
	const query = historySearch.value.toLowerCase().trim();
	list.replaceChildren();
	for (const item of sessionChoices) {
		if (!(item.label + ' ' + (item.detail ?? '') + ' ' + (item.cwd ?? '')).toLowerCase().includes(query)) { continue; }
		const button = document.createElement('button');
		const label = document.createElement('span');
		label.textContent = item.label;
		button.append(label);
		button.dataset.choice = item.id;
		button.title = [item.label, item.cwd].filter(Boolean).join('\n');
		if (item.detail) {
			const detail = document.createElement('small');
			detail.textContent = [item.detail, item.cwd].filter(Boolean).join(' · ');
			button.append(detail);
		}
		button.addEventListener('click', () => {
			sessionMenu.hidden = true;
			element('home-new').setAttribute('aria-expanded', 'false');
			post({ type: menuKind === 'new' ? 'newSession' : 'openHistory', id: item.id });
		});
		list.append(button);
		if (item.id === focusedId) { button.focus({ preventScroll: true }); }
	}
	element('no-matches').hidden = !!list.childElementCount || !!historyStatus.textContent;
}

historySearch.addEventListener('input', renderSessionChoices);
document.addEventListener('keydown', event => {
	const panel = event.target instanceof Element ? event.target.closest('.popover') : null;
	if (!panel || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) { return; }
	if (event.target === historySearch && (event.key === 'Home' || event.key === 'End')) { return; }
	const items = Array.from(panel.querySelectorAll<HTMLElement>('button:enabled, summary, input:enabled')).filter(el => el.checkVisibility());
	if (!items.length) { return; }
	const index = items.indexOf(document.activeElement as HTMLElement);
	const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1
		: (index + (event.key === 'ArrowUp' ? -1 : 1) + items.length) % items.length;
	event.preventDefault();
	items[next].focus();
});

const contextPanel = element('context-panel');
let contextPinned = false;
let contextTimer: number | undefined;

function showPanel(which?: 'model' | 'context' | 'mode') {
	clearTimeout(contextTimer);
	contextPinned = false;
	hideSuggestions();
	if (!sessionMenu.hidden && menuKind === 'history') { post({ type: 'endHistory' }); }
	sessionMenu.hidden = true;
	element('home-new').setAttribute('aria-expanded', 'false');
	closeChoices();
	for (const id of ['model', 'context', 'mode']) {
		element(id + '-panel').hidden = id !== which;
		element(id).setAttribute('aria-expanded', String(id === which));
	}
}
function openSettingsMenu(id: 'model' | 'mode') {
	const opening = element(id + '-panel').hidden;
	showPanel(opening ? id : undefined);
	if (opening && allowed && trusted && !busy && !metadata.connected && !metadata.configuring) {
		beginConfiguration();
		post({ type: 'options' });
	}
}
modelButton.addEventListener('click', () => openSettingsMenu('model'));
modeButton.addEventListener('click', () => openSettingsMenu('mode'));
element('attach').addEventListener('click', () => requestResources({ type: 'attach' }));
contextButton.addEventListener('pointerenter', event => {
	if (event.pointerType === 'touch') { return; }
	clearTimeout(contextTimer);
	if (contextPanel.hidden && !document.querySelector('.popover:not([hidden])')) {
		contextTimer = window.setTimeout(() => showPanel('context'), 150);
	}
});
contextPanel.addEventListener('pointerenter', () => clearTimeout(contextTimer));
for (const target of [contextButton, contextPanel]) {
	target.addEventListener('pointerleave', () => {
		clearTimeout(contextTimer);
		if (!contextPinned && !contextPanel.hidden) {
			contextTimer = window.setTimeout(() => showPanel(), 160);
		}
	});
}
function leaveContextView() {
	clearTimeout(contextTimer);
	if (!contextPinned && !contextPanel.hidden) { showPanel(); }
}
window.addEventListener('blur', leaveContextView);
document.addEventListener('mouseout', event => { if (!event.relatedTarget) { leaveContextView(); } });
contextButton.addEventListener('click', () => {
	const open = !contextPinned;
	showPanel(open ? 'context' : undefined);
	contextPinned = open;
});
document.addEventListener('click', event => {
	if (event.target instanceof Element && !event.target.closest('.popover, #model, #mode, #context, #input, #home-new')) { showPanel(); }
});
document.addEventListener('keydown', event => {
	if (event.key === 'Escape') {
		if (!choicePanel.hidden) { choiceTrigger?.focus(); closeChoices(); return; }
		if (!sessionMenu.hidden) { showPanel(); if (tabId) { input.focus(); } else { element('home-new').focus(); } return; }
		const trigger = !element('mode-panel').hidden ? modeButton : !element('model-panel').hidden ? modelButton : !element('context-panel').hidden ? contextButton : undefined;
		if (trigger) { showPanel(); trigger.focus(); }
	}
});

function updateComposer() {
	const agent = agentName;
	input.contentEditable = String(loaded);
	send.hidden = busy;
	send.disabled = !allowed || !trusted || !input.textContent.trim() || !loaded || metadata.configuring;
	element<HTMLButtonElement>('attach').disabled = !allowed || !trusted || busy || !loaded;
	stopButton.hidden = !busy;
	element('setup').hidden = !loaded || (allowed && trusted);
	element('setup-text').textContent = trusted ? 'Enable ' + agent + ' to chat.' : 'Chat requires a trusted workspace.';
	element('configure').textContent = trusted ? 'Agent settings' : 'Manage trust';
}

function saveDraft() {
	if (tabId) {
		drafts[tabId] = readDraft(input);
		api.setState({ drafts });
		post({ type: 'draft', parts: drafts[tabId] });
	}
	updateComposer();
}

const suggestions = element('suggestions');
let suggestionRequest = 0;
let suggestionIndex = 0;
let searchTimer: number | undefined;
let suggestionRange: Range | undefined;
let lastCaret: Range | undefined;
let insertionId = 0;
const insertions = new Map<number, { tab: string; range: Range | undefined; before: DraftPart[]; after: DraftPart[] }>();
document.addEventListener('selectionchange', () => {
	const range = currentRange(input);
	if (range) { lastCaret = range; }
});
function requestResources(message: object) {
	const range = currentRange(input) ?? lastCaret;
	const before = document.createRange();
	const after = document.createRange();
	before.selectNodeContents(input);
	after.selectNodeContents(input);
	if (range && input.contains(range.commonAncestorContainer)) {
		before.setEnd(range.startContainer, range.startOffset);
		after.setStart(range.endContainer, range.endOffset);
	} else { after.collapse(false); }
	const request = ++insertionId;
	insertions.set(request, { tab: tabId, range, before: readDraft(before.cloneContents()), after: readDraft(after.cloneContents()) });
	post({ ...message, request });
}
type Suggestion = { label: string; description?: string; uri?: string; action?: string };
let choices: Suggestion[] = [];

function hideSuggestions() {
	clearTimeout(searchTimer);
	suggestionRequest++;
	suggestions.hidden = true;
	suggestions.replaceChildren();
	choices = [];
	input.removeAttribute('aria-activedescendant');
}

function highlight(index: number) {
	suggestionIndex = index;
	for (const [i, row] of Array.from(suggestions.children).entries()) {
		row.setAttribute('aria-selected', String(i === index));
	}
	const active = suggestions.children[index];
	if (active) {
		input.setAttribute('aria-activedescendant', active.id);
		active.scrollIntoView({ block: 'nearest' });
	}
}

function selectSuggestion(choice: Suggestion) {
	const replacement = choice.uri || choice.action ? '' : '/' + choice.label + ' ';
	placeRange(input, suggestionRange);
	if (choice.uri) {
		const components = choice.label.split('/').filter(Boolean);
		insertChips(input, [{ type: 'resource_link', uri: choice.uri, name: components.at(-1) ?? choice.label, folder: choice.label.endsWith('/') }], suggestionRange);
	} else if (replacement) { document.execCommand('insertText', false, replacement); }
	else { document.execCommand('delete'); }
	hideSuggestions();
	saveDraft();
	input.focus();
	if (choice.action === 'attach' || choice.action === 'folder') { requestResources({ type: 'attach', folder: choice.action === 'folder' }); }
	else if (choice.action === 'mode' || choice.action === 'model') { openSettingsMenu(choice.action); }
}

function renderSuggestions(items: Suggestion[], empty: string) {
	choices = items;
	suggestions.replaceChildren();
	for (const [i, choice] of items.entries()) {
		const button = document.createElement('button');
		button.id = 'suggestion-' + i;
		button.tabIndex = -1;
		button.setAttribute('role', 'option');
		button.textContent = choice.uri ? choice.label : '/' + choice.label;
		button.title = choice.description ?? choice.label;
		if (choice.description) {
			const detail = document.createElement('small');
			detail.textContent = choice.description;
			button.append(detail);
		}
		button.addEventListener('mousedown', e => e.preventDefault());
		button.addEventListener('click', () => selectSuggestion(choice));
		suggestions.append(button);
	}
	if (!items.length) { suggestions.textContent = empty; }
	suggestions.hidden = false;
	highlight(0);
}

function commandChoices(query: string) {
	const commands: Suggestion[] = [...(metadata.commands ?? [])].map(c => ({ label: c.name, description: c.description }));
	for (const [action, description] of [['attach', 'Attach files'], ['folder', 'Attach folders'], ['mode', 'Choose agent mode'], ['model', 'Choose model']]) {
		if (!commands.some(c => c.label === action)) { commands.push({ label: action, action, description }); }
	}
	return commands.filter(c => c.label.toLowerCase().startsWith(query.toLowerCase()));
}

function suggest() {
	hideSuggestions();
	const caret = currentRange(input);
	if (!tabId || !allowed || !trusted || busy || !caret?.collapsed || caret.startContainer.nodeType !== Node.TEXT_NODE) { return; }
	const node = caret.startContainer;
	const value = node.textContent ?? '';
	const before = value.slice(0, caret.startOffset);
	const mention = /(?:^|\s)@([^\s@]*)$/.exec(before);
	const slash = /^\/([^\s/]*)$/.exec(before);
	if (!mention && (!slash || input.firstChild !== node)) { return; }
	const query = (mention ?? slash)![1];
	suggestionRange = document.createRange();
	suggestionRange.setStart(node, before.length - query.length - 1);
	suggestionRange.setEnd(node, caret.endOffset + (/^[^\s]*/.exec(value.slice(caret.endOffset))?.[0].length ?? 0));
	if (mention) {
		const request = suggestionRequest;
		renderSuggestions([], 'Searching files and folders…');
		searchTimer = window.setTimeout(() => post({ type: 'findContext', query, request }), 90);
	} else {
		renderSuggestions(commandChoices(query), 'No matching commands');
	}
}

let recentRequest = 0;
element('home-new').addEventListener('click', () => post({ type: 'chooseAgent' }));

function renderRecent(items: SessionChoice[], status: string) {
	const list = element('recent-list');
	const focused = (document.activeElement as HTMLElement | null)?.dataset.recent;
	list.replaceChildren();
	for (const item of items) {
		const row = document.createElement('button');
		row.type = 'button';
		row.dataset.recent = item.id;
		const title = document.createElement('span');
		title.textContent = item.label;
		const detail = document.createElement('small');
		detail.textContent = [item.detail, item.cwd?.split(/[\\/]/).filter(Boolean).at(-1)].filter(Boolean).join(' · ');
		row.title = [item.label, item.cwd].filter(Boolean).join('\n');
		row.append(title, detail);
		row.addEventListener('click', () => post({ type: 'openHistory', home: true, id: item.id }));
		list.append(row);
		if (focused === item.id) { row.focus(); }
	}
	element('recent-status').textContent = status || (items.length ? '' : 'No recent conversations.');
}

const nearEnd = () => thread.scrollHeight - thread.clientHeight - thread.scrollTop < 48;
window.addEventListener('message', ({ data }) => {
	if (data.type === 'refreshIcons') {
		input.querySelectorAll<HTMLElement>('.resource-chip').forEach(requestChipIcon);
	} else if (data.type === 'fileIcon' && Number.isSafeInteger(data.request)) {
		const img = input.querySelector<HTMLImageElement>(`[data-icon-request="${data.request}"] > img`);
		if (img) {
			img.hidden = !data.src;
			if (data.src) { img.src = data.src; }
		}
	} else if (data.type === 'resourceDrag') {
		element('agent-drop').hidden = !(data.over && tabId && trusted && allowed && !busy);
	} else if (data.type === 'droppedResources') {
		element('agent-drop').hidden = true;
		if (tabId && trusted && allowed && !busy) { requestResources({ type: 'addResources', uris: data.uris }); }
	} else if (data.type === 'insertResources') {
		const target = insertions.get(data.request);
		insertions.delete(data.request);
		if (!target || target.tab !== data.tabId || !data.parts.length) { return; }
		if (target.tab === tabId) {
			insertChips(input, data.parts, target.range);
			hideSuggestions();
			saveDraft();
		} else {
			drafts[target.tab] = [...target.before, ...data.parts, ...target.after];
			api.setState({ drafts });
		}
	} else if (data.type === 'forgetDraft') {
		delete drafts[data.tabId];
		api.setState({ drafts });
	} else if (data.type === 'restoreDraft') {
		if (data.tabId === tabId && !input.textContent) {
			renderDraft(input, data.parts);
			saveDraft();
		} else if (data.tabId !== tabId && !drafts[data.tabId]?.length) {
			drafts[data.tabId] = data.parts;
			api.setState({ drafts });
		}
	} else if (data.type === 'contextMatches') {
		if (data.tabId === tabId && data.request === suggestionRequest) { renderSuggestions(data.items, 'No matching files or folders'); }
	} else if (data.type === 'sessionMenu') {
		const dismiss = !sessionMenu.hidden && menuKind === data.menu && sessionMenu.classList.contains('from-home') === !!data.home;
		showPanel();
		if (dismiss) { return; }
		menuKind = data.menu;
		sessionChoices = data.items;
		historyStatus.textContent = menuKind === 'history' ? 'Loading sessions…' : '';
		if (menuKind === 'history') { post({ type: 'listHistory', request: ++historyRequest }); }
		historySearch.value = '';
		historySearch.hidden = menuKind !== 'history';
		element('session-menu-title').textContent = menuKind === 'new' ? 'New session' : 'Session history';
		renderSessionChoices();
		sessionMenu.classList.toggle('from-home', !!data.home);
		element('home-new').setAttribute('aria-expanded', String(!!data.home));
		sessionMenu.hidden = false;
		(menuKind === 'history' ? historySearch : sessionMenu.querySelector('button'))?.focus();
	} else if (data.type === 'historyPage' && data.home) {
		if (!loaded && data.request === recentRequest) { renderRecent(data.items, data.status); }
	} else if (data.type === 'historyPage' && !sessionMenu.hidden && menuKind === 'history' && data.request === historyRequest) {
		sessionChoices = data.items;
		historyStatus.textContent = data.status;
		renderSessionChoices();
	} else if (data.type === 'dismissHistory' && menuKind === 'history') {
		showPanel();
	} else if (data.type === 'empty') {
		element('agent-drop').hidden = true;
		showPanel();
		tabId = '';
		loaded = false;
		messages.replaceChildren();
		document.querySelector('footer')!.hidden = true;
		welcome.hidden = false;
		element('home').hidden = false;
		element('welcome-title').textContent = 'Otrion Chat';
		renderRecent([], 'Loading recent conversations…');
		post({ type: 'listHistory', home: true, request: ++recentRequest });
	} else if (data.type === 'state') {
		const follow = nearEnd() || !welcome.hidden;
		if (tabId !== data.tabId) { messages.replaceChildren(); }
		while (messages.childElementCount > data.messages.length) { messages.lastElementChild!.remove(); }
		data.messages.forEach((message: TranscriptRow, index: number) => renderTranscriptRow(index, message));
		welcome.hidden = data.messages.length > 0;
		busy = data.busy;
		allowed = data.allowed;
		trusted = data.trusted;
		loaded = true;
		element('home').hidden = true;
		agentName = data.selected === 'claude' ? 'Claude Code' : 'Codex';
		document.querySelector('footer')!.hidden = false;
		element('welcome-title').textContent = 'Start a conversation';
		if (tabId !== data.tabId) {
			showPanel();
			tabId = data.tabId;
			lastCaret = undefined;
			renderDraft(input, drafts[tabId] ?? '');
		}
		updateMetadata(data);
		statusLabel.textContent = data.status;
		statusLabel.classList.toggle('working', busy);
		element('retry-connection').hidden = !data.connectionFailed || !allowed || !trusted || data.configuring || busy;
		updateComposer();
		if (follow) { thread.scrollTop = thread.scrollHeight; }
	} else if (data.type === 'metadata') {
		updateMetadata(data);
		updateComposer();
	} else if (data.type === 'transcript' && tabId === data.tabId) {
		const follow = nearEnd();
		for (const { index, message } of data.rows) { renderTranscriptRow(index, message); }
		statusLabel.textContent = data.status;
		if (follow) { thread.scrollTop = thread.scrollHeight; }
	}
});

element('retry-connection').addEventListener('click', () => post({ type: 'options' }));
element('configure').addEventListener('click', () => post({ type: trusted ? 'settings' : 'trust' }));
document.querySelector('form')!.addEventListener('submit', event => {
	event.preventDefault();
	if (!loaded || !allowed || !trusted || busy || metadata.configuring || !input.textContent.trim()) { return; }
	showPanel();
	busy = true;
	for (const [id, target] of insertions) { if (target.tab === tabId) { insertions.delete(id); } }
	post({ type: 'send', parts: readDraft(input) });
	input.replaceChildren();
	lastCaret = undefined;
	saveDraft();
	input.focus();
});
input.addEventListener('keydown', event => {
	if (!suggestions.hidden && !event.isComposing && !event.shiftKey) {
		if (choices.length && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
			event.preventDefault();
			highlight((suggestionIndex + (event.key === 'ArrowDown' ? 1 : -1) + choices.length) % choices.length);
			return;
		}
		if (choices.length && (event.key === 'Tab' || event.key === 'Enter')) {
			event.preventDefault();
			selectSuggestion(choices[suggestionIndex]);
			return;
		}
		if (event.key === 'Escape') { event.stopPropagation(); hideSuggestions(); return; }
	}
	if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
		event.preventDefault();
		input.closest('form')?.requestSubmit();
	}
});
input.addEventListener('paste', event => {
	event.preventDefault();
	document.execCommand('insertText', false, event.clipboardData?.getData('text/plain') ?? '');
});
input.addEventListener('input', () => { saveDraft(); suggest(); });
input.addEventListener('click', suggest);
input.addEventListener('keyup', event => { if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) { suggest(); } });
input.addEventListener('blur', hideSuggestions);
stopButton.addEventListener('click', () => post({ type: 'stop' }));
saveDraft();
post({ type: 'ready', drafts });
