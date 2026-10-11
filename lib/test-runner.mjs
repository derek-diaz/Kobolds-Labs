import { randomInt } from 'node:crypto';
import { setTimeout as delay, setImmediate as yieldLoop } from 'node:timers/promises';
import { readConfig, normalizedEndpoint } from './config.mjs';
import { Metrics } from './metrics.mjs';
import { connectAuthenticated, closeFailedClientSockets } from './connection.mjs';

const REQUEST_OPTIONS = { timeout_ms: 2_000n, trace: false };
const PUBLISH_INTERVAL_MS = 20;
const SAMPLE_INTERVAL_MS = 1_000;
const RECEIPT_TIMEOUT_MS = 10_000;
const DRAIN_TIMEOUT_MS = 2_000;
const CLEANUP_TIMEOUT_MS = 6_000;
const MAX_PUBLISH_BATCH = 64;
const MAX_QUEUED_CHUNKS = 32;
const MAX_OUTSTANDING_MESSAGES = 25_000;

const TOPIC_OPTIONS = {
  retained_message_ttl_ms: 0n,
  max_message_size: 65_536,
  congestion_strategy: 0,
  ordering: 0,
  qos: 0,
  durability: 0,
  retain_last_message: false,
};

async function withTimeout(promise, timeoutMs, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs);
  });

  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

// One instance lives in one isolated worker. The parent talks to it using the
// start/stop/send messages handled by runner.mjs.
export class TestRunner {
  constructor(directory, send) {
    this.directory = directory;
    this.send = send;
    this.stopRequested = false;
    this.closing = false;
    this.fault = null;
    this.manualPublishes = 0;
    this.completed = false;
    this.publishers = [];
    this.subscribers = [];
    this.clients = [];
    this.connectionStats = { connected: 0, closed: 0, errors: 0 };
    this.phase = 'connecting';
    this.sequence = 0;
    this.tokens = 0;
    this.previousSampleAt = null;
    this.previousSent = 0;
    this.previousReceived = 0;
    this.lastPreviewAt = 0;
  }

  requestStop() {
    this.stopRequested = true;
  }

  requestPublish() {
    this.manualPublishes = Math.min(10, this.manualPublishes + 1);
  }

  log(level, text) {
    this.send({ type: 'log', level, text, at: new Date().toISOString() });
  }

  setPhase(status) {
    this.phase = status;
    this.send({ type: 'status', status });
  }

  recordFault(error, connectionError = false) {
    this.fault = error;
    this.metrics.errors++;
    if (connectionError) {
      this.connectionStats.errors++;
    }
  }

  get elapsed() {
    return this.startedAt ? (Date.now() - this.startedAt) / 1_000 : 0;
  }

  targetRate(elapsed = this.elapsed) {
    if (!this.config.ramp) {
      return this.config.rate;
    }
    const rampFraction = Math.min(1, 0.1 + (0.9 * elapsed) / this.config.ramp);
    return this.config.rate * rampFraction;
  }

  sample() {
    const now = Date.now();
    const interval = this.previousSampleAt ? (now - this.previousSampleAt) / 1_000 : 1;
    const sample = {
      ...this.metrics.snapshot(),
      elapsed: this.elapsed,
      phase: this.phase,
      targetRate: this.targetRate(),
      sentRate: (this.metrics.sent - this.previousSent) / Math.max(0.001, interval),
      receivedRate: (this.metrics.received - this.previousReceived) / Math.max(0.001, interval),
      workerRss: process.memoryUsage().rss,
      connections: { ...this.connectionStats },
      at: new Date().toISOString(),
    };
    this.previousSampleAt = now;
    this.previousSent = this.metrics.sent;
    this.previousReceived = this.metrics.received;
    this.send({ type: 'sample', sample });
    return sample;
  }

