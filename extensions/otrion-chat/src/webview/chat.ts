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

let attachedImages: InlineImage[] = [];
let readingImages = false;
let agentName = '';
let connectionIssue: 'setup' | 'connection' | undefined;
const statusLabel = element('status');
let allowed = false;
let trusted = false;
let busy = false;
let loaded = false;
type ChatOption = import('../sessionOptions').SessionOption;
interface SessionMetadata {
	recordedModel?: string;
	options: ChatOption[];
	commands?: { name: string; description?: string }[];
	configuring: boolean;
	connected: boolean;
	workspace?: string;
	cwd?: string;
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
	const { options, workspace, connected, configuring } = data;
	const model = options.find(option => option.kind === 'model');
	const modelLabel = model?.choices.find(choice => choice.value === model.current)?.name ?? (typeof model?.current === 'string' ? model.current : 'Model');
	const warning = element<HTMLDetailsElement>('resume-warning');
	const mismatch = data.recordedModel && model && model.current !== data.recordedModel && connected && !configuring;
	warning.hidden = !mismatch;
	if (!mismatch) { warning.open = false; }
	element('resume-warning-detail').textContent = mismatch ? `This session used ${data.recordedModel}. Current model: ${modelLabel}.` : '';
	element('model-name').textContent = modelLabel;
	modelButton.title = modelLabel + ' · Model settings';
	// Keep menu focus when unrelated metadata changes.
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
}

function beginConfiguration() {
	updateMetadata({ ...metadata, configuring: true });
	updateComposer();
}

type SessionChoice = { id: string; label: string; detail?: string; cwd?: string; agent?: string; updatedAt?: string; active?: boolean };
const sessionMenu = element('session-menu');
const historySearch = element<HTMLInputElement>('history-search');
let menuKind: 'new' | 'history' = 'new';
let historyRequest = 0;
const historyStatus = element('history-status');
let sessionChoices: SessionChoice[] = [];

function sessionLogo(button: HTMLButtonElement, agent: string) {
	button.dataset.agent = agent;
	const logo = document.createElement('span');
	logo.className = 'agent-icon';
	logo.setAttribute('aria-hidden', 'true');
	button.append(logo);
}

function sessionDate(value?: string) {
	const date = new Date(value ?? '');
	if (!Number.isFinite(date.getTime())) { return { group: 'Other sessions', age: '' }; }
	const today = new Date();
	const day = (d: Date) => Date.UTC(d.getFullYear(), d.getMonth(), d.getDate());
	const days = Math.max(0, (day(today) - day(date)) / 86400000);
	const minutes = Math.max(0, Math.floor((today.getTime() - date.getTime()) / 60000));
	const age = days ? days + 'd' : minutes >= 60 ? Math.floor(minutes / 60) + 'h' : minutes ? minutes + 'm' : 'Now';
	return { group: days === 0 ? 'Today' : days === 1 ? 'Yesterday' : days < 7 ? 'Last 7 Days' : 'Earlier', age };
}

const sessionsSidebar = element('sessions-sidebar');
const sidebarSearch = element<HTMLInputElement>('sidebar-search');
let sidebarChoices: SessionChoice[] = [];
let sidebarRequest = 0;
let sidebarPending = false;
let sidebarRefreshTimer: number | undefined;
const choiceContent = new WeakMap<HTMLButtonElement, string>();

function refreshSidebar() {
	if (!sessionsSidebar.hidden) {
		sidebarPending = true;
		post({ type: 'listHistory', sidebar: true, request: ++sidebarRequest });
	}
}

