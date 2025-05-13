import { Request, Response } from 'express';
import Joi from 'joi';
import stateService from '../../services/StateService';
import logger from '../../utils/logger';

/**
 * Controller for message exchange between parties
 */
export class MessageController {
  /**
   * Get a message by key
   */
  async getMessage(req: Request, res: Response): Promise<void> {
    try {
      // Get request values - support both JWT auth and direct request format
      // from the Rust client which doesn't use JWT
      let sessionId, partyId, key;
      
      if (req.user) {
        // User info from JWT token (via authenticateJWT middleware)
        sessionId = req.user.sessionId;
        partyId = req.user.partyId;
        key = req.body.key;
      } else {
        // Direct format used by Rust client
        const requestBody = req.body;
        key = requestBody.key;
        // In Rust client, there's no session/party ID in the request
        // Fetch the message directly without session validation
      }

      // Validate key is present
      if (!key) {
        logger.warn('Missing key in request', { body: req.body });
        res.status(400).json({
          Err: null
        });
        return;
      }
      
      // Get message from state service - for Rust client, get without session ID
      const message = sessionId 
        ? await stateService.getMessage(sessionId, key)
        : await stateService.getMessageWithoutSession(key);
      
      if (!message) {
        logger.warn('Message not found for key: ' + key);
        res.status(404).json({
          Err: null
        });
        process.exit(1);
        return;
      }

      logger.debug('Message retrieved successfully', { key });

      // Update party's last seen timestamp if we have session info
      if (sessionId && partyId) {
        await stateService.updatePartyLastSeen(sessionId, partyId);
      }

      // Return the message in the format expected by Rust client
      if (req.user) {
        // Format for JWT authenticated requests
        res.status(200).json({
          key: message.key,
          value: message.value
        });
      } else {
        // Format response for Rust client (look at postb function in api.rs)
        res.status(200).json({ 
          Ok: { 
            key: message.key, 
            value: message.value 
          } 
        });
      }
    } catch (error: any) {
      logger.error('Get message failed', { error: error.message, key: req.body?.key });
      res.status(500).json({
        Err: null
      });
    }
  }

  /**
   * Set a message by key
   */
  async setMessage(req: Request, res: Response): Promise<void> {
    try {
      // Support both JWT auth and direct request format from Rust client
      let sessionId, partyId, key, messageValue;
      
      if (req.user) {
        // User info from JWT token (via authenticateJWT middleware)
        sessionId = req.user.sessionId;
        partyId = req.user.partyId;
        
        // Validate request parameters for JWT auth
        const schema = Joi.object({
          key: Joi.string().required(),
          value: Joi.string().required()
        });

        const { error, value } = schema.validate(req.body);
        if (error) {
          logger.warn('Erorr in request validation', error);
          res.status(400).json({
            Err: null
          });
          return;
        }

        key = value.key;
        messageValue = value.value;
      } else {
        // Direct format used by Rust client
        const requestBody = req.body;
        key = requestBody.key;
        messageValue = requestBody.value;
        
        if (!key || messageValue === undefined) {
          logger.warn('Missing key or value in request', { body: req.body });
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
            logger.messageKeys('Message key received', {
              fullKey: key,
              party,
              round,
              timestamp,
              random,
              valueLength: messageValue.length
            });
          } catch (e) {
            logger.debug('Failed to parse message key parts', { key, error: e });
          }
        }
      }

      logger.debug('Setting message', { key });

      // Set message in state service
      if (sessionId && partyId) {
        // For JWT authenticated clients
        await stateService.setMessage(sessionId, key, messageValue, partyId);
      } else {
        // For Rust client without session/party context
        await stateService.setMessageWithoutSession(key, messageValue);
      }
      
      logger.debug('Message set successfully', { key });
      
      // Return the response in the format expected by the client
      if (req.user) {
        // Format for JWT authenticated requests
        res.status(200).json({ success: true });
      } else {
        // Format for Rust client (based on Rust implementation)
        res.status(200).json({ Ok: null });
      }
    } catch (error: any) {
      logger.error('Set message failed', { error: error.message, key: req.body?.key });
      res.status(500).json({
        Err: null
      });
    }
  }
}