  async run({ id, config }) {
    this.id = id;
    this.config = config;
    this.metrics = new Metrics(id, config.subscribers);

    try {
      await this.loadSdk();
      await this.connectTestClients();
      if (this.stopRequested) {
        this.setPhase('stopped');
      } else {
        await this.runTraffic();
      }
    } catch (error) {
      this.fault = error;
      this.metrics.errors = Math.max(1, this.metrics.errors);
      this.log('error', error.message ?? String(error));
    } finally {
      await this.cleanup();
      this.finish();
    }
  }

  async loadSdk() {
    const settings = await readConfig(this.directory);
    this.endpoint = await normalizedEndpoint(this.config.endpoint || settings.endpoint);
    const { Client, Libkobolds } = await import('@kobolds/kobolds-ts');
    const authentication = {
      method: Libkobolds.Method[settings.method],
      algorithm: Libkobolds.Algorithm[settings.algorithm],
      ...settings.credentials,
    };
    if (authentication.algorithm === undefined) {
      throw new Error(`Unsupported authentication algorithm: ${settings.algorithm}`);
    }

    this.Client = Client;
    this.clientOptions = {
      connection_string: this.endpoint,
      authentication_config: authentication,
      chunk_pool_capacity: 1_000,
      max_connections: 1,
      control_message_encoding: Libkobolds.Encoding[settings.encoding],
    };
    this.baseClientId = randomInt(10_000, 50_000);
    this.topic = `${this.config.topicPrefix}/${this.id.slice(0, 8)}`;
    this.send({ type: 'details', topic: this.topic, endpoint: this.endpoint });
  }

  async createClient(label, index) {
    const client = new this.Client({
      ...this.clientOptions,
      client_id: BigInt(this.baseClientId + index),
    });
    const tracked = { client, label, connections: [], closed: false };
    this.clients.push(tracked);

    const createConnection = client.initializeOutboundConnection.bind(client);
    client.initializeOutboundConnection = () => {
      const connection = createConnection();
      tracked.connections.push(connection);
      this.observeConnection(connection, label);
      return connection;
    };

    await connectAuthenticated(client, { label, endpoint: this.endpoint });
    if (this.fault) {
      throw this.fault;
    }
    return tracked;
  }

  observeConnection(connection, label) {
    connection.on('auth_success', () => {
      this.connectionStats.connected++;
      this.log('info', `${label} authenticated; persistent connection ready.`);
    });
    connection.on('auth_failure', () => {
      if (!this.closing) {
        this.recordFault(new Error(`${label}: authentication failed`));
      }
    });
    connection.on('pipe_error', (error) => {
      if (!this.closing) {
        const message = error?.message ?? error ?? 'socket error';
        this.recordFault(new Error(`${label}: ${message}`), true);
      }
    });
    connection.on('pipe_close', () => {
      this.connectionStats.closed++;
      if (!this.closing && !this.stopRequested) {
        this.recordFault(new Error(`${label}: broker connection closed`));
      }
    });
  }

  async connectTestClients() {
    for (let index = 0; index < this.config.publishers; index++) {
      if (this.stopRequested) {
        break;
      }
      const tracked = await this.createClient(`Publisher ${index + 1}`, index);
      if (!this.topicOwner) {
        this.topicOwner = tracked.client;
        this.topicId = await this.topicOwner.createTopic(
          this.topic,
          TOPIC_OPTIONS,
          REQUEST_OPTIONS,
        );
        this.log('info', `Created isolated test topic ${this.topic}.`);
      }
      const id = await tracked.client.createPublisher(this.topic, REQUEST_OPTIONS);
      this.publishers.push({ tracked, id });
    }

    for (let index = 0; index < this.config.subscribers; index++) {
      if (this.stopRequested) {
        break;
      }
      const clientIndex = this.config.publishers + index;
      const tracked = await this.createClient(`Subscriber ${index + 1}`, clientIndex);
      const id = await tracked.client.createSubscriber(this.topic, REQUEST_OPTIONS);
      this.subscribers.push({ tracked, id });
      await tracked.client.subscribe(
        id,
        (_subscriber, message) => this.receiveMessage(index, message),
        REQUEST_OPTIONS,
      );
    }
  }

