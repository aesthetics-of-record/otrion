/* Copyright (c) Otrion contributors. Licensed under the MIT License. */

import * as vscode from 'vscode';
import type { AccountQuota, QuotaWindow } from './acp';
import { agents, type AgentId } from './agentCatalog';
import type { AgentStore } from './agents';

interface SessionUsage {
	id: string;
	agent: AgentId;
	title: string;
	active: boolean;
	cost?: { amount: number; currency: string };
}

// Reserve an empty or full meter for an actual zero or exhausted limit.
function remainingPercent(usedPercent: number) {
	if (usedPercent >= 100) { return 0; }
	if (usedPercent <= 0) { return 100; }
	return Math.max(1, Math.min(99, Math.round(100 - usedPercent)));
}

function quotaPeriod(window: QuotaWindow) {
	if (window.label) { return window.label; }
	const minutes = window.windowDurationMins;
	if (!minutes) { return vscode.l10n.t("Limit"); }
	if (minutes % 1440 === 0) { return vscode.l10n.t("{0}d", minutes / 1440); }
	if (minutes % 60 === 0) { return vscode.l10n.t("{0}h", minutes / 60); }
	return vscode.l10n.t("{0}m", minutes);
}

function timeUntilReset(timestamp?: number | null) {
	if (!timestamp) { return ''; }
	const minutes = Math.max(1, Math.ceil((timestamp * 1000 - Date.now()) / 60_000));
	const hours = Math.floor(minutes / 60);
	if (hours >= 24) { return vscode.l10n.t("{0}d {1}h", Math.floor(hours / 24), hours % 24); }
	if (hours) { return vscode.l10n.t("{0}h {1}m", hours, minutes % 60); }
	return vscode.l10n.t("{0}m", minutes);
}

