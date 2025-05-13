# Detailed Specification for Enhanced TSS Coordinator Nodes

## 1. System Overview

The coordinator nodes will enable secure communication between parties in a Threshold Signature Scheme (TSS) implementation while addressing the single point of failure in the current design.

### 1.1 Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                       Load Balancer                              │
└───────────────────────────────┬─────────────────────────────────┘
                                │
        ┌─────────────────────┬─┴───────────────┬─────────────────┐
        │                     │                 │                 │
┌───────▼───────┐     ┌───────▼───────┐  ┌──────▼────────┐  ┌─────▼─────────┐
│  Coordinator  │     │  Coordinator  │  │  Coordinator  │  │  Coordinator  │
│  Node 1       │◄───►│  Node 2       │◄─►│  Node 3      │◄─►│  Node N      │
└───────┬───────┘     └───────┬───────┘  └──────┬────────┘  └─────┬─────────┘
        │                     │                 │                 │
        └────────────────────►│                 │◄────────────────┘
                              │                 │
                      ┌───────▼─────────────────▼───────┐
                      │         Redis Cluster           │
                      └───────────────────────────────┬─┘
                                                      │
                                                ┌─────▼─────┐
                                                │  Backups  │
                                                └───────────┘
```

## 2. Key Requirements

### 2.1 Functional Requirements

1. **Message Exchange**: Enable secure message exchange between TSS parties
2. **Party Registration**: Provide party signup and ID assignment
3. **Session Management**: Support multiple concurrent TSS sessions
4. **High Availability**: Maintain service with node failures
5. **Data Consistency**: Ensure consistent state across coordinator nodes
6. **Authentication**: Verify identity of participating parties
7. **Authorization**: Control access to session data

### 2.2 Non-Functional Requirements

1. **Security**: Prevent unauthorized access to TSS communications
2. **Scalability**: Handle hundreds of concurrent sessions
3. **Performance**: Process messages with < 100ms latency
4. **Reliability**: 99.9% uptime with node failures
5. **Observability**: Comprehensive monitoring and logging
6. **Recovery**: Automatic recovery from failures

## 3. Detailed Component Specifications

### 3.1 API Layer

#### 3.1.1 Endpoints

| Endpoint | Method | Description | Auth Required |
|----------|--------|-------------|--------------|
| `/get` | POST | Retrieve message by key | Yes |
| `/set` | POST | Store message by key | Yes |
| `/signupkeygen` | POST | Register for key generation | Yes |
| `/signupsign` | POST | Register for signing | Yes |
| `/health` | GET | Service health check | No |
| `/metrics` | GET | Performance metrics | Yes (Admin) |

#### 3.1.2 Request/Response Formats

```typescript
// GET Request
interface GetRequest {
  key: string;
  sessionId: string;
}

// GET Response
interface GetResponse {
  key: string;
  value: string;
  timestamp: number;
}

// SET Request
interface SetRequest {
  key: string;
  value: string;
  sessionId: string;
  ttl?: number; // Optional TTL in seconds
}

// Signup Response
interface PartySignup {
  number: number;
  uuid: string;
  sessionId: string;
  timestamp: number;
  expiresAt: number;
}
```

### 3.2 Authentication System

1. **JWT-based Authentication**:
   - Each party receives a session token during registration
   - Tokens include sessionId, partyId, and expiration
   - Tokens are signed with coordinator private key

2. **API Key Authentication** (for initial registration):
   - Pre-shared API keys for trusted parties
   - Rate limiting to prevent abuse

### 3.3 State Management

1. **Distributed Redis Store**:
   - Primary data store for all coordinator nodes
   - Data organization using Redis hash structures:
     - `session:{sessionId}:meta` - Session metadata
     - `session:{sessionId}:messages` - Message storage
     - `session:{sessionId}:parties` - Party information

2. **Data Structure**:
   ```
   session:{uuid}:meta = {
     threshold: 2,
     parties: 3,
     createdAt: timestamp,
     expiresAt: timestamp,
     status: "keygen|signing|completed"
   }
   
   session:{uuid}:parties = {
     party1: { id: 1, publicKey: "...", lastSeen: timestamp },
     party2: { id: 2, publicKey: "...", lastSeen: timestamp }
   }
   
   session:{uuid}:messages:{key} = {
     value: "...",
     timestamp: timestamp,
     sender: partyId
   }
   ```

3. **Data Consistency**:
   - Redis transactions for atomic operations
   - Optimistic locking for party registration

### 3.4 Reliability Features

1. **Node Synchronization**:
   - Heartbeat mechanism between nodes
   - Leader election for coordinated operations
   - Automatic failover using Redis Sentinel

2. **Data Persistence**:
   - Redis AOF (Append-Only File) persistence
   - Regular RDB snapshots
   - Backup to external storage

3. **Session Cleanup**:
   - Automatic expiration of inactive sessions
   - Configurable TTL for all data types

### 3.5 Security Measures

1. **Transport Security**:
   - TLS 1.3 for all communications
   - Certificate pinning for known clients
   - Forward secrecy support

2. **Access Control**:
   - Granular permissions for each party
   - Access only to own session data
   - Message authentication codes (MACs)

3. **Protection Mechanisms**:
   - Rate limiting
   - Input validation
   - Brute force protection
   - Regular security audits

### 3.6 Monitoring & Logging

1. **Health Metrics**:
   - CPU/Memory usage
   - Request latency
   - Error rates
   - Queue lengths

2. **Structured Logging**:
   - Request IDs for tracing
   - Session activity logs
   - Error reporting
   - Audit logs for security events

3. **Alerting**:
   - Anomaly detection
   - Threshold-based alerts
   - On-call rotation

## 4. Implementation Guidelines

### 4.1 Technology Stack

1. **Backend**:
   - Node.js with Express.js or NestJS
   - TypeScript for type safety

2. **State Management**:
   - Redis Cluster for distributed storage
   - Redis Sentinel for high availability

3. **Security**:
   - jose/jwt for JWT handling
   - helmet for HTTP security headers
   - rate-limiter-flexible for rate limiting

4. **Deployment**:
   - Docker containers
   - Kubernetes for orchestration
   - Helm charts for deployment

### 4.2 Code Organization

```
/src
  /api
    /controllers
      KeygenController.ts
      SigningController.ts
      MessageController.ts
    /middlewares
      AuthMiddleware.ts
      RateLimitMiddleware.ts
      ValidationMiddleware.ts
    /routes
      index.ts
  /services
    StateService.ts
    AuthService.ts
    SessionService.ts
    MetricsService.ts
  /models
    Session.ts
    Message.ts
    Party.ts
  /config
    index.ts
  /utils
    crypto.ts
    logging.ts
  app.ts
  server.ts
