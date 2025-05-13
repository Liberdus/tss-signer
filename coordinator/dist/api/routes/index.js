"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const KeygenController_1 = __importDefault(require("../controllers/KeygenController"));
const SigningController_1 = require("../controllers/SigningController");
const MessageController_1 = require("../controllers/MessageController");
// Create controller instances
const signingController = new SigningController_1.SigningController();
const messageController = new MessageController_1.MessageController();
// Create Router
const router = (0, express_1.Router)();
// Health check endpoint (public)
router.get('/health', (req, res) => {
    res.status(200).json({ status: 'ok', timestamp: Date.now() });
});
// Session creation endpoints - require API key with stricter rate limits
router.post('/signupkeygen', KeygenController_1.default.signupKeygen.bind(KeygenController_1.default));
router.post('/signupsign', KeygenController_1.default.signupSign.bind(KeygenController_1.default));
// Session communication endpoints - adjust for Rust client compatibility
router.post('/get', messageController.getMessage);
router.post('/set', messageController.setMessage);
// Commented out JWT authentication for compatibility with Rust client
// router.post('/get', authenticateJWT, authenticatedRateLimit, messageController.getMessage);
// router.post('/set', authenticateJWT, authenticatedRateLimit, messageController.setMessage);
exports.default = router;
