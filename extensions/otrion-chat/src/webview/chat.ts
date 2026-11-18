/* Copyright (c) Otrion contributors. Licensed under the MIT License. */

declare function acquireVsCodeApi(): {
	postMessage(message: object): void;
	setState(state: { draft: string }): void;
	getState(): { draft: string } | undefined;
};

const api = acquireVsCodeApi();
const messages = document.querySelector<HTMLElement>('#messages')!;
const statusLabel = document.querySelector<HTMLElement>('#status')!;
const input = document.querySelector<HTMLTextAreaElement>('#input')!;
const send = document.querySelector<HTMLButtonElement>('#send')!;
const stopButton = document.querySelector<HTMLButtonElement>('#stop')!;
const newChat = document.querySelector<HTMLButtonElement>('#new')!;
let busy = false;

function updateButtons() {
	send.disabled = busy || !input.value.trim();
	stopButton.hidden = !busy;
	newChat.disabled = busy;
}

function addMessage(role: string, text: string) {
	const article = document.createElement('article');
	const label = document.createElement('strong');
	const body = document.createElement('div');
	label.textContent = role;
	body.textContent = text;
	article.append(label, body);
	messages.append(article);
	return body;
}

window.addEventListener('message', ({ data }) => {
	const atBottom = messages.scrollHeight - messages.clientHeight - messages.scrollTop < 32;
	if (data.type === 'state') {
		messages.replaceChildren();
		for (const message of data.messages) {
			addMessage(message.role, message.text);
		}
		busy = data.busy;
		statusLabel.textContent = data.status;
		updateButtons();
	} else if (data.type === 'chunk') {
		const body = messages.children[data.index]?.lastElementChild ?? addMessage('Codex', '');
		body.append(data.text);
		statusLabel.textContent = 'Codex is replying…';
	}
	if (atBottom) {
		messages.scrollTop = messages.scrollHeight;
	}
});

document.querySelector('form')!.addEventListener('submit', event => {
	event.preventDefault();
	if (busy || !input.value.trim()) {
		return;
	}
	busy = true;
	api.postMessage({ type: 'send', text: input.value });
	input.value = '';
	api.setState({ draft: '' });
	updateButtons();
	input.focus();
});
input.addEventListener('keydown', event => {
	if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
		event.preventDefault();
		send.form?.requestSubmit();
	}
});
input.addEventListener('input', () => {
	api.setState({ draft: input.value });
	updateButtons();
});
stopButton.addEventListener('click', () => api.postMessage({ type: 'stop' }));
newChat.addEventListener('click', () => {
	api.postMessage({ type: 'new' });
	input.focus();
});
input.value = api.getState()?.draft ?? '';
api.postMessage({ type: 'ready' });
