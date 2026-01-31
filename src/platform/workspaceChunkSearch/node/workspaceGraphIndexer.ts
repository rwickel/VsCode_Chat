/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Robert Wickel. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'node:path';
import { TelemetryCorrelationId } from '../../../util/common/telemetryCorrelationId';
import { sha256 } from '../../../util/node/hash';
import { CancellationTokenSource } from '../../../util/vs/base/common/cancellation';
import { Emitter, Event } from '../../../util/vs/base/common/event';
import { Disposable } from '../../../util/vs/base/common/lifecycle';
import { URI } from '../../../util/vs/base/common/uri';
import { EmbeddingType, IEmbeddingsComputer } from '../../embeddings/common/embeddingsComputer';
import { packEmbedding } from '../../embeddings/common/embeddingsStorage';
import { ILogService } from '../../log/common/logService';
import { IWorkspaceService } from '../../workspace/common/workspaceService';
import { EdgeType, GraphService, Node, NodeType } from './graphService';
import { FileRepresentation, IWorkspaceFileIndex } from './workspaceFileIndex';

export class WorkspaceGraphIndexer extends Disposable {
	private readonly _cts = this._register(new CancellationTokenSource());
	private _processedCount = 0;
	private _totalCount = 0;

	private readonly _onDidProgress = this._register(new Emitter<{ total: number; processed: number; currentFile?: string }>());
	public readonly onDidProgress: Event<{ total: number; processed: number; currentFile?: string }> = this._onDidProgress.event;

	constructor(
		private readonly _embeddingType: EmbeddingType,
		private readonly _graphService: GraphService,
		@IWorkspaceFileIndex private readonly _workspaceFileIndex: IWorkspaceFileIndex,
		@IEmbeddingsComputer private readonly _embeddingsComputer: IEmbeddingsComputer,
		@ILogService private readonly _logService: ILogService,
		@IWorkspaceService private readonly _workspaceService: IWorkspaceService,
	) {
		super();

		this._register(this._workspaceFileIndex.onDidCreateFiles(uris => this._indexFiles(uris)));
		this._register(this._workspaceFileIndex.onDidChangeFiles(uris => this._indexFiles(uris)));
		this._register(this._workspaceFileIndex.onDidDeleteFiles(uris => this._handleDeletedFiles(uris)));
	}

	async start(): Promise<void> {
		await this._workspaceFileIndex.initialize();
		this._logService.info('WorkspaceGraphIndexer: Starting hierarchical Merkle index...');

		const allFiles = Array.from(this._workspaceFileIndex.values());
		this._totalCount = allFiles.length;
		this._processedCount = 0;
		const folders = this._workspaceService.getWorkspaceFolders();

		let totalSymbols = 0;
		for (const folder of folders) {
			const folderFiles = allFiles.filter(f => f.uri.fsPath.startsWith(folder.fsPath));
			const { symbolsCount } = await this._indexFolderRecursively(folder.fsPath, folderFiles);
			totalSymbols += symbolsCount;
		}

		this._onDidProgress.fire({ total: this._totalCount, processed: this._totalCount });
		this._logService.info(`WorkspaceGraphIndexer: Hierarchical index complete. Total symbols: ${totalSymbols}`);
	}

	private async _indexFolderRecursively(dirPath: string, filesInFolder: FileRepresentation[]): Promise<{ symbolsCount: number; hash: string }> {
		const immediateFiles = filesInFolder.filter(f => path.dirname(f.uri.fsPath) === dirPath);

		// Group files by their immediate subdirectory
		const subdirFiles = new Map<string, FileRepresentation[]>();
		for (const f of filesInFolder) {
			const dirname = path.dirname(f.uri.fsPath);
			if (dirname === dirPath) continue;

			const relative = path.relative(dirPath, f.uri.fsPath);
			const firstPart = relative.split(path.sep)[0];
			const subdirPath = path.join(dirPath, firstPart);

			let list = subdirFiles.get(subdirPath);
			if (!list) {
				list = [];
				subdirFiles.set(subdirPath, list);
			}
			list.push(f);
		}

		const childHashes: { name: string; hash: string }[] = [];
		let totalSymbols = 0;

		// 1. Process immediate files
		for (const file of immediateFiles) {
			this._processedCount++;
			this._onDidProgress.fire({ total: this._totalCount, processed: this._processedCount, currentFile: file.uri.fsPath });
			const result = await this._indexFile(file);
			totalSymbols += result.symbolsCount;
			childHashes.push({ name: path.basename(file.uri.fsPath), hash: result.hash });
		}

		// 2. Process subdirectories
		for (const [subdirPath, files] of subdirFiles) {
			const result = await this._indexFolderRecursively(subdirPath, files);
			totalSymbols += result.symbolsCount;
			childHashes.push({ name: path.basename(subdirPath), hash: result.hash });
		}

		// 3. Compute and store directory hash
		childHashes.sort((a, b) => a.name.localeCompare(b.name));
		const combined = childHashes.map(c => `${c.name}:${c.hash}`).join('|');
		const dirHash = sha256(combined);

		// Add/Update directory node
		const dirNode: Node = {
			id: `dir:${dirPath}`,
			type: NodeType.DIRECTORY,
			name: path.basename(dirPath) || dirPath,
			path: dirPath,
			metadata: dirHash
		};
		await this._graphService.addNode(dirNode);

		// Add edges to children
		for (const child of childHashes) {
			const childId = subdirFiles.has(path.join(dirPath, child.name)) ? `dir:${path.join(dirPath, child.name)}` : `file:${path.join(dirPath, child.name)}`;
			await this._graphService.addEdge({
				fromId: dirNode.id,
				toId: childId,
				type: EdgeType.CONTAINS
			});
		}

		return { symbolsCount: totalSymbols, hash: dirHash };
	}

