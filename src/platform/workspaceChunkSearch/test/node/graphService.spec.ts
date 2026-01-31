/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Robert Wickel. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EdgeType, GraphService, NodeType } from '../../node/graphService';

describe('GraphService', () => {
	let dbPath: string;
	let service: GraphService;

	beforeEach(async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'graph-service-test-'));
		dbPath = path.join(tempDir, 'test.db');
		service = new GraphService(dbPath);
		await service.initialize();
	});

	afterEach(async () => {
		service.close();
		const dir = path.dirname(dbPath);
		if (fs.existsSync(dir)) {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it('should add and retrieve nodes', async () => {
		const node = {
			id: 'file1',
			type: NodeType.FILE,
			name: 'index.ts',
			path: '/src/index.ts'
		};
		await service.addNode(node);

		const nodes = await service.getAllNodes();
		expect(nodes).toHaveLength(1);
		expect(nodes[0].id).toBe('file1');
		expect(nodes[0].type).toBe(NodeType.FILE);
	});

	it('should add and retrieve edges', async () => {
		await service.addNode({ id: 'file1', type: NodeType.FILE, name: 'index.ts' });
		await service.addNode({ id: 'sym1', type: NodeType.SYMBOL, name: 'myFunction' });

		await service.addEdge({
			fromId: 'file1',
			toId: 'sym1',
			type: EdgeType.CONTAINS
		});

		const edges = await service.getAllEdges();
		expect(edges).toHaveLength(1);
		expect(edges[0].from_id).toBe('file1');
		expect(edges[0].to_id).toBe('sym1');
		expect(edges[0].type).toBe(EdgeType.CONTAINS);
	});

	it('should find traceability violations', async () => {
		// Requirement with no implementation
		await service.addNode({ id: 'REQ-1', type: NodeType.REQUIREMENT, name: 'Feature 1' });

		const violations = await service.findViolations();
		expect(violations.some(v => v.type === 'Unimplemented Requirement' && v.nodeId === 'REQ-1')).toBe(true);
	});

	it('should clear file data on deletion', async () => {
		const filePath = '/src/index.ts';
		await service.addNode({ id: 'file1', type: NodeType.FILE, name: 'index.ts', path: filePath });
		await service.addNode({ id: 'sym1', type: NodeType.SYMBOL, name: 'myFunction' });
		await service.addEdge({ fromId: 'file1', toId: 'sym1', type: EdgeType.CONTAINS });

		await service.clearFileData(filePath);

		const nodes = await service.getAllNodes();
		expect(nodes).toHaveLength(0); // Both file and contained symbol should be gone
	});
});
