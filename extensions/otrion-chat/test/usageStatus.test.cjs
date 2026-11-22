/* Copyright (c) Otrion contributors. Licensed under the MIT License. */

const assert = require('node:assert/strict');
const { registerHooks } = require('node:module');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const out = path.join(process.env.OTRION_CHAT_TEST_EXTENSION ?? path.resolve(__dirname, '..'), 'out');

test('Codex quota reads the connected account and accepts unversioned app-server responses', async () => {
	const { AcpClient } = require(path.join(out, 'acp.js'));
	const server = `
		const account = process.argv[1];
		let initialized = false;
		require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
			const { id, method } = JSON.parse(line);
			let result;
			if (method === 'initialize') { result = {}; }
			else if (method === 'initialized') { initialized = true; return; }
			else if (initialized && method === 'account/read') { result = { account: { type: account } }; }
			else if (account === 'chatgpt' && method === 'account/rateLimits/read') {
				result = { rateLimitsByLimitId: { codex: { planType: 'plus', credits: { balance: '37997' }, primary: { usedPercent: 0, windowDurationMins: 300 }, secondary: { usedPercent: -1 } } } };
			} else { process.exit(1); }
			console.log(JSON.stringify({ id, result }));
		});`;
	for (const type of ['chatgpt', 'apiKey']) {
		const client = new AcpClient('codex', process.execPath, ['-e', server, type], tmpdir(), {}, () => {});
		try {
			assert.deepEqual(await client.readCodexQuota('test'), type === 'chatgpt' ? { windows: [{ usedPercent: 0, windowDurationMins: 300 }], plan: 'plus', credits: '37997', unlimited: false } : undefined);
		} finally { client.dispose(); }
	}
});

