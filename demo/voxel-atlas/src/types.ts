import type { RegionLimitPreset } from './region-limits';

export type Vec3 = { x: number; y: number; z: number };
export type Bounds = { minX: number; maxX: number; minY: number; maxY: number; minZ: number; maxZ: number };
export type ViewerCell = {
  x: number;
  y: number;
  z: number;
  state: string;
  observedAt: number;
  source: string;
  evidence: string;
  stateComplete: boolean;
  freshness: string;
  staleReason?: string;
  sessionId: string;
  traversed: boolean;
  modified: boolean;
  risk: boolean;
  snapshotEvidence?: import('../../../src/voxel/snapshot.ts').VoxelCellEvidenceSnapshot;
};
export type FactMarker = {
  id: string;
  type: 'resource' | 'container' | 'portal' | 'place';
  kind: string;
  label: string;
  worldId: string;
  dimension: string;
  pos: Vec3;
  locationKind: 'exact' | 'area';
  radius?: number;
  observedAt: number;
  source: string;
  gone: boolean;
  data: Record<string, unknown>;
};
export type ChunkTile = { cx: number; cz: number; sections: number; observedCells: number };
export type ScopeSummary = {
  worldId: string;
  dimension: string;
  sections: number;
  observedCells: number;
  bounds: Bounds;
  suggestedCenter: Vec3;
  chunks: ChunkTile[];
};
export type DatabaseSummary = { fileName: string; fileBytes: number; schemaVersion: number; scopes: ScopeSummary[] };
export type RegionQuery = { worldId: string; dimension: string; bounds: Bounds; limitPreset?: RegionLimitPreset };
export type RegionData = {
  query: RegionQuery;
  bounds: Bounds;
  cells: ViewerCell[];
  markers: FactMarker[];
  stats: {
    sections: number;
    observedCells: number;
    airCells: number;
    solidCells: number;
    staleCells: number;
    latestObservedAt: number | null;
  };
};
export type ViewerSelection = { type: 'cell'; cell: ViewerCell } | { type: 'fact'; fact: FactMarker } | null;
