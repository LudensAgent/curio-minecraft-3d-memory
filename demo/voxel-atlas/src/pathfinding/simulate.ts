import { searchLandRoute } from '../../../../src/navigation/land-search.ts';
import { VoxelMap } from '../../../../src/voxel/voxel-map.ts';
import { blockToSection, cellIndex } from '../../../../src/voxel/coordinates.ts';
import { bitsRequired, setBit, writeCell } from '../../../../src/voxel/palette.ts';
import type { VoxelSectionSnapshot } from '../../../../src/voxel/snapshot.ts';
import type { RegionData, Vec3, ViewerCell } from '../types';
import { collisionProvider } from './collision';
import type { SimulationOptions, SimulationResult } from './types';

/** Reconstruct only the selected, actually observed cells; this never opens or writes a DB. */
export function simulateRoute(region: RegionData, options: SimulationOptions): SimulationResult {
  const startedAt = performance.now();
  if (region.cells.length > 300_000) throw new Error('寻路区域超过 300,000 个已观察格，请缩小加载区域。');
  if (!Number.isFinite(options.maxDrop) || options.maxDrop < 0 || options.maxDrop > 4) throw new Error('最大下落距离必须在 0–4 格内。');
  if (options.evidenceMode !== 'strict' && options.evidenceMode !== 'remembered') throw new Error('未知证据模式。');
  for (const point of [options.from, options.to]) {
    if (![point.x, point.y, point.z].every(Number.isFinite)) throw new Error('起终点必须是有效坐标。');
    const { minX, maxX, minY, maxY, minZ, maxZ } = region.bounds;
    if (point.x < minX || point.x > maxX || point.y < minY || point.y > maxY || point.z < minZ || point.z > maxZ) {
      throw new Error('起点和终点必须位于当前已加载区域内。');
    }
  }
  const grouped = new Map<string, { coords: ReturnType<typeof blockToSection>; cells: ViewerCell[] }>();
  let skippedCells = 0;
  for (const cell of region.cells) {
    if (!cell.snapshotEvidence) { skippedCells += 1; continue; }
    const coords = blockToSection(cell.x, cell.y, cell.z);
    const key = `${coords.cx},${coords.sy},${coords.cz}`;
    const group = grouped.get(key);
    if (group) group.cells.push(cell);
    else grouped.set(key, { coords, cells: [cell] });
  }
  if (grouped.size > 1200) throw new Error('寻路区域超过 1,200 个 Section，请缩小区域。');
  const sections: VoxelSectionSnapshot[] = [...grouped.values()].map(({ coords, cells: group }) => {
    const palette = ['minecraft:air'];
    const lookup = new Map([['minecraft:air', 0]]);
    for (const cell of group) {
      const state = cell.state === 'air' ? 'minecraft:air' : cell.state;
      if (!lookup.has(state)) { lookup.set(state, palette.length); palette.push(state); }
    }
    const bits = bitsRequired(palette.length);
    const cells = new Uint8Array(4096 * bits / 8);
    const traversed = new Uint8Array(512);
    const modified = new Uint8Array(512);
    const risk = new Uint8Array(512);
    const evidence = group.map((cell) => {
      const local = blockToSection(cell.x, cell.y, cell.z);
      const index = cellIndex(local.lx, local.ly, local.lz);
      writeCell(cells, bits, index, lookup.get(cell.state === 'air' ? 'minecraft:air' : cell.state)!);
      setBit(traversed, index, cell.traversed);
      setBit(modified, index, cell.modified);
      setBit(risk, index, cell.risk);
      return { index, evidence: { ...cell.snapshotEvidence! } };
    });
    return {
      dim: region.query.dimension, cx: coords.cx, cz: coords.cz, sy: coords.sy,
      palette, bits, cells, evidence, traversed, modified, risk,
      revision: evidence.reduce((sum, cell) => sum + cell.evidence.revision, 0),
    };
  });
  const map = new VoxelMap(region.query.worldId);
  map.restoreSnapshot({ worldId: region.query.worldId, schemaVersion: 2, sections });
  const preparationMs = performance.now() - startedAt;
  const explored: Vec3[] = [];
  const route = searchLandRoute(map, {
    worldId: region.query.worldId, dim: region.query.dimension,
    sessionId: 'voxel-atlas-offline-simulation',
    body: { feet: { x: options.from.x + 0.5, y: options.from.y, z: options.from.z + 0.5 }, width: 0.6, height: 1.8, pose: 'standing' },
    to: { x: options.to.x + 0.5, y: options.to.y, z: options.to.z + 0.5 },
    rules: { shapeProvider: collisionProvider },
    arrival: { kind: 'exact' }, goalMetric: '3d',
    evidenceMode: options.evidenceMode === 'strict' ? 'current' : 'remembered',
    allowed: ['walk', 'step', 'drop'], maxDrop: options.maxDrop,
    maxNodes: 20_000, maxEdges: 100_000, maxSurfaceReads: 400_000,
    maxSections: 1200, maxRoutePoints: 4096, maxBoundaries: 64, maxSearchMs: 1500,
    clock: () => performance.now(),
    onExpand(point) {
      if (explored.length < 6000) explored.push({ x: point.x - 0.5, y: point.y, z: point.z - 0.5 });
    },
    edgePolicy: {
      version: 'voxel-atlas-dry-land-v1',
      evaluate(edge) {
        return edge.hazards.some((hazard) => hazard.kind !== 'fall')
          ? { allow: false, reason: '此模拟仅支持陆地移动，液体移动需要独立规则。' }
          : { allow: true };
      },
    },
  });
  const path = (route.status === 'FOUND' ? route.points : route.prefix?.points ?? [])
    .map((point) => ({ x: point.x - 0.5, y: point.y, z: point.z - 0.5 }));
  return { route, path, explored, preparationMs, skippedCells, mode: options.evidenceMode };
}
