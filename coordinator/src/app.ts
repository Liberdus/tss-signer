import express, { Request, Response, NextFunction } from 'express';
import helmet from 'helmet';
import cors from 'cors';
import routes from './api/routes';
import config from './config';
import logger from './utils/logger';
import { v4 as uuidv4 } from 'uuid';

// Create Express app
const app = express();

// Add request ID middleware
app.use((req: Request, res: Response, next: NextFunction) => {
  req.headers['x-request-id'] = req.headers['x-request-id'] || uuidv4();
  next();
});

// Add request logging
app.use((req: Request, res: Response, next: NextFunction) => {
  const startTime = Date.now();
  
  // Log request details
  logger.info('Request received', {
    method: req.method,
    path: req.path,
    requestId: req.headers['x-request-id'],
    ip: req.ip
  });
  
  // Log response details when completed
  res.on('finish', () => {
    const duration = Date.now() - startTime;
    
    const logLevel = res.statusCode >= 500 
      ? 'error' 
      : res.statusCode >= 400 
        ? 'warn' 
        : 'info';
    
    logger[logLevel]('Request completed', {
      method: req.method,
      path: req.path,
      statusCode: res.statusCode,
      duration,
      requestId: req.headers['x-request-id']
    });
  });
  
  next();
});

// Apply security middleware
app.use(helmet());

// Configure CORS
app.use(cors({
  origin: '*', // For development; restrict to specific origins in production
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-API-Key', 'X-Request-ID'],
  exposedHeaders: ['Authorization']
}));

// Parse JSON request bodies
// app.use(express.json({ limit: '1mb' }));

app.use(express.text({ type: 'application/json' }));
app.use((req, res, next) => {
  if (req.body && typeof req.body === 'string') {
    try {
      req.body = JSON.parse(req.body);
    } catch (e) {
      // Log but continue
      console.warn('Failed to parse JSON body', e);
    }
  }
  next();
});

// Apply routes
app.use('/', routes);

// Error handler
app.use((err: Error, req: Request, res: Response, next: NextFunction) => {
  logger.error('Unhandled error', { 
    error: err.message, 
    stack: err.stack,
    requestId: req.headers['x-request-id']
  });
  
  res.status(500).json({
    error: {
      code: 'INTERNAL_SERVER_ERROR',
      message: 'An unexpected error occurred',
      requestId: req.headers['x-request-id'],
      timestamp: Date.now()
    }
  });
});

export default app;