test('Account usage loads on startup without a session and follows changes in enabled agents', async () => {
	let visible = false;
	const handlers = new Map();
	const read = (...args) => handlers.get('_otrion.readUsagePopover')(...args);
	let opened;
	const status = { show() { visible = true; }, hide() { visible = false; }, dispose() {} };
	globalThis.__usageTest = {
		workspace: { isTrusted: true },
		l10n: { t: (message, ...args) => message.replace(/\{(\d+)\}/g, (_, i) => String(args[i])) },
		StatusBarAlignment: { Left: 1 },
		window: {
			createStatusBarItem: () => status
		},
		commands: { registerCommand: (id, handle) => { handlers.set(id, handle); return { dispose() {} }; } }
	};
	const hook = registerHooks({
		resolve(specifier, context, next) {
			return specifier === 'vscode' ? { url: 'otrion-usage:vscode', shortCircuit: true } : next(specifier, context);
		},
		load(url, context, next) {
			return url === 'otrion-usage:vscode' ? { format: 'module', source: 'export const { l10n, window, commands, workspace, StatusBarAlignment } = globalThis.__usageTest;', shortCircuit: true } : next(url, context);
		}
	});
	const context = { subscriptions: [] };
	const requests = [];
	const store = { accountQuota: (id, signal) => id === 'codex' ? new Promise(resolve => requests.push({ signal, resolve })) : Promise.resolve(undefined) };
	const codex = { id: 'a', agent: 'codex', title: 'First', active: true };
	const claude = { id: 'b', agent: 'claude', title: 'Second', active: false, context: { used: 25, size: 100 } };
	const enabled = new Set(['claude', 'codex']);
	let sessions = [];
	const tick = () => new Promise(resolve => setImmediate(resolve));
	try {
		const { registerUsageStatus } = require(path.join(out, 'usageStatus.js'));
		const { refresh, resetAccount } = registerUsageStatus(context, store, () => enabled, () => [...sessions], id => { opened = id; }, () => undefined);
		assert.equal(visible, true);
		assert.match(status.tooltip, /Checking/);
		requests[0].resolve({ credits: '37997', plan: 'plus', windows: [{ usedPercent: 10, windowDurationMins: 300 }] });
		await tick();
		assert.equal(status.text, 'Codex 90% left');
		assert.doesNotMatch(status.accessibilityInformation.label, /[▰▱]/);
		const [provider] = (await read()).providers;
		assert.equal(provider.plan, 'plus');
		assert.match(provider.credits, /37.?997 credits/);
		assert.equal(provider.limits[0].percent, 90);
		assert.equal(opened, undefined);
		resetAccount();
		enabled.delete('codex');
		refresh();
		assert.equal(requests[1].signal.aborted, true);
		sessions = [claude];
		refresh();
		assert.equal(status.text, 'Agent Usage');
		assert.deepEqual((await read()).providers, []);
		claude.cost = { amount: 0, currency: 'USD' };
		refresh();
		assert.equal(status.text, 'Claude Code Session cost USD 0');
		requests[1].resolve({ windows: [{ usedPercent: 27, windowDurationMins: 300 }] });
		await tick();
		sessions.push(codex);
		enabled.add('codex');
		refresh();
		assert.doesNotMatch(status.text, /Codex/);
		requests[2].resolve({ windows: [{ usedPercent: 80, windowDurationMins: 300, resetsAt: 1 }, { usedPercent: 0, windowDurationMins: 10080 }] });
		await tick();
		assert.equal(status.text, 'Codex 100% left  +1');
		assert.doesNotMatch(status.tooltip, /5h account limit/);
		assert.equal(requests.length, 3);
		const session = (await read()).providers.find(p => p.id === 'claude').sessions[0];
		assert.deepEqual(session, { id: 'b', title: 'Second', cost: 'USD 0' });
		handlers.get('_otrion.openUsageSession')(session.id);
		assert.equal(opened, 'b');
		sessions = [];
		refresh();
		assert.equal(status.text, 'Codex 100% left');
		for (const [usedPercent, expected] of [[99.9, '1% left'], [100, '0% left']]) {
			resetAccount();
			requests.at(-1).resolve({ windows: [{ usedPercent, windowDurationMins: 10080 }] });
			await tick();
			assert.equal(status.text, 'Codex ' + expected);
			assert.ok(status.tooltip.includes(expected));
			assert.ok(status.accessibilityInformation.label.includes(expected));
		}
		store.accountQuota = async id => id === 'claude' ? { windows: [{ usedPercent: 25, resetsAt: 1 }] } : { windows: [{ usedPercent: 80 }] };
		resetAccount('claude');
		await tick();
		const quotaRows = (await read(true)).providers;
		assert.equal(quotaRows.length, 2);
		assert.equal(status.text, 'Codex 20% left  +1');
		const prior = quotaRows.find(row => row.id === 'claude');
		assert.equal(prior.previous, true);
		assert.match(prior.summary, /Previous period.*75%/);
		assert.equal(prior.limits[0].resetsIn, undefined);
		enabled.clear();
		refresh();
		assert.equal(visible, false);
	} finally {
		for (const sub of context.subscriptions) { sub.dispose(); }
		hook.deregister();
		delete globalThis.__usageTest;
	}
});

