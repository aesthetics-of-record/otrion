import assert from 'node:assert/strict';

const [, , mode, version] = process.argv;
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

if (mode === 'matrix') {
	console.log(JSON.stringify({ runner: targets.map(target => target.runner) }));
} else if (mode === 'assets') {
	for (const { platform, arch } of targets) {
		const desktop = platform === 'win32' ? `windows-${arch}-setup.exe`
			: platform === 'darwin' ? `macos-${arch}.zip` : `linux-${arch}.tar.gz`;
		console.log(`Otrion-${version}-${desktop}`);
		console.log(`otrion-reh-${platform}-${arch}.tar.gz`);
	}
} else {
	throw new Error('Expected matrix or assets.');
}
