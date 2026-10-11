import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { emptyMetrics } from '../lib/metrics.mjs';
import { ReportStore, reportAsCsv, reportAsJson } from '../lib/reports.mjs';

test('saved reports and their history survive reopening the store', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'kobolds-labs-reports-'));
  const run = {
    id: randomUUID(),
    status: 'completed',
    createdAt: '2026-10-10T20:00:00.000Z',
    endedAt: '2026-10-10T20:00:02.000Z',
    config: { mode: 'quick' },
    topic: '/kobolds-labs/test',
    reason: null,
    metrics: emptyMetrics(),
    samples: [],
    logs: [],
    messages: [],
  };
  const system = { app: 'Kobolds Labs' };

  try {
    const store = new ReportStore(directory);
    await store.initialize();
    await store.save(run, system);

    const reopened = new ReportStore(directory);
    await reopened.initialize();
    assert.equal(reopened.history.length, 1);
    assert.equal(reopened.history[0].id, run.id);
    assert.deepEqual(await reopened.read(run.id, null, system), { ...run, system });
    assert.deepEqual(await reopened.read(run.id, run, system), { ...run, system });
    await assert.rejects(reopened.read('../outside.json', null, system), /Invalid run ID/);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('exports retain CSV column order, missing values, and JSON measurement notes', () => {
  const report = {
    id: 'example',
    samples: [{ ...emptyMetrics(), elapsed: 1, sent: 5, received: 5 }],
  };
  const [header, row] = reportAsCsv(report).split('\n');
  assert.equal(
    header,
    'elapsed,sent,received,expected,pending,sentRate,receivedRate,targetRate,backpressure,errors,workerRss,brokerRss,p50Ms,p95Ms,p99Ms',
  );
  assert.equal(row, '1,5,5,0,0,0,0,0,0,0,,,,,');

  const json = JSON.parse(reportAsJson(report));
  assert.deepEqual(json.samples, report.samples);
  assert.equal(json.measurementNotes.length, 6);
  assert.match(json.measurementNotes[0], /subscriber receipts verify delivery/);
});
