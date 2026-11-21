/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { app } from 'electron';
import { mkdtemp, rm, unlink } from 'fs/promises';
import { join } from '../../../base/common/path.js';
import { URI } from '../../../base/common/uri.js';
import { CancellationToken, CancellationTokenSource } from '../../../base/common/cancellation.js';
import { IConfigurationService } from '../../configuration/common/configuration.js';
import { IEnvironmentMainService } from '../../environment/electron-main/environmentMainService.js';
import { IFileService } from '../../files/common/files.js';
import { ILifecycleMainService } from '../../lifecycle/electron-main/lifecycleMainService.js';
import { ILogService } from '../../log/common/log.js';
import { IMeteredConnectionService } from '../../meteredConnection/common/meteredConnection.js';
import { INativeHostMainService } from '../../native/electron-main/nativeHostMainService.js';
import { IProductService } from '../../product/common/productService.js';
import { isSuccess, IRequestService } from '../../request/common/request.js';
import { IApplicationStorageMainService } from '../../storage/electron-main/storageMainService.js';
import { ITelemetryService } from '../../telemetry/common/telemetry.js';
import { AvailableForDownload, IUpdate, State, StateType, UpdateType } from '../common/update.js';
import { AbstractUpdateService, createUpdateURL, IUpdateURLOptions } from './abstractUpdateService.js';
import { activateLinuxUpdate, extractLinuxUpdate, getLinuxInstallRoot } from './linuxArchiveUpdate.js';

export class ArchiveUpdateService extends AbstractUpdateService {

	private linuxRoot?: string;
	private download?: CancellationTokenSource;
	private downloadFinished?: Promise<void>;
	private pending?: { stage: string; version: string };

	constructor(
		@ILifecycleMainService lifecycleMainService: ILifecycleMainService,
		@IConfigurationService configurationService: IConfigurationService,
		@IEnvironmentMainService environmentMainService: IEnvironmentMainService,
		@IRequestService requestService: IRequestService,
		@ILogService logService: ILogService,
		@IFileService private readonly fileService: IFileService,
		@INativeHostMainService private readonly nativeHostMainService: INativeHostMainService,
		@IProductService productService: IProductService,
		@ITelemetryService telemetryService: ITelemetryService,
		@IApplicationStorageMainService applicationStorageMainService: IApplicationStorageMainService,
		@IMeteredConnectionService meteredConnectionService: IMeteredConnectionService,
	) {
		super(lifecycleMainService, configurationService, environmentMainService, requestService, logService, productService, telemetryService, applicationStorageMainService, meteredConnectionService, false);
		this._register(lifecycleMainService.onWillShutdown(event => {
			event.join('otrion.archiveUpdate', this.state.type === StateType.Restarting ? this.activatePendingUpdate() : this.cancelUpdate());
		}));
	}

	protected override async postInitialize(): Promise<void> {
		if (process.platform === 'linux' && this.githubReleaseUrl && this.productService.otrionVersion) {
			this.linuxRoot = await getLinuxInstallRoot(process.execPath, this.productService.otrionVersion);
		}
	}

	protected buildUpdateFeedUrl(quality: string, commit: string, options?: IUpdateURLOptions): string {
		return this.githubReleaseUrl ?? createUpdateURL(this.productService.updateUrl!, `linux-${process.arch}`, quality, commit, options);
	}

	protected doCheckForUpdates(explicit: boolean, _pendingCommit?: string): void {
		if (!this.quality) {
			return;
		}

		const internalOrg = this.getInternalOrg();
		const background = !explicit && !internalOrg;
		const url = this.buildUpdateFeedUrl(this.quality, this.productService.commit!, { background, internalOrg });
		const checking = State.CheckingForUpdates(explicit);
		this.setState(checking);

		this.fetchUpdate(url, 'updateService.archive.checkForUpdates', CancellationToken.None)
			.then(update => {
				// If updates were disabled mid-check, ignore the result so we don't leave the Disabled state.
				if (this.state !== checking) {
					return;
				}

				if (!update || !update.url || !update.version || !update.productVersion) {
					this.setState(State.Idle(UpdateType.Archive, undefined, explicit || undefined));
				} else {
					this.setState(State.AvailableForDownload(update));
				}
			})
			.then(undefined, err => {
				if (this.state !== checking) {
					return;
				}

				this.logService.error(err);
				// only show message when explicitly checking for updates
				const message: string | undefined = explicit ? (err.message || err) : undefined;
				this.setState(State.Idle(UpdateType.Archive, message));
			});
	}

	protected override async doDownloadUpdate(state: AvailableForDownload): Promise<void> {
		if (this.linuxRoot && state.update.sha256hash) {
			return this.startDownload(state.update, true);
		}
		// Use the download URL if available as we don't currently detect the package type that was
		// installed and the website download page is more useful than the tarball generally.
		const url = this.githubReleaseUrl ? state.update.url : this.productService.downloadUrl || state.update.url;
		if (url) {
			await this.nativeHostMainService.openExternal(undefined, url);
		}

		this.setState(State.Idle(UpdateType.Archive));
	}

	private startDownload(update: IUpdate, explicit: boolean): Promise<void> {
		const source = new CancellationTokenSource();
		this.download = source;
		this.setState(State.Downloading(update, explicit, false));
		this.downloadFinished = this.stageDownload(update, explicit, source).finally(() => {
			source.dispose();
			this.download = undefined;
			this.downloadFinished = undefined;
		});
		return this.downloadFinished;
	}

	private async stageDownload(update: IUpdate, explicit: boolean, source: CancellationTokenSource): Promise<void> {
		let stage: string | undefined;
		try {
			stage = await mkdtemp(join(this.linuxRoot!, '.otrion-update-'));
			const context = await this.requestService.request({ url: update.url!, callSite: 'updateService.archive.download' }, source.token);
			if (!isSuccess(context)) {
				throw new Error(`Download failed (HTTP ${context.res.statusCode})`);
			}
			const file = join(stage, 'release.tar.gz');
			await this.fileService.writeFile(URI.file(file), context.stream);
			if (source.token.isCancellationRequested) {
				return;
			}
			await extractLinuxUpdate(stage, update.version, update.sha256hash!);
			await unlink(file);
			if (!source.token.isCancellationRequested) {
				this.pending = { stage, version: update.version };
				stage = undefined; // Ownership passes to restart or cancellation.
				this.setState(State.Ready(update, explicit, false));
			}
		} catch (error) {
			if (!source.token.isCancellationRequested) {
				this.logService.error(error);
				this.setState(State.Idle(UpdateType.Archive, explicit ? String(error) : undefined));
			}
		} finally {
			if (stage) {
				await rm(stage, { recursive: true, force: true });
			}
		}
	}

	protected override async cancelUpdate(): Promise<void> {
		this.download?.cancel();
		await this.downloadFinished;
		if (this.pending) {
			await rm(this.pending.stage, { recursive: true, force: true });
			this.pending = undefined;
		}
	}

	private async activatePendingUpdate(): Promise<void> {
		if (!this.linuxRoot || !this.pending) {
			return;
		}
		try {
			await activateLinuxUpdate(this.linuxRoot, this.pending.stage, this.productService.otrionVersion!, this.pending.version);
		} catch (error) {
			this.logService.error('Failed to activate the Linux update', error);
		} finally {
			await rm(this.pending.stage, { recursive: true, force: true });
			this.pending = undefined;
		}
	}

	protected override doQuitAndInstall(): void {
		if (this.linuxRoot) {
			app.relaunch({ execPath: join(this.linuxRoot, 'current', 'otrion') });
		}
	}
}
