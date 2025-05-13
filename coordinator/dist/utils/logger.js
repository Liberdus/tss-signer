"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const winston_1 = __importDefault(require("winston"));
const config_1 = __importDefault(require("../config"));
const path_1 = __importDefault(require("path"));
const fs_1 = __importDefault(require("fs"));
// Ensure logs directory exists
const logsDir = path_1.default.join(process.cwd(), 'logs');
if (!fs_1.default.existsSync(logsDir)) {
    fs_1.default.mkdirSync(logsDir, { recursive: true });
}
// Create a formatter for console output
const consoleFormat = winston_1.default.format.combine(winston_1.default.format.colorize(), winston_1.default.format.timestamp(), winston_1.default.format.printf(({ timestamp, level, message, ...meta }) => {
    return `${timestamp} ${level}: ${message} ${Object.keys(meta).length ? JSON.stringify(meta) : ''}`;
}));
// Create a formatter for file output (include more details)
const fileFormat = winston_1.default.format.combine(winston_1.default.format.timestamp(), winston_1.default.format.json());
// Define log files
const logFile = path_1.default.join(logsDir, 'coordinator.log');
const errorLogFile = path_1.default.join(logsDir, 'error.log');
const debugLogFile = path_1.default.join(logsDir, 'debug.log');
// Configure logger with both console and file transports
const winstonLogger = winston_1.default.createLogger({
    level: config_1.default.logging.level,
    defaultMeta: { service: 'tss-coordinator' },
    transports: [
        // Console transport
        new winston_1.default.transports.Console({
            format: consoleFormat
        }),
        // Main log file with all logs at configured level
        new winston_1.default.transports.File({
            filename: logFile,
            format: fileFormat,
            maxsize: 5 * 1024 * 1024, // 5MB
            maxFiles: 5
        }),
        // Separate error log file
        new winston_1.default.transports.File({
            filename: errorLogFile,
            level: 'error',
            format: fileFormat,
            maxsize: 5 * 1024 * 1024, // 5MB
            maxFiles: 5
        }),
        // Detailed debug log file with all debug messages
        new winston_1.default.transports.File({
            filename: debugLogFile,
            level: 'debug',
            format: fileFormat,
            maxsize: 10 * 1024 * 1024, // 10MB
            maxFiles: 3
        })
    ]
});
// Add a special method to log message keys for TSS debugging
winstonLogger.messageKeys = (message, keys) => {
    winstonLogger.debug(`${message} - TSS_KEYS`, {
        keys,
        timestamp: Date.now(),
        tssKeyDebug: true
    });
};
// Export the configured logger with the custom type
const logger = winstonLogger;
exports.default = logger;
