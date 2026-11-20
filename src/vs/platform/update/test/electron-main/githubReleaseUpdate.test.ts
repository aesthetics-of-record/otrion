/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { getGitHubReleaseUrl, selectGitHubReleaseUpdate } from '../../electron-main/githubReleaseUpdate.js';

suite('Otrion GitHub release updates', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const repository = 'aesthetics-of-record/otrion';
	const digest = 'a'.repeat(64);
	const tag = 'v0.1.10';
	const baseUrl = `https://github.com/${repository}/releases/download/${tag}`;
	const asset = (name: string) => ({ name, state: 'uploaded', browser_download_url: `${baseUrl}/${name}`, digest: `sha256:${digest}` });
	const desktop = [
		'windows-x64-setup.exe',
		'macos-x64.zip', 'macos-arm64.zip',
		'linux-x64.tar.gz', 'linux-arm64.tar.gz',
	].map(suffix => asset(`Otrion-0.1.10-${suffix}`));
	const release = { tag_name: tag, draft: false, prerelease: false, assets: [...desktop, asset('otrion-reh-darwin-arm64.tar.gz')] };

	test('uses the configured public release endpoint', () => {
		assert.deepStrictEqual([getGitHubReleaseUrl(repository), getGitHubReleaseUrl('https://example.org/other/repo')], [
			`https://api.github.com/repos/${repository}/releases/latest`, undefined,
		]);
	});

	test('selects the desktop asset for each supported target', () => {
		const targets = [['win32', 'x64'], ['darwin', 'x64'], ['darwin', 'arm64'], ['linux', 'x64'], ['linux', 'arm64']];
		assert.deepStrictEqual(targets.map(([platform, arch]) => selectGitHubReleaseUpdate(repository, '0.1.9', platform, arch, release)), desktop.map(file => ({
			version: '0.1.10', productVersion: '0.1.10', url: file.browser_download_url, sha256hash: digest,
		})));
	});

	test('skips current and older versions, draft releases, and unsupported targets', () => {
		assert.deepStrictEqual([
			selectGitHubReleaseUpdate(repository, '0.1.10', 'darwin', 'arm64', release),
			selectGitHubReleaseUpdate(repository, '0.2.0', 'darwin', 'arm64', release),
			selectGitHubReleaseUpdate(repository, '0.1.9', 'darwin', 'arm64', { ...release, draft: true }),
			selectGitHubReleaseUpdate(repository, '0.1.9', 'darwin', 'arm64', { ...release, prerelease: true }),
			selectGitHubReleaseUpdate(repository, '0.1.9', 'darwin', 'arm64', { ...release, assets: [asset('otrion-reh-darwin-arm64.tar.gz')] }),
			selectGitHubReleaseUpdate(repository, '0.1.9', 'win32', 'arm64', release),
		], [null, null, null, null, null, null]);
	});

	test('requires the expected installer URL and checksum before offering a Windows update', () => {
		const installer = desktop[0];
		assert.deepStrictEqual([
			selectGitHubReleaseUpdate(repository, '0.1.9', 'win32', 'x64', { ...release, assets: [{ ...installer, digest: null }] }),
			selectGitHubReleaseUpdate(repository, '0.1.9', 'win32', 'x64', { ...release, assets: [{ ...installer, browser_download_url: 'https://example.org/installer.exe' }] }),
		], [null, null]);
	});
});
