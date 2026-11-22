/* Copyright (c) Otrion contributors. Licensed under the MIT License. */

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, chmod, mkdir, mkdtemp, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';

import type { AgentArchive } from './agentUpdates';
import { downloadVerified } from './nativeAgents';

export const antigravityVersion = '1.5.13';

// Pinned together from Google's per-platform Antigravity CLI updater manifests.
const release = 'https://storage.googleapis.com/antigravity-public/antigravity-cli/' + antigravityVersion + '-5999302598852608/';
const artifacts: Record<string, [file: string, sha512: string]> = {
	'darwin-x64': ['darwin-x64/cli_mac_x64.tar.gz', '6a7087eb847029bead89d496a6c4a5d3ec8552f351a486b3917948fee2a9a72ec6e2be7eae866b975b8ed3fc2a1827cf176b5bd45d6eb9970424fec4352d3930'],
	'darwin-arm64': ['darwin-arm/cli_mac_arm64.tar.gz', 'd9825ebce6954df6b7841970fd7ef3d37acdfe628993f14c396ec73b20ed06bbe95e7b7be047e7c0b0baaf009f75fe95ce051b9f4af5e84b002da15bda4a1f45'],
	'linux-x64': ['linux-x64/cli_linux_x64.tar.gz', '014b37387703acab1f47cd532c8bb60167a6a3537b0f9891de03f1b1ffa9614307bc83c4b2f7551273b0877d722716b0cd9e26782f6b2a50705db4f05e18c68f'],
	'linux-x64-musl': ['linux-x64-musl/cli_linux_x64_musl.tar.gz', 'd84889054ba7230b34c1f8107df23a533813352831613712d59b84be0f57ee6d2f4deec338eec1c6094e7ebe4c8de10712f0ede9c889c4c12b95ca3dc2c4f546'],
	'linux-arm64': ['linux-arm/cli_linux_arm64.tar.gz', 'dccea2eb455099f5175f0c87cc47b38fcefe4cb0cb44dea3927469bb4bbf68ac3c0b30fc04affb24c17e90959386a93c3785e8e4b8b1a3338ca4e4d57b80057b'],
	'linux-arm64-musl': ['linux-arm-musl/cli_linux_arm64_musl.tar.gz', '0bdb2f2202f25a2d3fa63ac871ed1ad7c5e72b19f63ceca1ec9a5e848859c6110ba05651ee20d1dd012cbf4d50ed16d59e6c7684bc097d7a72484bffb95b17da'],
	'win32-x64': ['windows-x64/cli_windows_x64.exe', '6b80a17a2bc34a969ed9ba31500a8201b0b4aad3e7fe061374022d161fec8bd7de49b6dc069a6ac67a90632e8671bbe860a7e94309bc5adbc536d27a75a86b58'],
	'win32-arm64': ['windows-arm/cli_windows_arm64.exe', 'c85686d6ae68d4566f86af0c240e4b49a303549ae152757546878193f25a263b02c4d8f1d5030631dc93646a298dcb02713c18e7850390e3db5c9dda6c31265f'],
};

export async function installAntigravity(staging: string, download: typeof fetch = fetch, update?: AgentArchive, onDownload?: (fraction: number) => void) {
	let target = process.platform + '-' + process.arch;
	if (process.platform === 'linux') {
		const report = process.report.getReport() as { header: { glibcVersionRuntime?: string } };
		if (!report.header.glibcVersionRuntime) { target += '-musl'; }
	}
	const artifact = artifacts[target];
	if (!artifact) { throw new Error('Antigravity is unavailable for ' + target + '.'); }
	const [file, sha512] = artifact;
	const payload = await downloadVerified('Antigravity', staging, update?.url ?? release + file, 'sha512', update?.digest ?? sha512, download, onDownload);
	if (process.platform === 'win32') {
		await rename(payload, path.join(staging, 'agy.exe'));
	} else {
		await promisify(execFile)('tar', ['-xzf', payload, '-C', staging, 'antigravity']);
		const entry = path.join(staging, 'agy');
		await rename(path.join(staging, 'antigravity'), entry);
		await chmod(entry, 0o755);
		await unlink(payload);
	}
}

// agy requires a relative application data directory under ~/.gemini.
export async function configureAntigravityKeyProfile(storeRoot: string, home = homedir()) {
	const profile = 'otrion-key-' + createHash('sha256').update(storeRoot).digest('hex').slice(0, 16);
	const directory = path.join(home, '.gemini', profile);
	const settings = path.join(directory, 'settings.json');
	try {
		await access(settings);
		return profile;
	} catch (error) {
		if (error.code !== 'ENOENT') { throw error; }
	}
	await mkdir(directory, { recursive: true, mode: 0o700 });
	const staging = await mkdtemp(path.join(directory, 'init-'));
	try {
		const temp = path.join(staging, 'settings.json');
		await writeFile(temp, JSON.stringify({ modelProvider: 'gemini' }), { mode: 0o600 });
		await rename(temp, settings);
	} finally { await rm(staging, { recursive: true, force: true }); }
	return profile;
}
