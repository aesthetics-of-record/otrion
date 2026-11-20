/* Copyright (c) Otrion contributors. Licensed under the MIT License. */

import { stripVTControlCharacters } from 'node:util';
import type { SessionUpdate } from './acp';

export interface ContentBlock {
	type: string;
	text?: string;
	name?: string;
	uri?: string;
	mimeType?: string;
	data?: string;
	resource?: { uri: string; text?: string };
}

export interface ToolContent {
	type: string;
	content?: ContentBlock;
	path?: string;
	oldText?: string | null;
	newText?: string;
	terminalId?: string;
}

export interface ChatMessage {
	role: string;
	text: string;
	messageId?: string;
	kind?: 'thought' | 'tool' | 'plan' | 'notice' | 'compaction';
	compactionId?: string;
	title?: string;
	status?: string;
	toolCallId?: string;
	toolKind?: string;
	locations?: { path: string; line?: number }[];
	input?: string;
	output?: string;
	terminal?: string;
	exit?: string;
	artifacts?: { label: string; text?: string; before?: string; after?: string; image?: string }[];
	entries?: { content: string; status: string }[];
}

const limit = 32000;
function excerpt(value: string) {
	return value.length > limit ? value.slice(0, limit) + '\n… (output truncated)' : value;
}
function pretty(value: unknown) {
	return excerpt(typeof value === 'string' ? value : JSON.stringify(value, null, 2) ?? '');
}
function contentText(block: ContentBlock) {
	switch (block.type) {
		case 'text': return block.text ?? '';
		case 'resource_link': return '@' + (block.name || block.uri || 'resource');
		case 'resource': return block.resource?.text ?? block.resource?.uri ?? '';
		case 'image': return 'Image';
		case 'audio': return 'Audio attachment';
		default: return '';
	}
}
function imageSource(block: ContentBlock) {
	if (block.type === 'image' && /^image\/(png|jpeg|gif|webp)$/.test(block.mimeType ?? '')
		&& typeof block.data === 'string' && block.data.length <= 5_592_408) {
		return 'data:' + block.mimeType + ';base64,' + block.data;
	}
	return undefined;
}
function artifacts(content: ToolContent[]): NonNullable<ChatMessage['artifacts']> {
	const parts: NonNullable<ChatMessage['artifacts']> = [];
	for (const item of content) {
		if (item?.type === 'diff' && typeof item.newText === 'string') {
			parts.push({ label: item.path || 'File change', before: excerpt(item.oldText ?? ''), after: excerpt(item.newText) });
		} else if (item?.type === 'content' && item.content) {
			parts.push({ label: 'Result', text: excerpt(contentText(item.content)), image: imageSource(item.content) });
		} else if (item?.type === 'terminal') {
			parts.push({ label: 'Terminal', text: item.terminalId });
		}
	}
	return parts;
}

/** Apply the same ordered ACP updates to live turns and session/load replay. */
export function applyTranscriptUpdate(rows: ChatMessage[], agent: string, update: SessionUpdate): number | undefined {
	const type = update.sessionUpdate;
	if (type === 'tool_call' || type === 'tool_call_update') {
		if (!update.toolCallId) { return; }
		let index = rows.findLastIndex(row => row.kind === 'tool' && row.toolCallId === update.toolCallId);
		if (index < 0) {
			index = rows.push({ role: agent, text: '', kind: 'tool', toolCallId: update.toolCallId, status: 'pending' }) - 1;
		}
		const row = rows[index];
		row.toolKind = update.kind ?? row.toolKind;
		row.title = update.title ?? row.title ?? update.name ?? update.kind ?? 'Tool call';
		row.status = update.status ?? row.status;
		if (Array.isArray(update.locations)) { row.locations = update.locations.filter(loc => typeof loc?.path === 'string'); }
		if (update.rawInput != null) { row.input = pretty(update.rawInput); }
		if (update.rawOutput != null) { row.output = pretty(update.rawOutput); }
		const meta = update._meta;
		const snapshot = meta?.terminal_output?.data;
		const delta = meta?.terminal_output_delta?.data;
		if (typeof snapshot === 'string' || typeof delta === 'string') {
			const buffer = (typeof snapshot === 'string' ? stripVTControlCharacters(snapshot) : row.terminal ?? '')
				+ (typeof delta === 'string' ? stripVTControlCharacters(delta) : '');
			row.terminal = buffer.length > limit ? '… (earlier output truncated)\n' + buffer.slice(-limit) : buffer;
		}
		const exit = meta?.terminal_exit;
		if (exit?.signal) { row.exit = 'Signal ' + exit.signal; }
		else if (typeof exit?.exit_code === 'number') { row.exit = 'Exit code ' + exit.exit_code; }
		if (Array.isArray(update.content)) { row.artifacts = artifacts(update.content); }
		return index;
	}
	if (type === 'plan' && Array.isArray(update.entries)) {
		const entries = update.entries.filter(entry => typeof entry?.content === 'string');
		const index = rows.findLastIndex(row => row.kind === 'plan');
		if (index >= 0 && index > rows.findLastIndex(row => row.role === 'You')) {
			rows[index].entries = entries;
			return index;
		}
		return rows.push({ role: agent, text: '', kind: 'plan', title: 'Plan', entries }) - 1;
	}
	if ((type === 'compaction_update' || type === 'compaction_summary_chunk') && update.compactionId) {
		let index = rows.findLastIndex(row => row.compactionId === update.compactionId);
		if (index < 0) {
			index = rows.push({ role: agent, text: '', kind: 'compaction', title: 'Context compaction', compactionId: update.compactionId, status: 'in_progress' }) - 1;
		}
		const row = rows[index];
		row.status = update.status ?? row.status;
		if (update.summary !== undefined) { row.text = update.summary?.map(contentText).join('') ?? ''; }
		if (update.error !== undefined) { row.output = update.error ?? undefined; }
		if (update.content && !Array.isArray(update.content)) { row.text += contentText(update.content); }
		return index;
	}
	if (type === 'notice' && update.title) {
		return rows.push({ role: agent, kind: 'notice', title: update.title, text: update.description ?? '', status: update.severity }) - 1;
	}
	if (type !== 'agent_message_chunk' && type !== 'agent_thought_chunk' && type !== 'user_message_chunk') { return; }
	const block = update.content;
	if (!block || Array.isArray(block)) { return; }
	const text = contentText(block);
	if (!text) { return; }
	const role = type === 'user_message_chunk' ? 'You' : agent;
	const kind = type === 'agent_thought_chunk' ? 'thought' : undefined;
	let row = rows.at(-1);
	if (!row || row.role !== role || row.kind !== kind || row.messageId !== update.messageId) {
		row = { role, kind, text: '', messageId: update.messageId };
		rows.push(row);
	}
	const image = imageSource(block);
	if (image) { (row.artifacts ??= []).push({ label: 'Image', image }); }
	else { row.text += text; }
	return rows.length - 1;
}
