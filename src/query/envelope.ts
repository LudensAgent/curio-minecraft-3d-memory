/**
 * Result envelope construction (contract §5.3).
 *
 * Every query result carries the same scope and read-only markers. `readOnly`
 * and `executable` are literal `true`/`false`: a query never authorizes an
 * action, even when it reports current `OPEN` evidence.
 */

import { CONTRACT_VERSION } from '../memory/capabilities.js';
import type {
  SpatialQueryContext,
  SpatialQueryData,
  SpatialQueryKind,
  SpatialQueryProblem,
  SpatialQueryResult,
  SpatialQueryStatus,
} from './types.js';

export interface EnvelopeInput {
  status: SpatialQueryStatus;
  dim?: string;
  data?: SpatialQueryData;
  problem?: SpatialQueryProblem;
  total?: number;
  nextAfter?: string;
}

export function makeQueryResult(
  context: SpatialQueryContext,
  input: EnvelopeInput,
): SpatialQueryResult {
  const sessionId = context.sources.currentSessionId();
  return {
    status: input.status,
    contract: CONTRACT_VERSION,
    worldId: context.worldId,
    ...(input.dim === undefined ? {} : { dim: input.dim }),
    ...(sessionId === null ? {} : { sessionId }),
    computedAt: context.now(),
    readOnly: true,
    executable: false,
    ...(input.data === undefined ? {} : { data: input.data }),
    ...(input.problem === undefined ? {} : { problem: input.problem }),
    ...(input.total === undefined ? {} : { total: input.total }),
    ...(input.nextAfter === undefined ? {} : { nextAfter: input.nextAfter }),
  };
}

export function invalidQueryResult(
  context: SpatialQueryContext,
  detail: string,
): SpatialQueryResult {
  return makeQueryResult(context, {
    status: 'invalid_request',
    problem: { kind: 'invalid_request', detail },
  });
}

export function unsupportedQueryResult(
  context: SpatialQueryContext,
  query: SpatialQueryKind,
  detail: string,
  dim?: string,
): SpatialQueryResult {
  return makeQueryResult(context, {
    status: 'unsupported',
    ...(dim === undefined ? {} : { dim }),
    problem: { kind: 'unsupported', query, detail },
  });
}
