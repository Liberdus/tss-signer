"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const helmet_1 = __importDefault(require("helmet"));
const cors_1 = __importDefault(require("cors"));
const routes_1 = __importDefault(require("./api/routes"));
const logger_1 = __importDefault(require("./utils/logger"));
const uuid_1 = require("uuid");
// Create Express app
const app = (0, express_1.default)();
// Add request ID middleware
app.use((req, res, next) => {
    req.headers['x-request-id'] = req.headers['x-request-id'] || (0, uuid_1.v4)();
    next();
});
// Add request logging
app.use((req, res, next) => {
    const startTime = Date.now();
    // Log request details
    logger_1.default.info('Request received', {
        method: req.method,
        path: req.path,
        requestId: req.headers['x-request-id'],
        ip: req.ip
    });
    // Log response details when completed
    res.on('finish', () => {
        const duration = Date.now() - startTime;
        const logLevel = res.statusCode >= 500
            ? 'error'
            : res.statusCode >= 400
                ? 'warn'
                : 'info';
        logger_1.default[logLevel]('Request completed', {
            method: req.method,
            path: req.path,
            statusCode: res.statusCode,
            duration,
            requestId: req.headers['x-request-id']
        });
    });
    next();
});
// Apply security middleware
app.use((0, helmet_1.default)());
// Configure CORS
app.use((0, cors_1.default)({
    origin: '*', // For development; restrict to specific origins in production
    methods: ['GET', 'POST'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-API-Key', 'X-Request-ID'],
    exposedHeaders: ['Authorization']
}));
// Parse JSON request bodies
// app.use(express.json({ limit: '1mb' }));
app.use(express_1.default.text({ type: 'application/json' }));
app.use((req, res, next) => {
    if (req.body && typeof req.body === 'string') {
        try {
            req.body = JSON.parse(req.body);
        }
        catch (e) {
            // Log but continue
            console.warn('Failed to parse JSON body', e);
        }
    }
    next();
});
// Apply routes
app.use('/', routes_1.default);
// Error handler
app.use((err, req, res, next) => {
    logger_1.default.error('Unhandled error', {
        error: err.message,
        stack: err.stack,
        requestId: req.headers['x-request-id']
    });
    res.status(500).json({
        error: {
            code: 'INTERNAL_SERVER_ERROR',
            message: 'An unexpected error occurred',
            requestId: req.headers['x-request-id'],
            timestamp: Date.now()
        }
    });
});
exports.default = app;
