import http from 'node:http';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { readConfig, validateRun } from './lib/config.mjs';
import { Lab } from './lib/lab.mjs';
import { ReportStore, reportAsCsv, reportAsJson } from './lib/reports.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const options = readServerOptions(process.argv.slice(2));
const requestToken = randomBytes(24).toString('hex');
const eventListeners = new Set();
const system = {
  platform: process.platform,
  architecture: process.arch,
  node: process.version,
  osRelease: os.release(),
  cpus: os.cpus().length,
  totalMemory: os.totalmem(),
  sdk: '0.1.1',
  lab: '1.0.0',
  app: 'Kobolds Labs',
};

let configuration;
let setupError = null;
let secretValues = [];

try {
  if (!options.directory) {
    throw new Error('Set KOBOLDS_DIR in .env and run npm start, or pass --kobolds-dir PATH.');
  }

  configuration = await readConfig(options.directory);
  secretValues = Object.values(configuration.credentials).filter(
    (value) => typeof value === 'string' && value,
  );
  const sdkEntry = import.meta.resolve('@kobolds/kobolds-ts');
  const sdkDirectory = path.dirname(path.dirname(fileURLToPath(sdkEntry)));
  const sdkPackage = JSON.parse(await fs.readFile(path.join(sdkDirectory, 'package.json'), 'utf8'));
  system.sdk = sdkPackage.version;
} catch (error) {
  setupError =
    error.code === 'ERR_MODULE_NOT_FOUND'
      ? 'Install Labs dependencies with npm install before starting a test.'
      : error.message;
}

const reports = new ReportStore(options.dataDirectory);
await reports.initialize();
const lab = new Lab({ root, directory: options.directory, reports, system, redact });
for (const event of ['state', 'log', 'sample', 'message']) {
  lab.on(event, (value) => broadcast(event, value));
}

const assets = {
  '/': ['index.html', 'text/html'],
  '/style.css': ['style.css', 'text/css'],
  '/app.js': ['app.js', 'application/javascript'],
  '/dashboard.js': ['dashboard.js', 'application/javascript'],
  '/charts.js': ['charts.js', 'application/javascript'],
  '/format.js': ['format.js', 'application/javascript'],
};

const server = http.createServer(handleRequest);
const heartbeat = setInterval(() => {
  for (const response of eventListeners) {
    response.write(': heartbeat\n\n');
  }
}, 15_000);

server.listen(options.port, '127.0.0.1', () => {
  console.log(`Kobolds Labs: http://127.0.0.1:${server.address().port}`);
  console.log(`Kobolds directory: ${options.directory ?? '(not configured)'}`);
  if (setupError) {
    console.error(`Setup: ${setupError}`);
  }
});
server.on('error', (error) => {
  console.error(error.message);
  process.exit(1);
});
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, shutdown);
}

function readServerOptions(args) {
  const result = {
    directory: process.env.KOBOLDS_DIR ? path.resolve(process.env.KOBOLDS_DIR) : undefined,
    port: 4177,
    dataDirectory: path.join(root, 'data'),
  };

  for (let index = 0; index < args.length; index++) {
    switch (args[index]) {
      case '--kobolds-dir':
        result.directory = path.resolve(args[++index]);
        break;
      case '--port':
        result.port = Number(args[++index]);
        break;
      case '--data-dir':
        result.dataDirectory = path.resolve(args[++index]);
        break;
      case '--help':
        console.log('node server.mjs [--port 4177] [--kobolds-dir PATH] [--data-dir PATH]');
        process.exit(0);
        break;
      default:
        throw new Error(`Unknown argument: ${args[index]}`);
    }
  }

  if (!Number.isInteger(result.port) || result.port < 0 || result.port > 65_535) {
    throw new Error('Invalid HTTP port.');
  }
  return result;
}

function redact(value) {
  let text = value;
  for (const secret of secretValues) {
    text = text.split(secret).join('[redacted]');
  }
  return text;
}

function sendJson(response, status, body) {
  response.writeHead(status, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
  });
  response.end(JSON.stringify(body));
}

async function readJsonBody(request) {
  let contents = '';
  for await (const chunk of request) {
    contents += chunk;
    if (contents.length > 16_384) {
      throw new Error('Request is too large.');
    }
  }
  return JSON.parse(contents || '{}');
}

