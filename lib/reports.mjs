import * as fs from 'node:fs/promises';
import path from 'node:path';

const HISTORY_LIMIT = 30;
const CSV_COLUMNS = [
  'elapsed',
  'sent',
  'received',
  'expected',
  'pending',
  'sentRate',
  'receivedRate',
  'targetRate',
  'backpressure',
  'errors',
  'workerRss',
  'brokerRss',
];

const MEASUREMENT_NOTES = [
  'Sent means queued by the SDK; subscriber receipts verify delivery and SHA-256 body equality.',
  'End-to-end latency measures publish submission to subscriber callback in the same test worker.',
  'Percentiles use the most recent 10000 valid receipts. Duplicate detection retains 50000 subscriber/sequence keys.',
  'Pending during a run becomes unreceived at the end of the 2-second drain window; it is not proof of permanent loss.',
  'Memory is separated into test-worker RSS and discovered local broker RSS. UI payloads are sampled.',
  'Time-series samples retain the latest 7200 seconds; logs retain 500 entries; payload previews retain 100 entries.',
];

function summarizeRun(run) {
  return {
    id: run.id,
    status: run.status,
    createdAt: run.createdAt,
    endedAt: run.endedAt,
    config: run.config,
    topic: run.topic,
    reason: run.reason,
    metrics: run.metrics,
  };
}

export class ReportStore {
  constructor(directory) {
    this.directory = directory;
    this.history = [];
  }

  async initialize() {
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });

    try {
      const contents = await fs.readFile(this.historyPath, 'utf8');
      this.history = JSON.parse(contents).slice(0, HISTORY_LIMIT);
    } catch {
      // A fresh installation has no history. A bad history file must not block startup.
      this.history = [];
    }
  }

  get historyPath() {
    return path.join(this.directory, 'history.json');
  }

  async save(run, system) {
    this.history.unshift(summarizeRun(run));
    this.history = this.history.slice(0, HISTORY_LIMIT);

    await fs.writeFile(
      path.join(this.directory, `${run.id}.json`),
      JSON.stringify({ ...run, system }, null, 2),
      { mode: 0o600 },
    );
    await fs.writeFile(this.historyPath, JSON.stringify(this.history.map(summarizeRun)), {
      mode: 0o600,
    });
  }

  async read(id, activeRun, system) {
    if (activeRun?.id === id) {
      return { ...activeRun, system };
    }

    if (!/^[0-9a-f-]{36}$/.test(id)) {
      throw new Error('Invalid run ID.');
    }

    const contents = await fs.readFile(path.join(this.directory, `${id}.json`), 'utf8');
    return JSON.parse(contents);
  }
}

export function reportAsCsv(report) {
  const header = [...CSV_COLUMNS, 'p50Ms', 'p95Ms', 'p99Ms'].join(',');
  const rows = report.samples.map((sample) => {
    const values = CSV_COLUMNS.map((column) => sample[column] ?? '');
    values.push(sample.latency.p50 ?? '', sample.latency.p95 ?? '', sample.latency.p99 ?? '');
    return values.join(',');
  });

  return [header, ...rows].join('\n');
}

export function reportAsJson(report) {
  return JSON.stringify({ ...report, measurementNotes: MEASUREMENT_NOTES }, null, 2);
}
