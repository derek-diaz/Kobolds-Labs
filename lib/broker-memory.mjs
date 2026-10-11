import * as fs from 'node:fs/promises';
import path from 'node:path';

async function listeningSocketInodes(port) {
  const table = await fs.readFile('/proc/net/tcp', 'utf8');
  const inodes = new Set();

  for (const row of table.split('\n').slice(1)) {
    if (!row.trim()) {
      continue;
    }

    const fields = row.trim().split(/\s+/);
    const state = fields[3];
    const localPort = parseInt(fields[1].split(':')[1], 16);
    if (state === '0A' && localPort === port) {
      inodes.add(fields[9]);
    }
  }

  return inodes;
}

async function ownsListeningSocket(pid, inodes) {
  const descriptors = await fs.readdir(`/proc/${pid}/fd`);

  for (const descriptor of descriptors) {
    try {
      const link = await fs.readlink(`/proc/${pid}/fd/${descriptor}`);
      const inode = link.match(/^socket:\[(\d+)\]$/)?.[1];
      if (inodes.has(inode)) {
        return true;
      }
    } catch {
      // File descriptors can close between listing and reading them.
    }
  }

  return false;
}

async function findBrokerPid(port) {
  const inodes = await listeningSocketInodes(port);

  for (const pid of await fs.readdir('/proc')) {
    if (!/^\d+$/.test(pid)) {
      continue;
    }

    try {
      const executable = await fs.readlink(`/proc/${pid}/exe`);
      if (path.basename(executable) === 'kobolds' && (await ownsListeningSocket(pid, inodes))) {
        return pid;
      }
    } catch {
      // Processes can exit or be unreadable; memory measurement is optional.
    }
  }

  return null;
}

export class BrokerMemory {
  constructor() {
    this.endpoint = null;
    this.pid = null;
  }

  async read(endpoint) {
    if (endpoint !== this.endpoint) {
      this.pid = null;
      this.endpoint = endpoint;
    }

    try {
      const target = new URL(endpoint);
      if (target.hostname !== '127.0.0.1') {
        return null;
      }

      this.pid ??= await findBrokerPid(Number(target.port));
      if (!this.pid) {
        return null;
      }

      const status = await fs.readFile(`/proc/${this.pid}/status`, 'utf8');
      const rssKiB = Number(status.match(/^VmRSS:\s+(\d+)/m)?.[1] ?? 0);
      return rssKiB * 1024 || null;
    } catch {
      this.pid = null;
      return null;
    }
  }
}
