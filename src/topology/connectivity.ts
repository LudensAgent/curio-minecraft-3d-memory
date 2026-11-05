/**
 * Fragment connectivity (design §5 "碎片合并与拆分").
 *
 * Union-Find is used only for static connected components. The components are
 * built from *actual* links and evidence-backed endpoints — never from proximity
 * or a shared coordinate. A blocked edge splits the current passable segments
 * but never deletes the historical fragment.
 */

import type { PathFragment, TraversalEvidence } from './path-fragment.js';
import type { Vec3Like } from '../types.js';

export interface ConnectivityLink {
  a: Vec3Like;
  b: Vec3Like;
}

export interface FragmentMerge {
  a: string;
  b: string;
}

export interface FragmentPiece {
  points: number;
  records: number;
  fragmentIds: string[];
}

export interface FragmentationResult {
  records: number;
  points: number;
  components: number;
  pieces: FragmentPiece[];
}

export interface FragmentConnectivityInput {
  fragments: PathFragment[];
  /** Actual cell pairs: fragment `links` plus traversal evidence endpoints. */
  links: ConnectivityLink[];
  /** Fragment pairs explicitly merged by evidence. */
  merges: FragmentMerge[];
}

/** Stable point identity for union-find (exact coordinates; no proximity matching). */
export function pointKey(p: Vec3Like): string {
  return `${p.x},${p.y},${p.z}`;
}

/** All geometry points of one fragment (polyline + entrance reference points). */
export function fragmentPointKeys(fragment: PathFragment): Set<string> {
  const keys = new Set<string>();
  for (const p of fragment.polyline) keys.add(pointKey(p));
  for (const p of fragment.entrances) keys.add(pointKey(p));
  return keys;
}

/**
 * Whether a concrete traversal record actually connects two fragments: one of
 * its endpoints belongs to `a` and the other to `b` (either order). Proximity
 * does not count.
 */
export function traversalConnectsFragments(
  evidence: TraversalEvidence,
  a: PathFragment,
  b: PathFragment,
): boolean {
  const aKeys = fragmentPointKeys(a);
  const bKeys = fragmentPointKeys(b);
  const from = pointKey(evidence.from);
  const to = pointKey(evidence.to);
  return (
    (aKeys.has(from) && bKeys.has(to)) || (aKeys.has(to) && bKeys.has(from))
  );
}

/**
 * Compute connected pieces over actual links. `points` counts distinct geometry
 * coordinates, `records` counts fragments with at least one point in the piece
 * (a fragment can span pieces when it has no links between its own points).
 */
export function computeFragmentation(input: FragmentConnectivityInput): FragmentationResult {
  const parent = new Map<string, string>();
  const find = (key: string): string => {
    let root = key;
    while (parent.get(root) !== root) {
      const next = parent.get(root);
      if (next === undefined) {
        parent.set(root, root);
        return root;
      }
      root = next;
    }
    let cursor = key;
    while (cursor !== root) {
      const next = parent.get(cursor)!;
      parent.set(cursor, root);
      cursor = next;
    }
    return root;
  };
  const union = (a: string, b: string): void => {
    if (!parent.has(a)) parent.set(a, a);
    if (!parent.has(b)) parent.set(b, b);
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(rb, ra);
  };

  const fragmentPoints = input.fragments.map((fragment) => ({
    fragment,
    keys: fragmentPointKeys(fragment),
  }));
  for (const { fragment, keys } of fragmentPoints) {
    for (const key of keys) parent.set(key, parent.get(key) ?? key);
    for (const link of fragment.links ?? []) union(pointKey(link.a), pointKey(link.b));
  }
  for (const link of input.links) union(pointKey(link.a), pointKey(link.b));

  // A merge is only a union of representative points; it never invents links
  // between unrelated coordinates.
  const byId = new Map(fragmentPoints.map((entry) => [entry.fragment.id, entry]));
  for (const merge of input.merges) {
    const a = byId.get(merge.a);
    const b = byId.get(merge.b);
    const aKey = firstKey(a?.keys);
    const bKey = firstKey(b?.keys);
    if (aKey !== null && bKey !== null) union(aKey, bKey);
  }

  const componentOf = new Map<string, string>();
  for (const key of parent.keys()) componentOf.set(key, find(key));
  const componentIds = new Map<string, number>();
  const pieces = new Map<number, { keys: Set<string>; fragmentIds: Set<string> }>();
  const pieceFor = (component: string): { keys: Set<string>; fragmentIds: Set<string> } => {
    let id = componentIds.get(component);
    if (id === undefined) {
      id = componentIds.size;
      componentIds.set(component, id);
    }
    let piece = pieces.get(id);
    if (piece === undefined) {
      piece = { keys: new Set(), fragmentIds: new Set() };
      pieces.set(id, piece);
    }
    return piece;
  };

  for (const [key, component] of componentOf) pieceFor(component).keys.add(key);
  for (const { fragment, keys } of fragmentPoints) {
    if (keys.size === 0) {
      // A point-less legacy record still counts as one record in its own piece.
      const piece = pieceFor(`record:${fragment.id}`);
      piece.fragmentIds.add(fragment.id);
      continue;
    }
    const touched = new Set<string>();
    for (const key of keys) touched.add(componentOf.get(key)!);
    for (const component of touched) pieceFor(component).fragmentIds.add(fragment.id);
  }

  const ordered = [...pieces.values()].map((piece) => ({
    points: piece.keys.size,
    records: piece.fragmentIds.size,
    fragmentIds: [...piece.fragmentIds].sort(),
  }));
  return {
    records: input.fragments.length,
    points: componentOf.size,
    components: ordered.length,
    pieces: ordered,
  };
}

function firstKey(keys: Set<string> | undefined): string | null {
  if (keys === undefined) return null;
  for (const key of keys) return key;
  return null;
}

/** One current-passable run of a fragment polyline. Boundaries are cut points. */
export interface FragmentSegment {
  startIndex: number;
  endIndex: number;
  points: Vec3Like[];
}

export interface FragmentSegmentsView {
  fragmentId: string;
  segments: FragmentSegment[];
  /** Blocked edges that produced cuts. */
  blockedEdgeIds: string[];
  /** Cut coordinates actually present on the polyline. */
  cuts: Vec3Like[];
  totalPoints: number;
}

/** Split a polyline at exact cut coordinates; the cut point itself is omitted. */
export function splitPolyline(polyline: Vec3Like[], cuts: Vec3Like[]): FragmentSegment[] {
  const cutKeys = new Set(cuts.map(pointKey));
  const segments: FragmentSegment[] = [];
  let run: { index: number; point: Vec3Like }[] = [];
  const flush = (): void => {
    if (run.length === 0) return;
    segments.push({
      startIndex: run[0]!.index,
      endIndex: run[run.length - 1]!.index,
      points: run.map((entry) => ({ x: entry.point.x, y: entry.point.y, z: entry.point.z })),
    });
    run = [];
  };
  for (let i = 0; i < polyline.length; i++) {
    const point = polyline[i]!;
    if (cutKeys.has(pointKey(point))) {
      flush();
      continue;
    }
    run.push({ index: i, point });
  }
  flush();
  return segments;
}
