import dotenv from 'dotenv';
import path from 'path';

// Load environment variables from .env file
dotenv.config();

const config = {
  server: {
    port: parseInt(process.env.PORT || '8000', 10),
    environment: process.env.NODE_ENV || 'development',
  },
  redis: {
    url: process.env.REDIS_URL || 'redis://localhost:6379',
    password: process.env.REDIS_PASSWORD || '',
    sentinelName: process.env.REDIS_SENTINEL_NAME || 'mymaster',
    sentinelUrls: process.env.REDIS_SENTINEL_URLS ? 
      process.env.REDIS_SENTINEL_URLS.split(',') : 
      ['localhost:26379', 'localhost:26380', 'localhost:26381'],
  },
  auth: {
    jwtSecret: process.env.JWT_SECRET || 'development-secret-key',
    jwtExpiration: process.env.JWT_EXPIRATION || '1h',
    apiKey: process.env.API_KEY || 'development-api-key',
  },
  security: {
    rateLimitWindowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS || '60000', 10),
    rateLimitMaxRequests: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS || '100', 10),
  },
  logging: {
    level: process.env.LOG_LEVEL || 'info',
  },
  session: {
    ttl: parseInt(process.env.SESSION_TTL || '3600', 10),
  },
};

// Validate required configuration
const validateConfig = () => {
  const requiredVars = [
    { key: 'auth.jwtSecret', value: config.auth.jwtSecret, default: 'development-secret-key' },
    { key: 'auth.apiKey', value: config.auth.apiKey, default: 'development-api-key' }
  ];

  // In production, ensure we don't use default values for sensitive config
  if (config.server.environment === 'production') {
    const issues = requiredVars.filter(v => v.value === v.default);
    if (issues.length > 0) {
      throw new Error(`Missing required configuration in production: ${issues.map(i => i.key).join(', ')}`);
    }
  }
};

// Validate config when imported
validateConfig();

export default config;