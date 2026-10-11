# Kobolds Labs

Local test console for the Kobolds message broker. Run quick checks, soak tests,
and rate-controlled stress tests; inspect received payloads and export results.

## Setup

Requires Node.js 24+ on Linux x86_64 and a running Kobolds broker.
`npm install` installs the `@kobolds/kobolds-ts` SDK and its Linux x86_64 native
library into Labs' own `node_modules`. Both Kobolds packages are pinned to
0.1.1; `package-lock.json` also records their transitive dependencies.

The Kobolds packages are in a private GitLab npm registry. The repository's
`.npmrc` routes the `@kobolds` scope there and reads authentication from the
`KOBOLDS_TOKEN` environment variable. Set that variable in your shell using the
same package token you used for the SDK installation, then run `npm install`.
Other packages use the default npm registry. The token is not stored in this
repository. npm does not load the app's `.env` file.

In the repo directory, copy `.env.example` to `.env` and set `KOBOLDS_DIR` to the
absolute path of the directory containing your `client_config.yaml`. It can be
your Kobolds installation or a separate client configuration directory. Labs
does not load packages from that directory.

```bash
# With KOBOLDS_TOKEN set in your shell:
npm install
cp .env.example .env
# Edit KOBOLDS_DIR in .env, then:
npm start
```

Open <http://127.0.0.1:4177> and start with Quick check. `npm start` loads your
local `.env` automatically. The environment and saved reports are ignored by Git.

You can also specify the installation directly:

```bash
node server.mjs --kobolds-dir /path/to/your/kobolds-installation
```

Command-line `--kobolds-dir` overrides `KOBOLDS_DIR`. Optional arguments are
`--port 4177` and `--data-dir /path/to/run-results`.

Stop a run using **Stop test**. Ctrl+C in the server terminal closes the app
and its test clients. The app does not start or stop your broker. The HTTP server
binds to `127.0.0.1`; credentials are read from your installation's client config
and never sent to the browser.

### Connection failures

Labs waits for an authentication-success event before creating test entities.
An open TCP port alone does not mean the broker is ready. If it accepts TCP but
does not authenticate, check its terminal output and restart the broker if it
has stopped responding. Authentication rejection indicates that the client and
broker authentication settings need to be checked.

SDK v0.1.1 can report connected without successful authentication, and its native
cleanup can abort after a failed connection. Labs guards authentication and
closes failed-session sockets before exiting the isolated worker, allowing the
operating system to reclaim its native resources. Unexpected native crashes are
still recorded; a prior client error is retained as part of the failure reason.

## Test profiles

| Profile     | Default traffic                                                             |
| ----------- | --------------------------------------------------------------------------- |
| Quick check | 5 messages/second for 10 seconds                                            |
| Soak test   | 10 messages/second for 30 minutes                                           |
| Stress test | Ramp from 10% to 250 messages/second over 20 seconds; hold until 30 seconds |
| Custom      | Choose the rate, duration, ramp, payload size, and client counts            |

All values are editable. The total rate is shared across publishers. Each
subscriber receives every test message, so expected receipts equal messages sent
multiplied by subscriber count.

Limits: 0.1–2000 messages/second, 1–86400 seconds, 256–32768 bytes per payload,
and 1–4 publishers and subscribers. These limits accommodate the buffer handling
in the tested alpha SDK.

Each run creates a unique topic under `/kobolds-labs` by default, connects
persistent publishers and subscribers, and removes the topic after a clean
finish. A crash or broken connection can leave a topic behind. Native test
workers run in separate processes, and the parent server enforces startup, run,
and stop deadlines.

## Measurements

- **Sent:** messages queued by the SDK; this is not a broker acknowledgment.
- **Valid receipts:** matching run ID and sequence plus SHA-256 body equality.
- **Delivery:** valid receipts divided by expected receipts, including fan-out.
- **Pending:** expected receipts that have not arrived. Sending is followed by a
  two-second drain window. Unreceived after drain does not prove permanent loss.
