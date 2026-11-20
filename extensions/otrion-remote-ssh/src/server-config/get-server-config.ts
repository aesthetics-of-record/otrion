import type { IServerConfig, ServerValidation } from './types';

import * as vscode from 'vscode';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { getProductJson } from './get-product-json';

export async function getServerConfig(): Promise<IServerConfig> {
    const productJson = await getProductJson();

    const customServerBinaryName = vscode.workspace.getConfiguration('otrion.ssh').get<string>('serverBinaryName', '');
    const serverValidation = vscode.workspace.getConfiguration('otrion.ssh').get<ServerValidation>('serverValidation', 'strict');
    const downloadUrl = productJson.serverDownloadUrlTemplate as string | undefined;
    const otrionVersion = productJson.otrionVersion as string | undefined;
    let commit = productJson.commit as string | undefined;
    if (!commit && otrionVersion) {
        // Source launches use the server published for the checked-in Otrion version.
        const tag = 'v' + otrionVersion;
        try {
            const { stdout } = await promisify(execFile)('git', ['-C', vscode.env.appRoot, 'rev-parse', '--verify', 'refs/tags/' + tag + '^{commit}']);
            commit = stdout.trim();
        } catch {
            throw new Error('Fetch the Otrion release tag (' + tag + ') to connect from a source checkout.');
        }
    }
    if (!commit) { throw new Error('This build has no remote server commit.'); }

    return {
        version: vscode.version.replace('-insider',''),
        commit,
        quality: productJson.quality as string,
        release: productJson.release as string || '',
        serverApplicationName: customServerBinaryName || productJson.serverApplicationName as string,
        serverDataFolderName: productJson.serverDataFolderName as string,
        serverDownloadUrlTemplate: otrionVersion ? downloadUrl?.replaceAll('${otrionVersion}', otrionVersion) : downloadUrl,
        serverValidation,
    };
}
