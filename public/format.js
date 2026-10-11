const numberFormatter = new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 });
const timeFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Puerto_Rico',
  hour12: false,
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});
const HTML_ENTITIES = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function element(id) {
  return document.getElementById(id);
}

export function formatNumber(value) {
  return numberFormatter.format(value);
}

export function formatTime(value) {
  return timeFormatter.format(new Date(value));
}

export function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => HTML_ENTITIES[character]);
}

export function formatBytes(value) {
  if (value == null) {
    return '—';
  }
  if (value >= 1_048_576) {
    return `${(value / 1_048_576).toFixed(1)} MiB`;
  }
  return `${(value / 1_024).toFixed(1)} KiB`;
}

export function formatDuration(value) {
  const seconds = Math.max(0, Math.floor(value ?? 0));
  const minutes = String(Math.floor(seconds / 60)).padStart(2, '0');
  const remainder = String(seconds % 60).padStart(2, '0');
  return `${minutes}:${remainder}`;
}

export function formatMilliseconds(value) {
  if (value == null) {
    return '—';
  }
  return `${value < 10 ? value.toFixed(2) : value.toFixed(1)} ms`;
}