  receiveMessage(subscriberIndex, message) {
    try {
      const receivedBefore = this.metrics.received;
      this.metrics.receive(subscriberIndex, message.body(), process.hrtime.bigint());
      const receivedValidMessage = this.metrics.received > receivedBefore;
      const previewDue = this.metrics.received <= 3 || Date.now() - this.lastPreviewAt > 300;
      if (receivedValidMessage && previewDue) {
        this.lastPreviewAt = Date.now();
        this.send({ type: 'message', message: this.metrics.lastMessage });
      }
    } catch (error) {
      this.recordFault(error);
    }
  }

  publishOne() {
    const sequence = ++this.sequence;
    const payload = {
      run: this.id,
      seq: sequence,
      sentAt: new Date().toISOString(),
      message: this.config.message,
      pad: '',
    };
    const minimumBytes = Buffer.byteLength(JSON.stringify(payload));
    payload.pad = 'x'.repeat(Math.max(0, this.config.payloadBytes - minimumBytes));
    const body = Buffer.from(JSON.stringify(payload));
    this.metrics.recordSend(sequence, body);

    const publisher = this.publishers[(sequence - 1) % this.publishers.length];
    try {
      const canContinue = publisher.tracked.client.publish(publisher.id, body, { trace: false });
      // false means the SDK queued the message but applied backpressure.
      if (!canContinue) {
        this.metrics.backpressure++;
      }
    } catch (error) {
      this.recordFault(error);
    }
  }

  publishTick() {
    if (this.stopRequested || this.fault) {
      return;
    }
    if (this.elapsed >= this.config.duration) {
      this.completed = true;
      this.stopRequested = true;
      return;
    }

    // Token accumulation paces the total rate; publishers take turns below.
    const now = performance.now();
    const tokensEarned = ((now - this.lastPublishTick) / 1_000) * this.targetRate();
    this.tokens = Math.min(MAX_PUBLISH_BATCH, this.tokens + tokensEarned);
    this.lastPublishTick = now;

    const queuesFull = this.publishers.some((publisher) =>
      publisher.tracked.connections.some(
        (connection) => (connection.pipe.send_queue?.length ?? 0) > MAX_QUEUED_CHUNKS,
      ),
    );
    if (queuesFull || this.metrics.pending.size > MAX_OUTSTANDING_MESSAGES) {
      this.metrics.throttledTicks++;
      return;
    }

    let budget = Math.min(MAX_PUBLISH_BATCH, Math.floor(this.tokens) + this.manualPublishes);
    while (budget > 0 && !this.fault) {
      budget--;
      if (this.manualPublishes) {
        this.manualPublishes--;
      } else {
        this.tokens--;
      }
      this.publishOne();
    }
  }

  checkReceiptTimeout() {
    const noRecentReceipt =
      this.metrics.lastReceiptAt && Date.now() - this.metrics.lastReceiptAt > RECEIPT_TIMEOUT_MS;
    if (this.metrics.pending.size && noRecentReceipt) {
      this.recordFault(
        new Error('No test message received for 10 seconds while messages were outstanding.'),
      );
    }
    if (!this.metrics.received && this.metrics.sent && this.elapsed > 10) {
      this.recordFault(new Error('Subscribers received no test messages within 10 seconds.'));
    }
  }

