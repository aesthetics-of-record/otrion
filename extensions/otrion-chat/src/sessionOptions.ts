/* Copyright (c) Otrion contributors. Licensed under the MIT License. */

export interface SessionOption {
	id: string;
	kind: 'model' | 'reasoning' | 'fast' | 'mode';
	description?: string;
	current: string | boolean;
	choices: { value: string; name: string; description?: string }[];
}

function record(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}

export function readSessionOptions(raw: unknown): SessionOption[] {
	if (!Array.isArray(raw)) { return []; }
	const result: SessionOption[] = [];
	for (const item of raw) {
		if (!record(item) || typeof item.id !== 'string') { continue; }
		const kind = item.category === 'mode' ? 'mode' : item.category === 'model' ? 'model' : item.category === 'thought_level' ? 'reasoning'
			: item.id === 'fast' || item.id === 'fast-mode' ? 'fast' : undefined;
		if (!kind) { continue; }
		const base = { id: item.id, kind, description: typeof item.description === 'string' ? item.description : undefined } as const;
		if (item.type === 'boolean' && typeof item.currentValue === 'boolean') {
			result.push({ ...base, current: item.currentValue, choices: [] });
		} else if (item.type === 'select' && Array.isArray(item.options) && typeof item.currentValue === 'string') {
			const choices: SessionOption['choices'] = [];
			for (const entry of item.options) {
				// ACP groups model families under a group name on some adapters.
				for (const option of record(entry) && Array.isArray(entry.options) ? entry.options : [entry]) {
					if (record(option) && typeof option.value === 'string' && typeof option.name === 'string') {
						choices.push({ value: option.value, name: option.name, description: typeof option.description === 'string' ? option.description : undefined });
					}
				}
			}
			if (choices.length) { result.push({ ...base, current: item.currentValue, choices }); }
		}
	}
	return result;
}
