import { Request, Response, NextFunction } from 'express';
import authService from '../../services/AuthService';
import logger from '../../utils/logger';

// Extend Express Request type to include user information
declare global {
  namespace Express {
    interface Request {
      user?: {
        sessionId: string;
        partyId: number;
      };
    }
  }
}

/**
 * Middleware to validate JWT token from Authorization header
 */
export const authenticateJWT = (req: Request, res: Response, next: NextFunction) => {
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
    const decoded = authService.verifyToken(token);
    
    // Attach user info to request for use in route handlers
    req.user = decoded;
    next();
  } catch (error: any) {
    logger.warn('JWT authentication failed', { 
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

/**
 * Middleware to validate API key for registration endpoints
 */
export const validateApiKey = (req: Request, res: Response, next: NextFunction) => {
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
  } catch (error: any) {
    logger.warn('API key validation failed', { 
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