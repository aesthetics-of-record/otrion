import assert from 'node:assert/strict';

const [, , mode, version, repository] = process.argv;
assert.match(version ?? '', /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/);

const targets = [
	{ runner: 'macos-15', platform: 'darwin', arch: 'arm64' },
	{ runner: 'macos-15-intel', platform: 'darwin', arch: 'x64' },
	{ runner: 'windows-2022', platform: 'win32', arch: 'x64' },
	{ runner: 'ubuntu-24.04', platform: 'linux', arch: 'x64' },
	{ runner: 'ubuntu-24.04-arm', platform: 'linux', arch: 'arm64' },
];

if (version === '0.1.0' || version === '0.1.1') {
	targets.push({ runner: 'windows-11-arm', platform: 'win32', arch: 'arm64' });
}

function desktopAsset({ platform, arch }) {
	const suffix = {
		win32: `windows-${arch}-setup.exe`,
		darwin: `macos-${arch}.dmg`,
		linux: `linux-${arch}.tar.gz`,
	}[platform];
	return `Otrion-${version}-${suffix}`;
}

if (mode === 'matrix') {
	console.log(JSON.stringify({ runner: targets.map(target => target.runner) }));
} else if (mode === 'assets') {
	for (const target of targets) {
		const { platform, arch } = target;
		console.log(desktopAsset(target));
		if (platform === 'darwin') {
			console.log(`Otrion-${version}-macos-${arch}.zip`);
		}
		console.log(`otrion-reh-${platform}-${arch}.tar.gz`);
	}
} else if (mode === 'notes') {
	assert.match(repository ?? '', /^[\w.-]+\/[\w.-]+$/);
	const downloadBase = `https://github.com/${repository}/releases/download/v${version}`;
	const platforms = { win32: 'EXE', darwin: 'DMG', linux: 'TAR.GZ' };
	const architectures = { x64: 'x64 (Intel/AMD)', arm64: 'ARM64 (Apple silicon on Mac)' };
	console.log('## Downloads\n\n| Architecture | Windows | macOS | Linux |\n| --- | --- | --- | --- |');
	for (const [arch, label] of Object.entries(architectures)) {
		const links = Object.entries(platforms).map(([platform, format]) => {
			const target = targets.find(target => target.platform === platform && target.arch === arch);
			return target ? `[${format}](${downloadBase}/${desktopAsset(target)})` : '—';
		});
		console.log(`| ${label} | ${links.join(' | ')} |`);
	}
} else {
	throw new Error('Expected matrix, assets, or notes.');
}
