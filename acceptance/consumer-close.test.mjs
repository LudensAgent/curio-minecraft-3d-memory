/**
 * Focused fault verification for the shared consumer close path
 * (`closeSession` / `finalizeResources` exported from `consumer.mjs`). Each case
 * injects a close/cleanup collaborator and asserts the final resource verdict:
 * a returned incomplete close, a thrown close, a cleanup-only failure, and an
 * existing primary plus a secondary close/cleanup failure must all yield a
 * non-zero exit and no "PASS", while retaining the original primary when present.
 * A clean-but-dirty close must NOT be treated as a shutdown failure.
 */

import { test } from 'node:test';
import { strict as assert } from 'node:assert';

import { finalizeResources } from './consumer.mjs';

function captureConsole() {
  const logs = [];
  const errors = [];
  const origLog = console.log;
  const origError = console.error;
  console.log = (...args) => logs.push(args.map(String).join(' '));
  console.error = (...args) => errors.push(args.map(String).join(' '));
  return {
    logs,
    errors,
    restore() {
      console.log = origLog;
      console.error = origError;
    },
  };
}

function cleanClose(extra = {}) {
  return { completed: true, unconfirmedRequest: false, dirty: false, error: null, ...extra };
}

async function run(sessions, { primaryError = null, cleanup = () => {} } = {}) {
  const cap = captureConsole();
  let code;
  try {
    code = await finalizeResources({ sessions, closeRecords: new Map(), primaryError, dir: 'C:\\tmp\\consumer-acceptance-fault', cleanup });
  } finally {
    cap.restore();
  }
  return { code, ...cap };
}

test('clean close with dirty=true is not a shutdown failure', async () => {
  const sessions = [{ async close() { return cleanClose({ dirty: true }); } }];
  const { code, logs } = await run(sessions);
  assert.equal(code, 0, 'dirty-but-clean close exits 0');
  assert.ok(logs.some((l) => l.includes('PASS')), 'PASS is printed after clean resource handling');
});

test('returned incomplete close yields non-zero and no PASS', async () => {
  const sessions = [{ async close() { return cleanClose({ completed: false }); } }];
  const { code, logs } = await run(sessions);
  assert.equal(code, 1);
  assert.ok(!logs.some((l) => l.includes('PASS')), 'no PASS on unclean close');
});

test('thrown close yields non-zero and no PASS', async () => {
  const sessions = [{ async close() { throw new Error('injected close throw'); } }];
  const { code, logs, errors } = await run(sessions);
  assert.equal(code, 1);
  assert.ok(!logs.some((l) => l.includes('PASS')));
  assert.ok(errors.some((e) => e.includes('injected close throw')), 'close error is diagnosed');
});

test('cleanup-only failure yields non-zero and no PASS', async () => {
  const sessions = [{ async close() { return cleanClose(); } }];
  const { code, logs, errors } = await run(sessions, { cleanup: () => { throw new Error('injected cleanup fault'); } });
  assert.equal(code, 1);
  assert.ok(!logs.some((l) => l.includes('PASS')));
  assert.ok(errors.some((e) => e.includes('injected cleanup fault')), 'cleanup error is diagnosed');
});

test('primary plus secondary close failure retains the primary', async () => {
  const primary = new Error('primary assertion failure');
  const sessions = [{ async close() { throw new Error('secondary close failure'); } }];
  const { code, logs, errors } = await run(sessions, { primaryError: primary });
  assert.equal(code, 1);
  assert.ok(!logs.some((l) => l.includes('PASS')));
  assert.ok(errors.some((e) => e.includes('primary assertion failure')), 'primary is retained');
  assert.ok(errors.some((e) => e.includes('secondary close failure')), 'secondary is also diagnosed');
});
