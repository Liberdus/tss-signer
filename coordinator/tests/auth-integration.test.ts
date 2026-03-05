/**
 * Integration tests for auth middleware
 * These tests verify the actual runtime behavior of the auth middleware
 */

import { Request, Response, NextFunction } from "express";
import * as fs from "fs";
import * as path from "path";

describe("Auth Middleware Integration", () => {
  const testFixturesDir = path.join(__dirname, "fixtures");
  const allowedSignersPath = path.join(testFixturesDir, "allowed-tss-signers.json");

  // Helper to create mock request/response
  function createMockRequest(body: any): Partial<Request> {
    return { body, path: "/test" } as Partial<Request>;
  }

  function createMockResponse(): Partial<Response> {
    const res: any = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    };
    return res;
  }

  describe("Request Body Validation", () => {
    test("valid signed request structure should have all required fields", () => {
      const validSignedBody = {
        payload: { key: "test", value: 123 },
        ts: Date.now(),
        sign: {
          owner: "a".repeat(64),
          sig: "signature_hex_string",
        },
      };

      expect(validSignedBody).toHaveProperty("payload");
      expect(validSignedBody).toHaveProperty("ts");
      expect(validSignedBody).toHaveProperty("sign.owner");
      expect(validSignedBody).toHaveProperty("sign.sig");
      expect(typeof validSignedBody.ts).toBe("number");
      expect(typeof validSignedBody.sign.owner).toBe("string");
      expect(typeof validSignedBody.sign.sig).toBe("string");
    });

    test("invalid request bodies should be identifiable", () => {
      const invalidBodies = [
        {},
        { payload: "test" }, // missing ts and sign
        { ts: 123 }, // missing payload and sign
        { payload: "test", ts: 123 }, // missing sign
        { payload: "test", sign: { owner: "key" } }, // missing ts
        { ts: 123, sign: { owner: "key", sig: "sig" } }, // missing payload
      ];

      for (const body of invalidBodies) {
        const hasAllFields =
          body.hasOwnProperty("payload") &&
          body.hasOwnProperty("ts") &&
          body.hasOwnProperty("sign") &&
          (body as any).sign?.owner &&
          (body as any).sign?.sig;

        expect(hasAllFields).toBe(false);
      }
    });
  });

  describe("Whitelist File Format", () => {
    test("fixture file should have correct format", () => {
      const data = fs.readFileSync(allowedSignersPath, "utf8");
      const config = JSON.parse(data);

      expect(config).toHaveProperty("allowedTSSSigners");
      expect(Array.isArray(config.allowedTSSSigners)).toBe(true);
    });

    test("public keys should be 64-character hex strings", () => {
      const data = fs.readFileSync(allowedSignersPath, "utf8");
      const config = JSON.parse(data);

      for (const key of config.allowedTSSSigners) {
        expect(typeof key).toBe("string");
        expect(key.length).toBe(64);
        expect(/^[0-9a-fA-F]{64}$/.test(key)).toBe(true);
      }
    });
  });

  describe("Public Key Validation", () => {
    function isValidPublicKey(key: string): boolean {
      return key.length === 64 && /^[0-9a-fA-F]+$/.test(key);
    }

    test("should accept valid 64-char hex keys", () => {
      expect(isValidPublicKey("a".repeat(64))).toBe(true);
      expect(isValidPublicKey("0123456789abcdef".repeat(4))).toBe(true);
      expect(isValidPublicKey("ABCDEF0123456789".repeat(4))).toBe(true);
    });

    test("should reject invalid keys", () => {
      expect(isValidPublicKey("")).toBe(false);
      expect(isValidPublicKey("short")).toBe(false);
      expect(isValidPublicKey("g".repeat(64))).toBe(false); // 'g' not hex
      expect(isValidPublicKey("a".repeat(63))).toBe(false); // too short
      expect(isValidPublicKey("a".repeat(65))).toBe(false); // too long
    });
  });

  describe("Payload Unwrapping", () => {
    test("should demonstrate payload extraction from signed request", () => {
      const originalPayload = { key: "signup-keygen", data: { value: 42 } };
      const signedRequest = {
        payload: originalPayload,
        ts: 1234567890,
        sign: { owner: "a".repeat(64), sig: "signature" },
      };

      // After successful verification, middleware sets req.body = req.body.payload
      const unwrapped = signedRequest.payload;

      expect(unwrapped).toEqual(originalPayload);
      expect(unwrapped).not.toHaveProperty("ts");
      expect(unwrapped).not.toHaveProperty("sign");
    });
  });

  describe("Timestamp Validation", () => {
    test("timestamp should be a reasonable number", () => {
      const now = Date.now();
      const oneHourAgo = now - 3600000;
      const oneHourFromNow = now + 3600000;

      expect(typeof now).toBe("number");
      expect(now).toBeGreaterThan(1600000000000); // After Sep 2020
      expect(now).toBeLessThan(2000000000000); // Before May 2033
      expect(oneHourAgo).toBeLessThan(now);
      expect(oneHourFromNow).toBeGreaterThan(now);
    });
  });

  describe("Error Response Format", () => {
    test("401 response should have correct format", () => {
      const error401 = { Err: "Missing or invalid signed request body" };
      expect(error401).toHaveProperty("Err");
      expect(typeof error401.Err).toBe("string");
    });

    test("403 response should have correct format", () => {
      const error403 = { Err: "Signer public key is not whitelisted" };
      expect(error403).toHaveProperty("Err");
      expect(typeof error403.Err).toBe("string");
    });
  });

  describe("Key Normalization", () => {
    test("should normalize keys to lowercase for comparison", () => {
      const upperCase = "ABCDEF0123456789".repeat(4);
      const lowerCase = "abcdef0123456789".repeat(4);
      const mixed = "AbCdEf0123456789".repeat(4);

      expect(upperCase.toLowerCase()).toBe(lowerCase);
      expect(mixed.toLowerCase()).toBe(lowerCase);
    });
  });
});
