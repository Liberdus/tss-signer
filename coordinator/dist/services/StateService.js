"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const ioredis_1 = __importDefault(require("ioredis"));
const config_1 = __importDefault(require("../config"));
const logger_1 = __importDefault(require("../utils/logger"));
const types_1 = require("../models/types");
/**
 * Service for interacting with Redis for state management
 */
class StateService {
    constructor() {
        // Configure Redis client based on environment
        if (config_1.default.server.environment === 'production' && config_1.default.redis.sentinelUrls.length > 0) {
            // Use Redis Sentinel in production for high availability
            this.client = new ioredis_1.default({
                sentinels: config_1.default.redis.sentinelUrls.map(url => {
                    const [host, port] = url.split(':');
                    return { host, port: parseInt(port, 10) };
                }),
                name: config_1.default.redis.sentinelName,
                password: config_1.default.redis.password,
                keyPrefix: 'tss:',
            });
        }
        else {
            // Use direct Redis connection for development
            this.client = new ioredis_1.default(config_1.default.redis.url, {
                keyPrefix: 'tss:',
                password: config_1.default.redis.password,
            });
        }
        // Setup event handlers
        this.client.on('error', (err) => {
            logger_1.default.error('Redis error', { error: err.message });
        });
        this.client.on('connect', () => {
            logger_1.default.info('Connected to Redis');
        });
    }
    /**
     * Get a message by key from a specific session
     */
    async getMessage(sessionId, key) {
        try {
            const result = await this.client.hget(`session:${sessionId}:messages`, key);
            if (!result)
                return null;
            return JSON.parse(result);
        }
        catch (error) {
            logger_1.default.error('Failed to get message', { sessionId, key, error: error.message });
            throw error;
        }
    }
    /**
     * Store a message in a specific session
     */
    async setMessage(sessionId, key, value, sender) {
        try {
            const message = {
                key,
                value,
                timestamp: Date.now(),
                sender,
                sessionId,
            };
            // Store message and update TTL
            const pipeline = this.client.pipeline();
            pipeline.hset(`session:${sessionId}:messages`, key, JSON.stringify(message));
            pipeline.expire(`session:${sessionId}:messages`, config_1.default.session.ttl);
            await pipeline.exec();
            // Update party's lastSeen timestamp
            await this.updatePartyLastSeen(sessionId, sender);
        }
        catch (error) {
            logger_1.default.error('Failed to set message', { sessionId, key, error: error.message });
            throw error;
        }
    }
    /**
     * Get a message without session context (for Rust client compatibility)
     * Simple direct lookup with exact key match - no smart key lookup
     */
    async getMessageWithoutSession(key) {
        try {
            // Get message from Redis using the exact key - just like the Rust implementation
            const messageValue = await this.client.get(`message:${key}`);
            if (!messageValue) {
                // If message not found with exact key
                logger_1.default.debug('Message not found with exact key', { key });
                return null;
            }
            logger_1.default.debug('Message found with exact key', { key });
            return {
                key,
                value: messageValue
            };
        }
        catch (error) {
            logger_1.default.error('Failed to get message without session', { error, key });
            throw error;
        }
    }
    /**
     * Set a message without session context (for Rust client compatibility)
     */
    async setMessageWithoutSession(key, value) {
        try {
            // Store message in Redis with TTL to prevent memory leaks
            // Use the exact key format from the Rust client without modification
            await this.client.set(`message:${key}`, value, 'EX', config_1.default.session.ttl);
            logger_1.default.debug('Message set without session', { key });
        }
        catch (error) {
            logger_1.default.error('Failed to set message without session', { error, key });
            throw error;
        }
    }
    /**
     * Create or retrieve session for key generation
     */
    async createKeygenSession(threshold, parties) {
        try {
            const session = {
                id: await this.generateUniqueSessionId(),
                threshold,
                parties,
                createdAt: Date.now(),
                expiresAt: Date.now() + config_1.default.session.ttl * 1000,
                status: types_1.SessionStatus.KEYGEN,
            };
            // Store session metadata
            await this.client.set(`session:${session.id}:meta`, JSON.stringify(session), 'EX', config_1.default.session.ttl);
            return session;
        }
        catch (error) {
            logger_1.default.error('Failed to create keygen session', { error: error.message });
            throw error;
        }
    }
    /**
     * Create or retrieve session for signing
     */
    async createSigningSession(threshold, parties) {
        try {
            const session = {
                id: await this.generateUniqueSessionId(),
                threshold,
                parties,
                createdAt: Date.now(),
                expiresAt: Date.now() + config_1.default.session.ttl * 1000,
                status: types_1.SessionStatus.SIGNING,
            };
            // Store session metadata
            await this.client.set(`session:${session.id}:meta`, JSON.stringify(session), 'EX', config_1.default.session.ttl);
            return session;
        }
        catch (error) {
            logger_1.default.error('Failed to create signing session', { error: error.message });
            throw error;
        }
    }
    /**
     * Register a party in a session
     * Returns the party number (1-based index)
     */
    async registerParty(sessionId) {
        // Use Redis transaction to ensure atomic operations
        const luaScript = `
      local sessionKey = KEYS[1]
      local partiesKey = KEYS[2]
      
      -- Check if session exists
      local sessionData = redis.call('GET', sessionKey)
      if not sessionData then
        return {err = "Session not found"}
      end
      
      local session = cjson.decode(sessionData)
      local partyCount = redis.call('HLEN', partiesKey)
      
      -- Check if session is full
      if partyCount >= session.parties then
        return {err = "Session is full"}
      end
      
      -- Register party with next available ID
      local partyId = partyCount + 1
      local party = {
        id = partyId, 
        lastSeen = tonumber(ARGV[1]),
        sessionId = session.id
      }
      
      redis.call('HSET', partiesKey, partyId, cjson.encode(party))
      redis.call('EXPIRE', partiesKey, tonumber(ARGV[2]))
      
      return partyId
    `;
        try {
            const result = await this.client.eval(luaScript, 2, // Two keys
            `session:${sessionId}:meta`, `session:${sessionId}:parties`, Date.now().toString(), config_1.default.session.ttl.toString());
            if (result === null) {
                throw new Error('Unexpected null result from Redis');
            }
            if (typeof result === 'object' && 'err' in result) {
                throw new Error(result.err);
            }
            return result;
        }
        catch (error) {
            logger_1.default.error('Failed to register party', { sessionId, error: error.message });
            throw error;
        }
    }
    /**
     * Get session by ID
     */
    async getSession(sessionId) {
        try {
            const result = await this.client.get(`session:${sessionId}:meta`);
            if (!result)
                return null;
            return JSON.parse(result);
        }
        catch (error) {
            logger_1.default.error('Failed to get session', { sessionId, error: error.message });
            throw error;
        }
    }
    /**
     * Get party by ID in a session
     */
    async getParty(sessionId, partyId) {
        try {
            const result = await this.client.hget(`session:${sessionId}:parties`, partyId.toString());
            if (!result)
                return null;
            return JSON.parse(result);
        }
        catch (error) {
            logger_1.default.error('Failed to get party', { sessionId, partyId, error: error.message });
            throw error;
        }
    }
    /**
     * Update party's last seen timestamp
     */
    async updatePartyLastSeen(sessionId, partyId) {
        try {
            const party = await this.getParty(sessionId, partyId);
            if (!party) {
                throw new Error('Party not found');
            }
            party.lastSeen = Date.now();
            await this.client.hset(`session:${sessionId}:parties`, partyId.toString(), JSON.stringify(party));
        }
        catch (error) {
            logger_1.default.error('Failed to update party last seen', {
                sessionId, partyId, error: error.message
            });
            throw error;
        }
    }
    /**
     * Generate a unique session ID
     */
    async generateUniqueSessionId() {
        // UUID v4 would normally be used here, but we're using a simpler approach for demo
        const timestamp = Date.now();
        const random = Math.floor(Math.random() * 10000000);
        const sessionId = `${timestamp}-${random}`;
        // Check if this ID already exists (unlikely but possible)
        const exists = await this.client.exists(`session:${sessionId}:meta`);
        if (exists) {
            // Recursive call to generate a new ID
            return this.generateUniqueSessionId();
        }
        return sessionId;
    }
    /**
     * Clean up expired sessions (would be called by a scheduler)
     */
    async cleanupExpiredSessions() {
        try {
            // This would normally use a more sophisticated approach with SCAN
            // For demo purposes, we're using a simplified approach
            const sessionKeys = await this.client.keys('tss:session:*:meta');
            let expiredCount = 0;
            for (const key of sessionKeys) {
                const sessionData = await this.client.get(key);
                if (!sessionData)
                    continue;
                const session = JSON.parse(sessionData);
                if (session.expiresAt < Date.now()) {
                    // Session has expired, clean up related keys
                    const sessionId = session.id;
                    await this.client.del(`session:${sessionId}:meta`, `session:${sessionId}:parties`, `session:${sessionId}:messages`);
                    expiredCount++;
                }
            }
            return expiredCount;
        }
        catch (error) {
            logger_1.default.error('Failed to cleanup expired sessions', { error: error.message });
            throw error;
        }
    }
    /**
     * Get the current signup state for keygen or signing
     */
    async getSignupState(key) {
        try {
            const result = await this.client.get(`signup:${key}`);
            if (!result)
                return null;
            return JSON.parse(result);
        }
        catch (error) {
            logger_1.default.error('Failed to get signup state', { key, error });
            throw error;
        }
    }
    /**
     * Save the signup state for keygen or signing
     */
    async setSignupState(key, value) {
        try {
            await this.client.set(`signup:${key}`, JSON.stringify(value), 'EX', config_1.default.session.ttl);
            logger_1.default.debug('Signup state saved', { key, value });
        }
        catch (error) {
            logger_1.default.error('Failed to set signup state', { key, error });
            throw error;
        }
    }
}
// Create a singleton instance
const stateService = new StateService();
exports.default = stateService;