```

### 4.3 Error Handling Strategy

1. **Structured Error Responses**:
   ```json
   {
     "error": {
       "code": "SESSION_NOT_FOUND",
       "message": "The requested session does not exist",
       "requestId": "req-123456",
       "timestamp": 1620000000000
     }
   }
   ```

2. **Error Categories**:
   - Authentication errors (401)
   - Authorization errors (403)
   - Client errors (400)
   - Server errors (500)
   - Rate limiting errors (429)

### 4.4 Deployment Guidelines

1. **Environment Configuration**:
   - Environment variables for all configurations
   - Secrets management using Kubernetes secrets

2. **Scaling Strategy**:
   - Horizontal scaling based on CPU/memory usage
   - Minimum of 3 nodes for redundancy

3. **Backup Strategy**:
   - Hourly Redis snapshots
   - Daily full backups
   - Restore testing procedures

## 5. Integration with TSS Client

### 5.1 Client Modifications

1. **Connection Management**:
   - Load balancer discovery
   - Node failover handling
   - Connection pooling

2. **Authentication Flow**:
   - Initial API key authentication
   - JWT token management
   - Token refresh logic

3. **Retry Strategy**:
   - Exponential backoff for failed requests
   - Jitter to prevent thundering herd

### 5.2 Communication Protocol

1. **Message Format**:
   ```json
   {
     "sessionId": "session-uuid",
     "senderId": "party-1",
     "messageType": "round1",
     "payload": "base64-encoded-data",
     "timestamp": 1620000000000,
     "signature": "message-signature"
   }
   ```

2. **Protocol Sequence**:
   - Session initialization
   - Party registration
   - Round message exchange
   - Session completion
   - Session cleanup

## 6. Security Considerations

1. **Threat Model**:
   - Compromised coordinator nodes
   - Network eavesdropping
   - Session hijacking
   - DoS attacks

2. **Mitigations**:
   - Message encryption
   - Message authentication
   - Session isolation
   - Resource limits

3. **Regular Security Reviews**:
   - Code audits
   - Dependency scanning
   - Penetration testing

## 7. Implementation Phases

### Phase 1: Core Functionality
- Basic API endpoints
- Redis integration
- Authentication system
- Deployment automation

### Phase 2: Reliability & Scaling
- Multi-node coordination
- Leader election
- Automatic failover
- Monitoring & alerting

### Phase 3: Enhanced Security
- Advanced authentication
- Audit logging
- Intrusion detection
- Compliance features

### Phase 4: Performance Optimization
- Request batching
- Connection pooling
- Data compression
- Cache optimization

## 8. Testing Strategy

1. **Unit Testing**:
   - Controller logic
   - Service methods
   - Authentication flow

2. **Integration Testing**:
   - API endpoint behavior
   - Redis integration
   - Error handling

3. **Load Testing**:
   - Simulated multi-party sessions
   - Concurrent request handling
   - Recovery from node failures

4. **Security Testing**:
   - Authentication bypass attempts
   - Authorization constraints
   - Input validation
   - Rate limiting effectiveness

This specification provides a comprehensive framework for implementing secure, reliable coordinator nodes for TSS operations while maintaining the security properties of the threshold signature scheme.

Similar code found with 2 license types