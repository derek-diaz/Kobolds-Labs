// SDK v0.1.1 can finish connect() at its deadline without an auth_success event.
// Require both the SDK promise and the actual authentication event before RPCs.
export async function connectAuthenticated(client, { label, endpoint, timeoutMs = 2_500 }) {
  const originalFactory = client.initializeOutboundConnection;
  let connection;
  let tcpConnected = false;
  let resolveAuthentication;
  let rejectAuthentication;
  const authenticated = new Promise((resolve, reject) => {
    resolveAuthentication = resolve;
    rejectAuthentication = reject;
  });

  function timeoutError() {
    if (tcpConnected) {
      return new Error(
        `${label}: broker at ${endpoint} accepted TCP but did not complete authentication ` +
          `within ${timeoutMs / 1_000} seconds. Check whether the broker is responsive ` +
          'and verify the client authentication settings.',
      );
    }
    return new Error(
      `${label}: connection to ${endpoint} timed out. ` +
        'Verify the broker is running and the address is correct.',
    );
  }

  function authenticationError() {
    return new Error(
      `${label}: authentication rejected by ${endpoint}. Verify the client authentication settings.`,
    );
  }

  const handlers = {
    pipe_connect() {
      tcpConnected = true;
    },
    auth_success() {
      resolveAuthentication();
    },
    auth_failure() {
      rejectAuthentication(authenticationError());
    },
    pipe_error(error) {
      const code = error?.code ? ` (${error.code})` : '';
      rejectAuthentication(
        new Error(
          `${label}: cannot connect to ${endpoint}${code}. ` +
            'Verify the broker is running and the address is correct.',
        ),
      );
    },
    pipe_close() {
      rejectAuthentication(
        new Error(
          `${label}: broker connection to ${endpoint} closed before authentication completed.`,
        ),
      );
    },
  };

  client.initializeOutboundConnection = () => {
    connection = originalFactory.call(client);
    for (const [event, handler] of Object.entries(handlers)) {
      connection.on(event, handler);
    }
    return connection;
  };

  const timer = setTimeout(() => rejectAuthentication(timeoutError()), timeoutMs);
  try {
    const connected = Promise.resolve()
      .then(() => client.connect(timeoutMs))
      .catch((error) => {
        if (error.message === 'timeout') {
          throw timeoutError();
        }
        if (error.message === 'failed to authenticate') {
          throw authenticationError();
        }
        throw error;
      });
    await Promise.all([connected, authenticated]);
  } finally {
    clearTimeout(timer);
    client.initializeOutboundConnection = originalFactory;
    if (connection) {
      for (const [event, handler] of Object.entries(handlers)) {
        connection.off(event, handler);
      }
    }
  }
}

// Failed SDK clients may contain live or already-closed native connections.
// Client.close() can assert on that state. Close TCP sockets and let the isolated
// worker's exit reclaim native memory instead of invoking unsafe teardown.
export function closeFailedClientSockets(clients) {
  for (const tracked of clients) {
    for (const connection of tracked.connections) {
      connection.pipe?.socket?.destroy();
    }
    tracked.closed = true;
  }
}