function renderSessionChoices(sidebar = false) {
	const list = element(sidebar ? 'sidebar-choices' : 'session-choices');
	const query = (sidebar ? sidebarSearch : historySearch).value.toLowerCase().trim();
	const focused = list.contains(document.activeElement) ? document.activeElement as HTMLElement : undefined;
	const previous = new Map(Array.from(list.children, child => [(child as HTMLElement).dataset.key, child as HTMLElement]));
	let position = 0;
	const place = (node: HTMLElement, key: string) => {
		previous.delete(key);
		node.dataset.key = key;
		if (list.children[position] !== node) { list.insertBefore(node, list.children[position] ?? null); }
		position++;
	};
	let group = '';
	for (const item of sidebar ? sidebarChoices : sessionChoices) {
		if (!(item.label + ' ' + (item.detail ?? '') + ' ' + (item.cwd ?? '')).toLowerCase().includes(query)) { continue; }
		const date = sessionDate(item.updatedAt);
		if ((sidebar || menuKind === 'history') && date.group !== group) {
			group = date.group;
			const key = 'group:' + group;
			const heading = previous.get(key) ?? document.createElement('h3');
			if (heading.textContent !== group) { heading.textContent = group; }
			place(heading, key);
		}
		const key = 'choice:' + item.id;
		let button = previous.get(key) as HTMLButtonElement | undefined;
		if (!button) {
			button = document.createElement('button');
			button.dataset.choice = item.id;
			button.addEventListener('click', () => {
				if (!sidebar) {
					sessionMenu.hidden = true;
					element('home-new').setAttribute('aria-expanded', 'false');
				}
				post({ type: !sidebar && menuKind === 'new' ? 'newSession' : 'openHistory', sidebar, id: item.id });
			});
		}
		const content = JSON.stringify([item.agent, item.label, item.detail, item.cwd, date.age]);
		if (choiceContent.get(button) !== content) {
			button.replaceChildren();
			sessionLogo(button, item.agent ?? item.id);
			const label = document.createElement('span');
			label.textContent = item.label;
			button.append(label);
			button.title = [item.detail, item.label, item.cwd].filter(Boolean).join('\n');
			button.setAttribute('aria-label', [item.detail, item.label, date.age].filter(Boolean).join(' · '));
			if (item.detail) {
				const detail = document.createElement('small');
				detail.textContent = date.age;
				button.append(detail);
			}
			choiceContent.set(button, content);
		}
		if (item.active) { button.setAttribute('aria-current', 'true'); } else { button.removeAttribute('aria-current'); }
		place(button, key);
	}
	for (const node of previous.values()) { node.remove(); }
	if (focused?.isConnected && document.activeElement !== focused) { focused.focus({ preventScroll: true }); }
	if (sidebar) {
		const status = element('sidebar-status');
		const text = status.dataset.status || (position ? '' : 'No sessions found.');
		if (status.textContent !== text) { status.textContent = text; }
	} else { element('no-matches').hidden = !!position || !!historyStatus.textContent; }
}

historySearch.addEventListener('input', () => renderSessionChoices());
sidebarSearch.addEventListener('input', () => renderSessionChoices(true));
element('history-close').addEventListener('click', () => {
	showPanel();
	(tabId ? input : element('home-new')).focus();
});
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
window.addEventListener('blur', () => {
	if (!element('model-panel').hidden) { showPanel(); }
	else { leaveContextView(); }
});
document.addEventListener('mouseout', event => { if (!event.relatedTarget) { leaveContextView(); } });
contextButton.addEventListener('click', () => {
	const open = !contextPinned;
	showPanel(open ? 'context' : undefined);
	contextPinned = open;
});
document.addEventListener('pointerdown', event => {
	if (!(event.target instanceof Element) || event.target.closest('.popover, #model, #mode, #context, #home-new')) { return; }
	if (input.contains(event.target) && element('model-panel').hidden && element('mode-panel').hidden) { return; }
	showPanel();
}, true);
document.addEventListener('keydown', event => {
	if (event.key === 'Escape') {
		if (!choicePanel.hidden) { choiceTrigger?.focus(); closeChoices(); return; }
		if (!sessionMenu.hidden) { showPanel(); if (tabId) { input.focus(); } else { element('home-new').focus(); } return; }
		const trigger = !element('mode-panel').hidden ? modeButton : !element('model-panel').hidden ? modelButton : !element('context-panel').hidden ? contextButton : undefined;
		if (trigger) { showPanel(); trigger.focus(); }
	}
});

const defaultPlaceholder = input.getAttribute('aria-placeholder')!;
const composerPlaceholder = document.querySelector<HTMLElement>('.composer-placeholder')!;
function updateComposer() {
	input.contentEditable = loaded ? 'plaintext-only' : 'false';
	const hasDraft = !!(attachedImages.length || input.textContent.trim());
	send.hidden = busy && !hasDraft;
	send.title = busy ? 'Queue message (Enter)' : 'Send message (Enter)';
	send.setAttribute('aria-label', busy ? 'Queue message' : 'Send message');
	input.setAttribute('aria-placeholder', busy ? 'Queue a follow-up…' : defaultPlaceholder);
	composerPlaceholder.textContent = busy ? 'Queue a follow-up…' : defaultPlaceholder;
	composerPlaceholder.hidden = readDraft(input).length > 0;
	send.disabled = readingImages || connectionIssue === 'setup' || !allowed || !trusted || (!attachedImages.length && !input.textContent.trim()) || !loaded || metadata.configuring;
	element<HTMLButtonElement>('attach-image').disabled = readingImages || !allowed || !trusted || !loaded;
	element<HTMLButtonElement>('attach').disabled = !allowed || !trusted || !loaded;
	stopButton.hidden = !busy;
	modeButton.disabled = modelButton.disabled = !allowed || !trusted || connectionIssue === 'setup';
}

