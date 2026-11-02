/**
 * Persistence worker contract (design §9.2).
 *
 * One worker owns the SQLite connection and serializes load, batched writes,
 * transactions and heavier encode/decode. It never reads mineflayer, never
 * judges what the agent saw, and never controls the body. Save confirmation is
 * explicit: accepting evidence ("observed") and committing it ("saved") are two
 * distinct moments.
 *
 * Implementation (phase 5): `better-sqlite3` in a Node worker thread — its sync
 * API must not be wrapped in a Promise on the control thread.
 */

/** A bounded batch of changes the store hands to the worker for persistence. */
export interface SaveBatch {
  /** Store-assigned batch id; the worker echoes it on commit confirmation. */
  id: string;
}

/** Per-batch commit confirmation; an old confirmation never covers newer observations. */
export interface SaveConfirmation {
  batchId: string;
  committed: boolean;
}

export interface PersistenceWorker {
  /** Queue a batch; resolves only when its transaction is committed. */
  save(batch: SaveBatch): Promise<SaveConfirmation>;
  /** Wait for all queued work within a bounded time; reports unflushed range on failure. */
  flush(): Promise<void>;
  /** Stop accepting writes and close; only confirmed transactions are reported saved. */
  close(): Promise<void>;
}
