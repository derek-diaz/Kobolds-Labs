import { formatNumber } from './format.js';

function formatAxisValue(value) {
  if (value >= 1_000) {
    return `${(value / 1_000).toFixed(1)}k`;
  }
  return value >= 10 ? Math.round(value) : value.toFixed(1);
}

function chartGrid({ left, right, height, maximum, start, span, x, y }) {
  const markup = [];
  for (let index = 0; index <= 4; index++) {
    const value = (maximum / 4) * index;
    const position = y(value);
    markup.push(`
      <line x1="${left}" y1="${position}" x2="${right}" y2="${position}"
        stroke="var(--line)" stroke-dasharray="3 5" />
      <text x="${left - 7}" y="${position + 3}" text-anchor="end">${formatAxisValue(value)}</text>
    `);
  }

  const tickCount = span <= 10 ? 5 : 6;
  for (let index = 0; index <= tickCount; index++) {
    const elapsed = start + (index * span) / tickCount;
    markup.push(`
      <text x="${x(elapsed)}" y="${height - 7}" text-anchor="middle">${formatNumber(elapsed)}s</text>
    `);
  }
  return markup.join('');
}

function chartSeries(points, series, x, y) {
  return series
    .map((line) => {
      const coordinates = points
        .map((point) => {
          const horizontal = x(point.elapsed).toFixed(2);
          const vertical = y(line.get(point) ?? 0).toFixed(2);
          return `${horizontal},${vertical}`;
        })
        .join(' ');
      const dash = line.dash ? 'stroke-dasharray="5 5"' : '';
      let markup = `
      <polyline points="${coordinates}" fill="none" stroke="${line.color}"
        stroke-width="${line.dash ? 1 : 2}" ${dash} stroke-linejoin="round" />
    `;

      const lastPoint = points.at(-1);
      if (lastPoint && !line.dash) {
        const value = line.get(lastPoint) ?? 0;
        markup += `
        <circle cx="${x(lastPoint.elapsed)}" cy="${y(value)}" r="3" fill="${line.color}">
          <title>${formatNumber(value)}</title>
        </circle>
      `;
      }
      return markup;
    })
    .join('');
}

export function renderChart(element, samples, series, fallbackWidth, fallbackHeight) {
  const width = Math.max(250, element.clientWidth || fallbackWidth);
  const height = Math.max(130, element.clientHeight || fallbackHeight);
  element.setAttribute('viewBox', `0 0 ${width} ${height}`);

  const latestElapsed = samples.at(-1)?.elapsed ?? 0;
  const span = Math.max(10, Math.min(60, latestElapsed));
  const end = Math.max(span, latestElapsed);
  const start = end - span;
  const points = samples.filter((sample) => sample.elapsed >= start);
  const values = points.flatMap((point) => series.map((line) => line.get(point) ?? 0));
  const maximum = Math.max(1, ...values) * 1.15;
  const left = 35;
  const right = width - 12;
  const top = 13;
  const bottom = height - 25;
  const x = (elapsed) => left + ((elapsed - start) / span) * (right - left);
  const y = (value) => bottom - (value / maximum) * (bottom - top);

  element.innerHTML =
    chartGrid({ left, right, height, maximum, start, span, x, y }) +
    chartSeries(points, series, x, y);
}
