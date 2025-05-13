"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const StateService_1 = __importDefault(require("../../services/StateService"));
const logger_1 = __importDefault(require("../../utils/logger"));
const uuid_1 = require("uuid");
const path_1 = __importDefault(require("path"));
const fs_1 = __importDefault(require("fs"));
/**
 * Controller for keygen-related endpoints
 */
class KeygenController {
    constructor() {
        // Session UUIDs for key generation and signing
        // Use standard UUID format with hyphens to match what the Rust client expects
        this.keygenUuid = (0, uuid_1.v4)();
        this.signUuid = (0, uuid_1.v4)();
    }
    /**
     * Sign up for key generation
     */
    async signupKeygen(req, res) {
        try {
            console.log('Keygen signup request received');
            // Read parameters from params.json file (matching Rust implementation)
            let params;
            try {
                // Find params.json at the project root
                const paramsPath = path_1.default.join(process.cwd(), '../../params.json');
                // Fallback to a few other potential locations if not found
                const fallbackPaths = [
                    path_1.default.join(process.cwd(), '../params.json'),
                    path_1.default.join(process.cwd(), 'params.json'),
                    path_1.default.join(__dirname, '../../../params.json'),
                    path_1.default.join(__dirname, '../../../../params.json')
                ];
                let paramsFile;
                if (fs_1.default.existsSync(paramsPath)) {
                    paramsFile = JSON.parse(fs_1.default.readFileSync(paramsPath, 'utf-8'));
                }
                else {
                    // Try fallback paths
                    for (const p of fallbackPaths) {
                        if (fs_1.default.existsSync(p)) {
                            paramsFile = JSON.parse(fs_1.default.readFileSync(p, 'utf-8'));
                            logger_1.default.info(`Found params.json at ${p}`);
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
                logger_1.default.info('Read params.json successfully', { params });
            }
            catch (error) {
                logger_1.default.error('Failed to read params.json file', { error });
                res.status(500).json({
                    Err: null
                });
                return;
            }
            const { parties } = params;
            // Get current signup state
            const signupKey = 'signup-keygen';
            const currentSignup = await StateService_1.default.getSignupState(signupKey);
            let partySignup;
            if (currentSignup) {
                // If we already have signups, increment the party number
                if (currentSignup.number < parties) {
                    partySignup = {
                        number: currentSignup.number + 1,
                        uuid: currentSignup.uuid // Use the SAME UUID for all parties
                    };
                }
                else {
                    // If we've reached the max parties, reset with a new UUID
                    this.keygenUuid = (0, uuid_1.v4)(); // Generate standard UUID with hyphens
                    partySignup = {
                        number: 1,
                        uuid: this.keygenUuid
                    };
                }
            }
            else {
                // First signup for this session
                partySignup = {
                    number: 1,
                    uuid: this.keygenUuid
                };
            }
            // Save the updated signup state
            await StateService_1.default.setSignupState(signupKey, partySignup);
            logger_1.default.info('Returning party signup', { partySignup });
            // Return the party signup information to the client
            res.status(200).json({ Ok: partySignup });
        }
        catch (error) {
            logger_1.default.error('Keygen signup failed', { error: error.message });
            res.status(500).json({ Err: null });
        }
    }
    /**
     * Sign up for signing
     */
    async signupSign(req, res) {
        try {
            console.log('Sign signup request received');
            // Read parameters from params.json file (matching Rust implementation)
            let params;
            try {
                // Find params.json at the project root
                const paramsPath = path_1.default.join(process.cwd(), '../../params.json');
                // Fallback to a few other potential locations if not found
                const fallbackPaths = [
                    path_1.default.join(process.cwd(), '../params.json'),
                    path_1.default.join(process.cwd(), 'params.json'),
                    path_1.default.join(__dirname, '../../../params.json'),
                    path_1.default.join(__dirname, '../../../../params.json')
                ];
                let paramsFile;
                if (fs_1.default.existsSync(paramsPath)) {
                    paramsFile = JSON.parse(fs_1.default.readFileSync(paramsPath, 'utf-8'));
                }
                else {
                    // Try fallback paths
                    for (const p of fallbackPaths) {
                        if (fs_1.default.existsSync(p)) {
                            paramsFile = JSON.parse(fs_1.default.readFileSync(p, 'utf-8'));
                            logger_1.default.info(`Found params.json at ${p}`);
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
                logger_1.default.info('Read params.json successfully', { params });
            }
            catch (error) {
                logger_1.default.error('Failed to read params.json file', { error });
                res.status(500).json({
                    Err: null
                });
                return;
            }
            const { threshold } = params;
            // Get current signup state
            const signupKey = 'signup-sign';
            const currentSignup = await StateService_1.default.getSignupState(signupKey);
            let partySignup;
            if (currentSignup) {
                // If we already have signups, increment the party number
                if (currentSignup.number < threshold + 1) {
                    partySignup = {
                        number: currentSignup.number + 1,
                        uuid: currentSignup.uuid // Use the SAME UUID for all parties
                    };
                }
                else {
                    // If we've reached the max parties, reset with a new UUID
                    this.signUuid = (0, uuid_1.v4)(); // Generate standard UUID with hyphens
                    partySignup = {
                        number: 1,
                        uuid: this.signUuid
                    };
                }
            }
            else {
                // First signup for this session
                partySignup = {
                    number: 1,
                    uuid: this.signUuid
                };
            }
            // Save the updated signup state
            await StateService_1.default.setSignupState(signupKey, partySignup);
            logger_1.default.info('Returning party signup', { partySignup });
            // Return the party signup information to the client
            res.status(200).json({ Ok: partySignup });
        }
        catch (error) {
            logger_1.default.error('Sign signup failed', { error: error.message });
            res.status(500).json({ Err: null });
        }
    }
}
// Create a singleton instance
const keygenController = new KeygenController();
exports.default = keygenController;
