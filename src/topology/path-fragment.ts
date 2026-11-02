/**
 * Historical geometry — path fragments (design §3.1).
 *
 * Current blockage never deletes a fragment; it only splits the currently
 * passable segments and disconnects the affected navigation edges.
 */

import type { Vec3Like } from '../types.js';

export interface PathFragment {
  id: string;
  worldId: string;
  dim: string;
  kind: 'dug' | 'walked' | 'bridge' | 'built';
  /** Surface reference points; not guaranteed to be the actual opening. */
  entrances: Vec3Like[];
  /** Foot-geometry polyline; source is separated from walked evidence. */
  polyline: Vec3Like[];
  geometrySource: 'traversal' | 'observed_structure' | 'legacy';
  /** Actually-walked cell pairs — historical connectivity evidence, not a current guarantee. */
  links?: { a: Vec3Like; b: Vec3Like }[];
  deepestY: number;
  createdAt: number;
  lastUsedAt: number;
  uses: number;
}
