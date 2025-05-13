# TSS Coordinator Node

A secure, highly available coordinator implementation for Threshold Signature Scheme (TSS) in Node.js, designed to replace the single-point-of-failure server manager in the original Rust implementation.

## Features

- **Distributed Architecture**: Multiple coordinator nodes work together for high availability
- **Secure Communication**: JWT-based authentication and authorization
- **State Synchronization**: Redis-based distributed state management
- **Load Balancing**: NGINX load balancer for distributing requests
- **Rate Limiting**: Protection against DoS attacks
- **Detailed Logging**: Structured logging for monitoring and debugging
- **Docker Ready**: Easy deployment with Docker and Docker Compose

## Prerequisites

- Node.js 18+ (for development)
- Docker and Docker Compose (for containerized deployment)
- Redis (automatically set up with Docker Compose)

## Getting Started

### Local Development

1. Install dependencies:
   ```bash
   npm install
   ```

2. Create a `.env` file based on `.env.example`:
   ```bash
   cp .env.example .env
   ```

3. Start Redis locally or use Docker:
   ```bash
   docker run -d -p 6379:6379 redis:alpine
   ```

4. Run the development server:
   ```bash
   npm run dev
   ```

### Docker Deployment

Use Docker Compose to start the entire system:

```bash
docker-compose up -d
```

This will start:
- 3 coordinator nodes (ports 8000, 8001, 8002)
- Redis instance (port 6379)
- NGINX load balancer (port 80)

## API Endpoints

### Public Endpoints

- `GET /health`: Check service health

### Authentication Required Endpoints

All endpoints except `/health` require authentication:

- For signup endpoints (`/signupkeygen`, `/signupsign`): API Key via `X-API-Key` header
- For communication endpoints (`/get`, `/set`): JWT via `Authorization: Bearer <token>` header

### Endpoints

- `POST /signupkeygen`: Register for key generation
  - Request: `{ "threshold": number, "parties": number }`
  - Response: `{ "number": number, "uuid": string, "sessionId": string, "timestamp": number, "expiresAt": number }`

- `POST /signupsign`: Register for signing
  - Request: `{ "threshold": number, "parties": number }`
  - Response: `{ "number": number, "uuid": string, "sessionId": string, "timestamp": number, "expiresAt": number }`

- `POST /get`: Get a message by key
  - Request: `{ "key": string }`
  - Response: `{ "key": string, "value": string }`

- `POST /set`: Set a message
  - Request: `{ "key": string, "value": string }`
  - Response: `{ "success": true }`

## Integration with TSS-WASM

To integrate this coordinator with the TSS-WASM library:

1. Update the client-side code to use the new API endpoints
2. Adapt the communication protocols to include JWT authentication
3. Use the load balancer endpoint instead of the single server manager

## Error Handling

All API responses use structured error format:

```json
{
  "error": {
    "code": "ERROR_CODE",
    "message": "Human readable error message",
    "requestId": "unique-request-id",
    "timestamp": 1620000000000
  }
}
```

## Architecture

```
┌─────────────────────────┐
│     NGINX (Port 80)     │
└───────────┬─────────────┘
            │
┌───────────┼───────────────────────────┐
│           │                           │
│  ┌────────▼───────┐  ┌────────────┐   │
│  │ Coordinator 1  │  │    Redis   │   │
│  └────────────────┘  └──────┬─────┘   │
│                             │         │
│  ┌────────────────┐         │         │
│  │ Coordinator 2  ◄─────────┘         │
│  └────────────────┘                   │
│                                       │
│  ┌────────────────┐                   │
│  │ Coordinator 3  │                   │
│  └────────────────┘                   │
│                                       │
└───────────────────────────────────────┘
```

## Security Considerations

- JWT tokens are used for authentication
- API keys are used for initial registration
- All communications should be over HTTPS in production
- Redis should be password-protected in production
- Docker containers run as non-root users
- Rate limiting is applied to all endpoints

## Production Deployment

For production, you should:

1. Use a managed Redis service with proper security
2. Set secure values for JWT_SECRET and API_KEY
3. Configure proper SSL termination in NGINX
4. Set up monitoring and alerts
5. Implement backup and disaster recovery procedures