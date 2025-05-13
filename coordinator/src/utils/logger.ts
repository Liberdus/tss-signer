import winston from 'winston';
import config from '../config';
import path from 'path';
import fs from 'fs';

// Extend the Winston Logger type to include our custom method
interface CustomLogger extends winston.Logger {
  messageKeys: (message: string, keys: any) => void;
}

// Ensure logs directory exists
const logsDir = path.join(process.cwd(), 'logs');
if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir, { recursive: true });
}

// Create a formatter for console output
const consoleFormat = winston.format.combine(
  winston.format.colorize(),
  winston.format.timestamp(),
  winston.format.printf(({ timestamp, level, message, ...meta }) => {
    return `${timestamp} ${level}: ${message} ${Object.keys(meta).length ? JSON.stringify(meta) : ''}`;
  })
);

// Create a formatter for file output (include more details)
const fileFormat = winston.format.combine(
  winston.format.timestamp(),
  winston.format.json()
);

// Define log files
const logFile = path.join(logsDir, 'coordinator.log');
const errorLogFile = path.join(logsDir, 'error.log');
const debugLogFile = path.join(logsDir, 'debug.log');

// Configure logger with both console and file transports
const winstonLogger = winston.createLogger({
  level: config.logging.level,
  defaultMeta: { service: 'tss-coordinator' },
  transports: [
    // Console transport
    new winston.transports.Console({
      format: consoleFormat
    }),
    
    // Main log file with all logs at configured level
    new winston.transports.File({
      filename: logFile,
      format: fileFormat,
      maxsize: 5 * 1024 * 1024, // 5MB
      maxFiles: 5
    }),
    
    // Separate error log file
    new winston.transports.File({
      filename: errorLogFile,
      level: 'error',
      format: fileFormat,
      maxsize: 5 * 1024 * 1024, // 5MB
      maxFiles: 5
    }),
    
    // Detailed debug log file with all debug messages
    new winston.transports.File({
      filename: debugLogFile,
      level: 'debug',
      format: fileFormat,
      maxsize: 10 * 1024 * 1024, // 10MB
      maxFiles: 3
    })
  ]
});

// Add a special method to log message keys for TSS debugging
(winstonLogger as CustomLogger).messageKeys = (message: string, keys: any) => {
  winstonLogger.debug(`${message} - TSS_KEYS`, { 
    keys,
    timestamp: Date.now(),
    tssKeyDebug: true
  });
};

// Export the configured logger with the custom type
const logger = winstonLogger as CustomLogger;
export default logger;