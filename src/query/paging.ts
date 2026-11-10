/**
 * Bounded paging for list queries (contract §5.6).
 *
 * The facts store applies filters and cursor paging itself; the query layer
 * only resolves the requested page size and carries the source's `nextAfter`.
 * It never loads all records, sorts them, and slices.
 */

export const DEFAULT_QUERY_LIMIT = 100;
export const MAX_QUERY_LIMIT = 1000;

export interface QueryPage<T> {
  items: T[];
  total: number;
  nextAfter?: string;
}

export function resolveLimit(limit: number | undefined): number {
  return limit ?? DEFAULT_QUERY_LIMIT;
}
