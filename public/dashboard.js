import {
  element,
  escapeHtml,
  formatBytes,
  formatDuration,
  formatMilliseconds,
  formatNumber,
  formatTime,
} from './format.js';
import { renderChart } from './charts.js';

export const LIVE_STATUSES = new Set(['connecting', 'running', 'draining', 'stopping']);
const STATUS_LABELS = {
  connecting: 'Connecting',
  running: 'Test running',
  draining: 'Draining',
  stopping: 'Stopping',
  completed: 'Completed',
  stopped: 'Stopped',
  failed: 'Test failed',
};

function payloadPreview(message) {
  try {
    const payload = JSON.parse(message.preview);
    if (payload.pad) {
      payload.pad = `${payload.pad.slice(0, 35)}… (${payload.pad.length} padding characters)`;
    }
    return JSON.stringify(payload, null, 2);
  } catch {
    return `${message.preview}\n… preview truncated`;
  }
}

function matchesLogFilter(item, filter) {
  switch (filter) {
    case 'all':
      return true;
    case 'error':
      return item.level === 'error';
    case 'issues':
      return ['warn', 'error'].includes(item.level);
    default:
      return false;
  }
}

function connectionLabel(run, metrics) {
  if (run?.endedAt) {
    return 'Test clients closed';
  }
  if (metrics.connections?.connected) {
    return `${metrics.connections.connected} authenticated clients`;
  }
  return run ? 'Opening test clients' : 'No test connections';
}

export class Dashboard {
  constructor(state) {
    this.state = state;
  }

  render() {
    this.renderControls();
    this.renderMetrics();
    this.renderMessages();
    this.renderLogs();
    this.renderHistory();
  }

  renderControls() {
    const { activeRun, setupError } = this.state;
    const busy = LIVE_STATUSES.has(activeRun?.status);
    element('run-state').textContent = STATUS_LABELS[activeRun?.status] ?? 'Ready to test';
    element('run-state').className = `status-pill ${activeRun?.status ?? ''}`;
    element('start-button').disabled = busy || Boolean(setupError);
    element('start-button').textContent = busy ? 'Test in progress' : 'Start test';
    element('stop-button').disabled = !busy || activeRun?.status === 'stopping';
    element('send-button').disabled = activeRun?.status !== 'running';
    for (const field of document.querySelectorAll('#test-form input, .profile')) {
      field.disabled = busy;
    }
    element('export-json').disabled = !activeRun;
    element('export-csv').disabled = !activeRun;

    const running = activeRun?.status === 'running';
    const chartLabel = running ? 'LIVE' : activeRun?.endedAt ? 'RECORDED' : 'WAITING';
    element('chart-live').className = `live-label ${running ? 'running' : ''}`;
    element('chart-live').innerHTML = `<i></i> ${chartLabel}`;

    if (activeRun?.reason) {
      element('notice').textContent = activeRun.reason;
      element('notice').classList.remove('hidden');
    } else if (!setupError) {
      element('notice').classList.add('hidden');
    }
  }

  renderMetrics() {
    const metrics = this.state.activeRun?.metrics ?? {};
    element('sent').textContent = formatNumber(metrics.sent ?? 0);
    element('received').textContent = formatNumber(metrics.received ?? 0);
    element('message-counter').textContent = formatNumber(metrics.received ?? 0);
    element('sent-rate').textContent = formatNumber(metrics.sentRate ?? 0);
    element('received-rate').textContent = formatNumber(metrics.receivedRate ?? 0);
    element('delivery').textContent =
      metrics.deliveryPercent == null ? '—' : `${metrics.deliveryPercent.toFixed(1)}%`;
    element('latency').textContent = formatMilliseconds(metrics.latency?.p95);
    element('backpressure').textContent = formatNumber(metrics.backpressure ?? 0);
    element('errors').textContent = formatNumber(metrics.errors ?? 0);
    element('errors').classList.toggle('rose', (metrics.errors ?? 0) > 0);
    element('integrity').textContent =
      `${metrics.invalid ?? 0} invalid · ${metrics.duplicates ?? 0} duplicate`;
    const pendingLabel = this.state.activeRun?.endedAt
      ? 'unreceived after drain'
      : 'pending receipts';
    element('pending-label').textContent = metrics.sent
      ? `${formatNumber(metrics.pending ?? 0)} ${pendingLabel}`
      : 'No messages sent yet';
    element('elapsed').textContent = formatDuration(metrics.elapsed);

    this.renderMemory(metrics);
    this.renderProgress(metrics);
    this.renderCharts(metrics);
  }

  renderMemory(metrics) {
    element('worker-memory').textContent = formatBytes(metrics.workerRss);
    element('broker-memory').textContent = formatBytes(metrics.brokerRss);
    if (metrics.workerRss && this.state.firstWorkerRss === undefined) {
      const firstSample = this.state.activeRun?.samples?.find((sample) => sample.workerRss);
      this.state.firstWorkerRss = firstSample?.workerRss ?? metrics.workerRss;
    }
    const growth =
      metrics.workerRss && this.state.firstWorkerRss !== undefined
        ? metrics.workerRss - this.state.firstWorkerRss
        : null;
    element('memory-growth').textContent =
      growth == null ? '—' : `${growth >= 0 ? '+' : '−'}${formatBytes(Math.abs(growth))}`;
    const usagePercent = Math.min(100, ((metrics.workerRss ?? 0) / (512 * 1_048_576)) * 100);
    element('memory-bar').style.width = `${usagePercent}%`;
    element('connection-count').textContent = connectionLabel(this.state.activeRun, metrics);
  }

