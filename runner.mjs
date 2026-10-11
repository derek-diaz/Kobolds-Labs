import { TestRunner } from './lib/test-runner.mjs';

const runner = new TestRunner(process.argv[2], sendToDashboard);
let started = false;

process.on('message', (message) => {
  switch (message.type) {
    case 'start':
      if (!started) {
        started = true;
        runner.run(message).catch(reportFatalError);
      }
      break;
    case 'stop':
      runner.requestStop();
      break;
    case 'send':
      runner.requestPublish();
      break;
  }
});
process.on('SIGTERM', () => runner.requestStop());
process.on('uncaughtException', reportFatalError);
process.on('unhandledRejection', reportFatalError);

function sendToDashboard(message) {
  if (process.connected) {
    process.send(message);
  }
}

function reportFatalError(error) {
  const reason = error.message ?? String(error);
  runner.log('error', reason);
  sendToDashboard({ type: 'fatal', reason });
  setTimeout(() => process.exit(1), 50);
}