  async runTraffic() {
    this.startedAt = Date.now();
    this.lastPublishTick = performance.now();
    this.setPhase('running');
    const subscriberLabel = this.config.subscribers > 1 ? 'subscribers' : 'subscriber';
    this.log(
      'info',
      `All clients ready. Sending to ${this.config.subscribers} ${subscriberLabel}; ` +
        'payloads are checked byte for byte.',
    );
    this.sample();
    this.sampleTimer = setInterval(() => this.sample(), SAMPLE_INTERVAL_MS);
    this.publishTimer = setInterval(() => this.publishTick(), PUBLISH_INTERVAL_MS);

    while (!this.stopRequested && !this.fault) {
      await delay(50);
      this.checkReceiptTimeout();
    }
    if (this.fault) {
      throw this.fault;
    }

    clearInterval(this.publishTimer);
    this.publishTimer = null;
    this.setPhase('draining');
    this.log('info', 'Sending finished. Allowing up to 2 seconds for outstanding deliveries.');
    const drainDeadline = Date.now() + DRAIN_TIMEOUT_MS;
    while (this.metrics.pending.size && Date.now() < drainDeadline && !this.fault) {
      await delay(20);
    }
    if (this.fault) {
      throw this.fault;
    }
  }

  async removeTestEntities() {
    for (const subscriber of this.subscribers) {
      const client = subscriber.tracked.client;
      await withTimeout(client.unsubscribe(subscriber.id, REQUEST_OPTIONS), 2_200, 'unsubscribe');
      await withTimeout(
        client.destroySubscriber(subscriber.id, REQUEST_OPTIONS),
        2_200,
        'subscriber cleanup',
      );
    }
    for (const publisher of this.publishers) {
      await withTimeout(
        publisher.tracked.client.destroyPublisher(publisher.id, REQUEST_OPTIONS),
        2_200,
        'publisher cleanup',
      );
    }
    if (this.topicOwner && this.topicId !== undefined) {
      await withTimeout(
        this.topicOwner.destroyTopic(this.topicId, REQUEST_OPTIONS),
        2_200,
        'test topic cleanup',
      );
    }

    await yieldLoop();
    for (const tracked of this.clients) {
      await withTimeout(tracked.client.drain(), 500, `${tracked.label} drain`).catch((error) =>
        this.log('warn', error.message),
      );
    }
  }

  closeClients() {
    if (this.fault) {
      closeFailedClientSockets(this.clients);
      if (this.clients.length) {
        this.log(
          'warn',
          'Closed failed test sockets. Native resources will be released when the isolated worker exits.',
        );
      }
      return;
    }

    for (const tracked of this.clients) {
      if (tracked.closed) {
        continue;
      }
      tracked.closed = true;
      try {
        tracked.client.close();
      } catch (error) {
        this.log('warn', `${tracked.label} cleanup: ${error.message}`);
      }
    }
  }

  async cleanup() {
    clearInterval(this.publishTimer);
    clearInterval(this.sampleTimer);
    this.closing = true;

    const forceExit = setTimeout(() => {
      this.log('warn', 'SDK cleanup exceeded 6 seconds; isolated worker will exit.');
      this.send({
        type: 'finished',
        status: this.finalStatus,
        reason: this.fault?.message ?? null,
        sample: this.sample(),
        cleanupForced: true,
      });
      this.scheduleExit();
    }, CLEANUP_TIMEOUT_MS);

    try {
      if (!this.fault) {
        await this.removeTestEntities();
      }
      this.closeClients();
    } catch (error) {
      this.log('warn', `SDK cleanup: ${error.message}`);
    } finally {
      clearTimeout(forceExit);
    }
  }

  get finalStatus() {
    if (this.fault) {
      return 'failed';
    }
    return this.completed ? 'completed' : 'stopped';
  }

  finish() {
    const status = this.finalStatus;
    this.setPhase(status);
    const sample = this.sample();
    const expectedReceipts = this.metrics.sent * this.config.subscribers;
    this.log(
      this.fault ? 'error' : 'info',
      `${this.metrics.sent} messages sent; ${this.metrics.received}/${expectedReceipts} valid ` +
        `receipts; ${sample.pending} unreceived after drain.`,
    );
    this.send({
      type: 'finished',
      status,
      reason: this.fault?.message ?? null,
      sample,
      cleanupForced: Boolean(this.fault) && this.clients.length > 0,
    });
    this.scheduleExit();
  }

  scheduleExit() {
    setTimeout(() => process.exit(this.fault ? 1 : 0), 50);
  }
}