  renderProgress(metrics) {
    const run = this.state.activeRun;
    const percent = run ? Math.min(100, ((metrics.elapsed ?? 0) / run.config.duration) * 100) : 0;
    element('progress-bar').style.width = `${percent}%`;
    element('progress-percent').textContent = `${Math.round(percent)}%`;
    if (!run) {
      element('progress-title').textContent = 'No active test';
      element('progress-detail').textContent = 'Start a test to collect data.';
      return;
    }

    const mode = run.config.mode.charAt(0).toUpperCase() + run.config.mode.slice(1);
    const targetRate = formatNumber(metrics.targetRate ?? run.config.rate);
    element('progress-title').textContent = `${mode} test · ${run.status}`;
    element('progress-detail').textContent =
      `${formatDuration(metrics.elapsed)} / ${formatDuration(run.config.duration)} · ${targetRate} msg/s target`;
  }

  renderCharts(metrics) {
    element('chart-empty').classList.toggle('hidden', (metrics.sent ?? 0) > 0);
    const samples = this.state.activeRun?.samples ?? [];
    renderChart(
      element('throughput-chart'),
      samples,
      [
        { get: (sample) => sample.sentRate, color: 'var(--accent)' },
        { get: (sample) => sample.receivedRate, color: 'var(--success)' },
        { get: (sample) => sample.targetRate, color: 'var(--chart-target)', dash: true },
      ],
      740,
      215,
    );
    renderChart(
      element('latency-chart'),
      samples,
      [
        { get: (sample) => sample.latency?.p50 ?? 0, color: 'var(--success)' },
        { get: (sample) => sample.latency?.p95 ?? 0, color: 'var(--accent)' },
      ],
      350,
      150,
    );
  }

  renderMessages() {
    const { activeRun, paused, selectedMessage } = this.state;
    element('message-counter').textContent = formatNumber(activeRun?.metrics?.received ?? 0);
    if (paused) {
      return;
    }

    const messages = [...(activeRun?.messages ?? [])].reverse();
    if (!messages.length) {
      element('message-rows').innerHTML =
        '<tr><td colspan="5" class="empty-cell">No receipts.</td></tr>';
      element('payload-preview').textContent =
        '// Select a receipt to inspect its payload.\n// Previews are limited to 700 characters.';
      return;
    }

    element('message-rows').innerHTML = messages
      .slice(0, 30)
      .map((message, index) => {
        const selected =
          selectedMessage?.sequence === message.sequence &&
          selectedMessage?.subscriber === message.subscriber;
        return `
        <tr data-index="${index}" class="${selected ? 'selected' : ''}">
          <td>#${message.sequence}</td>
          <td>subscriber ${message.subscriber}</td>
          <td>${formatNumber(message.bytes)} B</td>
          <td class="latency">${formatMilliseconds(message.latency)}</td>
          <td>${formatTime(message.receivedAt)}</td>
        </tr>
      `;
      })
      .join('');

    for (const row of element('message-rows').querySelectorAll('[data-index]')) {
      row.onclick = () => {
        this.state.selectedMessage = messages[Number(row.dataset.index)];
        this.renderMessages();
      };
    }
    element('payload-preview').textContent = payloadPreview(selectedMessage ?? messages[0]);
  }

  renderLogs() {
    const filter = element('event-filter').value;
    const logs = (this.state.activeRun?.logs ?? []).filter((item) =>
      matchesLogFilter(item, filter),
    );
    const list = element('event-list');
    if (!logs.length) {
      list.innerHTML = '<div class="empty-events">No matching events yet.</div>';
      return;
    }

    const atBottom = list.scrollTop + list.clientHeight >= list.scrollHeight - 30;
    list.innerHTML = logs
      .slice(-200)
      .map(
        (item) => `
      <div class="event-row ${escapeHtml(item.level)}">
        <span class="event-time">${formatTime(item.at)}</span>
        <span class="event-level">${escapeHtml(item.level)}</span>
        <span class="event-text">${escapeHtml(item.text)}</span>
      </div>
    `,
      )
      .join('');
    if (atBottom) {
      list.scrollTop = list.scrollHeight;
    }
  }

  renderHistory() {
    const history = this.state.history;
    element('history-counter').textContent = history.length;
    if (!history.length) {
      return;
    }

    element('history-list').innerHTML = history
      .map((run) => {
        const marker = run.status === 'completed' ? '✓' : run.status === 'failed' ? '!' : '■';
        const mode = escapeHtml(run.config.mode);
        return `
        <div class="history-row ${escapeHtml(run.status)}">
          <span class="history-marker">${marker}</span>
          <div class="history-info">
            <div class="history-title">${mode} <span>${escapeHtml(run.status)}</span></div>
            <div class="history-detail">
              ${formatNumber(run.metrics.received ?? 0)} receipts ·
              ${formatMilliseconds(run.metrics.latency?.p95)} P95 · ${formatTime(run.createdAt)}
            </div>
          </div>
          <a href="/api/reports/${escapeHtml(run.id)}.json" title="Download JSON report"
            aria-label="Download ${mode} test report">↓</a>
        </div>
      `;
      })
      .join('');
  }
}
