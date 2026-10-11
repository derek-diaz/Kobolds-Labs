import * as fs from 'node:fs/promises';
import path from 'node:path';
import { lookup } from 'node:dns/promises';

const PROFILE_DEFAULTS = {
  quick: { rate: 5, duration: 10, ramp: 0 },
  soak: { rate: 10, duration: 1_800, ramp: 0 },
  stress: { rate: 250, duration: 30, ramp: 20 },
  custom: { rate: 1, duration: 60, ramp: 0 },
};

export function scalar(value) {
  const text = value.trim();
  if (text.startsWith('"')) {
    return JSON.parse(text.replace(/\s+#.*$/, ''));
  }
  if (text.startsWith("'")) {
    return text.slice(1, text.lastIndexOf("'")).replaceAll("''", "'");
  }
  return text.replace(/\s+#.*$/, '').trim();
}

export async function readConfig(directory) {
  const contents = await fs.readFile(path.join(directory, 'client_config.yaml'), 'utf8');
  const settings = {};
  const sections = {};
  let section;

  // The client's config uses root scalars and one level of credential sections.
  for (const line of contents.split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith('#')) {
      continue;
    }
    const match = line.match(/^(\s*)([a-z_]+):\s*(.*)$/);
    if (!match) {
      continue;
    }
    const [, indentation, key, value] = match;
    if (!indentation) {
      section = value ? undefined : key;
      if (value) {
        settings[key] = scalar(value);
      }
    } else if (section) {
      sections[section] ??= {};
      sections[section][key] = scalar(value);
    }
  }

  if (!settings.connection_string) {
    throw new Error('client_config.yaml has no connection_string.');
  }
  const method = settings.authentication_method ?? 'pre_shared_key';
  const credentials = sections[method] ?? {};
  if (method === 'pre_shared_key' && !credentials.secret) {
    throw new Error('Missing pre_shared_key.secret in client_config.yaml.');
  }
  if (method === 'username_password' && (!credentials.username || !credentials.password)) {
    throw new Error('Missing username/password in client_config.yaml.');
  }
  if (!['pre_shared_key', 'username_password'].includes(method)) {
    throw new Error(`Unsupported authentication method: ${method}`);
  }
  const encoding = settings.control_message_encoding ?? 'cbor';
  if (!['cbor', 'json'].includes(encoding)) {
    throw new Error(`Unsupported encoding: ${encoding}`);
  }

  return {
    endpoint: settings.connection_string,
    method,
    credentials,
    encoding,
    algorithm: settings.authentication_algorithm ?? 'hmac256',
  };
}

export async function normalizedEndpoint(value) {
  const url = new URL(value);
  const invalidPath = url.pathname && url.pathname !== '/';
  if (url.protocol !== 'tcp:' || !url.port || url.username || url.password || invalidPath) {
    throw new Error('Use a TCP address such as tcp://127.0.0.1:7331.');
  }
  const address = await lookup(url.hostname, { family: 4 });
  return `tcp://${address.address}:${url.port}`;
}

export function validateRun(input = {}) {
  const mode = input.mode ?? 'quick';
  if (!Object.keys(PROFILE_DEFAULTS).includes(mode)) {
    throw new Error('Unknown test mode.');
  }
  const defaults = PROFILE_DEFAULTS[mode];

  function readNumber(name, fallback, minimum, maximum, integer = false) {
    const value = Number(input[name] ?? fallback);
    const invalidInteger = integer && !Number.isInteger(value);
    if (!Number.isFinite(value) || value < minimum || value > maximum || invalidInteger) {
      const type = integer ? 'an integer' : 'a number';
      throw new Error(`${name} must be ${type} from ${minimum} to ${maximum}.`);
    }
    return value;
  }

  const topicPrefix = String(input.topicPrefix ?? '/kobolds-labs');
  if (!/^\/[a-zA-Z0-9_./-]{1,160}$/.test(topicPrefix)) {
    throw new Error('Topic must start with / and use letters, numbers, /, _, -, or .');
  }
  const message = String(input.message ?? 'Kobolds Labs test message');
  if (Buffer.byteLength(message) > 100) {
    throw new Error('Message text must be at most 100 UTF-8 bytes.');
  }
  const duration = readNumber('duration', defaults.duration, 1, 86_400);

  return {
    mode,
    rate: readNumber('rate', defaults.rate, 0.1, 2_000),
    duration,
    ramp: readNumber('ramp', defaults.ramp, 0, duration),
    publishers: readNumber('publishers', 1, 1, 4, true),
    subscribers: readNumber('subscribers', 1, 1, 4, true),
    payloadBytes: readNumber('payloadBytes', 512, 256, 32_768, true),
    endpoint: String(input.endpoint ?? ''),
    topicPrefix: topicPrefix.replace(/\/$/, ''),
    message,
  };
}