function renderStatus(status: string, activity?: string) {
	const text = activity ?? status;
	statusLabel.hidden = !text;
	if (statusLabel.firstElementChild!.textContent !== text) { statusLabel.firstElementChild!.textContent = text; }
	statusLabel.classList.toggle('working', !!activity);
}

function renderSetup(status: string, location: string, activity?: string) {
	const setup = element('setup');
	setup.hidden = trusted && allowed && !connectionIssue;
	renderStatus(setup.hidden ? status : '', setup.hidden ? activity : undefined);
	if (setup.hidden) { return; }
	const title = !trusted ? 'Workspace trust required' : !allowed || connectionIssue === 'setup'
		? 'Set up ' + agentName : 'Couldn’t connect to ' + agentName;
	element('setup-title').textContent = title;
	element('setup-text').textContent = !trusted ? 'Trust this workspace to use agent chat.' : !allowed
		? 'Enable the agent ' + location + ' to start chatting.' : status;
	element('configure').textContent = trusted ? 'Open Otrion Settings' : 'Manage workspace trust';
	element('retry-connection').hidden = !trusted || !allowed || !connectionIssue || busy || metadata.configuring;
	setup.classList.toggle('retry-first', connectionIssue === 'connection' && trusted && allowed);
}

function renderImageStrip() {
	const strip = element('attached-images');
	const previews = attachedImages.map(image => ({ label: image.name, image: 'data:' + image.mimeType + ';base64,' + image.data }));
	strip.hidden = !previews.length;
	strip.replaceChildren(...previews.map((image, index) => {
		const item = document.createElement('div');
		item.className = 'attached-image';
		const remove = document.createElement('button');
		remove.type = 'button';
		remove.className = 'remove-image';
		remove.title = 'Remove ' + image.label;
		remove.setAttribute('aria-label', remove.title);
		remove.textContent = '×';
		remove.addEventListener('click', event => {
			attachedImages.splice(index, 1);
			renderImageStrip();
			saveDraft();
			const nextThumbnail = strip.children[Math.min(index, attachedImages.length - 1)]?.querySelector('button');
			if (!event.detail && nextThumbnail) { nextThumbnail.focus(); }
			else { placeRange(input, lastCaret); }
		});
		item.append(imageThumbnail(previews, index), remove);
		return item;
	}));
}

function renderDraft(draft: Draft) {
	attachedImages = [];
	input.replaceChildren();
	if (typeof draft === 'string') { input.textContent = draft; }
	else {
		for (const part of draft) {
			if (part.type === 'image') { attachedImages.push(part); }
			else { input.append(part.type === 'text' ? part.text : resourceChip(part)); }
		}
	}
	renderImageStrip();
}

function composerDraft() {
	return [...attachedImages, ...readDraft(input)];
}

