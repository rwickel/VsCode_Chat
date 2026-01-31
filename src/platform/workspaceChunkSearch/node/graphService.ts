/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Robert Wickel. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'node:fs';

import * as path from 'node:path';
import sql from 'node:sqlite';

export enum NodeType {
	FILE = 'FILE',
	DIRECTORY = 'DIRECTORY',
	REQUIREMENT = 'REQUIREMENT',
	SYMBOL = 'SYMBOL',
	UNIT_TEST = 'UNIT_TEST'
}

export enum EdgeType {
	CONTAINS = 'CONTAINS',
	SATISFIES = 'SATISFIES',
	VERIFIES = 'VERIFIES'
}

export interface Node {
	id: string;
	type: NodeType;
	name: string;
	path?: string;
	metadata?: string;
	embedding?: Uint8Array;
}

export interface Edge {
	fromId: string;
	toId: string;
	type: EdgeType;
	metadata?: string;
}

export class GraphService {
	private db: sql.DatabaseSync | undefined;

	constructor(private readonly dbPath: string) { }

	async initialize(): Promise<void> {
		const dir = path.dirname(this.dbPath);
		if (!fs.existsSync(dir)) {
			await fs.promises.mkdir(dir, { recursive: true });
		}

		this.db = new sql.DatabaseSync(this.dbPath);

		this.db.exec(`
			PRAGMA journal_mode = WAL;
			PRAGMA synchronous = NORMAL;
			PRAGMA foreign_keys = ON;

			CREATE TABLE IF NOT EXISTS nodes (
				id TEXT PRIMARY KEY,
				type TEXT NOT NULL,
				name TEXT NOT NULL,
				path TEXT,
				metadata TEXT,
				embedding BLOB
			);

			CREATE TABLE IF NOT EXISTS edges (
				from_id TEXT NOT NULL,
				to_id TEXT NOT NULL,
				type TEXT NOT NULL,
				metadata TEXT,
				PRIMARY KEY (from_id, to_id, type),
				FOREIGN KEY (from_id) REFERENCES nodes (id) ON DELETE CASCADE,
				FOREIGN KEY (to_id) REFERENCES nodes (id) ON DELETE CASCADE
			);

			CREATE INDEX IF NOT EXISTS idx_nodes_path ON nodes (path);
			CREATE INDEX IF NOT EXISTS idx_nodes_type ON nodes (type);
			CREATE INDEX IF NOT EXISTS idx_edges_from ON edges (from_id);
			CREATE INDEX IF NOT EXISTS idx_edges_to ON edges (to_id);
		`);
	}

	async addNode(node: Node): Promise<void> {
		if (!this.db) throw new Error('GraphService not initialized');
		const stmt = this.db.prepare(
			'INSERT OR REPLACE INTO nodes (id, type, name, path, metadata, embedding) VALUES (?, ?, ?, ?, ?, ?)'
		);
		stmt.run(node.id, node.type, node.name, node.path ?? null, node.metadata ?? null, node.embedding ?? null);
	}

	async addEdge(edge: Edge): Promise<void> {
		if (!this.db) throw new Error('GraphService not initialized');
		const stmt = this.db.prepare(
			'INSERT OR REPLACE INTO edges (from_id, to_id, type, metadata) VALUES (?, ?, ?, ?)'
		);
		stmt.run(edge.fromId, edge.toId, edge.type, edge.metadata ?? null);
	}

	async deleteNode(id: string): Promise<void> {
		if (!this.db) throw new Error('GraphService not initialized');
		const stmt = this.db.prepare('DELETE FROM nodes WHERE id = ?');
		stmt.run(id);
	}

	async clearFileData(filePath: string): Promise<void> {
		if (!this.db) throw new Error('GraphService not initialized');
		// Deleting the FILE node will cascade to edges.
		// We also need to delete nodes that were CONTAINED by this file.
		// Since we don't have a hierarchical delete in sqlite without recursive triggers or manual cleanup:

		this.db.exec('BEGIN TRANSACTION');
		try {
			// Find all nodes contained by this file
			const nodesToDelete = this.db.prepare(`
				SELECT to_id FROM edges
				WHERE from_id = (SELECT id FROM nodes WHERE type = 'FILE' AND path = ?)
				AND type = 'CONTAINS'
			`).all(filePath);

			for (const row of nodesToDelete) {
				this.db.prepare('DELETE FROM nodes WHERE id = ?').run(row.to_id as string);
			}

			// Delete the file node itself
			this.db.prepare("DELETE FROM nodes WHERE type = 'FILE' AND path = ?").run(filePath);

			this.db.exec('COMMIT');
		} catch (e) {
			this.db.exec('ROLLBACK');
			throw e;
		}
	}

	async getFileStat(filePath: string): Promise<string | undefined> {
		if (!this.db) throw new Error('GraphService not initialized');
		const row = this.db.prepare("SELECT metadata FROM nodes WHERE (type = 'FILE' OR type = 'DIRECTORY') AND path = ?").get(filePath) as { metadata: string | null } | undefined;
		return row?.metadata ?? undefined;
	}

