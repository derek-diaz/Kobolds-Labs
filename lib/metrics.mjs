import { createHash } from 'node:crypto';

const DUPLICATE_WINDOW = 50_000;
const LATENCY_WINDOW = 10_000;
const PREVIEW_CHARACTERS = 700;

function bodyDigest(body) {
  return createHash('sha256').update(body).digest('hex');
}

export function emptyMetrics() {
  return {
    sent: 0,
    received: 0,
    expected: 0,
    pending: 0,
    deliveryPercent: null,
    duplicates: 0,
    invalid: 0,
    errors: 0,
    backpressure: 0,
    throttledTicks: 0,
    elapsed: 0,
    sentRate: 0,
    receivedRate: 0,
    targetRate: 0,
    workerRss: null,
    brokerRss: null,
    latency: { p50: null, p95: null, p99: null, average: null, window: 0 },
    connections: { connected: 0, closed: 0, errors: 0 },
  };
}

export class Metrics {
  constructor(runId, subscribers) {
    this.runId = runId;
    this.subscribers = subscribers;
    this.sent = 0;
    this.received = 0;
    this.duplicates = 0;
    this.invalid = 0;
    this.backpressure = 0;
    this.errors = 0;
    this.throttledTicks = 0;

    this.pending = new Map();
    this.recentReceipts = new Map();
    this.latencies = [];
    this.latencyIndex = 0;
    this.latencySum = 0;
    this.latencyCount = 0;
    this.lastMessage = null;
    this.lastReceiptAt = null;
  }

  recordSend(sequence, body, now = process.hrtime.bigint()) {
    this.sent++;
    this.pending.set(sequence, { now, digest: bodyDigest(body), seen: new Set() });
  }

  receive(subscriber, body, now = process.hrtime.bigint()) {
    let payload;
    try {
      payload = JSON.parse(Buffer.from(body).toString('utf8'));
    } catch {
      this.invalid++;
      return;
    }
    if (payload.run !== this.runId || !Number.isSafeInteger(payload.seq)) {
      this.invalid++;
      return;
    }

    const receiptKey = `${subscriber}:${payload.seq}`;
    if (this.recentReceipts.has(receiptKey)) {
      this.duplicates++;
      return;
    }
    const pending = this.pending.get(payload.seq);
    if (!pending || bodyDigest(body) !== pending.digest) {
      this.invalid++;
      return;
    }

    this.recentReceipts.set(receiptKey, true);
    if (this.recentReceipts.size > DUPLICATE_WINDOW) {
      this.recentReceipts.delete(this.recentReceipts.keys().next().value);
    }
    pending.seen.add(subscriber);
    this.received++;
    this.lastReceiptAt = Date.now();

    const latency = Number(now - pending.now) / 1e6;
    this.recordLatency(latency);
    // Keep the send until every subscriber has supplied a valid receipt.
    if (pending.seen.size === this.subscribers) {
      this.pending.delete(payload.seq);
    }
    this.lastMessage = {
      sequence: payload.seq,
      subscriber: subscriber + 1,
      latency,
      bytes: body.length,
      receivedAt: new Date().toISOString(),
      preview: Buffer.from(body).toString('utf8').slice(0, PREVIEW_CHARACTERS),
    };
  }

  recordLatency(latency) {
    this.latencySum += latency;
    this.latencyCount++;
    if (this.latencies.length < LATENCY_WINDOW) {
      this.latencies.push(latency);
    } else {
      this.latencies[this.latencyIndex] = latency;
      this.latencyIndex = (this.latencyIndex + 1) % LATENCY_WINDOW;
    }
  }

  snapshot() {
    const sortedLatencies = [...this.latencies].sort((a, b) => a - b);
    const percentile = (fraction) => {
      if (!sortedLatencies.length) {
        return null;
      }
      const index = Math.max(0, Math.ceil(sortedLatencies.length * fraction) - 1);
      return sortedLatencies[index];
    };
    const expected = this.sent * this.subscribers;

    return {
      sent: this.sent,
      received: this.received,
      expected,
      pending: Math.max(0, expected - this.received),
      deliveryPercent: expected ? Math.min(100, (this.received / expected) * 100) : null,
      duplicates: this.duplicates,
      invalid: this.invalid,
      backpressure: this.backpressure,
      errors: this.errors,
      throttledTicks: this.throttledTicks,
      outstandingMessages: this.pending.size,
      latency: {
        p50: percentile(0.5),
        p95: percentile(0.95),
        p99: percentile(0.99),
        average: this.latencyCount ? this.latencySum / this.latencyCount : null,
        window: sortedLatencies.length,
      },
      lastMessage: this.lastMessage,
    };
  }
}