test('Account meters preserve provider units and omit missing measurements', () => {
	const { parseAccountQuota } = require(path.join(out, 'accountQuota.js'));
	const reset = '2027-01-01T00:00:00Z';
	const claude = parseAccountQuota('claude', { rate_limits_available: true, rate_limits: { five_hour: { utilization: null }, seven_day: { utilization: 0, resets_at: reset } }, subscription_type: 'pro' });
	assert.equal(claude.windows.length, 1);
	assert.equal(claude.windows[0].windowDurationMins, 10080);
	assert.equal(claude.windows[0].usedPercent, 0);
	assert.equal(claude.windows[0].resetsAt, Date.parse(reset) / 1000);
	assert.equal(parseAccountQuota('claude', { session: { total_cost_usd: 10 }, rate_limits_available: false }), undefined);
	const copilot = parseAccountQuota('github-copilot-cli', { quotaSnapshots: { chat: { isUnlimitedEntitlement: true }, premium_interactions: { remainingPercentage: 8 } } });
	assert.deepEqual(copilot.unmetered, ['chat']);
	assert.equal(copilot.windows[0].usedPercent, 92);
	const cursor = parseAccountQuota('cursor', { billingCycleEnd: String(Date.parse(reset)), planUsage: { totalPercentUsed: 7, includedSpend: 2000, limit: 2000 } });
	assert.equal(cursor.windows[0].usedPercent, 7);
	assert.equal(cursor.windows[0].resetsAt, Date.parse(reset) / 1000);
	assert.equal(parseAccountQuota('opencode', { go: { weekly: { percent: 35, resetsAt: Date.parse(reset) } } }).windows[0].usedPercent, 35);
	assert.equal(parseAccountQuota('grok', { config: { creditUsagePercent: 80, prepaidBalance: { val: '1446' } } }).balance.amount, 14.46);
	const kimi = parseAccountQuota('kimi-code', { usages: { limit_5h: { used_ratio: '0.32' } }, boosterWallet: { balance: { type: 'BOOSTER', amountLeft: 105000000 } } });
	assert.equal(kimi.windows[0].usedPercent, 32);
	assert.equal(kimi.balance.amount, 1.05);
	assert.equal(parseAccountQuota('kilo', { balance: '0' }).balance.amount, 0);
	assert.equal(parseAccountQuota('kilo', { balance: null }), undefined);
	assert.equal(parseAccountQuota('cline', { success: true, data: { limits: [{ type: 'weekly', percentUsed: 100 }] } }).windows[0].usedPercent, 100);
});

test('CLI quota probes read fragmented control replies without sending a prompt', async () => {
	const { readProductQuota } = require(path.join(out, 'accountQuota.js'));
	for (const id of ['claude', 'github-copilot-cli']) {
		const fake = `
			const copilot = process.argv[1] === 'github-copilot-cli';
			process.stdin.once('data', data => {
				const req = JSON.parse(copilot ? String(data).split('\\r\\n\\r\\n')[1] : data);
				let reply;
				if (copilot && req.method === 'account.getQuota') { reply = { jsonrpc:'2.0', id:req.id, result:{quotaSnapshots:{chat:{remainingPercentage:80}}} }; }
				else if (!copilot && req.request?.subtype === 'get_usage' && req.request.skip_behaviors) {
					reply = { type:'control_response', response:{request_id:req.request_id,response:{rate_limits_available:true,rate_limits:{five_hour:{utilization:20}}}} };
				} else { process.exit(1); }
				const json = JSON.stringify(reply);
				const wire = copilot ? 'Content-Length: '+Buffer.byteLength(json)+'\\r\\n\\r\\n'+json : json+'\\n';
				process.stdout.write(wire.slice(0,11));
				setTimeout(() => process.stdout.write(wire.slice(11)),5);
			});`;
		const quota = await readProductQuota(id, { command: process.execPath, baseArgs: ['-e', fake, '--', id], env: process.env }, AbortSignal.timeout(2000));
		assert.equal(quota.windows[0].usedPercent, 20);
	}
});

test('Cline pay-as-you-go credits survive an unavailable subscription endpoint and use the active organization', async t => {
	const { readProductQuota } = require(path.join(out, 'accountQuota.js'));
	const urls = [];
	t.mock.method(globalThis, 'fetch', async (url, init) => {
		urls.push(url);
		assert.equal(init.headers.Authorization, 'Bearer test-key');
		assert.equal(init.redirect, 'error');
		if (url.endsWith('usage-limits')) { return new Response(null, { status: 404 }); }
		if (url.endsWith('users/me')) { return Response.json({ data: { id: 'user', organizations: [{ active: true, organizationId: 'team' }] } }); }
		assert.ok(url.endsWith('/organizations/team/balance'));
		return Response.json({ data: { balance: 0 } });
	});
	const quota = await readProductQuota('cline', { command: '', baseArgs: [], env: { CLINE_API_KEY: 'test-key' } }, AbortSignal.timeout(2000));
	assert.deepEqual(quota, { windows: [], credits: '0' });
	assert.equal(urls.length, 3);
});
