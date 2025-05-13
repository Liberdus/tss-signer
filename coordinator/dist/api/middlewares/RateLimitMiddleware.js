"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.authenticatedRateLimit = exports.apiKeyRateLimit = void 0;
const rate_limiter_flexible_1 = require("rate-limiter-flexible");
const config_1 = __importDefault(require("../../config"));
const logger_1 = __importDefault(require("../../utils/logger"));
// Create rate limiters
const apiKeyRateLimiter = new rate_limiter_flexible_1.RateLimiterMemory({
    points: config_1.default.security.rateLimitMaxRequests / 2, // Stricter limits for API key endpoints
    duration: config_1.default.security.rateLimitWindowMs / 1000,
});
const authenticatedRateLimiter = new rate_limiter_flexible_1.RateLimiterMemory({
    points: config_1.default.security.rateLimitMaxRequests,
    duration: config_1.default.security.rateLimitWindowMs / 1000,
});
// Rate limiting middleware for API key endpoints
const apiKeyRateLimit = async (req, res, next) => {
    try {
        // Use IP as key for rate limiting, with fallback to a default value
        const key = req.ip || 'unknown-ip';
        await apiKeyRateLimiter.consume(key);
        next();
    }
    catch (error) {
        logger_1.default.warn('Rate limit exceeded for API key endpoint', {
            ip: req.ip,
            path: req.path,
            requestId: req.headers['x-request-id']
        });
        return res.status(429).json({
            error: {
                code: 'RATE_LIMIT_EXCEEDED',
                message: 'Too many requests, please try again later',
                requestId: req.headers['x-request-id'],
                timestamp: Date.now()
            }
        });
    }
};
exports.apiKeyRateLimit = apiKeyRateLimit;
// Rate limiting middleware for authenticated endpoints
const authenticatedRateLimit = async (req, res, next) => {
    try {
        // If user is authenticated, use sessionId + partyId as key
        // Otherwise, fall back to IP with a default if IP is undefined
        const key = req.user
            ? `${req.user.sessionId}:${req.user.partyId}`
            : (req.ip || 'unknown-ip');
        await authenticatedRateLimiter.consume(key);
        next();
    }
    catch (error) {
        logger_1.default.warn('Rate limit exceeded for authenticated endpoint', {
            user: req.user,
            ip: req.ip,
            path: req.path,
            requestId: req.headers['x-request-id']
        });
        return res.status(429).json({
            error: {
                code: 'RATE_LIMIT_EXCEEDED',
                message: 'Too many requests, please try again later',
                requestId: req.headers['x-request-id'],
                timestamp: Date.now()
            }
        });
    }
};
exports.authenticatedRateLimit = authenticatedRateLimit;
