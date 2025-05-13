"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const app_1 = __importDefault(require("./app"));
const config_1 = __importDefault(require("./config"));
const logger_1 = __importDefault(require("./utils/logger"));
// Start the server
const server = app_1.default.listen(config_1.default.server.port, () => {
    logger_1.default.info(`TSS Coordinator Node started`, {
        port: config_1.default.server.port,
        environment: config_1.default.server.environment,
        startTime: new Date().toISOString()
    });
});
// Handle graceful shutdown
process.on('SIGTERM', () => {
    logger_1.default.info('SIGTERM signal received, shutting down gracefully');
    server.close(() => {
        logger_1.default.info('HTTP server closed');
        process.exit(0);
    });
    // Force close after 10s if the server hasn't closed
    setTimeout(() => {
        logger_1.default.error('Could not close connections in time, forcefully shutting down');
        process.exit(1);
    }, 10000);
});
exports.default = server;
