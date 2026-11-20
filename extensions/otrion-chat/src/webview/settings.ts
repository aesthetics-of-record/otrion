/* Copyright (c) Otrion contributors. Licensed under the MIT License. */

{
	const host = acquireVsCodeApi();
	const sections = Array.from(document.querySelectorAll<HTMLElement>('.agents section'));
	const search = document.querySelector<HTMLInputElement>('#search')!;
	search.addEventListener('input', () => {
		const term = search.value.trim().toLowerCase();
		for (const section of sections) {
			section.hidden = !section.querySelector('.agent-info')!.textContent.toLowerCase().includes(term);
			if (section.hidden) { section.querySelector<HTMLElement>('.menu')!.hidePopover(); }
		}
		document.getElementById('empty')!.hidden = sections.some(section => !section.hidden);
	});

	for (const section of sections) {
		section.addEventListener('click', event => {
			const button = event.target instanceof Element ? event.target.closest('button') : null;
			const action = button?.dataset.action;
			if (!action || !button) { return; }
			section.querySelector<HTMLElement>('.menu')!.hidePopover();
			button.disabled = true;
			host.postMessage(action === 'enable' || action === 'disable'
				? { id: section.id, action: 'allow', value: action === 'enable' }
				: { id: section.id, action });
		});
	}
	const gallery = document.querySelector<HTMLFormElement>('#gallery')!;
	const service = document.querySelector<HTMLInputElement>('#serviceUrl')!;
	const item = document.querySelector<HTMLInputElement>('#itemUrl')!;
	const reset = document.querySelector<HTMLButtonElement>('#reset')!;
	const reload = document.querySelector<HTMLButtonElement>('#reload')!;
	gallery.addEventListener('submit', event => {
		event.preventDefault();
		host.postMessage({ action: 'saveGallery', serviceUrl: service.value.trim(), itemUrl: item.value.trim() });
	});
	reset.addEventListener('click', () => host.postMessage({ action: 'resetGallery' }));
	reload.addEventListener('click', () => host.postMessage({ action: 'reload' }));
	window.addEventListener('message', ({ data }) => {
		if (data.focusAgent) {
			const target = sections.find(section => section.id === data.focusAgent);
			if (target) {
				if (target.hidden) { search.value = ''; search.dispatchEvent(new Event('input')); }
				target.focus({ preventScroll: true });
				target.scrollIntoView({ block: 'nearest' });
				host.postMessage({ action: 'focusedAgent', id: target.id });
			}
		}
		if (data.gallery) {
			service.value = data.gallery.serviceUrl;
			item.value = data.gallery.itemUrl;
		}
		if (data.notice) {
			document.getElementById('gallery-status')!.textContent = data.notice;
			reload.hidden = !data.saved;
		}
		if (!data.rows) { return; }
		for (const row of data.rows) {
			const section = document.getElementById(row.id)!;
			const primary = section.querySelector<HTMLButtonElement>('.primary')!;
			const enabled = !!row.source && row.allowed;
			const auth = section.querySelector<HTMLElement>('.auth')!;
			const byok = row.mode === 'key';
			for (const button of section.querySelectorAll<HTMLButtonElement>('.auth-options button')) {
				button.disabled = false;
				const action = button.dataset.action;
				if (action === 'cli' || action === 'key') {
					button.setAttribute('aria-pressed', String(action === row.mode));
				} else if (action === 'login') {
					button.hidden = byok || !enabled || row.auth === 'Signed in';
				} else {
					button.hidden = !byok || (action === 'removeKey' && !row.hasKey);
					if (action === 'replaceKey') { button.textContent = row.hasKey ? 'Replace key' : 'Add key'; }
				}
			}
			section.querySelector('.auth-note')!.textContent = byok
				? 'Uses your ' + (row.id === 'codex' ? 'OpenAI' : 'Anthropic') + ' API billing from the next request.'
				: data.remote ? 'Uses the CLI account on this host.' : 'Uses the credentials configured in your local CLI.';
			auth.textContent = byok ? (row.hasKey ? 'API key saved' : 'API key required') : row.auth === 'Unknown' ? 'Login status unavailable' : row.auth ?? (row.source ? 'Enable to check sign-in' : '');
			auth.classList.toggle('signed-in', byok ? row.hasKey : row.auth === 'Signed in');
			primary.hidden = enabled;
			primary.dataset.action = row.source ? 'enable' : 'install';
			primary.disabled = row.installing || (!row.source && row.installed);
			primary.textContent = row.installing ? (data.remote ? 'Installing on SSH host…' : 'Installing…') : row.source ? 'Enable' : row.installed ? 'Unavailable' : 'Install';
			section.querySelector<HTMLElement>('.enabled')!.hidden = !enabled;
			section.querySelector('.agent-info')!.setAttribute('title', row.availability);
			const menu = section.querySelector<HTMLElement>('.menu')!;
			for (const item of menu.querySelectorAll<HTMLButtonElement>('button')) {
				item.disabled = false;
				item.hidden = item.dataset.action === 'install' ? !row.source || row.installed || row.installing
					: !row.allowed;
			}
			const more = section.querySelector<HTMLButtonElement>('.more')!;
			more.disabled = !menu.querySelector('button:not([hidden])');
			if (more.disabled) { menu.hidePopover(); }
			section.querySelector('.error')!.textContent = row.error || (!row.source && row.availability !== 'Not installed' ? row.availability : '');
		}
	});
	host.postMessage({ action: 'ready' });
}
