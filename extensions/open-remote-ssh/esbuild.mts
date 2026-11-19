/* Copyright (c) Otrion contributors. Licensed under the MIT License. */

import * as path from 'node:path';
import { run } from '../esbuild-extension-common.mts';

const srcDir = path.join(import.meta.dirname, 'src');
await run({
	platform: 'node',
	srcDir,
	outdir: path.join(import.meta.dirname, 'dist'),
	entryPoints: {
		extension: path.join(srcDir, 'extension.ts'),
		'native/nativeSshServer': path.join(srcDir, 'native/nativeSshServer.ts'),
		'native/askpass/askpass-node': path.join(srcDir, 'native/askpass/askpass-node.ts'),
	},
	additionalOptions: {
		// ssh2 falls back to its JavaScript implementation without optional native accelerators.
		external: ['vscode', 'cpu-features', '*.node'],
		legalComments: 'external',
	},
}, process.argv);
