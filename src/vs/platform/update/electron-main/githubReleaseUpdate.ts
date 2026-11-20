/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IUpdate } from '../common/update.js';

export interface IGitHubRelease {
	readonly tag_name?: string;
	readonly draft?: boolean;
	readonly prerelease?: boolean;
	readonly assets?: readonly {
		readonly name?: string;
		readonly state?: string;
		readonly browser_download_url?: string;
		readonly digest?: string | null;
	}[];
}

export function getGitHubReleaseUrl(repository: string | undefined): string | undefined {
	return repository && /^[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+$/.test(repository)
		? `https://api.github.com/repos/${repository}/releases/latest`
		: undefined;
}

function parseVersion(version: string): number[] | undefined {
	if (!/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.test(version)) {
		return undefined;
	}
	const parts = version.split('.').map(Number);
	return parts.every(Number.isSafeInteger) ? parts : undefined;
}

export function selectGitHubReleaseUpdate(repository: string, currentVersion: string, platform: string, arch: string, release: IGitHubRelease | null): IUpdate | null {
	if (typeof release?.tag_name !== 'string' || !release.tag_name.startsWith('v') || release.draft || release.prerelease || !Array.isArray(release.assets)) {
		return null;
	}

	const productVersion = release.tag_name.slice(1);
	const current = parseVersion(currentVersion);
	const latest = parseVersion(productVersion);
	const changedComponent = current && latest ? latest.findIndex((value, index) => value !== current[index]) : -1;
	if (!current || !latest || changedComponent < 0 || latest[changedComponent] < current[changedComponent]) {
		return null;
	}

	if ((arch !== 'x64' && arch !== 'arm64') || (platform !== 'win32' && platform !== 'darwin' && platform !== 'linux')) {
		return null;
	}
	const filename = {
		win32: `Otrion-${productVersion}-windows-${arch}-setup.exe`,
		darwin: `Otrion-${productVersion}-macos-${arch}.zip`,
		linux: `Otrion-${productVersion}-linux-${arch}.tar.gz`,
	}[platform];

	const url = `https://github.com/${repository}/releases/download/${release.tag_name}/${filename}`;
	const asset = release.assets.find(asset => asset?.name === filename && asset.state === 'uploaded' && asset.browser_download_url === url);
	const sha256hash = /^sha256:([\da-f]{64})$/i.exec(asset?.digest ?? '')?.[1]?.toLowerCase();
	if (!asset || (platform === 'win32' && !sha256hash)) {
		return null;
	}
	return { productVersion, version: productVersion, url, sha256hash };
}
