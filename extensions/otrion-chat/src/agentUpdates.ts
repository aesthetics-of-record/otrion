/* Copyright (c) Otrion contributors. Licensed under the MIT License. */

import { agents, piRuntime, type AgentId } from './agentCatalog';
import { antigravityVersion } from './antigravity';
import { nativeVersions } from './nativeAgents';

export interface AgentVersion { version: string; runtime?: string }
export interface AgentArchive { url: string; digest: string }
export interface AgentRelease extends AgentVersion { archive?: AgentArchive }

export function bundledVersion(id: AgentId): AgentVersion {
	if (id === 'antigravity') { return { version: antigravityVersion }; }
	if (id === 'cursor' || id === 'goose') { return { version: nativeVersions[id] }; }
	return { version: agents[id].npm!.version, ...(id === 'pi' ? { runtime: piRuntime.version } : {}) };
}

const stable = /^\d{1,8}\.\d{1,8}\.\d{1,8}$/;
const cursorBuild = /^\d{4}\.\d{2}\.\d{2}-(?:\d{2}-\d{2}-\d{2}-)?[a-f0-9]{7,40}$/;

export function versionKey(release: AgentVersion) {
	return release.version + (release.runtime ? '-' + release.runtime : '');
}

export function parseInstalledVersion(id: AgentId, key: string): AgentVersion | undefined {
	if (id === 'cursor') { return cursorBuild.test(key) ? { version: key } : undefined; }
	if (id !== 'pi') { return stable.test(key) ? { version: key } : undefined; }
	const parts = key.split('-');
	return parts.length === 2 && parts.every(part => stable.test(part)) ? { version: parts[0], runtime: parts[1] } : undefined;
}

function compareNumbers(a: string, b: string) {
	const left = a.split(/[.-]/).map(Number), right = b.split(/[.-]/).map(Number);
	for (let i = 0; i < Math.max(left.length, right.length); i++) {
		const diff = (left[i] ?? 0) - (right[i] ?? 0);
		if (diff) { return diff; }
	}
	return 0;
}

export function compareVersions(a: AgentVersion, b: AgentVersion) {
	// Cursor's commit hash identifies the build but is not chronologically ordered.
	const numeric = (v: string) => cursorBuild.test(v) ? v.slice(0, v.lastIndexOf('-')) : v;
	return compareNumbers(numeric(a.version), numeric(b.version)) || compareNumbers(a.runtime ?? '0', b.runtime ?? '0');
}

export function isNewer(id: AgentId, next: AgentVersion, current: AgentVersion) {
	if (current.runtime && next.runtime && compareNumbers(next.runtime, current.runtime) < 0) { return false; }
	const diff = compareVersions(next, current);
	return diff > 0 || (id === 'cursor' && diff === 0 && next.version !== current.version);
}

const registry = 'https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json';
interface RegistryEntry { id: string; version: string; distribution: { binary?: Record<string, { archive: string; sha256?: string }> } }

export async function latestRelease(id: AgentId, download: typeof fetch = fetch): Promise<AgentRelease> {
	async function request(url: string) {
		const response = await download(url, { signal: AbortSignal.timeout(8000) });
		if (!response.ok) { throw new Error('Release check failed (HTTP ' + response.status + ').'); }
		return response;
	}
	const invalid = () => new Error('The publisher did not return a supported release for this host.');
	const npmVersion = async (name: string) => {
		const data = await (await request('https://registry.npmjs.org/' + encodeURIComponent(name) + '/latest')).json();
		if (data?.name !== name || typeof data.version !== 'string' || !stable.test(data.version)) { throw invalid(); }
		return data.version as string;
	};
	const npm = agents[id].npm;
	if (npm) {
		const [version, runtime] = await Promise.all([npmVersion(npm.package), id === 'pi' ? npmVersion(piRuntime.package) : undefined]);
		return { version, ...(runtime ? { runtime } : {}) };
	}

	const os = process.platform === 'win32' ? 'windows' : process.platform;
	const arm = process.arch === 'arm64';
	if (!arm && process.arch !== 'x64') { throw invalid(); }
	const musl = os === 'linux' && !(process.report.getReport() as { header: { glibcVersionRuntime?: string } }).header.glibcVersionRuntime;
	if (id === 'antigravity') {
		const platform = os + '_' + (arm ? 'arm64' : 'amd64') + (musl ? '_musl' : '');
		const data = await (await request('https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests/' + platform + '.json')).json();
		if (typeof data.version !== 'string' || !stable.test(data.version) || typeof data.url !== 'string'
			|| !data.url.startsWith('https://storage.googleapis.com/antigravity-public/antigravity-cli/' + data.version + '-')
			|| !/^[a-f0-9]{128}$/.test(data.sha512)) { throw invalid(); }
		return { version: data.version, archive: { url: data.url, digest: data.sha512 } };
	}

	const data: { agents: RegistryEntry[] } = await (await request(registry)).json();
	const agent = data.agents.find(entry => entry.id === id);
	const target = os + '-' + (arm ? 'aarch64' : 'x86_64') + (musl ? '-musl' : '');
	const archive = agent?.distribution.binary?.[target];
	if (!agent || !archive) { throw invalid(); }
	const url = archive.archive;
	if (id === 'goose' && stable.test(agent.version) && url.startsWith('https://github.com/block/goose/releases/download/v' + agent.version + '/goose-')
		&& archive.sha256 && /^[a-f0-9]{64}$/.test(archive.sha256)) {
		return { version: agent.version, archive: { url, digest: archive.sha256 } };
	}
	if (id === 'cursor') {
		const version = new URL(url).pathname.split('/')[2];
		const suffix = os === 'windows' ? '.zip' : '.tar.gz';
		if (!cursorBuild.test(version) || url !== 'https://downloads.cursor.com/lab/' + version + '/' + os + '/' + process.arch + '/agent-cli-package' + suffix) { throw invalid(); }
		const checksum = (await (await request(url + '.sha256')).text()).trim().split(/\s+/)[0];
		if (!/^[a-f0-9]{64}$/.test(checksum)) { throw invalid(); }
		return { version, archive: { url, digest: checksum } };
	}
	throw invalid();
}