function acceptsRequest(request, response) {
  const port = server.address().port;
  const allowedHosts = [`127.0.0.1:${port}`, `localhost:${port}`];
  if (!allowedHosts.includes(request.headers.host)) {
    sendJson(response, 403, { error: 'Local requests only.' });
    return false;
  }
  if (request.method !== 'POST') {
    return true;
  }

  const allowedOrigins = allowedHosts.map((host) => `http://${host}`);
  const origin = request.headers.origin;
  const invalidOrigin = origin && !allowedOrigins.includes(origin);
  if (invalidOrigin || request.headers['x-lab-token'] !== requestToken) {
    sendJson(response, 403, { error: 'Reload the local app before making changes.' });
    return false;
  }
  if (!request.headers['content-type']?.includes('application/json')) {
    sendJson(response, 415, { error: 'JSON required.' });
    return false;
  }
  return true;
}

async function handleRequest(request, response) {
  try {
    if (!acceptsRequest(request, response)) {
      return;
    }

    const url = new URL(request.url, `http://${request.headers.host}`);
    const route = `${request.method} ${url.pathname}`;

    switch (route) {
      case 'GET /api/bootstrap':
        sendJson(response, 200, {
          token: requestToken,
          endpoint: configuration?.endpoint ?? 'tcp://127.0.0.1:7331',
          setupError,
          system,
          ...lab.state,
        });
        return;
      case 'GET /api/state':
        sendJson(response, 200, lab.state);
        return;
      case 'GET /api/events':
        openEventStream(request, response);
        return;
      case 'POST /api/runs':
        await startRun(request, response);
        return;
      case 'POST /api/stop':
        lab.stop();
        sendJson(response, 200, { ok: true });
        return;
      case 'POST /api/send':
        if (!lab.sendOne()) {
          sendJson(response, 409, { error: 'Start a test before sending an extra message.' });
          return;
        }
        sendJson(response, 200, { ok: true });
        return;
    }

    if (request.method === 'GET' && url.pathname.startsWith('/api/reports/')) {
      await downloadReport(response, url.pathname);
    } else if (request.method === 'GET' && assets[url.pathname]) {
      await serveAsset(response, assets[url.pathname]);
    } else {
      sendJson(response, 404, { error: 'Not found.' });
    }
  } catch (error) {
    const status = error.code === 'ENOENT' ? 404 : 400;
    sendJson(response, status, { error: redact(error.message) });
  }
}

async function startRun(request, response) {
  if (setupError) {
    sendJson(response, 400, { error: setupError });
    return;
  }
  if (lab.isBusy) {
    sendJson(response, 409, {
      error: 'A test is already active. Stop it before starting another.',
    });
    return;
  }

  const config = validateRun(await readJsonBody(request));
  if (!config.endpoint) {
    config.endpoint = configuration.endpoint;
  }
  sendJson(response, 201, lab.start(config));
}

function openEventStream(request, response) {
  response.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  response.write(`event: state\ndata: ${JSON.stringify(lab.state)}\n\n`);
  eventListeners.add(response);
  request.on('close', () => eventListeners.delete(response));
}

function broadcast(type, value) {
  const event = `event: ${type}\ndata: ${JSON.stringify(value)}\n\n`;
  for (const response of eventListeners) {
    if (response.writableLength > 1_024 * 1_024) {
      response.destroy();
      eventListeners.delete(response);
    } else {
      response.write(event);
    }
  }
}

async function downloadReport(response, pathname) {
  const id = pathname.slice('/api/reports/'.length).replace(/\.(json|csv)$/, '');
  const report = await reports.read(id, lab.active, system);
  const csv = pathname.endsWith('.csv');
  const extension = csv ? 'csv' : 'json';
  response.writeHead(200, {
    'Content-Type': csv ? 'text/csv' : 'application/json',
    'Content-Disposition': `attachment; filename="kobolds-labs-${id.slice(0, 8)}.${extension}"`,
  });
  response.end(csv ? reportAsCsv(report) : reportAsJson(report));
}

async function serveAsset(response, [name, contentType]) {
  const contents = await fs.readFile(path.join(root, 'public', name));
  response.writeHead(200, {
    'Content-Type': `${contentType}; charset=utf-8`,
    'Cache-Control': 'no-cache',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy':
      "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; " +
      "img-src 'self' data:; frame-ancestors 'none'",
  });
  response.end(contents);
}

function shutdown() {
  clearInterval(heartbeat);
  lab.stop();
  setTimeout(
    () => {
      lab.worker?.kill('SIGKILL');
      server.close();
      process.exit(0);
    },
    lab.worker ? 3_500 : 50,
  );
}
