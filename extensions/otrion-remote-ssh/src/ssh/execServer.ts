/* Copyright (c) Otrion contributors. Licensed under the MIT License. */

import type { Readable, Writable } from 'node:stream';
import * as path from 'node:path';
import type * as vscode from 'vscode';
import { Platform } from '../common/platform';
import { quote } from '../common/quote';

export interface HostProcess {
    stdin: Writable;
    stdout: Readable;
    stderr: Readable;
    exit: Promise<vscode.ProcessExit>;
}

function readable(stream: Readable): vscode.ReadStream {
    return {
        onDidReceiveMessage(listener) {
            stream.on('data', listener);
            return { dispose: () => stream.off('data', listener) };
        },
        onEnd: new Promise<void>(resolve => stream.once('end', resolve))
    };
}

// The SSH host's installed Otrion Node runtime also supplies filesystem and socket
// operations. Paths and arguments always travel as data, including embedded quotes.
export function createExecServer(root: string, open: (command: string) => Promise<HostProcess>, windows = false): vscode.ExecServer {
    const node = windows ? path.win32.join(root, 'node.exe') : path.posix.join(root, 'node');
    const word = (s: string) => quote(s, Platform.Linux);
    async function spawn(command: string, args: string[], options?: vscode.ExecServerSpawnOptions) {
        const environment = Object.entries(options?.env ?? {}).map(([key, value]) => {
            if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) { throw new Error('Invalid environment variable name'); }
            return word(key + '=' + value);
        });
        const cwd = options?.cwd ? 'cd ' + word(options.cwd) + ' && ' : '';
        const proc = await open(windows ? windowsLauncher(node) : cwd + 'exec env ' + [...environment, ...[command, ...args].map(word)].join(' '));
        proc.stdin.on('error', () => { /* Exit status reports a closed SSH channel. */ });
        if (windows) {
            // Send argv as data. Long container scripts can exceed cmd.exe's command-line limit.
            proc.stdin.write(JSON.stringify({ command, args, cwd: options?.cwd, env: options?.env }) + '\n');
        }
        return {
            stdin: { write: (b: Uint8Array) => { proc.stdin.write(b); }, end: () => { proc.stdin.end(); } },
            stdout: readable(proc.stdout), stderr: readable(proc.stderr), onExit: proc.exit
        };
    }
    const runNode = (script: string, ...args: string[]) => spawn(node, ['-e', script, '--', ...args]);
    async function json<T>(expression: string, ...args: string[]): Promise<T> {
        const proc = await runNode('const fs=require("node:fs"),[a,b]=process.argv.slice(1); console.log(JSON.stringify((' + expression + ') ?? null));', ...args);
        const out: Buffer[] = [], errors: Buffer[] = [];
        proc.stdout.onDidReceiveMessage(b => out.push(Buffer.from(b)));
        proc.stderr.onDidReceiveMessage(b => errors.push(Buffer.from(b)));
        proc.stdin.end();
        const [exit] = await Promise.all([proc.onExit, proc.stdout.onEnd, proc.stderr.onEnd]);
        if (exit.status !== 0) { throw new Error(Buffer.concat(errors).toString() || 'Remote operation failed'); }
        return JSON.parse(Buffer.concat(out).toString());
    }
    async function socket(...args: string[]) {
        const proc = await runNode('const [host,port]=process.argv.slice(1); const s=require("node:net").connect(port?{host,port:Number(port)}:{path:host}); process.stdin.pipe(s).pipe(process.stdout); s.on("close",()=>process.stdin.destroy());', ...args);
        proc.stderr.onDidReceiveMessage(() => {});
        return { stream: { ...proc.stdin, ...proc.stdout }, done: proc.onExit.then(result => { if (result.status) { throw new Error('Remote socket closed with an error'); } }) };
    }
    return {
        spawn,
        env: () => json<vscode.ExecEnvironment>('({osPlatform:process.platform,env:{...process.env,OTRION_SERVER_ROOT:require("node:path").dirname(process.execPath)}})'),
        kill: pid => json<void>('process.kill(Number(a))', String(pid)),
        tcpConnect: (host, port) => socket(host, String(port)),
        fs: {
            stat: file => json<vscode.FileStat>('((s)=>({type:s.isDirectory()?2:s.isFile()?1:s.isSymbolicLink()?64:0,size:s.size,ctime:s.ctimeMs,mtime:s.mtimeMs}))(fs.lstatSync(a))', file),
            mkdirp: dir => json<void>('fs.mkdirSync(a,{recursive:true})', dir),
            rm: file => json<void>('fs.rmSync(a,{recursive:true,force:true})', file),
            rename: (from, to) => json<void>('fs.renameSync(a,b)', from, to),
            readdir: dir => json<vscode.DirectoryEntry[]>('fs.readdirSync(a,{withFileTypes:true}).map(e=>({name:e.name,type:e.isDirectory()?2:e.isFile()?1:e.isSymbolicLink()?64:0}))', dir),
            read: async file => {
                const proc = await runNode('require("node:fs").createReadStream(process.argv[1]).pipe(process.stdout)', file);
                proc.stdin.end();
                proc.stderr.onDidReceiveMessage(() => {});
                return proc.stdout;
            },
            write: async file => {
                const proc = await runNode('process.stdin.pipe(require("node:fs").createWriteStream(process.argv[1]))', file);
                proc.stderr.onDidReceiveMessage(() => {});
                return { stream: proc.stdin, done: proc.onExit.then(exit => { if (exit.status) { throw new Error('Remote write failed'); } }) };
            },
            connect: file => socket(file)
        }
    };
}

function windowsLauncher(node: string): string {
    // PowerShell only starts Node. Node owns the binary SSH streams and launches
    // Docker directly, preserving Unicode, quotes and bytes across Windows shells.
    const bridge = `
const input = process.stdin;
let header = Buffer.alloc(0);
input.on('data', function read(chunk) {
    const end = chunk.indexOf(10);
    if (end === -1) { header = Buffer.concat([header, chunk]); return; }
    input.pause();
    input.off('data', read);
    const spec = JSON.parse(Buffer.concat([header, chunk.subarray(0, end)]).toString());
    const child = require('node:child_process').spawn(spec.command, spec.args, {
        cwd: spec.cwd, env: { ...process.env, ...spec.env }, windowsHide: true, stdio: ['pipe', 'inherit', 'inherit']
    });
    child.stdin.on('error', () => {});
    child.on('error', error => { console.error(error.message); process.exitCode = 1; });
    child.on('close', code => { input.destroy(); process.exitCode = code ?? 1; });
    child.stdin.write(chunk.subarray(end + 1));
    input.pipe(child.stdin);
});`;
    const js = "eval(Buffer.from('" + Buffer.from(bridge).toString('base64') + "','base64').toString())";
    const invoke = "& '" + node.replaceAll("'", "''") + "' -e \"" + js + "\"; exit $LASTEXITCODE";
    return 'powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand ' + Buffer.from(invoke, 'utf16le').toString('base64');
}
