import { Request, Response, NextFunction } from 'express';
import { RateLimiterMemory } from 'rate-limiter-flexible';
import config from '../../config';
import logger from '../../utils/logger';

// Create rate limiters
const apiKeyRateLimiter = new RateLimiterMemory({
  points: config.security.rateLimitMaxRequests / 2, // Stricter limits for API key endpoints
  duration: config.security.rateLimitWindowMs / 1000,
});

const authenticatedRateLimiter = new RateLimiterMemory({
  points: config.security.rateLimitMaxRequests,
  duration: config.security.rateLimitWindowMs / 1000,
});

// Rate limiting middleware for API key endpoints
export const apiKeyRateLimit = async (req: Request, res: Response, next: NextFunction) => {
  try {
    // Use IP as key for rate limiting, with fallback to a default value
    const key = req.ip || 'unknown-ip';
    await apiKeyRateLimiter.consume(key);
    next();
  } catch (error) {
    logger.warn('Rate limit exceeded for API key endpoint', {
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

// Rate limiting middleware for authenticated endpoints
export const authenticatedRateLimit = async (req: Request, res: Response, next: NextFunction) => {
  try {
    // If user is authenticated, use sessionId + partyId as key
    // Otherwise, fall back to IP with a default if IP is undefined
    const key = req.user 
      ? `${req.user.sessionId}:${req.user.partyId}` 
      : (req.ip || 'unknown-ip');
      
    await authenticatedRateLimiter.consume(key);
    next();
  } catch (error) {
    logger.warn('Rate limit exceeded for authenticated endpoint', {
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