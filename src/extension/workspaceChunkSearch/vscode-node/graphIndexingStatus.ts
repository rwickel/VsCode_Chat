/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Robert Wickel. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { IWorkspaceChunkSearchService } from '../../../platform/workspaceChunkSearch/node/workspaceChunkSearchService';
import { Disposable } from '../../../util/vs/base/common/lifecycle';

export class GraphIndexingStatusBarItem extends Disposable {
	private readonly _statusBarItem: vscode.StatusBarItem;

	constructor(
		@IWorkspaceChunkSearchService private readonly _workspaceChunkSearchService: IWorkspaceChunkSearchService,
	) {
		super();

		this._statusBarItem = this._register(vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100));
		this._statusBarItem.name = 'Copilot Graph Indexing';

		this._register(this._workspaceChunkSearchService.onDidGraphProgress(e => {
			if (e.processed < e.total) {
				this._statusBarItem.text = `$(sync~spin) Indexing Graph: ${e.processed}/${e.total}`;
				this._statusBarItem.tooltip = e.currentFile ? `Currently indexing: ${e.currentFile}` : 'Indexing workspace symbols into graph...';
				this._statusBarItem.show();
			} else {
				this._statusBarItem.text = `$(check) Graph Indexed`;
				this._statusBarItem.tooltip = `Graph indexing complete. ${e.total} files processed.`;
				// Hide after a short delay or just keep it there? Usually better to hide or show "Ready"
				setTimeout(() => this._statusBarItem.hide(), 5000);
			}
		}));
	}
}
