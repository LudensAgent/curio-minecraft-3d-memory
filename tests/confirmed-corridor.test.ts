import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  canonicalCellKey,
  FragmentStore,
  TopologyStore,
  writeConfirmedCorridor,
} from '../dist/topology/index.js';
import type {
  ConfirmedCorridorEdge,
  ConfirmedCorridorNode,
  PathFragment,
  TraversalEvidence,
} from '../dist/topology/index.js';
import { openSpatialSession } from '../dist/storage/sqlite/index.js';
import type { Vec3Like } from '../dist/types.js';

const WORLD = 'world';
const DIM = 'overworld';
const SESSION = 's1';

function pt(x: number, y: number, z: number): Vec3Like {
  return { x, y, z };
}

function fragment(id: string, polyline: Vec3Like[]): PathFragment {
  return {
    id,
    worldId: WORLD,
    dim: DIM,
    kind: 'walked',
    entrances: [],
    polyline,
    geometrySource: 'traversal',
    deepestY: Math.min(...polyline.map((point) => point.y)),
    createdAt: 100,
    lastUsedAt: 200,
    uses: 1,
  };
}

function traversal(
  id: string,
  fragmentId: string,
  from: Vec3Like,
  to: Vec3Like,
  overrides: Partial<TraversalEvidence> = {},
): TraversalEvidence {
  return {
    id,
    fragmentId,
    from,
    to,
    worldId: WORLD,
    dim: DIM,
    sessionId: SESSION,
    observedAt: 1000,
    source: 'confirmed_traversal',
    mode: 'walk',
    ...overrides,
  };
}

function node(id: string, pos: Vec3Like): ConfirmedCorridorNode {
  return { id, pos, kind: 'place' };
}

function edge(id: string, from: string, to: string, evidenceIds: string[]): ConfirmedCorridorEdge {
  return { id, from, to, type: 'HORIZONTAL', evidenceIds, modes: ['walk'] };
}

const A = pt(0, 64, 0);
const B = pt(1, 64, 0);
const C = pt(1, 64, 1);

function pair() {
  const history = new FragmentStore(WORLD);
  return { history, topology: new TopologyStore(history) };
}

const tempDirs: string[] = [];

function makeDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'confirmed-corridor-'));
  tempDirs.push(dir);
  return join(dir, 'spatial.db');
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

