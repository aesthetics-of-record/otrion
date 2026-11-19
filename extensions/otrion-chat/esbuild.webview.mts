/* Copyright (c) Otrion contributors. Licensed under the MIT License. */

import path from 'node:path';
import { run } from '../esbuild-webview-common.mts';

const srcDir = path.join(import.meta.dirname, 'preview-src');
await run({
	srcDir,
	outdir: path.join(import.meta.dirname, 'media'),
	entryPoints: { markdown: path.join(srcDir, 'markdown.ts') },
	additionalOptions: { format: 'iife', globalName: 'otrionMarkdown' },
}, process.argv);
