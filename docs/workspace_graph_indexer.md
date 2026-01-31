# Workspace Graph Indexer

The `WorkspaceGraphIndexer` is a core component of the Code Traceability system. It is responsible for analyzing the workspace files, extracting relationships between code elements and requirements, and populating the Graph Database.

## Overview

The indexer monitors the workspace for file system changes and performs the following tasks:
1. **Node Extraction**: Identifies files, requirements, code symbols, and unit tests.
2. **Relationship Mapping**: Establishes edges between nodes (e.g., which symbol satisfies which requirement).
3. **Semantic Indexing**: Computes embeddings for code elements to enable vector search within the graph.

## Architecture

The indexer integrates with several platform services:
- **`IWorkspaceFileIndex`**: Provides file system events and access to file content.
- **`GraphService`**: The persistence layer using SQLite for storing the graph.
- **`IEmbeddingsComputer`**: Generates vector representations of code elements.

### Node Types

| Type | Description |
| :--- | :--- |
| `FILE` | Represents a source file in the workspace. |
| `DIRECTORY` | Represents a folder in the workspace, used for Merkle tree change detection. |
| `REQUIREMENT` | Represents a software requirement (usually identified by an ID like `REQ-123`). |
| `SYMBOL` | Represents code elements like classes, functions, or interfaces. |
| `UNIT_TEST` | Represents test cases or test files. |

### Edge Types

| Type | From | To | Description |
| :--- | :--- | :--- | :--- |
| `CONTAINS` | `FILE` / `DIRECTORY` | `SYMBOL` / `UNIT_TEST` / `FILE` / `DIRECTORY` | Indicates a code element or file/folder is contained within another. |
| `SATISFIES` | `SYMBOL` | `REQUIREMENT` | Indicates a piece of code implements a specific requirement. |
| `VERIFIES` | `UNIT_TEST` | `REQUIREMENT` | Indicates a test case validates a specific requirement. |

## Metadata Extraction

The indexer uses specialized comment tags to link code to requirements:

### `@satisfies`
Used to link a symbol to a requirement it implements.
```typescript
/**
 * Processes incoming data according to business rules.
 * @satisfies REQ-001
 */
function processData(data: any) { ... }
```

### `@verifies`
Used to link a unit test to the requirement it validates.
```typescript
/**
 * @verifies REQ-001
 */
test('should process data correctly', () => { ... });
```

## Change Detection (Merkle Tree)

The `WorkspaceGraphIndexer` uses a hierarchical **Merkle Tree** of SHA-256 hashes to efficiently track changes:
1. **File Hash**: Each `FILE` node stores the SHA-256 hash of its text content.
2. **Directory Hash**: Each `DIRECTORY` node stores a hash computed from the sorted names and hashes of its immediate children (files and subdirectories).
3. **Change Detection**: On startup or file change, hashes are recomputed. If a directory's hash matches the stored value, its entire subtree is skipped, drastically improving performance.

## Lifecycle

1. **Initialization**: On startup, the indexer builds a hierarchical Merkle structure of the workspace.
2. **Incremental Updates**:
   - **On Create/Change**: The file's content hash is checked. If changed, the file is re-parsed, old graph data for that path is cleared, and new nodes/edges are added. Directory hashes are updated up the chain.
   - **On Delete**: All nodes and edges associated with the path are removed, and parent directory hashes are invalidated/updated.

## Search and Traceability

Because the indexer stores embeddings for `SYMBOL` and `UNIT_TEST` nodes, the graph can be queried not just by direct links, but also by semantic similarity. This allows for advanced features like "Find tests related to this requirement" even if explicit `@verifies` tags are missing, or "Identify implementation gaps".

## Traceability Violations

The system can identify several types of traceability issues:
- **Unimplemented Requirements**: Requirements with no `SATISFIES` edges.
- **Untested Requirements**: Requirements with no `VERIFIES` edges.
- **Orphaned Implementations**: Symbols with no `SATISFIES` link.
- **Orphaned Tests**: Tests with no `VERIFIES` link.