export function registerUsageStatus(context: vscode.ExtensionContext, store: AgentStore, enabled: () => ReadonlySet<AgentId>, connected: () => SessionUsage[], open: (id: string) => void, logo: (id: AgentId) => string | undefined) {
	const status = vscode.window.createStatusBarItem('otrion.agentUsage', vscode.StatusBarAlignment.Left, 0);
	const name = vscode.l10n.t("Agent Usage");
	status.name = name;
	status.command = '_otrion.showUsagePopover';
	const accounts = new Map<AgentId, { quota?: AccountQuota; updatedAt?: number; nextRead: number; request?: AbortController; reading?: Promise<void> }>();
	const running = new Set<Promise<AccountQuota | undefined>>();
	const checking = () => [...accounts.values()].some(state => state.request);

	function rows() {
		const sessions = connected().filter(s => enabled().has(s.agent)).sort((a, b) => Number(b.active) - Number(a.active));
		const now = Date.now() / 1000;
		const sources: (Omit<SessionUsage, 'id'> & { id?: string })[] = [...sessions];
		for (const [agent, state] of accounts) {
			if (state.quota && !sessions.some(s => s.agent === agent)) { sources.push({ agent, active: false, title: vscode.l10n.t("Account") }); }
		}
		return sources.flatMap(session => {
			const account = accounts.get(session.agent)?.quota;
			const windows = account?.windows ?? [];
			const current = windows.filter(w => !w.resetsAt || w.resetsAt > now);
			const previous = windows.length > 0 && !current.length;
			const quota = previous ? windows : current;
			const cost = session.cost ? session.cost.currency + ' ' + session.cost.amount.toLocaleString(undefined, { maximumFractionDigits: 4 }) : '';
			const percent = quota.length && !(previous && (account?.credits !== undefined || account?.balance || account?.unlimited || account?.unmetered?.length)) ? remainingPercent(quota[0].usedPercent) : undefined;
			const balance = account?.credits;
			const credits = account?.unlimited ? vscode.l10n.t("Unlimited credits")
				: account?.balance ? account.balance.amount.toLocaleString(undefined, { style: 'currency', currency: account.balance.currency })
				: balance !== undefined ? vscode.l10n.t("{0} credits", Number.isFinite(Number(balance)) ? Number(balance).toLocaleString() : balance) : '';
			const unmetered = account?.unmetered?.length ? vscode.l10n.t("Unlimited · {0}", account.unmetered.join(', ')) : '';
			const sessionCost = cost ? vscode.l10n.t("Session cost {0}", cost) : '';
			const summary = percent === undefined ? credits || unmetered || sessionCost : previous ? vscode.l10n.t("Previous period · {0}% left", percent) : vscode.l10n.t("{0} {1}% left", quotaPeriod(quota[0]), percent);
			if (!summary) { return []; }
			const statusLabel = percent !== undefined && previous ? summary : percent !== undefined ? vscode.l10n.t("{0}% left", percent) : unmetered && !credits ? vscode.l10n.t("Unlimited") : summary;
			return [{ id: session.id, agent: session.agent, label: agents[session.agent].name, description: session.title, summary, statusLabel,
				percent, credits, cost, unmetered, previous: previous && percent !== undefined,
				limits: quota.map(w => ({ label: quotaPeriod(w), percent: remainingPercent(w.usedPercent), resetsAt: w.resetsAt, resetsIn: previous ? undefined : timeUntilReset(w.resetsAt) })) }];
		});
	}

	function clearQuota(id: AgentId) {
		accounts.get(id)?.request?.abort();
		accounts.delete(id);
	}

	async function readAccount(id: AgentId, signal: AbortSignal) {
		while (running.size >= 3) { await Promise.race(running); }
		if (signal.aborted) { return undefined; }
		const work = store.accountQuota(id, AbortSignal.any([signal, AbortSignal.timeout(20_000)])).catch(() => undefined);
		running.add(work);
		try { return await work; }
		finally { running.delete(work); }
	}

	function refresh(force = false) {
		const ids = enabled();
		for (const id of accounts.keys()) {
			if (!vscode.workspace.isTrusted || !ids.has(id)) { clearQuota(id); }
		}
		if (!vscode.workspace.isTrusted || !ids.size) { status.hide(); return; }
		for (const id of ids) {
			if (!accounts.has(id)) { accounts.set(id, { nextRead: 0 }); }
			const state = accounts.get(id)!;
			if (state.request || (!force && Date.now() < state.nextRead)) { continue; }
			const request = new AbortController();
			state.request = request;
			state.nextRead = Date.now() + 5 * 60_000;
			state.reading = readAccount(id, request.signal).then(result => {
				if (accounts.get(id) !== state) { return; }
				state.request = undefined;
				state.reading = undefined;
				state.quota = result;
				state.updatedAt = result ? Date.now() : undefined;
				render();
			});
		}
		render();
	}

	function render() {
		const items = rows();
		if (!items.length) {
			status.text = name;
			status.tooltip = checking() ? vscode.l10n.t("Checking account usage…") : vscode.l10n.t("No account limits, credits, or session costs reported yet.");
			status.accessibilityInformation = { label: status.name + '. ' + status.tooltip };
			status.show();
			return;
		}
		const first = items.find(item => !item.previous && (item.percent !== undefined || item.credits || item.unmetered)) ?? items[0];
		const count = new Set(items.map(item => item.agent)).size;
		status.text = first.label + ' ' + first.statusLabel + (count > 1 ? '  +' + (count - 1) : '');
		status.tooltip = vscode.l10n.t("{0} · {1}. Click for details.", first.label, first.summary);
		status.accessibilityInformation = { label: vscode.l10n.t("Agent usage. {0}, {1}. Show session details.", first.label, first.summary) };
		status.show();
	}

	const timer = setInterval(refresh, 60_000);
	context.subscriptions.push(status, vscode.commands.registerCommand('_otrion.readUsagePopover', async (force?: boolean) => {
		if (force) {
			refresh(true);
			await Promise.all([...accounts.values()].map(state => state.reading));
		}
		const items = vscode.workspace.isTrusted ? rows() : [];
		const providers = [...new Set(items.map(item => item.agent))].map(id => {
			const sessions = items.filter(item => item.agent === id);
			const first = sessions[0];
			return { id, name: first.label, logo: logo(id), summary: first.summary, percent: first.percent, previous: first.previous,
				plan: accounts.get(id)?.quota?.plan, updatedAt: accounts.get(id)?.updatedAt, unmetered: first.unmetered,
				limits: first.limits, credits: first.credits,
				sessions: sessions.flatMap(s => s.id && s.cost ? [{ id: s.id, title: s.description, cost: s.cost }] : []) };
		});
		const unreported = [...accounts].filter(([id, state]) => !state.request && !items.some(item => item.agent === id && (item.percent !== undefined || item.credits || item.unmetered)));
		return { providers, unreported: unreported.map(([id]) => agents[id].name), empty: checking() ? vscode.l10n.t("Checking account usage…") : vscode.l10n.t("No usage reported yet.") };
	}), vscode.commands.registerCommand('_otrion.openUsageSession', (id: string) => {
		if (connected().some(item => item.id === id && enabled().has(item.agent))) { open(id); }
	}), { dispose() { clearInterval(timer); for (const id of accounts.keys()) { clearQuota(id); } } });
	refresh();
	return { refresh: () => refresh(), resetAccount(id?: AgentId) {
		for (const agent of accounts.keys()) { if (!id || agent === id) { clearQuota(agent); } }
		refresh();
	} };
}
