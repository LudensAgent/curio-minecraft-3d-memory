/**
 * Focused regression tests for the runner's scenario evaluation boundary. They
 * import the ACTUAL `evaluateScenario` / `hasResourceFailure` exported by
 * `run.mjs` (whose direct-entry guard keeps the orchestrator from running on
 * import) and prove that an intended assertion plus a resource/cleanup failure is
 * still FAIL, never PASS, and that the positive path rejects an unclean close.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { evaluateScenario, hasResourceFailure } from './run.mjs';

const POSITIVE = { id: 'positive', flags: [], expectExit: 0, expectStdout: 'PASS (all assertions held)' };
const PIN = { id: 'early-release-pin', flags: ['--early-release-pin'], expectExit: 1, expectStderr: 'stays pinned during the active walk' };
const SAVE = { id: 'skip-final-checkpoint', flags: ['--skip-final-checkpoint'], expectExit: 1, expectStderr: 'reopen has the unique final fact' };

function res(overrides = {}) {
  return { code: null, signal: null, error: null, stdout: '', stderr: '', ...overrides };
}

test('hasResourceFailure matches the three real closing/cleanup markers', () => {
  assert.equal(hasResourceFailure(''), false);
  assert.equal(hasResourceFailure('AssertionError: x stays pinned during the active walk'), false);
  assert.equal(hasResourceFailure('consumer acceptance: cleanup failure; preserving directory /tmp/x'), true);
  assert.equal(hasResourceFailure('consumer acceptance: unclean/unknown close; preserving directory /tmp/x'), true);
  assert.equal(hasResourceFailure('consumer acceptance: secondary close/cleanup error(s); preserving directory /tmp/x'), true);
});

test('a negative PASSes on the intended assertion alone', () => {
  const r = res({ code: 1, stderr: 'AssertionError: dependency (overworld, 0, 0, 0) stays pinned during the active walk' });
  assert.equal(evaluateScenario(PIN, r).status, 'PASS');
});

test('a negative with a cleanup failure alongside the assertion is still FAIL', () => {
  const r = res({
    code: 1,
    stderr: 'AssertionError: dependency stays pinned during the active walk\nconsumer acceptance: cleanup failure; preserving directory',
  });
  assert.equal(evaluateScenario(PIN, r).status, 'FAIL');
});

test('a negative with an unclean close alongside the assertion is still FAIL', () => {
  const r = res({
    code: 1,
    stderr: 'AssertionError: reopen has the unique final fact\nconsumer acceptance: unclean/unknown close; preserving directory',
  });
  assert.equal(evaluateScenario(SAVE, r).status, 'FAIL');
});

test('a negative failing for a non-assertion reason (startup/worker) is FAIL', () => {
  const r = res({ code: 1, stderr: 'Error: Cannot find module better-sqlite3' });
  assert.equal(evaluateScenario(PIN, r).status, 'FAIL');
});

test('a positive PASSes on exit 0 with the marker and no resource failure', () => {
  const r = res({ code: 0, stdout: 'consumer acceptance: PASS (all assertions held)\n' });
  assert.equal(evaluateScenario(POSITIVE, r).status, 'PASS');
});

test('a positive is FAIL when a cleanup failure is present', () => {
  const r = res({
    code: 0,
    stdout: 'consumer acceptance: PASS (all assertions held)\n',
    stderr: 'consumer acceptance: cleanup failure; preserving directory',
  });
  assert.equal(evaluateScenario(POSITIVE, r).status, 'FAIL');
});
