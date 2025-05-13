"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const uuid_1 = require("uuid");
const config_1 = __importDefault(require("../config"));
const logger_1 = __importDefault(require("../utils/logger"));
/**
 * Service for handling authentication and authorization
 */
class AuthService {
    /**
     * Generate a JWT token for a party
     */
    generateToken(sessionId, partyId) {
        try {
            const payload = {
                sessionId,
                partyId,
                // Add a unique jti (JWT ID) to prevent token reuse
                jti: (0, uuid_1.v4)(),
                // Add issued at timestamp
                iat: Math.floor(Date.now() / 1000)
            };
            // Use type assertions to help TypeScript understand the types
            const secret = config_1.default.auth.jwtSecret;
            // Use the sign method with type assertions to bypass TypeScript's strictness
            return jsonwebtoken_1.default.sign(payload, secret, 
            // Using any type here to work around the typing issues
            { expiresIn: config_1.default.auth.jwtExpiration });
        }
        catch (error) {
            logger_1.default.error('Failed to generate token', { error: error.message });
            throw error;
        }
    }
    /**
     * Verify and decode a JWT token
     */
    verifyToken(token) {
        try {
            // Use the same type assertion approach as in the generateToken method
            const secret = config_1.default.auth.jwtSecret;
            const decoded = jsonwebtoken_1.default.verify(token, secret);
            if (!decoded.sessionId || !decoded.partyId) {
                throw new Error('Invalid token payload');
            }
            return {
                sessionId: decoded.sessionId,
                partyId: decoded.partyId
            };
        }
        catch (error) {
            logger_1.default.error('Token verification failed', { error: error.message });
            throw error;
        }
    }
    /**
     * Validate API key for initial registration endpoints
     */
    validateApiKey(apiKey) {
        return apiKey === config_1.default.auth.apiKey;
    }
}
// Create a singleton instance
const authService = new AuthService();
exports.default = authService;
