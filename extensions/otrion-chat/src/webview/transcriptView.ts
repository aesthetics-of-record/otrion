/* Copyright (c) Otrion contributors. Licensed under the MIT License. */

type TranscriptRow = import('../transcript').ChatMessage;
declare const otrionMarkdown: {
	render(text: string, copyButton: (text: string) => HTMLButtonElement, open: (href: string) => void): DocumentFragment;
	patch(path: string, before: string, after: string): string | undefined;
};

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
			const patch = otrionMarkdown.patch(artifact.label, artifact.before, artifact.after);
			if (patch === undefined) {
				outputBlock(body, 'Before · ' + artifact.label, artifact.before);
				outputBlock(body, 'After · ' + artifact.label, artifact.after);
				continue;
			}
			const label = document.createElement('h4');
			label.textContent = artifact.label;
			const pre = document.createElement('pre');
			for (const line of patch.split('\n')) {
				const span = document.createElement('span');
				span.className = line.startsWith('+') ? 'diff-add' : line.startsWith('-') ? 'diff-remove' : '';
				span.textContent = line + '\n';
				pre.append(span);
			}
			body.append(label, pre);
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
