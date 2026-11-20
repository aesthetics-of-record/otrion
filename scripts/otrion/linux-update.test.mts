import assert from 'assert';
import { execFileSync } from 'child_process';
import { createHash } from 'crypto';
import { mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'node:path';
import { test } from 'node:test';
import { activateLinuxUpdate, extractLinuxUpdate, getLinuxInstallRoot } from '../../src/vs/platform/update/electron-main/linuxArchiveUpdate.ts';

test('packages and verifies a new payload, then switches the launcher while preserving portable data', { skip: process.platform === 'win32' }, async () => {
	const root = await mkdtemp(join(tmpdir(), 'otrion test-'));
	try {
		const previous = '.otrion-versions/0.1.1';
		const next = '0.1.2';
		const app = join(root, 'app');
		const stage = join(root, 'stage');
		await mkdir(join(app, 'resources/app'), { recursive: true });
		await mkdir(stage);
		await writeFile(join(app, 'otrion'), '#!/bin/sh\necho 0.1.2\n', { mode: 0o755 });
		await writeFile(join(app, 'resources/app/product.json'), JSON.stringify({ applicationName: 'otrion', otrionVersion: next }));
		const archive = join(stage, 'release.tar.gz');
		const script = join(process.cwd(), 'scripts/otrion/package-linux.sh');
		execFileSync('bash', [script, app, next, archive]);
		const digest = createHash('sha256').update(await readFile(archive)).digest('hex');
		await assert.rejects(extractLinuxUpdate(stage, next, '0'.repeat(64)), /Hash mismatch/);
		await extractLinuxUpdate(stage, next, digest);
		assert.strictEqual(await readlink(join(stage, 'payload/data')), '../../data');
		if (process.platform === 'linux') {
			await mkdir(join(root, previous), { recursive: true });
			await writeFile(join(root, previous, 'otrion'), 'old executable');
			await writeFile(join(root, previous, 'chrome-sandbox'), '');
			await symlink(previous, join(root, 'current'));
			await symlink('current/otrion', join(root, 'otrion'));
			await mkdir(join(root, 'data'));
			await writeFile(join(root, 'data/settings'), 'original data');
			assert.strictEqual(await getLinuxInstallRoot(join(root, 'otrion'), '0.1.1'), root);
			await assert.rejects(activateLinuxUpdate(root, stage, '0.1.0', next));
			assert.strictEqual(await readlink(join(root, 'current')), previous);
			await activateLinuxUpdate(root, stage, '0.1.1', next);
			await activateLinuxUpdate(root, stage, '0.1.1', next);
			assert.strictEqual(execFileSync(join(root, 'otrion'), { encoding: 'utf8' }).trim(), next);
			assert.strictEqual(await readFile(join(root, 'current/data/settings'), 'utf8'), 'original data');
		}
	} finally {
		await rm(root, { force: true, recursive: true });
	}
});
