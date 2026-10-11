import { element, formatBytes, formatNumber } from './format.js';
import { Dashboard, LIVE_STATUSES } from './dashboard.js';

const PROFILES = {
  quick: { rate: 5, duration: 10, ramp: 0, description: 'Short run with payload validation.' },
  soak: {
    rate: 10,
    duration: 1_800,
    ramp: 0,
    description: 'Fixed-rate traffic for an extended run.',
  },
  stress: {
    rate: 250,
    duration: 30,
    ramp: 20,
    description: 'Ramp from 10% to the target rate, then hold.',
  },
  custom: { rate: 1, duration: 60, ramp: 0, description: 'Use the settings below.' },
};
const SAMPLE_LIMIT = 7_200;
const MESSAGE_LIMIT = 100;
const LOG_LIMIT = 500;

const state = {
  token: null,
  activeRun: null,
  history: [],
  mode: 'quick',
  paused: false,
  selectedMessage: null,
  firstWorkerRss: undefined,
  setupError: null,
};
const dashboard = new Dashboard(state);
let eventSource;
let toastTimer;

bindControls();
selectProfile('quick');
dashboard.render();
window.addEventListener('resize', () => dashboard.renderMetrics());
await loadDashboard();

function showToast(message) {
  element('toast').textContent = message;
  element('toast').classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => element('toast').classList.add('hidden'), 6_000);
}

async function postJson(route, body = {}) {
  const response = await fetch(route, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Lab-Token': state.token },
    body: JSON.stringify(body),
  });
  const result = await response.json();
  if (!response.ok) {
    throw new Error(result.error);
  }
  return result;
}

function updateEstimate() {
  const rate = Number(element('rate').value);
  const seconds = Number(element('duration').value);
  const ramp = Number(element('ramp').value);
  element('ramp').max = seconds;

  // A linear ramp from 10% averages 55% of the target rate during ramp-up.
  const count = Math.round(rate * (seconds - 0.45 * Math.min(ramp, seconds)));
  const payloadBytes = count * Number(element('payload').value);
  element('estimate').textContent =
    `About ${formatNumber(count)} messages · ${formatBytes(payloadBytes)} payload data`;
}

function selectProfile(name) {
  state.mode = name;
  const profile = PROFILES[name];
  for (const button of document.querySelectorAll('.profile')) {
    const selected = button.dataset.mode === name;
    button.classList.toggle('selected', selected);
    button.setAttribute('aria-pressed', String(selected));
  }
  for (const field of ['rate', 'duration', 'ramp']) {
    element(field).value = profile[field];
  }
  element('profile-description').textContent = profile.description;
  updateEstimate();
}

function updateState(value) {
  const nextRun = value.active;
  if (nextRun?.id && nextRun.id !== state.activeRun?.id) {
    state.firstWorkerRss = undefined;
    state.selectedMessage = null;
    state.paused = false;
    element('pause-messages').textContent = 'Pause view';
  }
  state.activeRun = nextRun;
  state.history = value.history ?? [];
  if (nextRun?.config) {
    element('endpoint-display').textContent = nextRun.normalizedEndpoint ?? nextRun.config.endpoint;
    if (nextRun.id && LIVE_STATUSES.has(nextRun.status)) {
      element('endpoint').value = nextRun.config.endpoint;
    }
  }
  dashboard.render();
}

function readTestSettings() {
  return {
    mode: state.mode,
    endpoint: element('endpoint').value,
    topicPrefix: element('topic-prefix').value,
    rate: Number(element('rate').value),
    duration: Number(element('duration').value),
    ramp: Number(element('ramp').value),
    publishers: Number(element('publishers').value),
    subscribers: Number(element('subscribers').value),
    payloadBytes: Number(element('payload').value),
    message: element('message-text').value,
  };
}

