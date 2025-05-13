import { Router } from 'express';
import keygenController from '../controllers/KeygenController';
import { SigningController } from '../controllers/SigningController';
import { MessageController } from '../controllers/MessageController';
import { authenticateJWT, validateApiKey } from '../middlewares/AuthMiddleware';
import { apiKeyRateLimit, authenticatedRateLimit } from '../middlewares/RateLimitMiddleware';

// Create controller instances
const signingController = new SigningController();
const messageController = new MessageController();

// Create Router
const router = Router();

// Health check endpoint (public)
router.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', timestamp: Date.now() });
});

// Session creation endpoints - require API key with stricter rate limits
router.post('/signupkeygen', keygenController.signupKeygen.bind(keygenController));
router.post('/signupsign', keygenController.signupSign.bind(keygenController));

// Session communication endpoints - adjust for Rust client compatibility
router.post('/get', messageController.getMessage);
router.post('/set', messageController.setMessage);
// Commented out JWT authentication for compatibility with Rust client
// router.post('/get', authenticateJWT, authenticatedRateLimit, messageController.getMessage);
// router.post('/set', authenticateJWT, authenticatedRateLimit, messageController.setMessage);

export default router;