- **Latency:** publish submission to subscriber callback in the same worker,
  including broker, network, and client processing. Percentiles use the most
  recent 10,000 valid receipts.
- **Backpressure:** the SDK returned false while still queuing the message. The
  generator pauses as client queues grow. This is not a publish-failure count.
- **Invalid and duplicate receipts:** changed or unexpected bodies and repeat
  subscriber/sequence keys. Duplicate detection retains the latest 50,000 keys.
- **Memory:** test-worker RSS and, when its local process can be identified,
  broker RSS. Worker growth includes JavaScript and native memory and alone does
  not establish a leak.

UI timestamps use Puerto Rico time; payload and report timestamps are UTC.

## Messages and results

The message inspector samples payloads to keep the UI responsive. Every receipt
is validated, including receipts that are not displayed. Payloads include a run
ID, sequence, UTC send timestamp, message text, and padding to the selected size.
Select a receipt to inspect it; **Pause view** pauses rendering only.

**Export JSON** downloads the configuration, metrics, memory, events, sampled
payloads, and environment details. **Export CSV** downloads time-series metrics.
**Run history** lists the latest 30 tests and their JSON reports.

Reports are saved in `data/` and persist until you remove them. The app retains
the latest 7,200 seconds of samples, 500 events, and 100 payload previews.
Full-run counters remain cumulative. Historical reports keep their original
topic names and payloads.

## Development and validation

### Code layout

| File                                    | Responsibility                                                  |
| --------------------------------------- | --------------------------------------------------------------- |
| `server.mjs`                            | Startup, local HTTP routes, event streams, and static assets    |
| `lib/lab.mjs`                           | Run lifecycle, worker messages, deadlines, and dashboard state  |
| `runner.mjs`                            | Worker process entry point and start/stop/send messages         |
| `lib/test-runner.mjs`                   | SDK clients, test traffic, receipt handling, drain, and cleanup |
| `lib/connection.mjs`                    | Authentication checks and safe cleanup after connection failure |
| `lib/config.mjs`                        | Client configuration and test-setting validation                |
| `lib/metrics.mjs`                       | Payload integrity, fan-out tracking, and latency measurements   |
| `lib/reports.mjs`                       | Saved history and JSON/CSV reports                              |
| `lib/broker-memory.mjs`                 | Optional local broker RSS measurement                           |
| `public/app.js`                         | Form controls, API requests, and live event updates             |
| `public/dashboard.js`                   | Dashboard, message inspector, event list, and history rendering |
| `public/charts.js`, `public/format.js`  | SVG charts and display formatting                               |
| `public/index.html`, `public/style.css` | Page structure and styling                                      |
| `test/`                                 | Metrics, configuration, connection, and report regression tests |

The server communicates with its worker through Node IPC. The browser receives
state, samples, messages, and logs through server-sent events. Credentials stay
in the server and worker processes. The native SDK workaround is kept in
`lib/connection.mjs`; keep authentication checks ahead of topic or client RPCs.

Use two-space indentation, descriptive names, and one operation per statement.
`.editorconfig` and `.prettierrc.json` record the formatting for supporting editors.
The app runs without a bundler or build step. The SDK is resolved by package
name from Labs' dependencies; `KOBOLDS_DIR` supplies client configuration only.

### Validation

```bash
npm test
```

Verified against installed Kobolds/SDK v0.1.1 and Node v26 on Ubuntu x86_64:
persistent connections, payload validation, subscriber fan-out, short runs in
each profile, paced ramps, extra messages, stop and cleanup, JSON/CSV exports,
connection failures, and browser controls. A full 30-minute soak or maximum-rate
stress run has not been performed. Generator and SDK overhead affect latency
and achievable throughput, so these measurements are not a pure broker benchmark.

Connection regressions cover refused connections, TCP connections with no
authentication response, and a broker disconnect during a run, using the real
native SDK. These failures produce a failed result without a worker SIGABRT.

The private SDK and native library are npm dependencies of Labs. Their installed
binaries and `node_modules` are ignored by Git and are not bundled in the source
archive. The broker's npm packages are not used.
