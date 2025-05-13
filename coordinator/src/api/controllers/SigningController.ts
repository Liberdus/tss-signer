import { Request, Response } from 'express';
import Joi from 'joi';
import stateService from '../../services/StateService';
import authService from '../../services/AuthService';
import logger from '../../utils/logger';
import { PartySignup } from '../../models/types';

/**
 * Controller for signing-related endpoints
 */
export class SigningController {
  /**
   * Sign up for signing process
   */
  async signupSign(req: Request, res: Response): Promise<void> {
    try {
      // Validate request body
      const schema = Joi.object({
        threshold: Joi.number().integer().min(1).required(),
        parties: Joi.number().integer().min(2).required(),
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
      const session = await stateService.createSigningSession(threshold, parties);
      
      // Register this party in the session
      const partyId = await stateService.registerParty(session.id);
      
      // Generate JWT token for this party
      const token = authService.generateToken(session.id, partyId);
      
      // Create party signup response
      const response: PartySignup = {
        number: partyId,
        uuid: session.id,
        // sessionId: session.id,
        // timestamp: Date.now(),
        // expiresAt: session.expiresAt
      };

      // Log successful signup
      logger.info('Signing party registered', {
        sessionId: session.id,
        partyId,
        threshold,
        parties
      });

      // Return response with token in header
      res.setHeader('Authorization', `Bearer ${token}`);
      res.status(201).json(response);
    } catch (error: any) {
      logger.error('Signing signup failed', { error: error.message });
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