/* Copyright (c) Otrion contributors. Licensed under the MIT License. */

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { unlink } from 'node:fs/promises';
import * as path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';


export const nativeVersions = { cursor: '2026.11.19-f005e9d', goose: '1.60.2' } as const;
type NativeAgent = keyof typeof nativeVersions;

// Pinned releases from the ACP Registry. Cursor ships its own Node runtime and resources.
const cursorRelease = 'https://downloads.cursor.com/lab/' + nativeVersions.cursor + '/';
const gooseRelease = 'https://github.com/block/goose/releases/download/v' + nativeVersions.goose + '/';
const archives: Record<NativeAgent, Record<string, [url: string, sha256: string]>> = {
	cursor: {
		'darwin-arm64': [cursorRelease + 'darwin/arm64/agent-cli-package.tar.gz', '16bb33c59733725b466d31f988490de332747f0910d2d64b393c363e510e6c7d'],
		'darwin-x64': [cursorRelease + 'darwin/x64/agent-cli-package.tar.gz', '0cac2e918bdf9a0ff1a38700929bb3164730354a347dd6b373fe48a83814b236'],
		'linux-arm64': [cursorRelease + 'linux/arm64/agent-cli-package.tar.gz', '5ff05be0d7c0b7754574dbcd677c35254a3ff190ed6457e71bbee0f276237e29'],
		'linux-x64': [cursorRelease + 'linux/x64/agent-cli-package.tar.gz', 'a25986eaf0c9330aeeec599a139711cb9f267c64562d073a72b751edf5161695'],
		'win32-arm64': [cursorRelease + 'windows/arm64/agent-cli-package.zip', '5d9350d0e6510e6aeb25a77fd4a45458a0630b5054bc630ad87e863bad167d7b'],
		'win32-x64': [cursorRelease + 'windows/x64/agent-cli-package.zip', 'a3097c90b528ed9be693d3fe1a018cde5fbc09f1d4a3a2ec50ae57149fc13bb2'],
	},
	goose: {
		'darwin-arm64': [gooseRelease + 'goose-aarch64-apple-darwin.tar.bz2', '5b87260719bf565958f305b32a761cd8cd6d5f7ce9e7b5831a18c8b3f3cb01f8'],
		'darwin-x64': [gooseRelease + 'goose-x86_64-apple-darwin.tar.bz2', 'b83fead3e3813b876247d3612352783ae727f7620bddfb8ef352e909cc6bf63b'],
		'linux-arm64': [gooseRelease + 'goose-aarch64-unknown-linux-gnu.tar.bz2', '9d0fed3d301ce61b2b50cc19039795d3fa85270fe8857abe4a16ed35b21a1fbf'],
		'linux-x64': [gooseRelease + 'goose-x86_64-unknown-linux-gnu.tar.bz2', '83fef08e07c63c8cd41f9702e5e840487463f3b4e1290711a94ade5beab2d082'],
		'linux-arm64-musl': [gooseRelease + 'goose-aarch64-unknown-linux-musl.tar.bz2', 'e5c73e19d9954dc72aae0c4581c97f9ed8339559dbd11b6b0c645e1875b845ee'],
		'linux-x64-musl': [gooseRelease + 'goose-x86_64-unknown-linux-musl.tar.bz2', '3ec76884cd41adb1dc14f9bb24123febd62ad19cc574e664f74fe8d1c75c9afb'],
		'win32-x64': [gooseRelease + 'goose-x86_64-pc-windows-msvc.zip', '5b838ab498f7a6b121fab621b99d39a480458c373f16be7f7ce7869e9bc54888'],
	},
};

export function nativeEntry(id: NativeAgent) {
	if (id === 'cursor') { return path.join('dist-package', process.platform === 'win32' ? 'node.exe' : 'cursor-agent'); }
	return process.platform === 'win32' ? path.join('goose-package', 'goose.exe') : 'goose';
}

export async function downloadVerified(id: string, staging: string, url: string, algorithm: 'sha256' | 'sha512', digest: string, download: typeof fetch = fetch) {
	const response = await download(url, { signal: AbortSignal.timeout(300_000) });
	if (!response.ok || !response.body) { throw new Error(id + ' download failed (HTTP ' + response.status + ').'); }
	const file = path.join(staging, 'download');
	const hash = createHash(algorithm);
	await pipeline(response.body, async function* (chunks) {
		for await (const chunk of chunks) { hash.update(chunk); yield chunk; }
	}, createWriteStream(file, { flags: 'wx', mode: 0o600 }));
	if (hash.digest('hex') !== digest) { throw new Error(id + ' download failed its ' + (algorithm === 'sha512' ? 'SHA-512' : 'SHA-256') + ' check.'); }
	return file;
}

export async function installNative(id: NativeAgent, staging: string) {
	let target = process.platform + '-' + process.arch;
	if (id === 'goose' && process.platform === 'linux') {
		const report = process.report.getReport() as { header: { glibcVersionRuntime?: string } };
		if (!report.header.glibcVersionRuntime) { target += '-musl'; }
	}
	const archive = archives[id][target];
	if (!archive) { throw new Error('No ' + id + ' release for ' + target + '.'); }
	const [url, digest] = archive;
	const file = await downloadVerified(id, staging, url, 'sha256', digest);
	// Windows ships bsdtar, which also extracts ZIP releases.
	await promisify(execFile)('tar', ['-xf', file, '-C', staging], { windowsHide: true });
	await unlink(file);
}
