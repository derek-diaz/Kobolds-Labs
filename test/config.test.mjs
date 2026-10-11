import test from 'node:test';
import assert from 'node:assert/strict';
import { validateRun, scalar } from '../lib/config.mjs';

test('requests reject unsafe or incoherent load parameters', () => {
  assert.throws(() => validateRun({ rate: 100_000 }), /rate/);
  assert.throws(() => validateRun({ duration: 1, ramp: 2 }), /ramp/);
  assert.throws(() => validateRun({ payloadBytes: 65_536 }), /payloadBytes/);
  assert.throws(() => validateRun({ subscribers: 0 }), /subscribers/);
  assert.equal(validateRun({ mode: 'stress' }).ramp, 20);
});

test('quoted config secrets preserve literal values without printing them', () => {
  assert.equal(scalar('"a#b" # comment'), 'a#b');
  assert.equal(scalar("'a''b'"), "a'b");
  assert.equal(scalar('unquoted # comment'), 'unquoted');
});
