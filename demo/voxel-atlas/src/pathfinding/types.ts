import type { LandSearchResult } from '../../../../src/navigation/land-search.ts';
import type { RegionData, Vec3 } from '../types';

export type SimulationOptions = {
  /** UI block-column coordinates: integer X/Z denotes that block's centre. */
  from: Vec3;
  to: Vec3;
  evidenceMode: 'strict' | 'remembered';
  maxDrop: number;
};

export type SimulationResult = {
  /** Original library result, using continuous feet coordinates. */
  route: LandSearchResult;
  /** Display coordinates, with 0.5 subtracted from continuous X/Z. */
  path: Vec3[];
  /** First 6000 actual expansion events, in display coordinates and search order. */
  explored: Vec3[];
  preparationMs: number;
  skippedCells: number;
  mode: SimulationOptions['evidenceMode'];
};

export type SimulationRequest = { region: RegionData; options: SimulationOptions };
export type SimulationReply = { ok: true; result: SimulationResult } | { ok: false; error: string };