function saveDraft() {
	if (tabId) {
		drafts[tabId] = composerDraft();
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
	if (choice.action === 'image') { element('image-picker').click(); }
	else if (choice.action === 'attach' || choice.action === 'folder') { requestResources({ type: 'attach', folder: choice.action === 'folder' }); }
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
	for (const [action, description] of [['image', 'Add images from this device'], ['attach', 'Attach files'], ['folder', 'Attach folders'], ['mode', 'Choose agent mode'], ['model', 'Choose model']]) {
		if (!commands.some(c => c.label === action)) { commands.push({ label: action, action, description }); }
	}
	return commands.filter(c => c.label.toLowerCase().startsWith(query.toLowerCase()));
}

function suggest() {
	hideSuggestions();
	const caret = currentRange(input);
	if (!tabId || !allowed || !trusted || !caret?.collapsed || caret.startContainer.nodeType !== Node.TEXT_NODE) { return; }
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
element('home-settings').addEventListener('click', () => post({ type: 'settings' }));
element('home-new').addEventListener('click', () => post({ type: 'chooseAgent' }));

for (const button of document.querySelectorAll<HTMLButtonElement>('.agent-settings-link')) {
	button.addEventListener('click', () => post({ type: 'settings', target: button.dataset.target }));
}
function historySettings(id: string, target?: string) {
	const button = element(id);
	button.hidden = !target;
	button.dataset.target = target ?? '';
}

function renderRecent(items: SessionChoice[], status: string, settingsTarget?: string) {
	historySettings('recent-settings', settingsTarget);
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
		if (item.agent) { sessionLogo(row, item.agent); }
		row.append(title, detail);
		row.addEventListener('click', () => post({ type: 'openHistory', home: true, id: item.id }));
		list.append(row);
		if (focused === item.id) { row.focus(); }
	}
	element('recent-status').textContent = status || (items.length ? '' : 'No recent conversations.');
}

function renderQueue(items: { id: string; label: string }[], canSteer: boolean, delivering: boolean, error: string) {
	const panel = element('follow-ups');
	panel.hidden = !items.length;
	element('queue-count').textContent = items.length + ' queued';
	element('queue-error').textContent = error;
	const list = element('queue-list');
	list.replaceChildren(...items.map(item => {
		const row = document.createElement('div');
		row.className = 'queued-message';
		const label = document.createElement('span');
		label.textContent = label.title = item.label;
		const deliver = document.createElement('button');
		deliver.type = 'button';
		deliver.textContent = busy ? 'Steer now' : 'Send now';
		deliver.title = busy ? 'Add to the current turn' : 'Send this message';
		deliver.disabled = delivering || !trusted || !allowed || metadata.configuring || (busy && !canSteer);
		if (busy && !canSteer) { deliver.title = 'Waiting for the next turn'; }
		deliver.onclick = () => post({ type: 'sendQueued', id: item.id });
		const remove = document.createElement('button');
		remove.type = 'button';
		remove.textContent = '×';
		remove.title = 'Remove queued message';
		remove.setAttribute('aria-label', remove.title);
		remove.disabled = delivering;
		remove.onclick = () => post({ type: 'discardQueued', id: item.id });
		row.append(label, deliver, remove);
		return row;
	}));
}

const nearEnd = () => thread.scrollHeight - thread.clientHeight - thread.scrollTop < 48;
window.addEventListener('message', ({ data }) => {
	if (data.type === 'empty' || data.type === 'state') {
		element('chat-loading').hidden = true;
		thread.hidden = false;
	}
	if (data.type === 'copied') {
		confirmCopy(data.request);
	} else if (data.type === 'refreshIcons') {
		input.querySelectorAll<HTMLElement>('.resource-chip').forEach(requestChipIcon);
		messages.querySelectorAll<HTMLElement>('.edit-file-icon').forEach(requestEditIcon);
	} else if (data.type === 'fileIcon' && Number.isSafeInteger(data.request)) {
		const img = document.querySelector<HTMLImageElement>(`[data-icon-request="${data.request}"] > img`);
		if (img) {
			img.hidden = !data.src;
			if (data.src) { img.src = data.src; }
		}
	} else if (data.type === 'resourceDrag') {
		element('agent-drop').hidden = !(data.over && tabId && trusted && allowed);
	} else if (data.type === 'droppedResources') {
		element('agent-drop').hidden = true;
		if (tabId && trusted && allowed) { requestResources({ type: 'addResources', uris: data.uris }); }
	} else if (data.type === 'insertResources') {
		const target = insertions.get(data.request);
		insertions.delete(data.request);
		if (!target || target.tab !== data.tabId || !data.parts.length) { return; }
		if (target.tab === tabId) {
			insertChips(input, data.parts, target.range);
			hideSuggestions();
			saveDraft();
		} else {
			const draft = drafts[target.tab];
			const images = Array.isArray(draft) ? draft.filter(part => part.type === 'image') : [];
			drafts[target.tab] = [...images, ...target.before, ...data.parts, ...target.after];
			api.setState({ drafts });
		}
	} else if (data.type === 'forgetDraft') {
		delete drafts[data.tabId];
		api.setState({ drafts });
	} else if (data.type === 'restoreDraft') {
		if (data.tabId === tabId && !input.textContent && !attachedImages.length) {
			renderDraft(data.parts);
			saveDraft();
		} else if (data.tabId !== tabId && !drafts[data.tabId]?.length) {
			drafts[data.tabId] = data.parts;
			api.setState({ drafts });
		}
	} else if (data.type === 'contextMatches') {
		if (data.tabId === tabId && data.request === suggestionRequest) { renderSuggestions(data.items, 'No matching files or folders'); }
	} else if (data.type === 'toggleSessions') {
		sessionsSidebar.hidden = !sessionsSidebar.hidden;
		post({ type: 'sessionsSidebarVisible', open: !sessionsSidebar.hidden });
		if (sessionsSidebar.hidden) {
			window.clearInterval(sidebarRefreshTimer);
			post({ type: 'endHistory', sidebar: true });
			if (tabId) { input.focus(); }
		} else {
			showPanel();
			sidebarSearch.value = '';
			if (!sidebarChoices.length) { element('sidebar-status').dataset.status = 'Loading sessions…'; }
			renderSessionChoices(true);
			refreshSidebar();
			sidebarRefreshTimer = window.setInterval(() => {
				if (!document.hidden && !sidebarPending) { refreshSidebar(); }
			}, 60_000);
			sidebarSearch.focus();
		}
	} else if (data.type === 'historyPage' && data.sidebar) {
		if (!sessionsSidebar.hidden && data.request === sidebarRequest) {
			sidebarPending = false;
			sidebarChoices = data.items;
			element('sidebar-status').dataset.status = data.status;
			historySettings('sidebar-settings', data.settingsTarget);
			renderSessionChoices(true);
		}
	} else if (data.type === 'sessionMenu') {
		const dismiss = !sessionMenu.hidden && menuKind === data.menu && sessionMenu.classList.contains('from-home') === !!data.home;
		showPanel();
		if (dismiss) { return; }
		menuKind = data.menu;
		sessionChoices = data.items;
		historySettings('history-settings');
		historyStatus.textContent = menuKind === 'history' ? 'Loading sessions…' : '';
		if (menuKind === 'history') { post({ type: 'listHistory', request: ++historyRequest }); }
		historySearch.value = '';
		historySearch.hidden = menuKind !== 'history';
		element('history-close').hidden = historySearch.hidden;
		element('session-menu-title').textContent = menuKind === 'new' ? 'New session' : 'Sessions';
		renderSessionChoices();
		sessionMenu.classList.toggle('from-home', !!data.home);
		element('home-new').setAttribute('aria-expanded', String(!!data.home));
		sessionMenu.hidden = false;
		(menuKind === 'history' ? historySearch : sessionMenu.querySelector('button'))?.focus();
	} else if (data.type === 'historyPage' && data.home) {
		if (!loaded && data.request === recentRequest) { renderRecent(data.items, data.status, data.settingsTarget); }
	} else if (data.type === 'historyPage' && !sessionMenu.hidden && menuKind === 'history' && data.request === historyRequest) {
		sessionChoices = data.items;
		historyStatus.textContent = data.status;
		historySettings('history-settings', data.settingsTarget);
		renderSessionChoices();
	} else if (data.type === 'dismissHistory') {
		if (menuKind === 'history') { showPanel(); }
		refreshSidebar();
	} else if (data.type === 'empty') {
		element('agent-drop').hidden = true;
		showPanel();
		tabId = '';
		loaded = false;
		busy = false;
		renderStatus('');
		messages.replaceChildren();
		document.querySelector('footer')!.hidden = true;
		welcome.hidden = false;
		element('home').hidden = false;
		element('home-setup').hidden = !data.needsSetup;
		element('home-sessions').hidden = data.needsSetup;
		element('welcome-title').textContent = data.needsSetup ? 'Set up agent chat' : 'Otrion Chat';
		++recentRequest;
		if (data.needsSetup) {
			element('home-instruction').textContent = data.installed
				? `Enable an installed agent to start chatting ${data.location}.`
				: `Install and enable a chat agent to start chatting ${data.location}.`;
		} else {
			renderRecent([], 'Loading recent conversations…');
			post({ type: 'listHistory', home: true, request: recentRequest });
		}
	} else if (data.type === 'state') {
		const follow = nearEnd() || !welcome.hidden;
		if (tabId !== data.tabId) { messages.replaceChildren(); }
		while (messages.childElementCount > data.messages.length) { messages.lastElementChild!.remove(); }
		setTranscriptRoot(data.cwd ?? '');
		data.messages.forEach((message: TranscriptRow, index: number) => renderTranscriptRow(index, message));
		welcome.hidden = data.messages.length > 0;
		busy = data.busy;
		allowed = data.allowed;
		trusted = data.trusted;
		loaded = true;
		element('home').hidden = true;
		agentName = data.agentName;
		document.querySelector('footer')!.hidden = false;
		element('welcome-title').textContent = 'Start a conversation';
		if (tabId !== data.tabId) {
			showPanel();
			tabId = data.tabId;
			lastCaret = undefined;
			renderDraft(drafts[tabId] ?? '');
		}
		updateMetadata(data);
		renderQueue(data.queue ?? [], data.canSteer, data.steering, data.deliveryError ?? '');
		connectionIssue = data.connectionIssue;
		renderSetup(data.status, data.location, data.activity);
		updateComposer();
		if (follow) { thread.scrollTop = thread.scrollHeight; }
	} else if (data.type === 'metadata') {
		if (data.cwd) { setTranscriptRoot(data.cwd); }
		updateMetadata(data);
		updateComposer();
	} else if (data.type === 'transcript' && tabId === data.tabId) {
		const follow = nearEnd();
		for (const { index, message } of data.rows) { renderTranscriptRow(index, message); }
		if (element('setup').hidden) { renderStatus(data.status, data.activity); }
		if (follow) { thread.scrollTop = thread.scrollHeight; }
	}
});

element('retry-connection').addEventListener('click', () => post({ type: 'options' }));
element('configure').addEventListener('click', () => post({ type: trusted ? 'settings' : 'trust' }));
document.querySelector('form')!.addEventListener('submit', event => {
	event.preventDefault();
	if (send.disabled) { return; }
	showPanel();
	if (!busy) { busy = true; renderStatus('', 'Working'); }
	for (const [id, target] of insertions) { if (target.tab === tabId) { insertions.delete(id); } }
	post({ type: 'send', parts: composerDraft() });
	renderDraft('');
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
async function addImages(files: File[]) {
	if (!files.length || readingImages || !tabId || !trusted || !allowed) { return; }
	const owner = tabId;
	drafts[owner] ??= [];
	const existing = attachedImages.reduce((bytes, image) => bytes + Math.floor(image.data.replace(/=+$/, '').length * 3 / 4), 0);
	if (files.some(f => !/^image\/(png|jpeg|gif|webp)$/.test(f.type) || !f.size) || files.reduce((n, f) => n + f.size, existing) > 4 * 1024 * 1024) {
		renderStatus('Use PNG, JPEG, GIF or WebP images, up to 4 MB per message.');
		return;
	}
	readingImages = true;
	updateComposer();
	try {
		const images = await Promise.all(files.map(file => new Promise<InlineImage>((resolve, reject) => {
			const reader = new FileReader();
			reader.onload = () => resolve({ type: 'image', name: file.name || 'Image', mimeType: file.type, data: String(reader.result).split(',')[1] });
			reader.onerror = () => reject(reader.error);
			reader.readAsDataURL(file);
		})));
		if (owner === tabId) {
			attachedImages.push(...images);
			renderImageStrip();
			saveDraft();
		} else if (Object.hasOwn(drafts, owner)) {
			const draft = drafts[owner];
			drafts[owner] = [...(typeof draft === 'string' ? [{ type: 'text' as const, text: draft }] : draft), ...images];
			api.setState({ drafts });
		}
	} catch {
		if (owner === tabId) { renderStatus('Could not read the image. Try attaching it again.'); }
	} finally {
		readingImages = false;
		updateComposer();
	}
}
const imagePicker = element<HTMLInputElement>('image-picker');
element('attach-image').addEventListener('click', () => imagePicker.click());
imagePicker.addEventListener('change', () => {
	placeRange(input, lastCaret);
	void addImages(Array.from(imagePicker.files ?? []));
	imagePicker.value = '';
});
input.addEventListener('paste', event => {
	const images = Array.from(event.clipboardData?.files ?? []).filter(file => file.type.startsWith('image/'));
	if (images.length) {
		event.preventDefault();
		void addImages(images);
	}
});
input.addEventListener('input', () => { saveDraft(); suggest(); });
input.addEventListener('click', suggest);
input.addEventListener('keyup', event => { if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) { suggest(); } });
input.addEventListener('blur', hideSuggestions);
stopButton.addEventListener('click', () => post({ type: 'stop' }));
saveDraft();
post({ type: 'ready', drafts });
