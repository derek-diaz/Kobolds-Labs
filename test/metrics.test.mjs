import test from 'node:test';
import assert from 'node:assert/strict';
import { Metrics } from '../lib/metrics.mjs';

test('fan-out requires one valid receipt from every subscriber', () => {
  const metrics = new Metrics('test', 2);
  const body = Buffer.from('{"run":"test","seq":1,"text":"original"}');

  metrics.recordSend(1, body, 1_000_000n);
  metrics.receive(0, body, 3_000_000n);
  assert.equal(metrics.snapshot().pending, 1);
  assert.equal(metrics.snapshot().deliveryPercent, 50);

  metrics.receive(1, body, 4_000_000n);
  assert.equal(metrics.snapshot().pending, 0);
  assert.equal(metrics.snapshot().deliveryPercent, 100);
  assert.equal(metrics.snapshot().latency.p95, 3);
});
test('duplicates and altered bodies cannot inflate delivery success', () => {
  const metrics = new Metrics('test', 1);
  const body = Buffer.from('{"run":"test","seq":1,"text":"original"}');

  metrics.recordSend(1, body, 0n);
  metrics.receive(0, Buffer.from('{"run":"test","seq":1,"text":"altered"}'), 1_000_000n);
  assert.equal(metrics.invalid, 1);
  assert.equal(metrics.received, 0);

  metrics.receive(0, body, 2_000_000n);
  metrics.receive(0, body, 3_000_000n);
  assert.equal(metrics.received, 1);
  assert.equal(metrics.duplicates, 1);
});