async function startTest(event) {
  event.preventDefault();
  element('start-button').disabled = true;
  try {
    const run = await postJson('/api/runs', readTestSettings());
    updateState({ active: run, history: state.history });
  } catch (error) {
    showToast(error.message);
    dashboard.render();
  }
}

function toggleMessagePause() {
  state.paused = !state.paused;
  element('pause-messages').textContent = state.paused ? 'Resume view' : 'Pause view';
  if (!state.paused) {
    dashboard.renderMessages();
  }
}

function downloadReport(extension) {
  if (state.activeRun) {
    location.href = `/api/reports/${state.activeRun.id}.${extension}`;
  }
}

function bindControls() {
  element('test-form').onsubmit = startTest;
  element('stop-button').onclick = () => {
    postJson('/api/stop').catch((error) => showToast(error.message));
  };
  element('send-button').onclick = () => {
    postJson('/api/send').catch((error) => showToast(error.message));
  };
  element('pause-messages').onclick = toggleMessagePause;
  element('event-filter').onchange = () => dashboard.renderLogs();
  element('export-json').onclick = () => downloadReport('json');
  element('export-csv').onclick = () => downloadReport('csv');
  for (const button of document.querySelectorAll('.profile')) {
    button.onclick = () => selectProfile(button.dataset.mode);
  }
  for (const input of document.querySelectorAll('#test-form input')) {
    input.oninput = updateEstimate;
  }
}

function appendRecent(items, value, limit) {
  items.push(value);
  if (items.length > limit) {
    items.shift();
  }
}

function connectEventStream() {
  eventSource = new EventSource('/api/events');
  eventSource.onopen = refreshAfterReconnect;
  eventSource.onerror = () => {
    element('stream-dot').classList.remove('ready');
    element('stream-status').textContent = 'Reconnecting to dashboard';
  };
  eventSource.addEventListener('state', (event) => updateState(JSON.parse(event.data)));
  eventSource.addEventListener('sample', (event) => {
    const run = state.activeRun;
    if (!run) {
      return;
    }
    run.metrics = JSON.parse(event.data);
    run.samples ??= [];
    appendRecent(run.samples, run.metrics, SAMPLE_LIMIT);
    dashboard.renderMetrics();
  });
  eventSource.addEventListener('message', (event) => {
    const run = state.activeRun;
    if (!run) {
      return;
    }
    run.messages ??= [];
    appendRecent(run.messages, JSON.parse(event.data), MESSAGE_LIMIT);
    dashboard.renderMessages();
  });
  eventSource.addEventListener('log', (event) => {
    const run = state.activeRun;
    if (!run) {
      return;
    }
    run.logs ??= [];
    appendRecent(run.logs, JSON.parse(event.data), LOG_LIMIT);
    dashboard.renderLogs();
  });
}

async function refreshAfterReconnect() {
  element('stream-dot').classList.add('ready');
  element('stream-status').textContent = 'Dashboard connected';
  try {
    // The server creates a new request token on restart; refresh it with state.
    const response = await fetch('/api/bootstrap');
    const refreshed = await response.json();
    state.token = refreshed.token;
    updateState(refreshed);
  } catch {
    // EventSource keeps reconnecting; the next connection retries the refresh.
  }
}

async function loadDashboard() {
  try {
    const response = await fetch('/api/bootstrap');
    const initial = await response.json();
    state.token = initial.token;
    state.setupError = initial.setupError;
    element('endpoint').value = initial.endpoint;
    element('endpoint-display').textContent = initial.endpoint;
    element('sdk-version').textContent = `SDK ${initial.system.sdk} · Node ${initial.system.node}`;
    if (state.setupError) {
      element('notice').textContent = `Setup needed: ${state.setupError}`;
      element('notice').classList.remove('hidden');
    }
    updateState(initial);
    connectEventStream();
  } catch (error) {
    showToast(`Cannot load dashboard: ${error.message}`);
    element('stream-status').textContent = 'Dashboard unavailable';
    element('start-button').disabled = true;
  }
}
