import type { DatabaseSummary, RegionData, RegionQuery } from '../types';
import type { ReaderErrorCode } from './errors';

export type WorkerRequest =
  | { type: 'open'; id: number; file: File }
  | { type: 'loadRegion'; id: number; query: RegionQuery }
  | { type: 'clear'; id: number }
  | { type: 'dispose' };

export type WorkerResponse =
  | { type: 'progress'; id: number; stage: string; progress?: number }
  | { type: 'opened'; id: number; summary: DatabaseSummary }
  | { type: 'region'; id: number; data: RegionData }
  | { type: 'cleared'; id: number }
  | { type: 'error'; id: number; code: ReaderErrorCode; message: string };
