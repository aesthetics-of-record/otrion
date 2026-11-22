/* Copyright (c) Otrion contributors. Licensed under the MIT License. */

import { $, append, getActiveDocument, getWindow } from '../../../../base/browser/dom.js';
import { AnchorPosition } from '../../../../base/common/layout.js';
import { toDisposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { CommandsRegistry, ICommandService } from '../../../../platform/commands/common/commands.js';
import { IContextViewService } from '../../../../platform/contextview/browser/contextView.js';
import './media/agentUsagePopover.css';

interface UsageProvider {
	id: string;
	name: string;
	logo?: string;
	summary: string;
	percent?: number;
	previous?: boolean;
	plan?: string;
	credits?: string;
	unmetered?: string;
	updatedAt?: number;
	limits: { label: string; percent: number; resetsAt?: number; resetsIn?: string }[];
	sessions: { id: string; title: string; cost: string }[];
}

interface UsageSnapshot {
	providers: UsageProvider[];
	empty: string;
	unreported?: string[];
}

function meter(parent: HTMLElement, percent: number, label: string) {
	const bar = append(parent, $('meter.usage-meter', { min: 0, max: 100, 'aria-label': label })) as HTMLMeterElement;
	bar.value = percent;
}

function identity(parent: HTMLElement, provider: UsageProvider) {
	if (provider.logo && /^[A-Za-z0-9+/]+=*$/.test(provider.logo)) {
		const logo = append(parent, $('i.usage-logo', { 'aria-hidden': 'true' }));
		logo.style.maskImage = 'url(data:image/svg+xml;base64,' + provider.logo + ')';
	}
	append(parent, $('strong', {}, provider.name));
}

CommandsRegistry.registerCommand('_otrion.showUsagePopover', accessor => {
	const commands = accessor.get(ICommandService);
	const views = accessor.get(IContextViewService);
	const anchor = getActiveDocument().getElementById('otrion.otrion-chat.otrion.agentUsage');
	if (!anchor) { return; }
	if (anchor.querySelector('.otrion-usage-popover')) { views.hideContextView(); return; }
	views.showContextView({
		getAnchor: () => anchor,
		anchorPosition: AnchorPosition.ABOVE,
		hostAsPopover: true,
		render(container) {
			const win = getWindow(container);
			const title = localize('otrionUsage', "Agent usage");
			const root = append(container, $('section.otrion-usage-popover', { role: 'dialog', 'aria-label': title, tabindex: -1 }));
			const listPane = append(root, $('section.usage-pane'));
			const header = append(listPane, $('header'));
			append(header, $('strong', {}, title));
			const reloadLabel = localize('otrionRefreshUsage', "Refresh usage");
			const reload = append(header, $('button.usage-refresh.codicon.codicon-refresh', { type: 'button', title: reloadLabel, 'aria-label': reloadLabel })) as HTMLButtonElement;
			const manageLabel = localize('otrionManageAgents', "Manage agents…");
			const manage = append(header, $('button.codicon.codicon-settings-gear', { type: 'button', title: manageLabel, 'aria-label': manageLabel }));
			const list = append(listPane, $('.usage-list'));
			manage.onclick = () => { views.hideContextView(); void commands.executeCommand('otrion.settings.open', 'agents'); };
			const detail = append(root, $('section.usage-pane.usage-detail'));
			let snapshot: UsageSnapshot = { providers: [], empty: localize('otrionLoadingUsage', "Checking usage…") };
			let selected: string | undefined;
			let previous: string | undefined;
			let disposed = false;
			let fetching = false;

			function draw() {
				const focused = root.ownerDocument.activeElement as HTMLElement | null;
				const focusKey = focused?.dataset.usageKey;
				const provider = snapshot.providers.find(p => p.id === selected);
				list.replaceChildren();
				detail.replaceChildren();
				detail.hidden = !provider;
				if (!snapshot.providers.length) { append(list, $('p.usage-caption', {}, snapshot.empty)); }
				for (const p of snapshot.providers) {
					const button = append(list, $('button.usage-row.usage-provider', { type: 'button', title: p.summary, 'aria-expanded': String(p === provider) }));
					button.dataset.usageKey = p.id;
					const name = append(button, $('.usage-identity'));
					identity(name, p);
					const summary = append(button, $('.usage-summary'));
					if (p.percent !== undefined) {
						const ring = append(summary, $('i.usage-ring', { 'aria-hidden': 'true' }));
						ring.style.setProperty('--usage-remaining', `${p.percent}%`);
					}
					append(summary, $('span', {}, p.percent === undefined || p.previous ? p.summary : localize('otrionUsageLeft', "{0}% left", p.percent)));
					append(button, $('i.codicon.codicon-chevron-right', { 'aria-hidden': 'true' }));
					button.onclick = () => { selected = selected === p.id ? undefined : p.id; draw(); };
				}
				if (snapshot.unreported?.length) {
					append(list, $('p.usage-caption', {}, localize('otrionUsageUnreported', "No account data · {0}", snapshot.unreported.join(', '))));
				}
				if (provider) {
					const name = append(detail, $('header.usage-identity'));
					identity(name, provider);
					if (provider.plan) { append(name, $('span.usage-plan', {}, provider.plan)); }
					if (provider.updatedAt) {
						const time = new Date(provider.updatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
						append(name, $('small', {}, localize('otrionUsageUpdated', "Updated {0}", time)));
					}
					for (const limit of provider.limits) {
						const section = append(detail, $('.usage-section'));
						const caption = append(section, $('.usage-values'));
						append(caption, $('strong', {}, localize('otrionLimitPeriod', "{0} limit", limit.label)));
						const remaining = localize('otrionUsageLeft', "{0}% left", limit.percent);
						append(caption, $('span', {}, remaining));
						meter(section, limit.percent, remaining);
						if (limit.resetsAt) {
							const date = new Date(limit.resetsAt * 1000).toLocaleString();
							const reset = limit.resetsIn ? localize('otrionUsageResetsIn', "Resets in {0}", limit.resetsIn) : localize('otrionUsagePeriodEnded', "Period ended {0}", date);
							append(section, $('small', { title: date }, reset));
						}
					}
					if (provider.unmetered) { append(detail, $('p.usage-caption', {}, provider.unmetered)); }
					if (provider.credits) {
						const credits = append(detail, $('.usage-section'));
						append(credits, $('strong', {}, localize('otrionAvailableCredits', "Available credits")));
						append(credits, $('span', {}, provider.credits));
					}
					for (const session of provider.sessions) {
						const button = append(detail, $('button.usage-row.usage-session', { type: 'button' }));
						button.dataset.usageKey = session.id;
						append(button, $('strong', {}, session.title));
						append(button, $('small', {}, localize('otrionSessionCost', "Session cost {0}", session.cost)));
						button.onclick = () => { views.hideContextView(); void commands.executeCommand('_otrion.openUsageSession', session.id); };
					}
				}
				if (focusKey) { Array.from(root.querySelectorAll<HTMLElement>('[data-usage-key]')).find(el => el.dataset.usageKey === focusKey)?.focus(); }
				views.layout();
			}

			async function read(force = false) {
				if (fetching) { return; }
				fetching = true;
				reload.setAttribute('aria-busy', String(force));
				try {
					const next = await commands.executeCommand<UsageSnapshot>('_otrion.readUsagePopover', force);
					if (!disposed && next) {
						const serialized = JSON.stringify(next);
						if (serialized !== previous) {
							if (selected && !next.providers.some(p => p.id === selected)) { selected = undefined; }
							snapshot = next;
							previous = serialized;
							draw();
						}
					}
				} catch {
					if (!disposed && !snapshot.providers.length) {
						snapshot.empty = localize('otrionUsageUnavailable', "Usage is unavailable.");
						draw();
					}
				} finally { fetching = false; reload.removeAttribute('aria-busy'); }
			}
			reload.onclick = () => void read(true);
			root.onkeydown = e => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); views.hideContextView(); } };
			draw();
			root.focus();
			void read();
			const timer = win.setInterval(() => void read(), 10_000);
			return toDisposable(() => { disposed = true; win.clearInterval(timer); root.remove(); });
		},
	}, anchor);
});
