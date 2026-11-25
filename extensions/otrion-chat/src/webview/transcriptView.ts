/* Copyright (c) Otrion contributors. Licensed under the MIT License. */

type TranscriptRow = import('../transcript').ChatMessage;
/** Mirrors `DiffRow` in preview-src/markdown.ts; `html` is escaped by the bundle. */
interface DiffRow { type: 'add' | 'remove' | 'context' | 'gap'; html: string }
declare const otrionMarkdown: {
	render(text: string, copyButton: (text: string) => HTMLButtonElement, open: (href: string) => void): DocumentFragment;
	fileDiff(path: string, before: string, after: string): { added: number; removed: number; rows: DiffRow[] } | undefined;
};

/** The session's working directory, used to show edited files relative to it. */
let transcriptRoot = '';
function setTranscriptRoot(root: string) { transcriptRoot = root; }

let copyRequest = 0;
function copyButton(label: string, getText: () => string) {
	const template = element<HTMLTemplateElement>('copy-action');
	const button = template.content.firstElementChild!.cloneNode(true) as HTMLButtonElement;
	button.title = label;
	button.setAttribute('aria-label', label);
	button.addEventListener('click', () => {
		const request = ++copyRequest;
		button.dataset.copyRequest = String(request);
		button.classList.remove('copied');
		button.title = label;
		post({ type: 'copyCode', text: getText(), request });
	});
	return button;
}

function confirmCopy(request: number) {
	if (!Number.isSafeInteger(request)) { return; }
	const button = document.querySelector<HTMLButtonElement>(`[data-copy-request="${request}"]`);
	if (!button) { return; }
	button.classList.add('copied');
	button.title = 'Copied';
	window.setTimeout(() => {
		if (button.dataset.copyRequest === String(request)) {
			button.classList.remove('copied');
			button.title = button.getAttribute('aria-label')!;
			delete button.dataset.copyRequest;
		}
	}, 1500);
}

function formatted(text: string) {
	return otrionMarkdown.render(text, code => copyButton('Copy code', () => code), href => post({ type: 'openChatLink', href }));
}

// Command payloads from the Codex and Claude adapters may be shell text or an argv array.
function commandText(row: TranscriptRow): string | undefined {
	if (row.kind !== 'tool') { return; }
	let input: unknown;
	try { input = row.input && JSON.parse(row.input); } catch { input = row.input; }
	const fields = input && typeof input === 'object' && !Array.isArray(input) ? input as Record<string, unknown> : undefined;
	const command = fields?.command ?? fields?.cmd ?? (row.toolKind === 'execute' ? input : undefined);
	if (typeof command === 'string' && command.trim()) { return command; }
	if (Array.isArray(command) && command.length && command.every(arg => typeof arg === 'string')) {
		if (command.length === 3 && /^(?:.*\/)?(?:sh|bash|zsh|dash|ksh|fish)$/.test(command[0]) && /^-[a-z]*c$/i.test(command[1])) { return command[2]; }
		return command.join(' ');
	}
	return row.toolKind === 'execute' ? row.title : undefined;
}

const activityPaths: Record<string, string> = {
	execute: 'M4.5 3.5h11a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-11a2 2 0 0 1-2-2v-9a2 2 0 0 1 2-2Z M5.5 7.5l2 2-2 2 M10.5 12h3',
	search: 'M14 8.5a5.5 5.5 0 1 1-11 0 5.5 5.5 0 0 1 11 0Zm-1.5 4 4.5 4.5',
	read: 'M6 2.5h4.6q.8 0 1.4.6l3.4 3.4q.6.6.6 1.4V16a1.5 1.5 0 0 1-1.5 1.5H6A1.5 1.5 0 0 1 4.5 16V4A1.5 1.5 0 0 1 6 2.5Z M11 3v3a1.5 1.5 0 0 0 1.5 1.5h3 M7.5 10.5h5m-5 3h3.5',
	edit: 'M3.6 12.9 13 3.5a1.6 1.6 0 0 1 2.3 0l1.2 1.2a1.6 1.6 0 0 1 0 2.3l-9.4 9.4q-.3.3-.8.4l-3 .7q-.8.2-.6-.6l.6-3.2q.1-.5.3-.8Z M11.5 5l3.5 3.5',
	plan: 'm2.5 5 1 1 2-2M8 5h9m-14.5 5 1 1 2-2M8 10h9M3 15h2m3 0h9',
	tool: 'M11.5 3a5 5 0 0 0-6 6L2.5 12a2.5 2.5 0 0 0 3.5 3.5l4-4a5 5 0 0 0 6-6l-3 3-3-3z',
	chevron: 'm7.5 4.5 4.4 4.7q.7.8 0 1.6l-4.4 4.7',
};

