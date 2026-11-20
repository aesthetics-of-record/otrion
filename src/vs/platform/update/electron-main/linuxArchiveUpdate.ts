/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { execFile } from 'child_process';
import { constants } from 'fs';
import { access, mkdir, readFile, readlink, realpath, stat, writeFile } from 'fs/promises';
import { promisify } from 'util';
import { basename, dirname, join } from '../../../base/common/path.js';
import { checksum } from '../../../base/node/crypto.js';

const versions = '.otrion-versions';

export async function getLinuxInstallRoot(executable: string, version: string): Promise<string | undefined> {
	try {
		const payload = dirname(await realpath(executable));
		const root = dirname(dirname(payload));
		if (basename(payload) !== version || basename(dirname(payload)) !== versions || await readlink(join(root, 'current')) !== `${versions}/${version}`) {
			return undefined;
		}
		// A root-installed setuid sandbox must be updated by its administrator.
		const sandbox = await stat(join(payload, 'chrome-sandbox'));
		if (sandbox.uid === 0 && (sandbox.mode & 0o4000)) {
			return undefined;
		}
		await Promise.all([
			access(root, constants.W_OK), access(join(root, versions), constants.W_OK),
			access('/usr/bin/flock', constants.X_OK), access('/usr/bin/tar', constants.X_OK),
		]);
		return root;
	} catch {
		return undefined;
	}
}

export async function extractLinuxUpdate(stage: string, version: string, digest: string): Promise<void> {
	if (!/^\d+\.\d+\.\d+$/.test(version)) {
		throw new Error('Invalid Otrion release version');
	}
	const archive = join(stage, 'release.tar.gz');
	await checksum(archive, digest);
	const payload = join(stage, 'payload');
	await mkdir(payload);
	await promisify(execFile)('/usr/bin/tar', ['-xzf', archive, '-C', payload, '--strip-components=3', `Otrion/${versions}/${version}`]);
	const product = JSON.parse(await readFile(join(payload, 'resources', 'app', 'product.json'), 'utf8'));
	if (product.applicationName !== 'otrion' || product.otrionVersion !== version) {
		throw new Error('The downloaded archive does not contain the expected Otrion release.');
	}
	await access(join(payload, 'otrion'), constants.X_OK);
	await writeFile(join(payload, '.release-sha256'), digest);
}

/** Run after the workbench has accepted shutdown. A directory lock serializes separate user-data instances. */
export async function activateLinuxUpdate(root: string, stage: string, installed: string, next: string): Promise<void> {
	// Both renames are on the install filesystem. Until current is replaced, the old app is fully usable.
	const activate = `
		cd "$1"
		active=$(readlink current)
		[ "$active" != ".otrion-versions/$4" ] || exit 0
		[ "$active" = ".otrion-versions/$3" ]
		if [ ! -d ".otrion-versions/$4" ]; then
			mv -T "$2/payload" ".otrion-versions/$4"
		else
			cmp "$2/payload/.release-sha256" ".otrion-versions/$4/.release-sha256"
		fi
		ln -s ".otrion-versions/$4" "$2/next"
		mv -Tf "$2/next" current
	`;
	await promisify(execFile)('/usr/bin/flock', ['-w', '3', root, '/bin/sh', '-ec', activate, 'otrion-update', root, stage, installed, next], { timeout: 5000 });
}
