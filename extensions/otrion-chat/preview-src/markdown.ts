/* Copyright (c) Otrion contributors. Licensed under the MIT License. */

import MarkdownIt from 'markdown-it';
import hljs from 'highlight.js/lib/common';
import { structuredPatch } from 'diff';

const md = new MarkdownIt({
	html: false,
	linkify: true,
	highlight(source, language) {
		if (language && source.length < 40000 && hljs.getLanguage(language)) {
			return hljs.highlight(source, { language, ignoreIllegals: true }).value;
		}
		return '';
	},
});

md.validateLink = href => !href.startsWith('//')
	&& (!/^[a-z][a-z0-9+.-]*:/i.test(href)
		|| /^(?:https?:\/\/|file:\/\/\/|vscode-remote:\/\/|mailto:|[a-z]:[\\/])/i.test(href)
		|| /^[\w.-]+\.[\w-]+:\d+(?::\d+)?$/.test(href));

// Fetch remote images only after the reader chooses to display them.
md.renderer.rules.image = (tokens, index) => {
	const token = tokens[index];
	const url = token.attrGet('src') ?? '';
	const label = md.utils.escapeHtml(token.content || 'Image');
	if (url && !/^(?:https?:|mailto:)/i.test(url)) { return '<a href="' + md.utils.escapeHtml(url) + '">' + label + '</a>'; }
	return /^https:\/\//i.test(url) ? '<button type="button" class="markdown-image" data-src="' + md.utils.escapeHtml(url) + '">Show image · ' + label + '</button>' : label;
};

export function render(source: string, copyButton: (text: string) => HTMLButtonElement, open: (href: string) => void) {
	const template = document.createElement('template');
	// markdown-it escapes raw HTML; highlight.js escapes code before adding syntax spans.
	template.innerHTML = md.render(source);
	const fragment = template.content;
	const headings = new Map<string, Element>();
	for (const heading of fragment.querySelectorAll('h1,h2,h3,h4,h5,h6')) {
		const slug = heading.textContent.toLowerCase().trim().replace(/[^\p{L}\p{M}\p{N}_ -]/gu, '').replace(/ +/g, '-');
		let id = slug;
		for (let i = 1; headings.has(id); i++) { id = slug + '-' + i; }
		headings.set(id, heading);
	}
	for (const link of fragment.querySelectorAll('a[href]')) {
		const href = link.getAttribute('href')!;
		link.addEventListener('click', e => {
			e.preventDefault();
			// The webview host also opens anchor clicks that bubble up to its window.
			e.stopPropagation();
			if (href.startsWith('#')) {
				try { headings.get(decodeURIComponent(href.slice(1)))?.scrollIntoView({ block: 'nearest' }); }
				catch { /* Ignore malformed fragment escapes. */ }
			} else { open(href); }
		});
	}
	for (const button of fragment.querySelectorAll<HTMLButtonElement>('.markdown-image')) {
		button.addEventListener('click', () => {
			const img = document.createElement('img');
			img.alt = button.textContent ?? 'Image';
			img.referrerPolicy = 'no-referrer';
			img.src = button.dataset.src!;
			button.replaceWith(img);
		});
	}
	for (const li of fragment.querySelectorAll('li')) {
		const first = (li.firstElementChild?.tagName === 'P' ? li.firstElementChild : li)?.firstChild;
		if (first?.nodeType !== Node.TEXT_NODE) { continue; }
		const match = /^\[([ xX])\]\s+/.exec(first.textContent ?? '');
		if (!match) { continue; }
		const check = document.createElement('input');
		check.type = 'checkbox';
		check.disabled = true;
		check.checked = match[1] !== ' ';
		li.classList.add('task-item');
		(first as Text).deleteData(0, match[0].length);
		first.parentNode!.insertBefore(check, first);
	}
	for (const code of fragment.querySelectorAll('pre > code')) {
		const pre = code.parentElement!;
		const box = document.createElement('div');
		box.className = 'code-block';
		const bar = document.createElement('div');
		bar.className = 'code-bar';
		bar.append(code.className.replace(/^language-/, '') || 'Code');
		bar.append(copyButton(code.textContent));
		pre.replaceWith(box);
		box.append(bar, pre);
	}
	for (const table of fragment.querySelectorAll('table')) {
		const wrap = document.createElement('div');
		wrap.className = 'table-scroll';
		table.replaceWith(wrap);
		wrap.append(table);
	}
	return fragment;
}

/** A rendered row of an inline file diff; `html` is escaped and may contain syntax spans. */
export interface DiffRow {
	type: 'add' | 'remove' | 'context' | 'gap';
	html: string;
}

const maxHighlightedRows = 2000;

/** Diff two file versions into syntax-highlighted rows with change counts, or undefined when diffing times out. */
export function fileDiff(path: string, before: string, after: string) {
	const result = structuredPatch(path, path, before, after, undefined, undefined, { context: 3, timeout: 100 });
	if (!result) { return undefined; }
	const extension = /\.(?<extension>[\w+-]+)$/.exec(path)?.groups?.extension.toLowerCase();
	const language = extension && hljs.getLanguage(extension) ? extension : undefined;
	const rows: DiffRow[] = [];
	let added = 0;
	let removed = 0;
	for (const hunk of result.hunks) {
		if (rows.length) { rows.push({ type: 'gap', html: '' }); }
		for (const line of hunk.lines) {
			const sign = line[0];
			if (sign !== '+' && sign !== '-' && sign !== ' ') { continue; }
			if (sign === '+') { added++; } else if (sign === '-') { removed++; }
			const text = line.slice(1);
			const html = language && rows.length < maxHighlightedRows && text.length < 2000
				? hljs.highlight(text, { language, ignoreIllegals: true }).value
				: md.utils.escapeHtml(text);
			rows.push({ type: sign === '+' ? 'add' : sign === '-' ? 'remove' : 'context', html });
		}
	}
	return { added, removed, rows };
}
