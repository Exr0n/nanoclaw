import pino from 'pino';

export const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  transport: { target: 'pino-pretty', options: { colorize: true } },
});

// Route uncaught errors through pino so they get timestamps in stderr
process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'Uncaught exception');
  process.exit(1);
});

// Exit on unhandled rejection so launchd's KeepAlive restarts us cleanly.
// Staying up after an unhandled rejection has burned us — e.g. a startup-time
// DNS miss for discord.com left the bot offline for hours because the process
// kept running but Discord never reconnected.
process.on('unhandledRejection', (reason) => {
  logger.fatal({ err: reason }, 'Unhandled rejection — exiting for restart');
  process.exit(1);
});
