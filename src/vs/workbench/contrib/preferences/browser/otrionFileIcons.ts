/* Copyright (c) Otrion contributors. Licensed under the MIT License. */

import { getWindow } from '../../../../base/browser/dom.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { Schemas } from '../../../../base/common/network.js';
import { ILanguageService } from '../../../../editor/common/languages/language.js';
import { IModelService } from '../../../../editor/common/services/model.js';
import { getIconClasses } from '../../../../editor/common/services/getIconClasses.js';
import { CommandsRegistry, ICommandService } from '../../../../platform/commands/common/commands.js';
import { FileKind } from '../../../../platform/files/common/files.js';
import { IWorkbenchLayoutService } from '../../../services/layout/browser/layoutService.js';
import { IWorkbenchThemeService } from '../../../services/themes/common/workbenchThemeService.js';
import { registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';

/** Resolve the Explorer's themed pseudo-element inside the workbench, where theme fonts and images are loaded. */
class OtrionFileIcons extends Disposable {
	constructor(
		@IWorkbenchLayoutService layout: IWorkbenchLayoutService,
		@IWorkbenchThemeService themes: IWorkbenchThemeService,
		@ILanguageService languages: ILanguageService,
		@IModelService models: IModelService,
		@ICommandService commands: ICommandService,
	) {
		super();
		let used = false;
		const refresh = () => {
			if (used && CommandsRegistry.getCommand('_otrion.chat.refreshIcons')) {
				void commands.executeCommand('_otrion.chat.refreshIcons');
			}
		};
		this._register(themes.onDidFileIconThemeChange(refresh));
		this._register(themes.onDidColorThemeChange(refresh));
		this._register(CommandsRegistry.registerCommand('_otrion.chat.fileIcon', async (_, resource: URI, folder: boolean) => {
			used = true;
			if (!URI.isUri(resource) || (resource.scheme !== Schemas.file && resource.scheme !== Schemas.vscodeRemote)) { return; }
			const container = layout.activeContainer;
			const doc = container.ownerDocument;
			const probe = doc.createElement('div');
			probe.className = 'show-file-icons';
			probe.style.cssText = 'position:absolute;visibility:hidden;pointer-events:none;font-size:13px';
			const label = doc.createElement('span');
			const theme = themes.getFileIconTheme();
			if (folder && theme.hasFileIcons && !theme.hasFolderIcons) {
				label.classList.add('codicon', 'codicon-folder');
			} else {
				label.classList.add('monaco-icon-label', ...getIconClasses(models, languages, resource, folder ? FileKind.FOLDER : FileKind.FILE));
			}
			probe.append(label);
			container.append(probe);
			try {
				const style = getWindow(container).getComputedStyle(label, '::before');
				const canvas = doc.createElement('canvas');
				canvas.width = canvas.height = 48;
				const ctx = canvas.getContext('2d')!;
				ctx.scale(3, 3);
				const mask = style.maskImage !== 'none';
				const image = /^url\("(.*)"\)$/.exec(mask ? style.maskImage : style.backgroundImage);
				if (image) {
					const img = doc.createElement('img');
					img.src = image[1];
					await img.decode();
					const size = 16 / Math.max(img.naturalWidth, img.naturalHeight);
					const w = img.naturalWidth * size, h = img.naturalHeight * size;
					ctx.drawImage(img, (16 - w) / 2, (16 - h) / 2, w, h);
					if (mask) {
						ctx.globalCompositeOperation = 'source-in';
						ctx.fillStyle = style.backgroundColor;
						ctx.fillRect(0, 0, 16, 16);
					}
				} else {
					const glyph = style.content.replace(/^"|"$/g, '');
					if (!glyph.trim() || glyph === 'none' || glyph === 'normal') { return; }
					const font = style.fontStyle + ' ' + style.fontWeight + ' ' + style.fontSize + ' ' + style.fontFamily;
					await doc.fonts.load(font, glyph);
					ctx.font = font;
					ctx.fillStyle = style.color;
					ctx.textAlign = 'center';
					ctx.textBaseline = 'middle';
					ctx.fillText(glyph, 8, 8);
				}
				return canvas.toDataURL();
			} finally { probe.remove(); }
		}));
	}
}

registerWorkbenchContribution2('otrion.fileIcons', OtrionFileIcons, WorkbenchPhase.BlockRestore);
