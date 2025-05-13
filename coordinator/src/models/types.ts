/**
 * Interface representing a session in the TSS system
 */
export interface Session {
  id: string;
  threshold: number;
  parties: number;
  createdAt: number;
  expiresAt: number;
  status: SessionStatus;
}

/**
 * Enum for possible session statuses
 */
export enum SessionStatus {
  KEYGEN = 'keygen',
  SIGNING = 'signing',
  COMPLETED = 'completed',
  EXPIRED = 'expired'
}

/**
 * Interface representing a party in a TSS session
 */
export interface Party {
  id: number;
  publicKey?: string;
  lastSeen: number;
  sessionId: string;
}

/**
 * Interface for session message
 */
export interface Message {
  key: string;
  value: string;
  timestamp: number;
  sender: number;
  sessionId: string;
}

/**
 * Interface for party signup response
 */
export interface PartySignup {
  number: number;
  uuid: string;
  // sessionId: string;
  // timestamp: number;
  // expiresAt: number;
}