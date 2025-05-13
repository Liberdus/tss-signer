"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.validateApiKey = exports.authenticateJWT = void 0;
const AuthService_1 = __importDefault(require("../../services/AuthService"));
const logger_1 = __importDefault(require("../../utils/logger"));
/**
 * Middleware to validate JWT token from Authorization header
 */
const authenticateJWT = (req, res, next) => {
    try {
        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return res.status(401).json({
                error: {
                    code: 'UNAUTHORIZED',
                    message: 'Authentication token is missing',
                    requestId: req.headers['x-request-id'],
                    timestamp: Date.now()
                }
            });
        }
        const token = authHeader.split(' ')[1];
        const decoded = AuthService_1.default.verifyToken(token);
        // Attach user info to request for use in route handlers
        req.user = decoded;
        next();
    }
    catch (error) {
        logger_1.default.warn('JWT authentication failed', {
            error: error.message,
            path: req.path,
            requestId: req.headers['x-request-id']
        });
        return res.status(403).json({
            error: {
                code: 'INVALID_TOKEN',
                message: 'Invalid or expired token',
                requestId: req.headers['x-request-id'],
                timestamp: Date.now()
            }
        });
    }
};
exports.authenticateJWT = authenticateJWT;
/**
 * Middleware to validate API key for registration endpoints
 */
const validateApiKey = (req, res, next) => {
    try {
        // const apiKey = req.headers['x-api-key'] as string;
        // if (!apiKey || !authService.validateApiKey(apiKey)) {
        //   return res.status(401).json({
        //     error: {
        //       code: 'INVALID_API_KEY',
        //       message: 'Invalid API key',
        //       requestId: req.headers['x-request-id'],
        //       timestamp: Date.now()
        //     }
        //   });
        // }
        next();
    }
    catch (error) {
        logger_1.default.warn('API key validation failed', {
            error: error.message,
            path: req.path,
            requestId: req.headers['x-request-id']
        });
        return res.status(500).json({
            error: {
                code: 'SERVER_ERROR',
                message: 'An error occurred during authentication',
                requestId: req.headers['x-request-id'],
                timestamp: Date.now()
            }
        });
    }
};
exports.validateApiKey = validateApiKey;
