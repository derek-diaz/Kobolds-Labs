import { fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { BrokerMemory } from './broker-memory.mjs';
import { emptyMetrics } from './metrics.mjs';

const ACTIVE_STATUSES = new Set(['connecting', 'running', 'draining', 'stopping']);
const STARTUP_TIMEOUT_MS = 40_000;
const RUN_CLEANUP_ALLOWANCE_MS = 12_000;
const STOP_TIMEOUT_MS = 10_000;
const LOG_LIMIT = 500;
const MESSAGE_LIMIT = 100;
const SAMPLE_LIMIT = 7_200;

function appendRecent(items, value, limit) {
  items.push(value);
  if (items.length > limit) {
    items.shift();
  }
}

function sdkLogLevel(line) {
  if (/error|panic|fatal/i.test(line)) {
    return 'error';
  }
  if (/warn/i.test(line)) {
    return 'warn';
  }
  return 'debug';
}

// The HTTP server owns this controller. Native SDK work stays in child processes
// so an SDK abort cannot take down the dashboard or erase the recorded failure.
export class Lab extends EventEmitter {
  constructor({ root, directory, reports, system, redact }) {
    super();
    this.root = root;
    this.directory = directory;
    this.reports = reports;
    this.system = system;
    this.redact = redact;
    this.brokerMemory = new BrokerMemory();
    this.active = null;
    this.worker = null;
    this.stopTimer = null;
  }

  get state() {
    return { active: this.active, history: this.reports.history };
  }

  get isBusy() {
    return Boolean(this.worker) || ACTIVE_STATUSES.has(this.active?.status);
  }

  publishState() {
    this.emit('state', this.state);
  }

  log(level, text, source = 'lab', at = new Date().toISOString()) {
    if (!this.active) {
      return;
    }

    const item = {
      at,
      level,
      source,
      text: this.redact(String(text).slice(0, 4_000)),
    };
    appendRecent(this.active.logs, item, LOG_LIMIT);
    this.emit('log', item);
  }

  start(config) {
    const run = {
      id: randomUUID(),
      createdAt: new Date().toISOString(),
      endedAt: null,
      status: 'connecting',
      config,
      topic: null,
      reason: null,
      metrics: emptyMetrics(),
      samples: [],
      messages: [],
      logs: [],
    };
    this.active = run;

    const child = fork(path.join(this.root, 'runner.mjs'), [this.directory], {
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      execArgv: [],
    });
    this.worker = child;
    this.setWatchdog(child, run, STARTUP_TIMEOUT_MS, 'SDK worker stalled during startup.');
    this.log(
      'info',
      `${config.mode} test requested. ${config.publishers} publisher(s), ` +
        `${config.subscribers} subscriber(s), ${config.rate} messages/s total.`,
    );

    this.captureSdkLogs(child.stdout);
    this.captureSdkLogs(child.stderr);
    child.on('message', (message) => this.handleWorkerMessage(child, run, message));
    child.on('error', (error) => {
      this.log('error', error.message);
      this.finish('failed', error.message);
    });
    child.on('exit', (code, signal) => this.handleWorkerExit(child, run, code, signal));
    child.send({ type: 'start', id: run.id, config });
    this.publishState();

    return run;
  }

  setWatchdog(child, run, timeoutMs, reason) {
    clearTimeout(child.watchdog);
    child.watchdog = setTimeout(() => {
      if (this.worker === child && !run.endedAt) {
        child.kill('SIGKILL');
        this.finish('failed', reason, true);
      }
    }, timeoutMs);
  }

  captureSdkLogs(stream) {
    let pendingLine = '';
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => {
      pendingLine = (pendingLine + chunk).slice(-16_384);
      const lines = pendingLine.split(/\r?\n/);
      pendingLine = lines.pop();

      for (const line of lines) {
        if (line.trim()) {
          this.log(sdkLogLevel(line), line, 'sdk');
        }
      }
    });
  }

  async handleWorkerMessage(child, run, message) {
    if (this.active?.id !== run.id) {
      return;
    }

    switch (message.type) {
      case 'log':
        this.log(message.level, message.text, 'client', message.at);
        if (message.level === 'error') {
          child.failureReason ??= this.redact(message.text);
        }
        break;

      case 'status':
        run.status = message.status;
        if (message.status === 'running') {
          this.setWatchdog(
            child,
            run,
            run.config.duration * 1_000 + RUN_CLEANUP_ALLOWANCE_MS,
            'SDK worker exceeded the scheduled duration and cleanup window.',
          );
        }
        this.publishState();
        break;

      case 'details':
        run.topic = message.topic;
        run.normalizedEndpoint = message.endpoint;
        this.publishState();
        break;

      case 'message':
        appendRecent(run.messages, message.message, MESSAGE_LIMIT);
        this.emit('message', message.message);
        break;

      case 'sample': {
        const endpoint = run.normalizedEndpoint ?? run.config.endpoint;
        const brokerRss = await this.brokerMemory.read(endpoint);
        run.metrics = { ...message.sample, brokerRss };
        appendRecent(run.samples, run.metrics, SAMPLE_LIMIT);
        this.emit('sample', run.metrics);
        break;
      }

      case 'fatal':
        this.log('error', message.reason);
        await this.finish('failed', message.reason);
        break;

      case 'finished':
        run.metrics = { ...message.sample, brokerRss: run.metrics.brokerRss };
        await this.finish(message.status, message.reason, message.cleanupForced);
        break;
    }
  }

  handleWorkerExit(child, run, code, signal) {
    clearTimeout(child.watchdog);
    if (this.worker === child) {
      this.worker = null;
    }
    if (run.endedAt) {
      return;
    }

    const cause = child.failureReason ? `${child.failureReason} ` : '';
    const exit = signal ? `with ${signal}` : `with code ${code}`;
    const reason = `${cause}Test worker exited ${exit}. The dashboard is still running.`;
    this.log('error', reason);
    this.finish('failed', reason);
  }

  async finish(status, reason, cleanupForced = false) {
    const run = this.active;
    if (!run || run.endedAt) {
      return;
    }

    clearTimeout(this.stopTimer);
    this.stopTimer = null;
    clearTimeout(this.worker?.watchdog);
    run.status = status;
    run.reason = reason ?? null;
    run.cleanupForced = cleanupForced;
    run.endedAt = new Date().toISOString();
    if (status === 'failed') {
      run.metrics.errors = Math.max(1, run.metrics.errors);
    }

    try {
      await this.reports.save(run, this.system);
    } catch (error) {
      this.log('warn', `Could not save run history: ${error.message}`);
    }
    this.publishState();
  }

  stop() {
    if (!this.worker || !ACTIVE_STATUSES.has(this.active?.status)) {
      return;
    }

    this.active.status = 'stopping';
    this.worker.send({ type: 'stop' });
    clearTimeout(this.worker.watchdog);
    this.log('info', 'Stop requested. Finishing outstanding deliveries and closing test clients.');
    clearTimeout(this.stopTimer);

    const currentWorker = this.worker;
    this.stopTimer = setTimeout(() => {
      if (this.worker === currentWorker) {
        currentWorker.kill('SIGKILL');
        this.finish('stopped', 'Worker cleanup exceeded 10 seconds.', true);
      }
    }, STOP_TIMEOUT_MS);
    this.publishState();
  }

  sendOne() {
    if (!this.worker || this.active?.status !== 'running') {
      return false;
    }
    this.worker.send({ type: 'send' });
    return true;
  }
}
