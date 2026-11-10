import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { include: ['demo/voxel-atlas/src/pathfinding/*.test.ts'] },
});
