/** The daemon's entry: the real Slack connection, knowledge and clock for `startDaemon`, plus signals. */
import { App, LogLevel, SocketModeReceiver } from '@slack/bolt';
import { loadConfig } from './config.ts';
import { startDaemon } from './daemon.ts';
import { createKnowledge } from './knowledge.ts';
import { errorMessage } from './lib/errors.ts';
import { timestampedLogger } from './logging.ts';

const config = loadConfig();
const logger = timestampedLogger(LogLevel.INFO);
// The receiver is made here rather than by `socketMode: true` so its connection state can feed the status socket.
const receiver = new SocketModeReceiver({ appToken: config.appToken, logger, logLevel: LogLevel.INFO });
const app = new App({ token: config.botToken, receiver, logger, logLevel: LogLevel.INFO });

const daemon = await startDaemon({
  config, app, client: app.client, logger: app.logger, connection: receiver.client, knowledge: createKnowledge(config.knowledgeDir),
}).catch((error: unknown) => {
  logger.error(errorMessage(error));
  process.exit(1);
});

let stopping = false;
const shutdown = (): void => {
  if (stopping) return;
  stopping = true;
  void daemon.stop().catch((error: unknown) => logger.error(`Shutdown failed: ${errorMessage(error)}`)).finally(() => process.exit(0));
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
