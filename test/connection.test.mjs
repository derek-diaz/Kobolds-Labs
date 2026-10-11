import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { connectAuthenticated, closeFailedClientSockets } from '../lib/connection.mjs';

const options = { label: 'Publisher 1', endpoint: 'tcp://127.0.0.1:7331', timeoutMs: 30 };
function mockClient(events) {
  const connection = new EventEmitter();
  let originalCalls = 0;
  const client = {
    initializeOutboundConnection() {
      originalCalls++;
      return connection;
    },
    async connect() {
      this.initializeOutboundConnection();
      events(connection);
    },
  };
  return {
    client,
    connection,
    get originalCalls() {
      return originalCalls;
    },
  };
}

test('SDK connect resolving without authentication is rejected before any RPC', async () => {
  const mock = mockClient((connection) => connection.emit('pipe_connect'));
  const originalFactory = mock.client.initializeOutboundConnection;
  await assert.rejects(
    connectAuthenticated(mock.client, options),
    /accepted TCP but did not complete authentication/,
  );
  assert.equal(mock.client.initializeOutboundConnection, originalFactory);
  assert.equal(mock.connection.eventNames().length, 0);
});

test('an authenticated connection can proceed and preserves the SDK factory', async () => {
  const mock = mockClient((connection) => {
    connection.emit('pipe_connect');
    connection.emit('auth_success');
  });
  const originalFactory = mock.client.initializeOutboundConnection;
  await connectAuthenticated(mock.client, options);
  assert.equal(mock.originalCalls, 1);
  assert.equal(mock.client.initializeOutboundConnection, originalFactory);
});

test('refused connections and rejected authentication keep an actionable cause', async () => {
  const refused = mockClient((connection) =>
    connection.emit('pipe_error', { code: 'ECONNREFUSED' }),
  );
  await assert.rejects(connectAuthenticated(refused.client, options), /ECONNREFUSED/);
  const rejected = mockClient((connection) => connection.emit('auth_failure'));
  await assert.rejects(connectAuthenticated(rejected.client, options), /authentication rejected/);
});

test('socket loss during authentication rejects instead of appearing connected', async () => {
  const mock = mockClient((connection) => connection.emit('pipe_close'));
  await assert.rejects(connectAuthenticated(mock.client, options), /closed before authentication/);
});

test('failure cleanup closes sockets without invoking native client teardown', () => {
  let socketsClosed = 0;
  const tracked = {
    closed: false,
    client: {
      close() {
        assert.fail('Unsafe native teardown invoked');
      },
    },
    connections: [
      {
        pipe: {
          socket: {
            destroy() {
              socketsClosed++;
            },
          },
        },
      },
    ],
  };
  closeFailedClientSockets([tracked]);
  assert.equal(socketsClosed, 1);
  assert.equal(tracked.closed, true);
});
