/* Copyright (c) Otrion contributors. Licensed under the MIT License. */

import MarkdownIt from 'markdown-it';
import hljs from 'highlight.js/lib/common';
import { createTwoFilesPatch } from 'diff';

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

export function patch(path: string, before: string, after: string) {
	return createTwoFilesPatch(path, path, before, after, undefined, undefined, { context: 3, timeout: 100 });
}
