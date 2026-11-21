/* Copyright (c) Otrion contributors. Licensed under the MIT License. */

import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import * as path from 'node:path';
import { pipeline } from 'node:stream/promises';


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
