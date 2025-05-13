"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.SigningController = void 0;
const joi_1 = __importDefault(require("joi"));
const StateService_1 = __importDefault(require("../../services/StateService"));
const AuthService_1 = __importDefault(require("../../services/AuthService"));
const logger_1 = __importDefault(require("../../utils/logger"));
/**
 * Controller for signing-related endpoints
 */
class SigningController {
    /**
     * Sign up for signing process
     */
    async signupSign(req, res) {
        try {
            // Validate request body
            const schema = joi_1.default.object({
                threshold: joi_1.default.number().integer().min(1).required(),
                parties: joi_1.default.number().integer().min(2).required(),
            });
            const { error, value } = schema.validate(req.body);
            if (error) {
                res.status(400).json({
                    error: {
                        code: 'INVALID_REQUEST',
                        message: error.message,
                        requestId: req.headers['x-request-id'],
                        timestamp: Date.now()
                    }
                });
                return;
            }
            const { threshold, parties } = value;
            // Create signing session
            const session = await StateService_1.default.createSigningSession(threshold, parties);
            // Register this party in the session
            const partyId = await StateService_1.default.registerParty(session.id);
            // Generate JWT token for this party
            const token = AuthService_1.default.generateToken(session.id, partyId);
            // Create party signup response
            const response = {
                number: partyId,
                uuid: session.id,
                // sessionId: session.id,
                // timestamp: Date.now(),
                // expiresAt: session.expiresAt
            };
            // Log successful signup
            logger_1.default.info('Signing party registered', {
                sessionId: session.id,
                partyId,
                threshold,
                parties
            });
            // Return response with token in header
            res.setHeader('Authorization', `Bearer ${token}`);
            res.status(201).json(response);
        }
        catch (error) {
            logger_1.default.error('Signing signup failed', { error: error.message });
            res.status(500).json({
                error: {
                    code: 'SERVER_ERROR',
                    message: 'Failed to register for signing',
                    requestId: req.headers['x-request-id'],
                    timestamp: Date.now()
                }
            });
        }
    }
}
exports.SigningController = SigningController;