	async getChildren(parentId: string): Promise<{ id: string; name: string; type: NodeType; metadata: string | null }[]> {
		if (!this.db) throw new Error('GraphService not initialized');
		const rows = this.db.prepare(`
			SELECT n.id, n.name, n.type, n.metadata
			FROM nodes n
			JOIN edges e ON n.id = e.to_id
			WHERE e.from_id = ? AND e.type = 'CONTAINS'
		`).all(parentId) as { id: string; name: string; type: string; metadata: string | null }[];

		return rows.map(r => ({ ...r, type: r.type as NodeType }));
	}

	async getAllNodes(): Promise<any[]> {
		if (!this.db) throw new Error('GraphService not initialized');
		return this.db.prepare('SELECT * FROM nodes').all();
	}

	async getAllEdges(): Promise<any[]> {
		if (!this.db) throw new Error('GraphService not initialized');
		return this.db.prepare('SELECT * FROM edges').all();
	}

	async findViolations(): Promise<{ type: string; message: string; nodeId: string }[]> {
		if (!this.db) throw new Error('GraphService not initialized');
		const violations: { type: string; message: string; nodeId: string }[] = [];

		// 1. Unimplemented Requirement
		const unimplemented = this.db.prepare(`
			SELECT id, name FROM nodes
			WHERE type = ? AND id NOT IN (SELECT to_id FROM edges WHERE type = ?)
		`).all(NodeType.REQUIREMENT, EdgeType.SATISFIES);

		for (const r of unimplemented) {
			violations.push({
				type: 'Unimplemented Requirement',
				message: `Requirement "${r.name}" has no implementation`,
				nodeId: r.id as string
			});
		}

		// 2. Untested Requirement
		const untested = this.db.prepare(`
			SELECT id, name FROM nodes
			WHERE type = ? AND id NOT IN (SELECT to_id FROM edges WHERE type = ?)
		`).all(NodeType.REQUIREMENT, EdgeType.VERIFIES);

		for (const r of untested) {
			violations.push({
				type: 'Untested Requirement',
				message: `Requirement "${r.name}" has no unit tests`,
				nodeId: r.id as string
			});
		}

		// 3. Orphaned Implementation
		const orphanedImpl = this.db.prepare(`
			SELECT id, name, path FROM nodes
			WHERE type = ? AND id NOT IN (SELECT from_id FROM edges WHERE type = ?)
		`).all(NodeType.SYMBOL, EdgeType.SATISFIES);

		for (const s of orphanedImpl) {
			violations.push({
				type: 'Orphaned Implementation',
				message: `Symbol "${s.name}" in ${s.path} is not linked to any requirement`,
				nodeId: s.id as string
			});
		}

		// 4. Orphaned Test
		const orphanedTest = this.db.prepare(`
			SELECT id, name, path FROM nodes
			WHERE type = ? AND id NOT IN (SELECT from_id FROM edges WHERE type = ?)
		`).all(NodeType.UNIT_TEST, EdgeType.VERIFIES);

		for (const t of orphanedTest) {
			violations.push({
				type: 'Orphaned Test',
				message: `Test "${t.name}" in ${t.path} is not linked to any requirement`,
				nodeId: t.id as string
			});
		}

		return violations;
	}

	async searchByEmbedding(embedding: Uint8Array, limit: number = 10): Promise<Node[]> {
		if (!this.db) throw new Error('GraphService not initialized');
		// Simple cosine similarity search if we were using a vector extension,
		// but since we are using standard node:sqlite, we'd have to do it in memory
		// or use a custom function. For now, let's just return all nodes with embeddings
		// and we can filter in the caller or implement a custom function if needed.
		// However, a full table scan in JS is slow.

		// In a real scenario, we'd use sqlite-vss or similar.
		// For this implementation, I'll provide a stub that returns nodes with embeddings.
		const rows = this.db.prepare('SELECT * FROM nodes WHERE embedding IS NOT NULL').all();
		return rows.map(row => ({
			id: row.id as string,
			type: row.type as NodeType,
			name: row.name as string,
			path: row.path as string,
			metadata: row.metadata as string,
			embedding: row.embedding as Uint8Array
		}));
	}

	async exportDOT(): Promise<string> {
		if (!this.db) throw new Error('GraphService not initialized');

		const nodes = await this.getAllNodes();
		const edges = await this.getAllEdges();

		let dot = 'digraph G {\n';
		dot += '  rankdir=LR;\n';
		dot += '  node [shape=box, style=filled, fontname="Arial"];\n\n';

		for (const node of nodes) {
			let color = 'white';
			switch (node.type) {
				case NodeType.FILE: color = 'lightblue'; break;
				case NodeType.REQUIREMENT: color = 'lightyellow'; break;
				case NodeType.SYMBOL: color = 'lightgreen'; break;
				case NodeType.UNIT_TEST: color = 'orchid'; break;
			}
			dot += `  "${node.id}" [label="${node.name}\\n(${node.type})", fillcolor="${color}"];\n`;
		}

		dot += '\n';

		for (const edge of edges) {
			let style = 'solid';
			switch (edge.type) {
				case EdgeType.CONTAINS: style = 'dashed'; break;
				case EdgeType.SATISFIES: style = 'bold'; break;
				case EdgeType.VERIFIES: style = 'dotted'; break;
			}
			dot += `  "${edge.from_id}" -> "${edge.to_id}" [label="${edge.type}", style="${style}"];\n`;
		}

		dot += '}\n';
		return dot;
	}

	close(): void {
		if (this.db) {
			this.db.close();
			this.db = undefined;
		}
	}
}
