/* Copyright (c) Otrion contributors. Licensed under the MIT License. */

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const { test } = require('node:test');
const { dockerHost, result } = require('../out/host.js');
const { createExecServer } = require('../../otrion-remote-ssh/out/ssh/execServer.js');

test('macOS SSH uses the host Docker search path for listings and child processes', async () => {
	const paths = [];
	const host = await dockerHost('', {
		env: async () => ({ osPlatform: 'darwin', env: { OTRION_SERVER_ROOT: '/server', HOME: '/Users/remote', PATH: '/custom/bin:/usr/bin' } }),
		spawn: async (_command, _args, options) => { paths.push(options.env.PATH); }
	});
	await host.docker(['ps', '-a']);
	await host.cli(['up', '--workspace-folder', '/workspace']);
	await host.node(['--version']);
	const expected = '/custom/bin:/usr/bin:/opt/homebrew/bin:/usr/local/bin:/Users/remote/.docker/bin:/Applications/Docker.app/Contents/Resources/bin';
	assert.deepEqual(paths, [expected, expected, expected]);
});

test('Windows SSH workspace paths use the Docker host drive and path rules', async () => {
	const calls = [];
	const root = 'C:\\Otrion Server';
	const host = await dockerHost('', {
		env: async () => ({ osPlatform: 'win32', env: { OTRION_SERVER_ROOT: root } }),
		spawn: async (command, args) => { calls.push([command, ...args]); }
	});
	await host.cli(['up', '--workspace-folder', '/D:/code/한 글']);
	assert.deepEqual(calls[0], [
		root + '\\node.exe', root + '\\node_modules\\@devcontainers\\cli\\devcontainer.js',
		'up', '--workspace-folder', 'D:\\code\\한 글'
	]);
});

test('host execution preserves long argv, quotes, Unicode, environment and binary stdin', async () => {
	const windows = process.platform === 'win32';
	const exec = createExecServer(path.dirname(process.execPath), async command => {
		const child = windows
			? spawn('powershell.exe', command.split(' ').slice(1))
			: spawn('sh', ['-c', command]);
		return { stdin: child.stdin, stdout: child.stdout, stderr: child.stderr,
			exit: new Promise((resolve, reject) => { child.on('error', reject); child.on('close', status => resolve({ status })); }) };
	}, windows);
	const value = "quote ' and \" 한 글\n" + 'x'.repeat(9000);
	const bytes = Buffer.from([0, 10, 13, 255, 1, 127, 128]);
	const script = `
		const chunks = [];
		process.stdin.on('data', chunk => chunks.push(chunk));
		process.stdin.on('end', () => console.log(JSON.stringify([
			process.argv[1], process.env.OTRION_TEST, process.cwd(), Buffer.concat(chunks).toString('hex')
		])));
	`;
	const proc = await exec.spawn(process.execPath, ['-e', script, '--', value], {
		env: { OTRION_TEST: 'space & quote\'' }, cwd: process.cwd()
	});
	proc.stdin.write(bytes);
	const actual = JSON.parse(await result(proc, { append() {} }));
	assert.deepEqual(actual, [value, "space & quote'", process.cwd(), bytes.toString('hex')]);
});