describe('writeConfirmedCorridor — atomic confirmed facts', () => {
  it('writes fragment, traversals, nodes and edges with exact endpoint agreement', () => {
    const { history, topology } = pair();
    const result = writeConfirmedCorridor(history, topology, {
      fragment: fragment('f1', [A, B, C]),
      traversals: [
        traversal('ev-ab', 'f1', A, B),
        traversal('ev-bc', 'f1', B, C),
      ],
      nodes: [node('a', A), node('b', B), node('c', C)],
      edges: [edge('e-ab', 'a', 'b', ['ev-ab']), edge('e-bc', 'b', 'c', ['ev-bc'])],
      sessionId: SESSION,
    });

    expect(result.status).toBe('written');
    expect(result.committed).toBe('all');
    expect(result.problem).toBeUndefined();
    expect(result.traversals.inserted).toEqual(['ev-ab', 'ev-bc']);
    expect(result.nodes.inserted).toEqual(['a', 'b', 'c']);
    expect(result.edges.inserted).toEqual(['e-ab', 'e-bc']);

    expect(history.getFragment('f1')).not.toBeNull();
    expect(history.getTraversal('ev-ab')!.from).toEqual(A);
    expect(history.getTraversal('ev-bc')!.to).toEqual(C);
    expect(topology.getNode('a')!.location).toEqual({ kind: 'exact', pos: A });
    expect(topology.getNode('c')!.location).toEqual({ kind: 'exact', pos: C });
    expect(topology.getEdge('e-ab')!.evidenceIds).toEqual(['ev-ab']);
    expect(topology.getEdge('e-bc')!.evidenceIds).toEqual(['ev-bc']);
  });

  it('is idempotent: retrying the same corridor writes no duplicate traversal or edge', () => {
    const { history, topology } = pair();
    const input = {
      fragment: fragment('f1', [A, B]),
      traversals: [traversal('ev-ab', 'f1', A, B)],
      nodes: [node('a', A), node('b', B)],
      edges: [edge('e-ab', 'a', 'b', ['ev-ab'])],
      sessionId: SESSION,
    };
    expect(writeConfirmedCorridor(history, topology, input).status).toBe('written');
    const retry = writeConfirmedCorridor(history, topology, input);

    expect(retry.status).toBe('unchanged');
    expect(retry.committed).toBe('all');
    expect(retry.fragments.unchanged).toEqual(['f1']);
    expect(retry.traversals.unchanged).toEqual(['ev-ab']);
    expect(retry.edges.unchanged).toEqual(['e-ab']);
    expect(history.traversals().total).toBe(1);
    expect(topology.edges().total).toBe(1);
  });

  it('rejects a moved node that an external edge still references and changes nothing', () => {
    const { history, topology } = pair();
    expect(writeConfirmedCorridor(history, topology, {
      fragment: fragment('f1', [A, B]),
      traversals: [traversal('ev-ab', 'f1', A, B)],
      nodes: [node('a', A), node('b', B)],
      edges: [edge('e-ab', 'a', 'b', ['ev-ab'])],
      sessionId: SESSION,
    }).status).toBe('written');

    // A later corridor reaches B at a slightly different exact position. The
    // first corridor's edge still points at B, so rebasing B is refused rather
    // than silently re-pointing or deleting that edge.
    const B2 = pt(1.2, 64, 0.1);
    const C2 = pt(1.2, 64, 1.1);
    const result = writeConfirmedCorridor(history, topology, {
      fragment: fragment('f2', [B2, C2]),
      traversals: [traversal('ev-bc', 'f2', B2, C2)],
      nodes: [node('b', B2), node('c', C2)],
      edges: [edge('e-bc', 'b', 'c', ['ev-bc'])],
      sessionId: SESSION,
    });

    expect(result.status).toBe('rejected');
    expect(result.committed).toBe('none');
    expect(result.problem).toMatchObject({
      kind: 'node_referenced',
      nodeId: 'b',
      externalEdgeIds: ['e-ab'],
    });
    // No prefix: the fragment and traversal were not left behind either.
    expect(history.getFragment('f2')).toBeNull();
    expect(history.getTraversal('ev-bc')).toBeNull();
    expect(topology.getNode('b')!.location).toEqual({ kind: 'exact', pos: B });
    expect(topology.getNode('c')).toBeNull();
    expect(topology.getEdge('e-bc')).toBeNull();
    expect(topology.getEdge('e-ab')).not.toBeNull();
  });

  it('rolls back a fragment written before a conflicting traversal is detected', () => {
    const { history, topology } = pair();
    expect(writeConfirmedCorridor(history, topology, {
      fragment: fragment('f1', [A, B]),
      traversals: [traversal('ev-ab', 'f1', A, B)],
      nodes: [node('a', A), node('b', B)],
      edges: [edge('e-ab', 'a', 'b', ['ev-ab'])],
      sessionId: SESSION,
    }).status).toBe('written');

    // Same traversal id with different content: the fragment is saved first,
    // then `addTraversal` refuses. The transaction must restore the fragment
    // and leave no node/edge prefix.
    const result = writeConfirmedCorridor(history, topology, {
      fragment: fragment('f2', [A, C]),
      traversals: [traversal('ev-ab', 'f2', A, C)],
      nodes: [node('a2', A), node('c2', C)],
      edges: [edge('e-ac', 'a2', 'c2', ['ev-ab'])],
      sessionId: SESSION,
    });

    expect(result.status).toBe('rejected');
    expect(result.committed).toBe('none');
    expect(result.problem).toMatchObject({ kind: 'identity_conflict' });
    expect(history.getFragment('f2')).toBeNull();
    expect(topology.getNode('a2')).toBeNull();
    expect(topology.getEdge('e-ac')).toBeNull();
    expect(history.getFragment('f1')).not.toBeNull();
    expect(history.getTraversal('ev-ab')!.to).toEqual(B);
  });

  it('cell coordinates make repeated measurements of the same block stable', () => {
    const { history, topology } = pair();
    const first = writeConfirmedCorridor(history, topology, {
      fragment: fragment('f1', [pt(0.2, 64.1, 0.1), pt(1.7, 64.2, 0.2)]),
      traversals: [traversal('ev-1', 'f1', pt(0.2, 64.1, 0.1), pt(1.7, 64.2, 0.2))],
      nodes: [node('a', pt(0.2, 64.1, 0.1)), node('b', pt(1.7, 64.2, 0.2))],
      edges: [edge('e-ab', 'a', 'b', ['ev-1'])],
      sessionId: SESSION,
      coordinate: 'cell',
    });
    expect(first.status).toBe('written');
    expect(topology.getNode('a')!.location).toEqual({ kind: 'exact', pos: pt(0, 64, 0) });
    expect(history.getTraversal('ev-1')!.from).toEqual(pt(0, 64, 0));
    expect(canonicalCellKey(pt(0.9, 64.9, 0.9))).toBe('0,64,0');

    // Jitter inside the same cells must not count as a node move.
    const second = writeConfirmedCorridor(history, topology, {
      fragment: fragment('f2', [pt(0.8, 64.9, 0.9), pt(1.1, 64.8, 0.8)]),
      traversals: [traversal('ev-2', 'f2', pt(0.8, 64.9, 0.9), pt(1.1, 64.8, 0.8))],
      nodes: [node('a', pt(0.8, 64.9, 0.9)), node('b', pt(1.1, 64.8, 0.8))],
      edges: [edge('e-ab', 'a', 'b', ['ev-2'])],
      sessionId: SESSION,
      coordinate: 'cell',
    });

    expect(second.status).toBe('written');
    expect(second.problem).toBeUndefined();
    expect(second.nodes.updated).toEqual([]);
    expect(second.edges.updated).toEqual(['e-ab']);
    expect(topology.getEdge('e-ab')!.evidenceIds).toEqual(['ev-2']);
    expect(history.getTraversal('ev-2')!.from).toEqual(pt(0, 64, 0));
  });

  it('merges duplicate node ids that canonicalize to the same cell', () => {
    const { history, topology } = pair();
    const result = writeConfirmedCorridor(history, topology, {
      fragment: fragment('f1', [pt(0.2, 64.1, 0.1), pt(1.7, 64.2, 0.2)]),
      traversals: [traversal('ev-1', 'f1', pt(0.2, 64.1, 0.1), pt(1.7, 64.2, 0.2))],
      nodes: [
        node('a', pt(0.2, 64.1, 0.1)),
        node('b', pt(1.7, 64.2, 0.2)),
        // Same cell reached twice in one corridor: still one exact endpoint.
        node('a', pt(0.7, 64.8, 0.9)),
      ],
      edges: [edge('e-ab', 'a', 'b', ['ev-1'])],
      sessionId: SESSION,
      coordinate: 'cell',
    });

    expect(result.status).toBe('written');
    expect(result.nodes.inserted).toEqual(['a', 'b']);
    expect(topology.getNode('a')!.location).toEqual({ kind: 'exact', pos: pt(0, 64, 0) });
  });

  it('never invents traversal evidence for planned nodes or edges', () => {
    const { history, topology } = pair();
    const result = writeConfirmedCorridor(history, topology, {
      fragment: fragment('f1', [A, B]),
      traversals: [],
      nodes: [node('a', A), node('b', B)],
      edges: [],
      sessionId: SESSION,
    });

    expect(result.status).toBe('written');
    expect(result.traversals.inserted).toEqual([]);
    expect(history.traversals().total).toBe(0);
    expect(topology.edges().total).toBe(0);
  });

  it('rejects evidence from another session or dimension', () => {
    const { history, topology } = pair();
    const result = writeConfirmedCorridor(history, topology, {
      fragment: fragment('f1', [A, B]),
      traversals: [traversal('ev-ab', 'f1', A, B, { sessionId: 'other' })],
      nodes: [node('a', A), node('b', B)],
      edges: [edge('e-ab', 'a', 'b', ['ev-ab'])],
      sessionId: SESSION,
    });

    expect(result.committed).toBe('none');
    expect(result.problem).toMatchObject({ kind: 'scope_mismatch', evidenceId: 'ev-ab' });
    expect(history.getFragment('f1')).toBeNull();
    expect(topology.getNode('a')).toBeNull();
  });

  it('round-trips nodes, edges and traversal endpoints through checkpoint/restart', async () => {
    const databasePath = makeDbPath();

    const first = await openSpatialSession({ databasePath, worldId: WORLD });
    const written = writeConfirmedCorridor(first.history, first.topology, {
      fragment: fragment('f1', [A, B, C]),
      traversals: [
        traversal('ev-ab', 'f1', A, B),
        traversal('ev-bc', 'f1', B, C),
      ],
      nodes: [node('a', A), node('b', B), node('c', C)],
      edges: [edge('e-ab', 'a', 'b', ['ev-ab']), edge('e-bc', 'b', 'c', ['ev-bc'])],
      sessionId: SESSION,
    });
    expect(written.status).toBe('written');
    await first.checkpoint();
    await first.close();

    const reopened = await openSpatialSession({ databasePath, worldId: WORLD });
    try {
      expect(reopened.topology.getNode('a')!.location).toEqual({ kind: 'exact', pos: A });
      expect(reopened.topology.getNode('b')!.location).toEqual({ kind: 'exact', pos: B });
      expect(reopened.topology.getNode('c')!.location).toEqual({ kind: 'exact', pos: C });

      const ab = reopened.history.getTraversal('ev-ab')!;
      const bc = reopened.history.getTraversal('ev-bc')!;
      expect(ab.from).toEqual(A);
      expect(ab.to).toEqual(B);
      expect(bc.from).toEqual(B);
      expect(bc.to).toEqual(C);

      const edgeAb = reopened.topology.getEdge('e-ab')!;
      const edgeBc = reopened.topology.getEdge('e-bc')!;
      expect(edgeAb.from).toBe('a');
      expect(edgeAb.to).toBe('b');
      expect(edgeAb.evidenceIds).toEqual(['ev-ab']);
      expect(edgeBc.evidenceIds).toEqual(['ev-bc']);
      // Reopened history resolves; current passability was never stored as OPEN.
      expect(edgeAb.resolution).toBe('resolved');
      expect(edgeAb.runtime.forward.status).toBe('UNKNOWN');
    } finally {
      await reopened.close();
    }
  });
});
