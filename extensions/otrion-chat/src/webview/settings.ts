/* Copyright (c) Otrion contributors. Licensed under the MIT License. */

{
	const host = acquireVsCodeApi();
	for (const section of Array.from(document.querySelectorAll<HTMLElement>('section'))) {
		const checkbox = section.querySelector('input')!;
		checkbox.addEventListener('change', () => {
			checkbox.disabled = true;
			host.postMessage({ action: 'allow', id: section.id, value: checkbox.checked });
		});
		for (const button of Array.from(section.querySelectorAll('button'))) {
			button.addEventListener('click', () => {
				host.postMessage({ action: button.dataset.action, id: section.id });
			});
		}
	}
	window.addEventListener('message', ({ data }) => {
		for (const row of data.rows) {
			const section = document.getElementById(row.id)!;
			const checkbox = section.querySelector('input')!;
			checkbox.disabled = false;
			checkbox.checked = row.allowed;
			section.querySelector('.availability')!.textContent = row.installing ? 'Downloading and installing…' : row.availability;
			const install = section.querySelector<HTMLButtonElement>('[data-action=install]')!;
			install.disabled = row.installing || row.installed;
			install.textContent = row.installed ? 'Installed' : 'Install';
			section.querySelector<HTMLButtonElement>('[data-action=login]')!.disabled = !row.source || !row.allowed;
			section.querySelector('.error')!.textContent = row.error ?? '';
		}
	});
	host.postMessage({ action: 'ready' });
}
