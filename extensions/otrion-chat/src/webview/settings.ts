/* Copyright (c) Otrion contributors. Licensed under the MIT License. */

{
	const host = acquireVsCodeApi();
	const sections = Array.from(document.querySelectorAll<HTMLElement>('.agents section'));
	const search = document.querySelector<HTMLInputElement>('#search')!;
	const navigation = document.querySelectorAll<HTMLButtonElement>('nav button[aria-controls]');
	function showPage(id: string) {
		for (const button of navigation) {
			const target = button.getAttribute('aria-controls')!;
			const active = target === id;
			document.getElementById(target)!.hidden = !active;
			button.setAttribute('aria-current', active ? 'page' : 'false');
		}
	}
	for (const button of navigation) {
		button.addEventListener('click', () => {
			if (button.getAttribute('aria-current') === 'page') { return; }
			const id = button.getAttribute('aria-controls')!;
			showPage(id);
			host.postMessage({ action: 'navigate', page: id === 'page-agents' ? 'agents' : 'general' });
		});
	}

	search.addEventListener('input', () => {
		const term = search.value.trim().toLowerCase();
		for (const section of sections) {
			const keywords = section.querySelector('.agent-info')!.textContent + ' ' + section.dataset.provider;
			section.hidden = !keywords.toLowerCase().includes(term);
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
				: { id: section.id, action, value: button.dataset.target });
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
			showPage('page-agents');
			const target = data.focusAgent === 'agents' ? search : sections.find(section => section.id === data.focusAgent);
			if (target) {
				if (target.hidden) { search.value = ''; search.dispatchEvent(new Event('input')); }
				target.focus({ preventScroll: true });
				target.scrollIntoView({ block: 'nearest' });
				host.postMessage({ action: 'focusedAgent', id: data.focusAgent });
			}
		}
		if (data.gallery) {
			service.value = data.gallery.serviceUrl;
			item.value = data.gallery.itemUrl;
			gallery.inert = false;
			gallery.removeAttribute('aria-busy');
		}
		if (data.notice) {
			document.getElementById('gallery-status')!.textContent = data.notice;
			reload.hidden = !data.saved;
		}
		if (data.agentUpdate) {
			const { id, installed, label, target } = data.agentUpdate;
			const section = document.getElementById(id);
			if (section && section.dataset.version === installed) {
				section.querySelector('.release-label')!.textContent = label;
				const button = section.querySelector<HTMLButtonElement>('[data-action="update"]')!;
				button.dataset.target = target ?? '';
				button.hidden = !target;
				section.querySelector<HTMLButtonElement>('[data-action="checkUpdate"]')!.disabled = false;
			}
		}
		if (!data.rows) { return; }
		for (const row of data.rows) {
			const section = document.getElementById(row.id)!;
			const primary = section.querySelector<HTMLButtonElement>('.primary')!;
			const update = section.querySelector<HTMLButtonElement>('[data-action="update"]')!;
			const release = section.querySelector<HTMLElement>('.agent-release')!;
			release.hidden = !row.version && row.source !== 'External installation';
			if (section.dataset.version !== (row.version ?? '') || !row.version) {
				section.dataset.version = row.version ?? '';
				update.hidden = true;
				release.querySelector('.release-label')!.textContent = row.versionLabel ?? 'Updated by your external installer';
			}
			update.disabled = row.installing || !row.trusted;
			update.textContent = row.installing ? 'Updating…' : 'Update';
			update.title = row.trusted ? 'Install this release for new sessions' : 'Trust this workspace to update';
			const enabled = !!row.source && row.allowed;
			const auth = section.querySelector<HTMLElement>('.auth')!;
			const byok = row.mode === 'key';
			for (const button of section.querySelectorAll<HTMLButtonElement>('.auth-options button')) {
				button.disabled = false;
				const action = button.dataset.action;
				if (action === 'cli' || action === 'key') {
					button.setAttribute('aria-pressed', String(action === row.mode));
				} else if (action === 'login' || action === 'guide') {
					button.hidden = byok || !enabled || row.authenticated;
					button.disabled = row.signingIn;
				} else {
					button.hidden = !byok || (action === 'removeKey' && !row.hasKey);
					if (action === 'replaceKey') { button.textContent = row.hasKey ? 'Replace key' : 'Add key'; }
				}
			}
			section.querySelector<HTMLElement>('.auth-options')!.hidden = !enabled && !byok;
			const note = section.querySelector<HTMLElement>('.auth-note');
			if (note) { note.hidden = !byok; }
			auth.textContent = byok ? (row.hasKey ? 'API key saved' : 'API key required') : row.authenticated || row.auth === 'Check account with /doctor' ? row.auth
				: row.signingIn ? 'Signing in…' : row.auth === 'Unknown' ? 'Login status unavailable' : row.auth ?? '';
			auth.classList.toggle('signed-in', byok ? row.hasKey : row.authenticated);
			primary.hidden = enabled;
			primary.dataset.action = row.source ? 'enable' : 'install';
			const unavailable = row.installed || row.installIssue;
			primary.disabled = row.installing || (!row.source && unavailable);
			primary.textContent = row.installing ? (data.remote ? 'Installing ' + data.location + '…' : 'Installing…') : row.source ? 'Enable' : unavailable ? 'Unavailable' : 'Install';
			section.querySelector<HTMLElement>('.enabled')!.hidden = !enabled;
			section.querySelector('.agent-info')!.setAttribute('title', row.availability);
			const menu = section.querySelector<HTMLElement>('.menu')!;
			for (const item of menu.querySelectorAll<HTMLButtonElement>('button')) {
				item.disabled = false;
				item.hidden = item.dataset.action === 'checkUpdate' ? !row.version || row.installing
					: item.dataset.action === 'install' ? !row.source || row.installed || row.installing || !!row.installIssue
					: item.dataset.action === 'key' ? enabled || byok
					: item.dataset.action === 'disable' && !row.allowed;
			}
			const more = section.querySelector<HTMLButtonElement>('.more')!;
			more.disabled = !menu.querySelector('button:not([hidden])');
			if (more.disabled) { menu.hidePopover(); }
			const unavailableReason = row.availability === 'Not installed' ? row.installIssue : row.availability;
			section.querySelector('.error')!.textContent = row.error || (!row.source && unavailableReason) || '';
		}
	});
	host.postMessage({ action: 'ready' });
}
