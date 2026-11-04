/**
 * Type-level consumer acceptance. Run by `run.mjs` with `tsc --noEmit` from the
 * consumer directory, so every import resolves through the installed package's
 * `dist/*.d.ts` (the `exports` `types` conditions), never the source tree. It
 * only needs to compile — nothing is executed.
 */

import { RouteVerifier, VoxelMap, WalkRouteExecutor } from 'curio-minecraft-3d-memory';
import { openSpatialSession, WorkingSetManager } from 'curio-minecraft-3d-memory/storage/sqlite';
import type {
  BlockState,
  BodyContext,
  CollisionShapeProvider,
  MoveExecutor,
  SectionKey,
  Vec3Like,
} from 'curio-minecraft-3d-memory';
import type {
  OpenSpatialSessionOptions,
  PrepareResult,
  SpatialCheckpointResult,
  SpatialSession,
} from 'curio-minecraft-3d-memory/storage/sqlite';

export function makeKey(): SectionKey {
  return { worldId: 'world', dim: 'overworld', cx: 0, cz: 0, sy: 0 };
}

export function makeState(): BlockState {
  return { name: 'minecraft:stone', properties: {} };
}

export function makePos(): Vec3Like {
  return { x: 0.5, y: 0, z: 0.5 };
}

export const sessionOptions: OpenSpatialSessionOptions = {
  databasePath: '/tmp/consumer.db',
  worldId: 'world',
};

export async function useSession(s: SpatialSession): Promise<string> {
  const cp: SpatialCheckpointResult = await s.checkpoint();
  return cp.checkpointId;
}

export function makeManager(s: SpatialSession): WorkingSetManager {
  return new WorkingSetManager(s);
}

export async function prepare(manager: WorkingSetManager, key: SectionKey): Promise<PrepareResult> {
  return manager.prepare([key]);
}

export function makeVerifier(map: VoxelMap): RouteVerifier {
  return new RouteVerifier(map, { now: () => 0 });
}

export function makeExecutor(map: VoxelMap, move: MoveExecutor): WalkRouteExecutor {
  return new WalkRouteExecutor(map, move, { now: () => 0 });
}

export const provider: CollisionShapeProvider = {
  version: 'types-1',
  resolve(state: BlockState) {
    if (state.name === 'minecraft:air') return { kind: 'shape', shape: { boxes: [], supportFaces: [] } };
    return {
      kind: 'shape',
      shape: {
        boxes: [{ minX: 0, minY: 0, minZ: 0, maxX: 1, maxY: 1, maxZ: 1 }],
        supportFaces: [{ top: 1, minX: 0, minZ: 0, maxX: 1, maxZ: 1 }],
      },
    };
  },
};

export const body: BodyContext = {
  feet: { x: 0.5, y: 0, z: 0.5 },
  width: 0.6,
  height: 1.8,
  pose: 'standing',
};

// `openSpatialSession` is a value export from the SQLite subpath: assert its type.
export const opener: (options: OpenSpatialSessionOptions) => Promise<SpatialSession> = openSpatialSession;

export {};