function activityIcon() {
	const ns = 'http://www.w3.org/2000/svg';
	const svg = document.createElementNS(ns, 'svg');
	svg.setAttribute('viewBox', '0 0 20 20');
	svg.setAttribute('aria-hidden', 'true');
	const symbol = document.createElementNS(ns, 'path');
	const chevron = document.createElementNS(ns, 'path');
	chevron.setAttribute('d', activityPaths.chevron);
	svg.append(symbol, chevron);
	return svg;
}

function activityTitle(row: TranscriptRow, command?: string) {
	if (row.kind === 'thought') { return 'Thoughts'; }
	if (command) {
		const verb = row.status === 'completed' ? 'Ran' : row.status === 'in_progress' ? 'Running' : 'Run';
		const shellText = command.trim().replace(/^(?:Ran|Running|Run)\s+/i, '').replace(/^(?:\S*\/)?(?:zsh|bash|sh|dash|ksh|fish)\s+-[a-z]*c\s+["']?/i, '');
		const firstLine = shellText.split('\n', 1)[0].trim();
		const concise = firstLine.length > 52 ? firstLine.split(/\s+/, 1)[0] : firstLine;
		return verb + ' ' + concise;
	}
	return row.title || 'Tool call';
}

function outputBlock(parent: HTMLElement, label: string, text: string) {
	const caption = document.createElement('h4');
	caption.textContent = label;
	const pre = document.createElement('pre');
	pre.textContent = text;
	const block = document.createElement('div');
	block.className = 'activity-output';
	block.append(caption, pre);
	parent.append(block);
}

interface FileEdit { label: string; before: string; after: string }
type FileDiff = NonNullable<ReturnType<typeof otrionMarkdown.fileDiff>>;

function fileEdits(row: TranscriptRow): FileEdit[] {
	return (row.artifacts ?? []).flatMap(({ label, before, after }) => before !== undefined && after !== undefined ? [{ label, before, after }] : []);
}

const diffCache = new Map<string, FileDiff | null>();
function diffFor(edit: FileEdit) {
	const key = edit.label + '\0' + edit.before + '\0' + edit.after;
	let diff = diffCache.get(key);
	if (diff === undefined) {
		diff = otrionMarkdown.fileDiff(edit.label, edit.before, edit.after) ?? null;
		diffCache.set(key, diff);
		if (diffCache.size > 200) { diffCache.delete(diffCache.keys().next().value!); }
	}
	return diff ?? undefined;
}

function isAbsolutePath(path: string) { return /^(?:\/|[a-z]:[\\/])/i.test(path); }

/** Split a path into its file name and its folder relative to the session directory. */
function displayPath(path: string) {
	let shown = path;
	const root = transcriptRoot.replace(/[\\/]+$/, '');
	if (root && path.startsWith(root) && /[\\/]/.test(path[root.length] ?? '')) { shown = path.slice(root.length + 1); }
	const slash = Math.max(shown.lastIndexOf('/'), shown.lastIndexOf('\\'));
	return { name: shown.slice(slash + 1) || shown, folder: slash > 0 ? shown.slice(0, slash) : '' };
}

function fileUri(path: string) {
	const absolute = isAbsolutePath(path) ? path : transcriptRoot && transcriptRoot.replace(/[\\/]+$/, '') + '/' + path;
	if (!absolute) { return undefined; }
	const slashed = absolute.replace(/\\/g, '/');
	return 'file://' + (slashed.startsWith('/') ? '' : '/') + slashed.split('/').map(encodeURIComponent).join('/');
}

const editIcons = {
	file: activityPaths.read,
	diff: 'M3.5 3.5h5v13h-5z M11.5 3.5h5v13h-5z M4.5 8.5h3 M6 7v3 M12.5 12h3',
	open: 'M11 3.5h5.5V9 M16.5 3.5l-7 7 M14 12v3.5a1 1 0 0 1-1 1H4.5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1H8',
	chevron: activityPaths.chevron,
};

function strokeIcon(path: string) {
	const ns = 'http://www.w3.org/2000/svg';
	const svg = document.createElementNS(ns, 'svg');
	svg.setAttribute('viewBox', '0 0 20 20');
	svg.setAttribute('aria-hidden', 'true');
	const shape = document.createElementNS(ns, 'path');
	shape.setAttribute('d', path);
	svg.append(shape);
	return svg;
}

/** Request the themed file icon the Explorer would show; the generic glyph stays until it arrives. */
function requestEditIcon(holder: HTMLElement) {
	if (!holder.dataset.uri) { return; }
	const request = ++iconSequence;
	holder.dataset.iconRequest = String(request);
	post({ type: 'fileIcon', request, uri: holder.dataset.uri, folder: false });
}

function editAction(label: string, icon: string, run: () => void) {
	const button = document.createElement('button');
	button.type = 'button';
	button.className = 'edit-action';
	button.title = label;
	button.setAttribute('aria-label', label);
	button.append(strokeIcon(icon));
	button.addEventListener('click', run);
	return button;
}

const maxDiffRows = 400;
function diffView(edit: FileEdit, diff: FileDiff | undefined, openDiff: () => void) {
	const view = document.createElement('div');
	view.className = 'edit-diff';
	if (!diff || !diff.rows.length) {
		const note = document.createElement('p');
		note.className = 'edit-note';
		note.textContent = diff ? 'No textual changes.' : 'This change is too large to compare inline.';
		if (!diff) {
			const link = document.createElement('button');
			link.type = 'button';
			link.textContent = 'Open Diff';
			link.addEventListener('click', openDiff);
			note.append(' ', link);
		}
		view.append(note);
		return view;
	}
	view.tabIndex = 0;
	view.setAttribute('role', 'region');
	view.setAttribute('aria-label', 'Changes in ' + edit.label);
	const code = document.createElement('div');
	code.className = 'diff-code';
	for (const row of diff.rows.slice(0, maxDiffRows)) {
		const line = document.createElement('div');
		line.className = 'diff-line ' + row.type;
		if (row.type === 'gap') {
			line.setAttribute('aria-label', 'Unchanged lines');
		} else {
			line.dataset.sign = row.type === 'add' ? '+' : row.type === 'remove' ? '-' : ' ';
			// The bundle escapes source text before adding syntax spans.
			line.innerHTML = row.html || ' ';
		}
		code.append(line);
	}
	view.append(code);
	if (diff.rows.length > maxDiffRows) {
		const more = document.createElement('button');
		more.type = 'button';
		more.className = 'diff-more';
		more.textContent = `${diff.rows.length - maxDiffRows} more lines · Open Diff`;
		more.addEventListener('click', openDiff);
		view.append(more);
	}
	return view;
}

let editSequence = 0;
/** A file change: a header that opens the file or its diff, over an inline, collapsible diff preview. */
function editCard(edit: FileEdit, expanded: boolean, state: string) {
	const diff = diffFor(edit);
	const { name, folder } = displayPath(edit.label);
	const open = (asDiff: boolean) => post({ type: 'openChatEdit', path: edit.label, before: edit.before, after: edit.after, diff: asDiff });
	const card = document.createElement('section');
	card.className = 'edit-card';
	card.setAttribute('aria-label', name);
	const header = document.createElement('div');
	header.className = 'edit-header';
	const toggle = document.createElement('button');
	toggle.type = 'button';
	toggle.className = 'edit-toggle';
	toggle.setAttribute('aria-label', 'Show changes in ' + name);
	toggle.append(strokeIcon(editIcons.chevron));
	const icon = document.createElement('span');
	icon.className = 'edit-file-icon';
	const image = document.createElement('img');
	image.alt = '';
	image.hidden = true;
	icon.append(image, strokeIcon(editIcons.file));
	const uri = fileUri(edit.label);
	if (uri) { icon.dataset.uri = uri; }
	const title = document.createElement('button');
	title.type = 'button';
	title.className = 'edit-name';
	title.textContent = name;
	title.title = 'Open ' + edit.label;
	title.addEventListener('click', () => open(false));
	const location = document.createElement('span');
	location.className = 'edit-folder';
	// Right-to-left overflow keeps the nearest folders visible; the marks keep the path itself left-to-right.
	location.textContent = folder && '\u200e' + folder + '\u200e';
	location.title = folder;
	const stats = document.createElement('span');
	stats.className = 'edit-stats';
	if (!edit.before) {
		const badge = document.createElement('span');
		badge.className = 'edit-badge';
		badge.textContent = 'New';
		stats.append(badge);
	}
	if (diff) {
		const added = document.createElement('span');
		added.className = 'added';
		added.textContent = '+' + diff.added;
		const removed = document.createElement('span');
		removed.className = 'removed';
		removed.textContent = '−' + diff.removed;
		// Show only the sides that changed, like a pull request file list.
		stats.append(...[diff.added || !diff.removed ? added : undefined, diff.removed ? removed : undefined].filter(part => !!part));
		stats.setAttribute('aria-label', `${diff.added} lines added, ${diff.removed} lines removed`);
	}
	const status = document.createElement('small');
	status.className = 'edit-state';
	status.textContent = state;
	header.append(toggle, icon, title, location, stats, status,
		editAction('Open Diff', editIcons.diff, () => open(true)),
		editAction('Open File', editIcons.open, () => open(false)));
	const body = document.createElement('div');
	body.id = 'edit-diff-' + ++editSequence;
	toggle.setAttribute('aria-controls', body.id);
	const setExpanded = (value: boolean) => {
		card.classList.toggle('expanded', value);
		toggle.setAttribute('aria-expanded', String(value));
		body.replaceChildren(...value ? [diffView(edit, diff, () => open(true))] : []);
		body.hidden = !value;
	};
	toggle.addEventListener('click', () => setExpanded(!card.classList.contains('expanded')));
	header.addEventListener('click', event => {
		if (!(event.target as Element).closest('button') && !getSelection()?.toString()) { toggle.click(); }
	});
	setExpanded(expanded);
	card.append(header, body);
	requestEditIcon(icon);
	return card;
}

const editSignatures = new WeakMap<HTMLElement, string>();
function renderEditRow(row: HTMLElement, message: TranscriptRow, edits: FileEdit[]) {
	const state = message.status ?? '';
	const failed = state === 'failed';
	const signature = JSON.stringify([state, failed && message.output, transcriptRoot, edits]);
	if (row.dataset.view === 'edit' && editSignatures.get(row) === signature) { return; }
	const wasExpanded = row.dataset.view === 'edit' ? Array.from(row.querySelectorAll('.edit-card'), card => card.classList.contains('expanded')) : [];
	editSignatures.set(row, signature);
	row.dataset.view = 'edit';
	row.dataset.status = state;
	row.toggleAttribute('data-failed', failed);
	row.className = 'activity tool edit-activity';
	const labels: Record<string, string> = { pending: 'Pending', in_progress: 'Editing…', failed: 'Failed', cancelled: 'Stopped' };
	row.replaceChildren(...edits.map((edit, index) => editCard(edit, wasExpanded[index] ?? true, labels[state] ?? '')));
	if (failed && message.output) { outputBlock(row, 'Error', message.output); }
}

function appendArtifacts(body: HTMLElement, row: TranscriptRow) {
	const images = (row.artifacts ?? []).flatMap(artifact => artifact.image ? [{ label: artifact.label, image: artifact.image }] : []);
	if (images.length) {
		const strip = document.createElement('div');
		strip.className = 'image-strip';
		strip.setAttribute('role', 'group');
		strip.setAttribute('aria-label', 'Message images');
		strip.append(...images.map((_, index) => imageThumbnail(images, index)));
		body.prepend(strip);
	}
	for (const artifact of row.artifacts ?? []) {
		if (artifact.before !== undefined && artifact.after !== undefined) {
			body.append(editCard({ label: artifact.label, before: artifact.before, after: artifact.after }, true, ''));
		} else if (!artifact.image && artifact.text && !(artifact.label === 'Terminal' && row.terminal !== undefined)) {
			outputBlock(body, artifact.label, artifact.text);
		}
	}
}

function executionSection(panel: HTMLElement, label: string, text: string, preview: string) {
	const section = document.createElement('details');
	section.dataset.section = label;
	const summary = document.createElement('summary');
	const name = document.createElement('strong');
	name.textContent = label;
	const excerpt = document.createElement('span');
	excerpt.textContent = preview;
	summary.append(name, excerpt);
	const content = document.createElement('div');
	const pre = document.createElement('pre');
	pre.textContent = text;
	pre.tabIndex = 0;
	pre.setAttribute('aria-label', label);
	content.append(pre, copyButton('Copy ' + label.toLowerCase(), () => text));
	section.append(summary, content);
	panel.append(section);
}

function executionPanel(command: string, row: TranscriptRow) {
	const panel = document.createElement('div');
	panel.className = 'execution-panel';
	executionSection(panel, 'Command', command, command.trim().split('\n', 1)[0]);
	if (row.terminal) {
		const lines = row.terminal.trimEnd().split('\n');
		executionSection(panel, 'Terminal', row.terminal, lines.at(-1) ?? '');
	}
	if (row.output && row.output !== row.terminal && !row.artifacts?.some(part => part.text === row.output)) {
		executionSection(panel, 'Output', row.output, row.output.trimStart().split('\n', 1)[0]);
	}
	if (row.input && row.input !== command) {
		executionSection(panel, 'Tool input', row.input, '');
	}
	return panel;
}

function activityBody(body: HTMLElement, row: TranscriptRow) {
	if (row.text) { body.append(formatted(row.text)); }
	const command = commandText(row);
	if (command) { body.append(executionPanel(command, row)); }
	else if (row.input) { outputBlock(body, 'Input', row.input); }
	for (const loc of row.locations ?? []) {
		const button = document.createElement('button');
		button.className = 'tool-location';
		button.textContent = loc.path + (loc.line ? ':' + loc.line : '');
		button.addEventListener('click', () => post({ type: 'openChatFile', path: loc.path, line: loc.line }));
		body.append(button);
	}
	if (row.entries) {
		const plan = document.createElement('ul');
		plan.className = 'plan';
		for (const entry of row.entries) {
			const item = document.createElement('li');
			item.textContent = (entry.status === 'completed' ? '✓ ' : entry.status === 'in_progress' ? '◉ ' : '○ ') + entry.content;
			item.title = entry.status.replaceAll('_', ' ');
			plan.append(item);
		}
		body.append(plan);
	}
	appendArtifacts(body, row);
	if (!command && (row.terminal !== undefined || row.exit)) {
		outputBlock(body, row.exit ? 'Terminal · ' + row.exit : 'Terminal', row.terminal ?? '');
	}
	if (!command && row.output && row.output !== row.terminal && !row.artifacts?.some(part => part.text === row.output)) { outputBlock(body, 'Output', row.output); }
}

const rowModels = new WeakMap<HTMLElement, TranscriptRow>();
function renderTranscriptRow(index: number, message: TranscriptRow) {
	let row = messages.children[index] as HTMLElement | undefined;
	if (!row) { row = document.createElement('article'); messages.append(row); }
	const previous = rowModels.get(row);
	rowModels.set(row, message);
	const edits = message.kind === 'tool' ? fileEdits(message) : [];
	if (edits.length) {
		renderEditRow(row, message, edits);
		return;
	}
	if (row.dataset.view === 'edit') {
		delete row.dataset.view;
		row.replaceChildren();
	}
	if (message.kind) {
		row.className = 'activity ' + message.kind;
		let details = row.querySelector('details');
		if (!details) {
			details = document.createElement('details');
			const summary = document.createElement('summary');
			summary.className = 'activity-heading';
			summary.append(activityIcon(), document.createElement('span'), document.createElement('small'));
			const body = document.createElement('div');
			body.className = 'activity-body markdown-body';
			details.append(summary, body);
			row.replaceChildren(details);
			const owner = row;
			details.addEventListener('toggle', event => {
				body.replaceChildren();
				if ((event.currentTarget as HTMLDetailsElement).open) { activityBody(body, rowModels.get(owner)!); }
			});
		}
		const command = commandText(message);
		const icon = command ? 'execute' : message.toolKind ?? message.kind;
		const heading = details.firstElementChild!;
		heading.querySelector('path')!.setAttribute('d', activityPaths[icon] ?? activityPaths[message.kind === 'tool' ? 'tool' : 'chevron']);
		const label = heading.querySelector('span')!;
		label.textContent = activityTitle(message, command);
		const labels: Record<string, string> = { in_progress: 'Running', pending: 'Queued', completed: '', failed: 'Failed', cancelled: 'Stopped', ended: 'Turn ended' };
		const entries = message.entries;
		const state = message.status ?? '';
		heading.querySelector('small')!.textContent = entries ? entries.filter(entry => entry.status === 'completed').length + '/' + entries.length
			: command && message.exit ? [labels[state], message.exit].filter(Boolean).join(' · ') : command && state === 'in_progress' ? '' : labels[state] ?? state;
		row.dataset.status = state;
		row.toggleAttribute('data-failed', state === 'failed' || !!message.exit && message.exit !== 'Exit code 0');
		if (details.open) {
			const body = details.lastElementChild as HTMLElement;
			const expanded = new Map(Array.from(body.querySelectorAll<HTMLDetailsElement>('details[data-section][open]'), section => {
				const pre = section.querySelector('pre')!;
				return [section.dataset.section, [pre.scrollTop, pre.scrollLeft]] as const;
			}));
			const focused = document.activeElement;
			const focusSection = focused?.closest<HTMLDetailsElement>('details[data-section]');
			body.replaceChildren();
			activityBody(body, message);
			for (const section of body.querySelectorAll<HTMLDetailsElement>('details[data-section]')) {
				const scroll = expanded.get(section.dataset.section);
				if (scroll) {
					section.open = true;
					section.querySelector('pre')!.scrollTo(scroll[1], scroll[0]);
				}
				if (focusSection && section.dataset.section === focusSection.dataset.section) {
					section.querySelector<HTMLElement>(focused!.tagName)?.focus({ preventScroll: true });
				}
			}
		}
	} else {
		if (previous && !previous.kind && previous.text === message.text && previous.role === message.role && !message.artifacts?.length && !previous.artifacts?.length) { return; }
		row.className = message.role === 'You' ? 'user' : message.role === 'Connection' ? 'error' : 'assistant';
		const body = document.createElement('div');
		body.className = 'message-body markdown-body';
		if (row.className === 'error') {
			const label = document.createElement('div');
			label.className = 'error-title';
			label.textContent = message.role;
			body.textContent = message.text;
			row.replaceChildren(label, body);
		} else {
			body.append(formatted(message.text));
			// Keep the copy button focused while the response streams.
			const copy = row.querySelector(':scope > .transcript-action');
			if (copy && message.text) {
				row.firstElementChild!.replaceWith(body);
			} else {
				row.replaceChildren(body);
				if (message.text) { row.append(copyButton('Copy as Markdown', () => rowModels.get(row)!.text)); }
			}
		}
		appendArtifacts(body, message);
	}
}
