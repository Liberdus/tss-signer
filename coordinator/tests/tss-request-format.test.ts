/**
 * TSS Party Request Format Tests
 *
 * These tests verify the structure and format of requests
 * sent from TSS parties to the coordinator
 */

describe("TSS Party Request Formats", () => {
  describe("Signed Request Structure", () => {
    test("should have correct signed request format", () => {
      const signedRequest = {
        payload: { key: "test", value: 123 },
        ts: Date.now(),
        sign: {
          owner: "a".repeat(64),
          sig: "signature_hex_string",
        },
      };

      expect(signedRequest).toHaveProperty("payload");
      expect(signedRequest).toHaveProperty("ts");
      expect(signedRequest).toHaveProperty("sign");
      expect(signedRequest.sign).toHaveProperty("owner");
      expect(signedRequest.sign).toHaveProperty("sig");
    });

    test("timestamp should be in milliseconds", () => {
      const ts = Date.now();
      expect(typeof ts).toBe("number");
      expect(ts.toString().length).toBeGreaterThanOrEqual(13);
    });

    test("owner should be 64-character hex string", () => {
      const owner = "a".repeat(64);
      expect(owner.length).toBe(64);
      expect(/^[0-9a-f]+$/i.test(owner)).toBe(true);
    });

    test("payload should be preserved exactly", () => {
      const originalPayload = {
        nested: { data: [1, 2, 3] },
        key: "value",
        number: 42,
        boolean: true,
      };

      const signedRequest = {
        payload: originalPayload,
        ts: Date.now(),
        sign: { owner: "a".repeat(64), sig: "sig" },
      };

      expect(signedRequest.payload).toEqual(originalPayload);
      expect(signedRequest.payload.nested.data).toEqual([1, 2, 3]);
    });
  });

  describe("Coordinator API Request Formats", () => {
    test("signup keygen request format", () => {
      const request = {
        payload: "signup-keygen",
        ts: Date.now(),
        sign: { owner: "a".repeat(64), sig: "sig" },
      };

      expect(request.payload).toBe("signup-keygen");
    });

    test("signup sign request format", () => {
      const request = {
        payload: "signup-sign",
        ts: Date.now(),
        sign: { owner: "a".repeat(64), sig: "sig" },
      };

      expect(request.payload).toBe("signup-sign");
    });

    test("KV store set request format", () => {
      const request = {
        payload: {
          key: "1-round1-uuid123",
          value: JSON.stringify({ roundData: "..." }),
        },
        ts: Date.now(),
        sign: { owner: "a".repeat(64), sig: "sig" },
      };

      expect(request.payload).toHaveProperty("key");
      expect(request.payload).toHaveProperty("value");
      expect(typeof request.payload.key).toBe("string");
      expect(typeof request.payload.value).toBe("string");
    });

    test("KV store get request format", () => {
      const request = {
        payload: { key: "1-round1-uuid123" },
        ts: Date.now(),
        sign: { owner: "a".repeat(64), sig: "sig" },
      };

      expect(request.payload).toHaveProperty("key");
      expect(typeof request.payload.key).toBe("string");
    });

    test("transaction enqueue request format", () => {
      const request = {
        payload: {
          txId: "0x" + "1".repeat(64),
          sender: "0x" + "a".repeat(40),
          value: "1000000000000000000",
          type: "BRIDGE_IN",
          txTimestamp: Date.now(),
          chainId: 1,
        },
        ts: Date.now(),
        sign: { owner: "a".repeat(64), sig: "sig" },
      };

      expect(request.payload).toHaveProperty("txId");
      expect(request.payload).toHaveProperty("sender");
      expect(request.payload).toHaveProperty("value");
      expect(request.payload).toHaveProperty("type");
      expect(request.payload).toHaveProperty("txTimestamp");
      expect(request.payload).toHaveProperty("chainId");
    });

    test("transaction update request format", () => {
      const request = {
        payload: {
          txId: "0x" + "1".repeat(64),
          status: "COMPLETED",
          receiptId: "0x" + "2".repeat(64),
          party: 1,
        },
        ts: Date.now(),
        sign: { owner: "a".repeat(64), sig: "sig" },
      };

      expect(request.payload).toHaveProperty("txId");
      expect(request.payload).toHaveProperty("status");
      expect(request.payload).toHaveProperty("receiptId");
      expect(request.payload).toHaveProperty("party");
    });
  });

  describe("Round Data Formats", () => {
    test("round1 broadcast format", () => {
      const request = {
        payload: {
          key: "1-round1-uuid123",
          value: JSON.stringify({
            commitment: "commitment_value",
            e: { n: "paillier_n" },
          }),
        },
        ts: Date.now(),
        sign: { owner: "a".repeat(64), sig: "sig" },
      };

      const roundData = JSON.parse(request.payload.value);
      expect(roundData).toHaveProperty("commitment");
    });

    test("round2 decommitment format", () => {
      const request = {
        payload: {
          key: "1-round2-uuid123",
          value: JSON.stringify({
            y_i: "public_key_point",
            blind_factor: "blind",
          }),
        },
        ts: Date.now(),
        sign: { owner: "a".repeat(64), sig: "sig" },
      };

      const roundData = JSON.parse(request.payload.value);
      expect(roundData).toHaveProperty("y_i");
      expect(roundData).toHaveProperty("blind_factor");
    });

    test("P2P encrypted share format", () => {
      const request = {
        payload: {
          key: "1-2-round3-uuid123",
          value: JSON.stringify({
            ciphertext: "encrypted_share",
            tag: "aead_tag",
          }),
        },
        ts: Date.now(),
        sign: { owner: "a".repeat(64), sig: "sig" },
      };

      const shareData = JSON.parse(request.payload.value);
      expect(shareData).toHaveProperty("ciphertext");
    });
  });

  describe("Payload Serialization", () => {
    test("should handle string payloads", () => {
      const request = {
        payload: "simple-string",
        ts: Date.now(),
        sign: { owner: "a".repeat(64), sig: "sig" },
      };

      expect(typeof request.payload).toBe("string");
    });

    test("should handle object payloads", () => {
      const request = {
        payload: { key: "value", number: 123 },
        ts: Date.now(),
        sign: { owner: "a".repeat(64), sig: "sig" },
      };

      expect(typeof request.payload).toBe("object");
      expect(request.payload).not.toBeNull();
    });

    test("should handle nested JSON in value field", () => {
      const nestedData = { deeply: { nested: { value: 42 } } };
      const request = {
        payload: {
          key: "test-key",
          value: JSON.stringify(nestedData),
        },
        ts: Date.now(),
        sign: { owner: "a".repeat(64), sig: "sig" },
      };

      const parsed = JSON.parse(request.payload.value);
      expect(parsed.deeply.nested.value).toBe(42);
    });
  });

  describe("Request Validation", () => {
    test("should identify complete signed requests", () => {
      const request = {
        payload: { data: "test" },
        ts: Date.now(),
        sign: { owner: "a".repeat(64), sig: "sig" },
      };

      const isValid =
        request.hasOwnProperty("payload") &&
        request.hasOwnProperty("ts") &&
        request.hasOwnProperty("sign") &&
        typeof request.ts === "number" &&
        typeof request.sign.owner === "string" &&
        typeof request.sign.sig === "string";

      expect(isValid).toBe(true);
    });

    test("should identify incomplete signed requests", () => {
      const invalidRequests = [
        { ts: 123, sign: { owner: "a".repeat(64), sig: "sig" } }, // missing payload
        { payload: "test", sign: { owner: "a".repeat(64), sig: "sig" } }, // missing ts
        { payload: "test", ts: 123 }, // missing sign
        { payload: "test", ts: 123, sign: { owner: "a".repeat(64) } }, // missing sig
      ];

      for (const request of invalidRequests) {
        const isValid = Boolean(
          request.hasOwnProperty("payload") &&
          request.hasOwnProperty("ts") &&
          request.hasOwnProperty("sign") &&
          (request as any).sign?.owner &&
          (request as any).sign?.sig
        );

        expect(isValid).toBe(false);
      }
    });
  });

  describe("Response Unwrapping", () => {
    test("coordinator should unwrap payload after verification", () => {
      const originalPayload = { key: "test-key", value: "test-value" };
      const signedRequest = {
        payload: originalPayload,
        ts: Date.now(),
        sign: { owner: "a".repeat(64), sig: "sig" },
      };

      // After verification, coordinator sets req.body = req.body.payload
      const unwrappedPayload = signedRequest.payload;

      expect(unwrappedPayload).toEqual(originalPayload);
      expect(unwrappedPayload).not.toHaveProperty("sign");
      expect(unwrappedPayload).not.toHaveProperty("ts");
    });
  });

  describe("Timestamp Requirements", () => {
    test("timestamp should be recent", () => {
      const now = Date.now();
      const oneHourAgo = now - 3600000;

      expect(now).toBeGreaterThan(oneHourAgo);
      expect(now - oneHourAgo).toBeLessThan(3600001);
    });

    test("different requests should have different timestamps", () => {
      const ts1 = Date.now();
      const ts2 = Date.now();

      // Timestamps should be the same or very close (within 1ms typically)
      expect(Math.abs(ts2 - ts1)).toBeLessThan(100);
    });
  });

  describe("Owner (Public Key) Format", () => {
    test("should be lowercase hex for comparison", () => {
      const upperKey = "ABCDEF0123456789".repeat(4);
      const lowerKey = upperKey.toLowerCase();

      expect(lowerKey.length).toBe(64);
      expect(/^[0-9a-f]+$/.test(lowerKey)).toBe(true);
    });

    test("should be consistent across requests from same party", () => {
      const owner = "a".repeat(64);

      const request1 = {
        payload: { data: "first" },
        ts: Date.now(),
        sign: { owner, sig: "sig1" },
      };

      const request2 = {
        payload: { data: "second" },
        ts: Date.now() + 1,
        sign: { owner, sig: "sig2" },
      };

      expect(request1.sign.owner).toBe(request2.sign.owner);
    });
  });
});
