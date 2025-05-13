import jwt from 'jsonwebtoken';
import { v4 as uuidv4 } from 'uuid';
import config from '../config';
import logger from '../utils/logger';

// Define a more specific type for the jwt.Secret
type JwtSecret = string | Buffer;

/**
 * Service for handling authentication and authorization
 */
class AuthService {
  /**
   * Generate a JWT token for a party
   */
  generateToken(sessionId: string, partyId: number): string {
    try {
      const payload = {
        sessionId,
        partyId,
        // Add a unique jti (JWT ID) to prevent token reuse
        jti: uuidv4(),
        // Add issued at timestamp
        iat: Math.floor(Date.now() / 1000)
      };

      // Use type assertions to help TypeScript understand the types
      const secret = config.auth.jwtSecret as JwtSecret;
      
      // Use the sign method with type assertions to bypass TypeScript's strictness
      return jwt.sign(
        payload, 
        secret, 
        // Using any type here to work around the typing issues
        { expiresIn: config.auth.jwtExpiration } as any
      );
    } catch (error: any) {
      logger.error('Failed to generate token', { error: error.message });
      throw error;
    }
  }

  /**
   * Verify and decode a JWT token
   */
  verifyToken(token: string): { sessionId: string; partyId: number } {
    try {
      // Use the same type assertion approach as in the generateToken method
      const secret = config.auth.jwtSecret as JwtSecret;
      const decoded = jwt.verify(token, secret) as jwt.JwtPayload;
      
      if (!decoded.sessionId || !decoded.partyId) {
        throw new Error('Invalid token payload');
      }

      return {
        sessionId: decoded.sessionId as string,
        partyId: decoded.partyId as number
      };
    } catch (error: any) {
      logger.error('Token verification failed', { error: error.message });
      throw error;
    }
  }

  /**
   * Validate API key for initial registration endpoints
   */
  validateApiKey(apiKey: string): boolean {
    return apiKey === config.auth.apiKey;
  }
}

// Create a singleton instance
const authService = new AuthService();
export default authService;