/* Copyright (c) Otrion contributors. Licensed under the MIT License. */

type InlineResource = { type: 'resource_link'; uri: string; name: string; folder?: boolean };
type InlineImage = { type: 'image'; name: string; mimeType: string; data: string };
type DraftPart = { type: 'text'; text: string } | InlineResource | InlineImage;
type Draft = string | DraftPart[];

let iconSequence = 0;
function requestChipIcon(chip: HTMLElement) {
	const request = ++iconSequence;
	chip.dataset.iconRequest = String(request);
	const { folder } = chip.dataset;
	post({ type: 'fileIcon', request, uri: chip.dataset.uri, folder: folder === undefined ? undefined : folder === 'true' });
}

function resourceChip(file: InlineResource) {
	const chip = document.createElement('span');
	chip.className = 'resource-chip';
	chip.contentEditable = 'false';
	chip.dataset.uri = file.uri;
	chip.dataset.name = file.name;
	if (file.folder !== undefined) { chip.dataset.folder = String(file.folder); }
	chip.title = file.folder === undefined ? file.uri : (file.folder ? 'Folder' : 'File') + ' · ' + file.uri;
	const image = document.createElement('img');
	image.alt = '';
	image.hidden = true;
	chip.append(image, file.name);
	requestChipIcon(chip);
	return chip;
}

type PreviewImage = { label: string; image: string };

function imageThumbnail(images: PreviewImage[], index: number) {
	const { label, image } = images[index];
	const button = document.createElement('button');
	button.type = 'button';
	button.className = 'image-thumbnail';
	button.title = label;
	button.setAttribute('aria-label', 'Preview ' + label + ' (' + (index + 1) + ' of ' + images.length + ')');
	const img = document.createElement('img');
	img.src = image;
	img.alt = '';
	img.draggable = false;
	button.append(img);
	button.addEventListener('click', () => post({ type: 'previewImages', images, startIndex: index }));
	return button;
}

function readDraft(root: Node): DraftPart[] {
	const parts: DraftPart[] = [];
	const append = (text: string) => {
		const last = parts.at(-1);
		if (last?.type === 'text') { last.text += text; }
		else if (text) { parts.push({ type: 'text', text }); }
	};
	function visit(parent: Node) {
		for (const child of Array.from(parent.childNodes)) {
			if (child.nodeType === Node.TEXT_NODE) { append(child.textContent ?? ''); continue; }
			if (!(child instanceof HTMLElement)) { continue; }
			const { uri, name, folder } = child.dataset;
			if (uri && name) { parts.push({ type: 'resource_link', uri, name, folder: folder === 'true' }); }
			else if (child.tagName === 'BR') {
				if (child.nextSibling) { append('\n'); }
			} else {
				if (child.previousSibling && ['DIV', 'P'].includes(child.tagName)) { append('\n'); }
				visit(child);
			}
		}
	}
	visit(root);
	return parts;
}

function currentRange(root: HTMLElement) {
	const selection = window.getSelection();
	if (!selection?.rangeCount) { return; }
	const range = selection.getRangeAt(0);
	return root.contains(range.commonAncestorContainer) ? range.cloneRange() : undefined;
}

function placeRange(root: HTMLElement, range?: Range) {
	root.focus();
	if (!range || !root.contains(range.commonAncestorContainer)) {
		range = document.createRange();
		range.selectNodeContents(root);
		range.collapse(false);
	}
	const selection = window.getSelection()!;
	selection.removeAllRanges();
	selection.addRange(range);
}

function insertChips(root: HTMLElement, parts: InlineResource[], range?: Range) {
	if (!parts.length) { return; }
	placeRange(root, range);
	// Chromium's editing command keeps insertion and deletion in the native undo history.
	const chips = parts.map(resourceChip);
	const marker = crypto.randomUUID();
	chips[chips.length - 1].dataset.insertEnd = marker;
	// Only our own file tokens need rich insertion. Native paste stays plain text.
	const editable = root.contentEditable;
	root.contentEditable = 'true';
	try {
		document.execCommand('insertHTML', false, chips.map(chip => chip.outerHTML).join(''));
	} finally {
		root.contentEditable = editable;
	}
	const end = root.querySelector<HTMLElement>('[data-insert-end="' + marker + '"]');
	if (end) {
		delete end.dataset.insertEnd;
		const caret = document.createRange();
		caret.setStartAfter(end);
		caret.collapse(true);
		placeRange(root, caret);
	}
}
