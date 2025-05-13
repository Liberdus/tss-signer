import app from './app';
import config from './config';
import logger from './utils/logger';

// Start the server
const server = app.listen(config.server.port, () => {
  logger.info(`TSS Coordinator Node started`, {
    port: config.server.port,
    environment: config.server.environment,
    startTime: new Date().toISOString()
  });
});

// Handle graceful shutdown
process.on('SIGTERM', () => {
  logger.info('SIGTERM signal received, shutting down gracefully');
  
  server.close(() => {
    logger.info('HTTP server closed');
    process.exit(0);
  });
  
  // Force close after 10s if the server hasn't closed
  setTimeout(() => {
    logger.error('Could not close connections in time, forcefully shutting down');
    process.exit(1);
  }, 10000);
});

export default server;