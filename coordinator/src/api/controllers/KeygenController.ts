import { Request, Response } from 'express';
import Joi from 'joi';
import stateService from '../../services/StateService';
import authService from '../../services/AuthService';
import logger from '../../utils/logger';
import { PartySignup } from '../../models/types';
import { v4 as uuidv4 } from 'uuid';
import path from 'path';
import fs from 'fs';

/**
 * Controller for keygen-related endpoints
 */
class KeygenController {
  // Session UUIDs for key generation and signing
  // Use standard UUID format with hyphens to match what the Rust client expects
  private keygenUuid: string = uuidv4();
  private signUuid: string = uuidv4();
  
  /**
   * Sign up for key generation
   */
  async signupKeygen(req: Request, res: Response): Promise<void> {
    try {
      console.log('Keygen signup request received');
      
      // Read parameters from params.json file (matching Rust implementation)
      let params;
      try {
        // Find params.json at the project root
        const paramsPath = path.join(process.cwd(), '../../params.json');
        
        // Fallback to a few other potential locations if not found
        const fallbackPaths = [
          path.join(process.cwd(), '../params.json'),
          path.join(process.cwd(), 'params.json'),
          path.join(__dirname, '../../../params.json'),
          path.join(__dirname, '../../../../params.json')
        ];
        
        let paramsFile;
        if (fs.existsSync(paramsPath)) {
          paramsFile = JSON.parse(fs.readFileSync(paramsPath, 'utf-8'));
        } else {
          // Try fallback paths
          for (const p of fallbackPaths) {
            if (fs.existsSync(p)) {
              paramsFile = JSON.parse(fs.readFileSync(p, 'utf-8'));
              logger.info(`Found params.json at ${p}`);
              break;
            }
          }
        }
        
        if (!paramsFile) {
          throw new Error('Could not find params.json file');
        }
        
        params = {
          parties: parseInt(paramsFile.parties, 10)
        };
        
        logger.info('Read params.json successfully', { params });
      } catch (error) {
        logger.error('Failed to read params.json file', { error });
        res.status(500).json({
          Err: null
        });
        return;
      }
      
      const { parties } = params;
      
      // Get current signup state
      const signupKey = 'signup-keygen';
      const currentSignup = await stateService.getSignupState(signupKey);
      
      let partySignup;
      if (currentSignup) {
        // If we already have signups, increment the party number
        if (currentSignup.number < parties) {
          partySignup = {
            number: currentSignup.number + 1,
            uuid: currentSignup.uuid  // Use the SAME UUID for all parties
          };
        } else {
          // If we've reached the max parties, reset with a new UUID
          this.keygenUuid = uuidv4();  // Generate standard UUID with hyphens
          partySignup = {
            number: 1,
            uuid: this.keygenUuid
          };
        }
      } else {
        // First signup for this session
        partySignup = {
          number: 1,
          uuid: this.keygenUuid
        };
      }
      
      // Save the updated signup state
      await stateService.setSignupState(signupKey, partySignup);
      
      logger.info('Returning party signup', { partySignup });
      
      // Return the party signup information to the client
      res.status(200).json({ Ok: partySignup });
    } catch (error: any) {
      logger.error('Keygen signup failed', { error: error.message });
      res.status(500).json({ Err: null });
    }
  }

  /**
   * Sign up for signing
   */
  async signupSign(req: Request, res: Response): Promise<void> {
    try {
      console.log('Sign signup request received');
      
      // Read parameters from params.json file (matching Rust implementation)
      let params;
      try {
        // Find params.json at the project root
        const paramsPath = path.join(process.cwd(), '../../params.json');
        
        // Fallback to a few other potential locations if not found
        const fallbackPaths = [
          path.join(process.cwd(), '../params.json'),
          path.join(process.cwd(), 'params.json'),
          path.join(__dirname, '../../../params.json'),
          path.join(__dirname, '../../../../params.json')
        ];
        
        let paramsFile;
        if (fs.existsSync(paramsPath)) {
          paramsFile = JSON.parse(fs.readFileSync(paramsPath, 'utf-8'));
        } else {
          // Try fallback paths
          for (const p of fallbackPaths) {
            if (fs.existsSync(p)) {
              paramsFile = JSON.parse(fs.readFileSync(p, 'utf-8'));
              logger.info(`Found params.json at ${p}`);
              break;
            }
          }
        }
        
        if (!paramsFile) {
          throw new Error('Could not find params.json file');
        }
        
        params = {
          threshold: parseInt(paramsFile.threshold, 10)
        };
        
        logger.info('Read params.json successfully', { params });
      } catch (error) {
        logger.error('Failed to read params.json file', { error });
        res.status(500).json({
          Err: null
        });
        return;
      }
      
      const { threshold } = params;
      
      // Get current signup state
      const signupKey = 'signup-sign';
      const currentSignup = await stateService.getSignupState(signupKey);
      
      let partySignup;
      if (currentSignup) {
        // If we already have signups, increment the party number
        if (currentSignup.number < threshold + 1) {
          partySignup = {
            number: currentSignup.number + 1,
            uuid: currentSignup.uuid  // Use the SAME UUID for all parties
          };
        } else {
          // If we've reached the max parties, reset with a new UUID
          this.signUuid = uuidv4();  // Generate standard UUID with hyphens
          partySignup = {
            number: 1,
            uuid: this.signUuid
          };
        }
      } else {
        // First signup for this session
        partySignup = {
          number: 1,
          uuid: this.signUuid
        };
      }
      
      // Save the updated signup state
      await stateService.setSignupState(signupKey, partySignup);
      
      logger.info('Returning party signup', { partySignup });
      
      // Return the party signup information to the client
      res.status(200).json({ Ok: partySignup });
    } catch (error: any) {
      logger.error('Sign signup failed', { error: error.message });
      res.status(500).json({ Err: null });
    }
  }
}

// Create a singleton instance
const keygenController = new KeygenController();
export default keygenController;