	private async _indexFiles(uris: readonly URI[]): Promise<void> {
		let totalSymbols = 0;
		for (const uri of uris) {
			try {
				const fileRep = this._workspaceFileIndex.get(uri);
				if (!fileRep) continue;

				const result = await this._indexFile(fileRep);
				totalSymbols += result.symbolsCount;
			} catch (e) {
				this._logService.error(`WorkspaceGraphIndexer: Failed to index ${uri.toString()}`, e);
			}
		}
		if (uris.length > 1) {
			this._logService.info(`WorkspaceGraphIndexer: Indexed ${totalSymbols} symbols from ${uris.length} files.`);
		}
	}

	private async _indexFile(file: FileRepresentation, force: boolean = false): Promise<{ symbolsCount: number; hash: string }> {
		const filePath = file.uri.fsPath;
		const text = await file.getText();
		const hash = sha256(text);

		if (!force) {
			const storedHash = await this._graphService.getFileStat(filePath);
			if (storedHash === hash) {
				this._logService.debug(`WorkspaceGraphIndexer: Skipping unchanged file: ${filePath}`);
				return { symbolsCount: 0, hash };
			}
			this._logService.info(`WorkspaceGraphIndexer: File changed or new: ${filePath} (Stored: ${storedHash}, Current: ${hash})`);
		}

		this._logService.info(`WorkspaceGraphIndexer: Indexing file: ${filePath}`);
		let symbolsInFile = 0;

		// 1. Clear old data for this file
		await this._graphService.clearFileData(filePath);

		// 2. Add FILE node
		const fileNode: Node = {
			id: `file:${filePath}`,
			type: NodeType.FILE,
			name: path.basename(filePath),
			path: filePath,
			metadata: hash
		};
		await this._graphService.addNode(fileNode);

		if (!text) {
			this._logService.debug(`WorkspaceGraphIndexer: No text content for file: ${filePath}`);
			return { symbolsCount: 0, hash };
		}
		const content = text;

		// 3. Extract Requirements from comments
		const reqRegex = /@(?<type>satisfies|verifies)\s+(?<id>[A-Z0-9_\-]+)/g;
		let match;

		while ((match = reqRegex.exec(content)) !== null) {
			const reqId = match.groups?.id;
			if (reqId) {
				await this._graphService.addNode({
					id: `req:${reqId}`,
					type: NodeType.REQUIREMENT,
					name: reqId
				});
			}
		}

		// 4. Extract Symbols
		const symbolRegex = /(?:class|function|interface|const|let)\s+(?<name>[a-zA-Z_$][\w$]*)/g;
		const extractedNodes: { node: Node; preText: string }[] = [];

		while ((match = symbolRegex.exec(content)) !== null) {
			const name = match.groups?.name;
			if (name) {
				const symbolId = `symbol:${filePath}:${name}`;
				const isTestFile = filePath.toLowerCase().includes('test') || filePath.toLowerCase().includes('spec');

				const node: Node = {
					id: symbolId,
					type: isTestFile ? NodeType.UNIT_TEST : NodeType.SYMBOL,
					name: name,
					path: filePath,
					metadata: match[0] // Store the match text for context
				};

				const preText = content.substring(Math.max(0, match.index - 200), match.index);
				extractedNodes.push({ node, preText });
			}
		}

		// Batch compute embeddings for efficiency
		if (extractedNodes.length > 0) {
			const textsToEmbed = extractedNodes.map(n => `Symbol: ${n.node.name} in ${path.basename(filePath)}`);
			const embeddings = await this._embeddingsComputer.computeEmbeddings(
				this._embeddingType,
				textsToEmbed,
				{ inputType: 'document' },
				new TelemetryCorrelationId('WorkspaceGraphIndexer'),
				this._cts.token
			);

			for (let i = 0; i < extractedNodes.length; i++) {
				const { node, preText } = extractedNodes[i];
				node.embedding = packEmbedding(embeddings.values[i]);

				await this._graphService.addNode(node);
				await this._graphService.addEdge({
					fromId: fileNode.id,
					toId: node.id,
					type: EdgeType.CONTAINS
				});

				const satisfiesMatch = /@satisfies\s+(?<id>[A-Z0-9_\-]+)/.exec(preText);
				if (satisfiesMatch?.groups?.id) {
					await this._graphService.addEdge({
						fromId: node.id,
						toId: `req:${satisfiesMatch.groups.id}`,
						type: EdgeType.SATISFIES
					});
				}

				const verifiesMatch = /@verifies\s+(?<id>[A-Z0-9_\-]+)/.exec(preText);
				if (verifiesMatch?.groups?.id && node.type === NodeType.UNIT_TEST) {
					await this._graphService.addEdge({
						fromId: node.id,
						toId: `req:${verifiesMatch.groups.id}`,
						type: EdgeType.VERIFIES
					});
				}
			}
			symbolsInFile = extractedNodes.length;
		}
		return { symbolsCount: symbolsInFile, hash };
	}

	private async _handleDeletedFiles(uris: readonly URI[]): Promise<void> {
		for (const uri of uris) {
			await this._graphService.clearFileData(uri.fsPath);
		}
	}
}
