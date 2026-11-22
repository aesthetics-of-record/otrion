/* Copyright (c) Otrion contributors. Licensed under the MIT License. */

import { execFile, spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import type { AccountQuota, QuotaWindow } from './acp';
import type { AgentId } from './agentCatalog';

type AgentCommand = { command: string; baseArgs: string[]; env: NodeJS.ProcessEnv };

function record(value: unknown): Record<string, unknown> {
	return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function numeric(value: unknown) {
	const n = typeof value === 'string' && value.trim() ? Number(value) : value;
	return typeof n === 'number' && Number.isFinite(n) ? n : undefined;
}

function windowOf(used: unknown, reset: unknown, period?: number, label?: string): QuotaWindow[] {
	const percent = numeric(used);
	if (percent === undefined || percent < 0) { return []; }
	const ms = typeof reset === 'number' ? reset : typeof reset === 'string' ? Date.parse(reset) : NaN;
	return [{ usedPercent: Math.min(100, percent), resetsAt: Number.isFinite(ms) ? ms / 1000 : undefined, windowDurationMins: period, label }];
}

function money(value: unknown, currency: unknown, divisor = 1) {
	const amount = numeric(value);
	if (amount !== undefined && typeof currency === 'string' && /^[A-Z]{3}$/.test(currency)) {
		return { amount: amount / divisor, currency };
	}
	return undefined;
}

export function parseAccountQuota(id: AgentId, payload: unknown): AccountQuota | undefined {
	const result = record(payload);
	const quota: AccountQuota = { windows: [] };
	switch (id) {
		case 'claude': {
			if (result.rate_limits_available !== true) { return; }
			const limits = record(result.rate_limits);
			for (const [key, label] of Object.entries({ five_hour: undefined, seven_day: undefined, seven_day_opus: 'Opus · 7d', seven_day_sonnet: 'Sonnet · 7d', seven_day_oauth_apps: 'OAuth apps · 7d' })) {
				const w = record(limits[key]);
				quota.windows.push(...windowOf(w.utilization, w.resets_at, key === 'five_hour' ? 300 : 10080, label));
			}
			for (const model of Array.isArray(limits.model_scoped) ? limits.model_scoped : []) {
				const w = record(model);
				if (typeof w.display_name === 'string') { quota.windows.push(...windowOf(w.utilization, w.resets_at, 10080, w.display_name + ' · 7d')); }
			}
			const extra = record(limits.extra_usage);
			if (extra.is_enabled === true) { quota.windows.push(...windowOf(extra.utilization, undefined, undefined, 'Extra usage')); }
			if (typeof result.subscription_type === 'string') { quota.plan = result.subscription_type; }
			break;
		}
		case 'github-copilot-cli': {
			const buckets = Object.entries(record(result.quotaSnapshots)).sort(([a], [b]) => Number(b === 'premium_interactions') - Number(a === 'premium_interactions'));
			for (const [key, bucket] of buckets) {
				const w = record(bucket);
				const label = key.replace(/_/g, ' ');
				if (w.isUnlimitedEntitlement === true) { (quota.unmetered ??= []).push(label); continue; }
				if (w.entitlementRequests === 0) { continue; }
				const left = numeric(w.remainingPercentage);
				if (left !== undefined && left >= 0 && left <= 100) { quota.windows.push(...windowOf(100 - left, w.resetDate, undefined, label)); }
			}
			break;
		}
		case 'opencode': {
			const info = record(result.data ?? result);
			const limits = record(info.go);
			for (const [key, period] of [['rolling', 300], ['weekly', 10080], ['monthly', undefined]] as const) {
				const w = record(limits[key]);
				quota.windows.push(...windowOf(w.percent, w.resetsAt, period, key === 'monthly' ? 'Monthly' : undefined));
			}
			for (const budget of Array.isArray(info.budgets) ? info.budgets : []) {
				const b = record(budget);
				const cap = numeric(b.limit);
				if (cap === undefined || cap <= 0) { continue; }
				const models = Array.isArray(b.models) ? b.models.map(record) : [];
				if (b.per === 'model' && b.coverage === 'models') {
					for (const model of models) {
						const spent = numeric(model.spent);
						if (spent !== undefined && typeof model.name === 'string') { quota.windows.push(...windowOf(spent / cap * 100, b.resetsAt, undefined, model.name)); }
					}
				} else {
					const spent = numeric(b.spent);
					const label = models.map(m => m.name).filter(n => typeof n === 'string').join(', ') || 'Workspace budget';
					if (spent !== undefined) { quota.windows.push(...windowOf(spent / cap * 100, b.resetsAt, undefined, label)); }
				}
			}
			break;
		}
		case 'grok': {
			const config = record(result.config ?? result.billing);
			const cap = numeric(record(config.monthlyLimit ?? result.monthlyLimit).val);
			const spent = numeric(record(config.used ?? record(result.usage).totalUsed).val);
			quota.windows = windowOf(config.creditUsagePercent ?? (cap && cap > 0 && spent !== undefined ? spent / cap * 100 : undefined),
				record(config.currentPeriod).end ?? config.billingPeriodEnd ?? record(result.billingCycle).billingPeriodEnd, undefined, 'Credits');
			quota.balance = money(record(config.prepaidBalance).val, 'USD', 100);
			if (typeof result.subscription_tier === 'string') { quota.plan = result.subscription_tier; }
			break;
		}
		case 'cursor': {
			const plan = record(result.planUsage);
			const cap = numeric(plan.limit);
			const spend = numeric(plan.includedSpend);
			const reset = numeric(result.billingCycleEnd) ?? result.billingCycleEnd;
			const included = plan.totalPercentUsed ?? (cap && cap > 0 && spend !== undefined ? spend / cap * 100 : undefined);
			quota.windows.push(...windowOf(included, reset, undefined, 'Included'), ...windowOf(plan.autoPercentUsed, reset, undefined, 'Auto'), ...windowOf(plan.apiPercentUsed, reset, undefined, 'API'));
			break;
		}
		case 'kimi-code': {
			const limits = record(result.usages);
			for (const [key, period] of [['limit_5h', 300], ['limit_7d', 10080], ['limit_month_total', undefined]] as const) {
				const w = record(limits[key]);
				const ratio = numeric(w.used_ratio);
				if (ratio !== undefined) { quota.windows.push(...windowOf(ratio * 100, w.reset_time, period, key === 'limit_month_total' ? 'Monthly' : undefined)); }
			}
			const wallet = record(result.boosterWallet);
			const balance = record(wallet.balance);
			if (balance.type === 'BOOSTER') { quota.balance = money(balance.amountLeft, record(wallet.monthlyChargeLimit).currency ?? record(wallet.monthlyUsed).currency ?? 'USD', 1e8); }
			break;
		}
		case 'cline': {
			const limits = record(result.data).limits;
			if (result.success !== true || !Array.isArray(limits)) { return; }
			for (const [type, period] of [['five_hour', 300], ['weekly', 10080], ['monthly', undefined]] as const) {
				const w = record(limits.find(l => record(l).type === type));
				quota.windows.push(...windowOf(w.percentUsed, w.resetsAt, period, type === 'monthly' ? 'Monthly' : undefined));
			}
			break;
		}
		case 'kilo':
			quota.balance = money(result.balance, 'USD');
			break;
	}
	return quota.windows.length || quota.unmetered?.length || quota.balance ? quota : undefined;
}

async function readJson(file: string) {
	return record(JSON.parse(await readFile(file, 'utf8')));
}

async function readClineBalance(headers: Record<string, string>, signal: AbortSignal) {
	const base = 'https://api.cline.bot/api/v1/';
	const get = async (route: string) => {
		const response = await fetch(base + route, { headers, signal, redirect: 'error' });
		if (!response.ok) { return {}; }
		const body = record(await response.json());
		return body.success === false ? {} : record(body.data ?? body);
	};
	const user = await get('users/me');
	const org = Array.isArray(user.organizations) ? user.organizations.map(record).find(o => o.active === true) : undefined;
	const id = org ? org.organizationId : user.id;
	if (typeof id !== 'string' || !id) { return undefined; }
	const balance = await get((org ? 'organizations/' : 'users/') + encodeURIComponent(id) + '/balance');
	return numeric(balance.balance);
}

async function readAccountApi(id: 'cline' | 'kilo' | 'kimi-code' | 'cursor', env: NodeJS.ProcessEnv, signal: AbortSignal) {
	let url: string;
	let auth: unknown;
	const headers: Record<string, string> = { Accept: 'application/json' };
	if (id === 'cline') {
		if ((env.CLINE_ENVIRONMENT && env.CLINE_ENVIRONMENT !== 'production') || (env.CLINE_API_BASE_URL && env.CLINE_API_BASE_URL !== 'https://api.cline.bot')) { return; }
		url = 'https://api.cline.bot/api/v1/users/me/plan/usage-limits';
		auth = env.CLINE_API_KEY;
		if (!auth) {
			const file = env.CLINE_PROVIDER_SETTINGS_PATH || path.join(env.CLINE_DATA_DIR || path.join(env.CLINE_DIR || path.join(homedir(), '.cline'), 'data'), 'settings', 'providers.json');
			const provider = record(record((await readJson(file)).providers).cline);
			const settings = record(provider.settings);
			const credential = record(settings.auth);
			auth = typeof credential.accessToken === 'string' && credential.accessToken ? (credential.accessToken.startsWith('workos:') ? credential.accessToken : 'workos:' + credential.accessToken) : settings.apiKey ?? credential.apiKey;
		}
	} else if (id === 'cursor') {
		if (env.CURSOR_API_KEY) { return; }
		url = 'https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage';
		const config = process.platform === 'linux' ? path.join(env.XDG_CONFIG_HOME || path.join(homedir(), '.config'), 'cursor') : path.join(homedir(), '.cursor');
		auth = env.CURSOR_AUTH_TOKEN || (await readJson(env.CURSOR_AUTH_FILE || path.join(env.CURSOR_HOME || config, 'auth.json'))).accessToken;
		headers['Connect-Protocol-Version'] = '1';
		headers['Content-Type'] = 'application/json';
	} else if (id === 'kimi-code') {
		if ((env.KIMI_CODE_BASE_URL && env.KIMI_CODE_BASE_URL.replace(/\/+$/, '') !== 'https://api.kimi.com/coding/v1') || env.KIMI_CODE_OAUTH_HOST || env.KIMI_OAUTH_HOST) { return; }
		url = 'https://api.kimi.com/coding/v1/usages';
		auth = (await readJson(path.join(env.KIMI_CODE_HOME || path.join(homedir(), '.kimi-code'), 'credentials', 'kimi-code.json'))).access_token;
	} else {
		if (env.KILO_API_URL && env.KILO_API_URL !== 'https://api.kilo.ai') { return; }
		url = 'https://api.kilo.ai/api/profile/balance';
		const cred = record((await readJson(path.join(env.XDG_DATA_HOME || path.join(homedir(), '.local', 'share'), 'kilo', 'auth.json'))).kilo);
		auth = cred.type === 'api' ? cred.key : cred.access;
		if (typeof cred.accountId === 'string') { headers['x-kilocode-organizationid'] = cred.accountId; }
	}
	if (typeof auth !== 'string' || !auth.trim()) { return; }
	headers.Authorization = 'Bearer ' + auth;
	const readLimits = async () => {
		const response = await fetch(url, { headers, redirect: 'error', signal, ...(id === 'cursor' ? { method: 'POST', body: '{}' } : {}) });
		return response.ok ? parseAccountQuota(id, await response.json()) : undefined;
	};
	if (id !== 'cline') { return readLimits(); }
	const [quota, balance] = await Promise.all([readLimits().catch(() => undefined), readClineBalance(headers, signal).catch(() => undefined)]);
	return balance === undefined ? quota : { ...quota, windows: quota?.windows ?? [], credits: String(balance) };
}

// Both CLIs accept a single read-only request without opening a chat. Copilot uses
// Content-Length framed JSON-RPC, Claude uses one stream-json control message per line.
async function queryCli(id: 'claude' | 'github-copilot-cli', cli: AgentCommand, signal: AbortSignal): Promise<unknown> {
	const copilot = id === 'github-copilot-cli';
	const args = copilot ? ['--headless', '--no-auto-update', '--stdio'] : ['--cli', '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--no-session-persistence', '--strict-mcp-config', '--settings', '{"disableAllHooks":true}', '--tools', ''];
	const request = JSON.stringify(copilot ? { jsonrpc: '2.0', id: 1, method: 'account.getQuota', params: {} }
		: { type: 'control_request', request_id: 'usage', request: { subtype: 'get_usage', skip_behaviors: true } });
	signal.throwIfAborted();
	const child = spawn(cli.command, [...cli.baseArgs, ...args], { cwd: tmpdir(), env: cli.env, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
	const stop = () => { child.stdin.end(); child.stdout.destroy(); child.kill(); };
	signal.addEventListener('abort', stop, { once: true });
	child.stdin.on('error', () => child.kill());
	child.once('error', error => child.stdout.destroy(error));
	try {
		child.stdin.write(copilot ? 'Content-Length: ' + Buffer.byteLength(request) + '\r\n\r\n' + request : request + '\n');
		let buffer: Buffer = Buffer.alloc(0);
		for await (const chunk of child.stdout) {
			buffer = Buffer.concat([buffer, chunk]);
			if (buffer.length > 2 * 1024 * 1024) { return; }
			while (buffer.length) {
				const split = buffer.indexOf(copilot ? '\r\n\r\n' : '\n');
				if (split < 0) { break; }
				let body = buffer.subarray(0, split);
				if (copilot) {
					const length = /^Content-Length:\s*(\d+)\s*$/im.exec(body.toString());
					if (!length) { return; }
					const end = split + 4 + Number(length[1]);
					if (end > buffer.length) { break; }
					body = buffer.subarray(split + 4, end);
					buffer = buffer.subarray(end);
				} else { buffer = buffer.subarray(split + 1); }
				const message = record(JSON.parse(body.toString()));
				if (copilot && message.id === 1) { return message.result; }
				const reply = record(message.response);
				if (!copilot && message.type === 'control_response' && reply.request_id === 'usage') { return reply.response; }
			}
		}
		return undefined;
	} finally { signal.removeEventListener('abort', stop); stop(); }
}

export async function readProductQuota(id: AgentId, cli: AgentCommand, signal: AbortSignal) {
	if (id === 'cline' || id === 'kilo' || id === 'kimi-code' || id === 'cursor') { return readAccountApi(id, cli.env, signal); }
	if (id === 'opencode') {
		const { stdout } = await promisify(execFile)(cli.command, [...cli.baseArgs, 'api', 'GET', '/api/experimental/usage/limits', '--standalone'], { env: cli.env, cwd: homedir(), signal, windowsHide: true, maxBuffer: 1024 * 1024 });
		return parseAccountQuota(id, JSON.parse(stdout));
	}
	if (id === 'claude' || id === 'github-copilot-cli') { return parseAccountQuota(id, await queryCli(id, cli, signal)); }
	return undefined;
}

// For agents that can bill through different services, only query the provider the
// user explicitly linked. CodexBar handles that provider's configured account.
export async function readLinkedQuota(provider: string, signal: AbortSignal) {
	if (!/^[a-z0-9][a-z0-9-]{0,60}$/.test(provider) || provider === 'all' || provider === 'both') { return; }
	const { stdout } = await promisify(execFile)('codexbar', ['usage', '--provider', provider, '--format', 'json'], {
		cwd: homedir(), signal, windowsHide: true, maxBuffer: 2 * 1024 * 1024,
		env: { ...process.env, CODEXBAR_ALLOW_BROWSER_COOKIE_IMPORT: '0' },
	});
	const data: unknown = JSON.parse(stdout);
	const entry = (Array.isArray(data) ? data : [data]).map(record).find(e => e.provider === provider && !e.error);
	const usage = record(entry?.usage);
	if (!entry || usage.dataConfidence === 'estimated' || entry.dataConfidence === 'estimated') { return; }
	const quota: AccountQuota = { windows: [], plan: 'CodexBar · ' + provider };
	for (const key of ['primary', 'secondary', 'tertiary']) {
		const w = record(usage[key]);
		quota.windows.push(...windowOf(w.usedPercent, w.resetsAt, numeric(w.windowMinutes), typeof w.title === 'string' ? w.title : undefined));
	}
	const credits = numeric(record(entry.credits).remaining);
	if (credits !== undefined) { quota.credits = String(credits); }
	const cost = record(usage.providerCost);
	quota.balance = money(cost.balance, cost.currencyCode);
	return quota.windows.length || quota.credits !== undefined || quota.balance ? quota : undefined;
}
