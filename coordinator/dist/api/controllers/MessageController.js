"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.MessageController = void 0;
const joi_1 = __importDefault(require("joi"));
const StateService_1 = __importDefault(require("../../services/StateService"));
const logger_1 = __importDefault(require("../../utils/logger"));
/**
 * Controller for message exchange between parties
 */
class MessageController {
    /**
     * Get a message by key
     */
    async getMessage(req, res) {
        var _a;
        try {
            // Get request values - support both JWT auth and direct request format
            // from the Rust client which doesn't use JWT
            let sessionId, partyId, key;
            if (req.user) {
                // User info from JWT token (via authenticateJWT middleware)
                sessionId = req.user.sessionId;
                partyId = req.user.partyId;
                key = req.body.key;
            }
            else {
                // Direct format used by Rust client
                const requestBody = req.body;
                key = requestBody.key;
                // In Rust client, there's no session/party ID in the request
                // Fetch the message directly without session validation
            }
            // Validate key is present
            if (!key) {
                logger_1.default.warn('Missing key in request', { body: req.body });
                res.status(400).json({
                    Err: null
                });
                return;
            }
            // Get message from state service - for Rust client, get without session ID
            const message = sessionId
                ? await StateService_1.default.getMessage(sessionId, key)
                : await StateService_1.default.getMessageWithoutSession(key);
            if (!message) {
                logger_1.default.warn('Message not found for key: ' + key);
                res.status(404).json({
                    Err: null
                });
                process.exit(1);
                return;
            }
            logger_1.default.debug('Message retrieved successfully', { key });
            // Update party's last seen timestamp if we have session info
            if (sessionId && partyId) {
                await StateService_1.default.updatePartyLastSeen(sessionId, partyId);
            }
            // Return the message in the format expected by Rust client
            if (req.user) {
                // Format for JWT authenticated requests
                res.status(200).json({
                    key: message.key,
                    value: message.value
                });
            }
            else {
                // Format response for Rust client (look at postb function in api.rs)
                res.status(200).json({
                    Ok: {
                        key: message.key,
                        value: message.value
                    }
                });
            }
        }
        catch (error) {
            logger_1.default.error('Get message failed', { error: error.message, key: (_a = req.body) === null || _a === void 0 ? void 0 : _a.key });
            res.status(500).json({
                Err: null
            });
        }
    }
    /**
     * Set a message by key
     */
    async setMessage(req, res) {
        var _a;
        try {
            // Support both JWT auth and direct request format from Rust client
            let sessionId, partyId, key, messageValue;
            if (req.user) {
                // User info from JWT token (via authenticateJWT middleware)
                sessionId = req.user.sessionId;
                partyId = req.user.partyId;
                // Validate request parameters for JWT auth
                const schema = joi_1.default.object({
                    key: joi_1.default.string().required(),
                    value: joi_1.default.string().required()
                });
                const { error, value } = schema.validate(req.body);
                if (error) {
                    logger_1.default.warn('Invalid request body for JWT auth', { error: error.message });
                    res.status(400).json({
                        Err: null
                    });
                    return;
                }
                key = value.key;
                messageValue = value.value;
            }
            else {
                // Direct format used by Rust client
                const requestBody = req.body;
                key = requestBody.key;
                messageValue = requestBody.value;
                if (!key || messageValue === undefined) {
                    logger_1.default.warn('Missing key or value in request', { body: req.body });
                    res.status(400).json({
                        Err: null
                    });
                    return;
                }
                // Log detailed information about the key for debugging
                const keyParts = key.split('-');
                if (keyParts.length >= 3) {
                    try {
                        const party = keyParts[0];
                        const round = keyParts[1];
                        const timestamp = keyParts[2];
                        const random = keyParts.length > 3 ? keyParts[3] : '';
                        // Use the special logger method for key tracking
                        logger_1.default.messageKeys('Message key received', {
                            fullKey: key,
                            party,
                            round,
                            timestamp,
                            random,
                            valueLength: messageValue.length
                        });
                    }
                    catch (e) {
                        logger_1.default.debug('Failed to parse message key parts', { key, error: e });
                    }
                }
            }
            logger_1.default.debug('Setting message', { key });
            // Set message in state service
            if (sessionId && partyId) {
                // For JWT authenticated clients
                await StateService_1.default.setMessage(sessionId, key, messageValue, partyId);
            }
            else {
                // For Rust client without session/party context
                await StateService_1.default.setMessageWithoutSession(key, messageValue);
            }
            logger_1.default.debug('Message set successfully', { key });
            // Return the response in the format expected by the client
            if (req.user) {
                // Format for JWT authenticated requests
                res.status(200).json({ success: true });
            }
            else {
                // Format for Rust client (based on Rust implementation)
                res.status(200).json({ Ok: null });
            }
        }
        catch (error) {
            logger_1.default.error('Set message failed', { error: error.message, key: (_a = req.body) === null || _a === void 0 ? void 0 : _a.key });
            res.status(500).json({
                Err: null
            });
        }
    }
}
exports.MessageController = MessageController;
