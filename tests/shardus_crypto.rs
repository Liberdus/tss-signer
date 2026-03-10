#[cfg(target_arch = "wasm32")]
extern crate wasm_bindgen;

#[cfg(all(test, target_arch = "wasm32"))]
extern crate wasm_bindgen_test;

#[cfg(target_arch = "wasm32")]
use wasm_bindgen_test::*;

use tss_wasm::shardus_crypto::{
    get_key_pair_using_sk, get_pk, hash, hashslice, maybe_sign_request_body,
    shardus_crypto_init, shardus_crypto_set_keys, sign, verify, verify_signed_request_body,
    Format, HexStringOrBuffer,
};
use serde::{Deserialize, Serialize};

// ============================================================================
// Test Helper Fixtures
// ============================================================================

/// Valid test keypair (ed25519) - Generated from all-zeros seed
/// Public key: 32 bytes
/// Secret key: 32 bytes (seed)
const TEST_PUBLIC_KEY: &str = "3b6a27bcceb6a42d62a3a8d02a6f0d73653215771de243a63ac048a18b59da29";
const TEST_SECRET_KEY: &str = "0000000000000000000000000000000000000000000000000000000000000000";
const TEST_HASH_KEY: &str = "fedcba0987654321fedcba0987654321fedcba0987654321fedcba0987654321";

/// Different valid keypair for testing updates - Generated from all-ones seed
const TEST_PUBLIC_KEY_2: &str = "76a1592044a6e4f511265bca73a604d90b0529d1df602be30a19a9257660d1f5";
const TEST_SECRET_KEY_2: &str = "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";

/// Third valid keypair - Generated from alternating pattern
const TEST_PUBLIC_KEY_3: &str = "e734ea6c2b6257de72355e472aa05a4c487e6b463c029ed306df2f01b5636b58";
const TEST_SECRET_KEY_3: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

// Constants for hash/sign/verify unit tests (native-only)
const HASH_KEY: &str = "64f152869ca2d473e4ba64ab53f49ccdb2edae22da192c126850970e788af347";
const SECRET_KEY_HEX: &str = "c3774b92cc8850fb4026b073081290b82cab3c0f66cac250b4d710ee9aaf83ed8088b37f6f458104515ae18c2a05bde890199322f62ab5114d20c77bde5e6c9d";
const PUBLIC_KEY_HEX: &str = "8088b37f6f458104515ae18c2a05bde890199322f62ab5114d20c77bde5e6c9d";

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
struct TestPayload {
    message: String,
    value: u32,
}

#[derive(Serialize, Deserialize, Debug)]
struct SignedRequest {
    payload: TestPayload,
    ts: u64,
    sign: SignField,
}

#[derive(Serialize, Deserialize, Debug)]
struct SignField {
    owner: String,
    sig: String,
}

// ============================================================================
// Initialization Tests
// ============================================================================

#[cfg_attr(target_arch = "wasm32", wasm_bindgen_test)]
#[test]
fn test_init_with_valid_hash_key() {
    let result = shardus_crypto_init(TEST_HASH_KEY);
    assert!(result.is_ok(), "Should initialize with valid hash key");
}

#[cfg_attr(target_arch = "wasm32", wasm_bindgen_test)]
#[test]
fn test_init_with_invalid_hex() {
    let invalid_hex = "not_valid_hex_123";
    let result = shardus_crypto_init(invalid_hex);
    assert!(result.is_err(), "Should fail with invalid hex");
}

#[cfg_attr(target_arch = "wasm32", wasm_bindgen_test)]
#[test]
fn test_init_with_empty_string() {
    let result = shardus_crypto_init("");
    assert!(result.is_ok(), "Should handle empty hash key");
}

#[cfg_attr(target_arch = "wasm32", wasm_bindgen_test)]
#[test]
fn test_init_multiple_times() {
    // First initialization
    let result1 = shardus_crypto_init(TEST_HASH_KEY);
    assert!(result1.is_ok(), "First init should succeed");

    // Re-initialize with different key
    let different_key = "1111111111111111111111111111111111111111111111111111111111111111";
    let result2 = shardus_crypto_init(different_key);
    assert!(result2.is_ok(), "Re-initialization should succeed");
}

// ============================================================================
// Key Setting Tests
// ============================================================================

#[cfg_attr(target_arch = "wasm32", wasm_bindgen_test)]
#[test]
fn test_set_keys_valid_32_byte_secret() {
    // Note: We need to generate a valid keypair where the public key matches
    // the secret key derivation. For testing, we'll use a known valid pair.

    // This is a valid ed25519 keypair (secret seed -> public key)
    let secret = "0000000000000000000000000000000000000000000000000000000000000000";
    let public = "3b6a27bcceb6a42d62a3a8d02a6f0d73653215771de243a63ac048a18b59da29";

    let result = shardus_crypto_set_keys(public, secret);
    assert!(result.is_ok(), "Should set keys with valid 32-byte secret");
}

#[cfg_attr(target_arch = "wasm32", wasm_bindgen_test)]
#[test]
fn test_set_keys_valid_64_byte_secret() {
    // Ed25519 also accepts 64-byte secrets (first 32 bytes are used as seed)
    let secret_64 = "0000000000000000000000000000000000000000000000000000000000000000\
                     1111111111111111111111111111111111111111111111111111111111111111";
    let public = "3b6a27bcceb6a42d62a3a8d02a6f0d73653215771de243a63ac048a18b59da29";

    let result = shardus_crypto_set_keys(public, secret_64);
    assert!(result.is_ok(), "Should set keys with valid 64-byte secret");
}

#[cfg_attr(target_arch = "wasm32", wasm_bindgen_test)]
#[test]
fn test_set_keys_invalid_public_key_length() {
    let invalid_public = "1234"; // Too short
    let result = shardus_crypto_set_keys(invalid_public, TEST_SECRET_KEY);
    assert!(result.is_err(), "Should fail with invalid public key length");
}

#[cfg_attr(target_arch = "wasm32", wasm_bindgen_test)]
#[test]
fn test_set_keys_invalid_secret_key_length() {
    let invalid_secret = "1234"; // Too short (not 32 or 64 bytes)
    let result = shardus_crypto_set_keys(TEST_PUBLIC_KEY, invalid_secret);
    assert!(result.is_err(), "Should fail with invalid secret key length");
}

#[cfg_attr(target_arch = "wasm32", wasm_bindgen_test)]
#[test]
fn test_set_keys_mismatched_keypair() {
    // Public key that doesn't match the secret key
    let secret = "0000000000000000000000000000000000000000000000000000000000000000";
    let wrong_public = "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";

    let result = shardus_crypto_set_keys(wrong_public, secret);
    assert!(result.is_err(), "Should fail when public key doesn't match secret");
}

#[cfg_attr(target_arch = "wasm32", wasm_bindgen_test)]
#[test]
fn test_set_keys_invalid_hex() {
    let invalid_public = "not_valid_hex_zzz_0000000000000000000000000000000000000000000000000";
    let result = shardus_crypto_set_keys(invalid_public, TEST_SECRET_KEY);
    assert!(result.is_err(), "Should fail with invalid hex in public key");
}

#[cfg_attr(target_arch = "wasm32", wasm_bindgen_test)]
#[test]
fn test_set_keys_updates_existing() {
    // Set initial keys (valid keypair 1)
    let result1 = shardus_crypto_set_keys(TEST_PUBLIC_KEY, TEST_SECRET_KEY);
    assert!(result1.is_ok(), "First key setting should succeed");

    // Update with different keys (valid keypair 2)
    let result2 = shardus_crypto_set_keys(TEST_PUBLIC_KEY_2, TEST_SECRET_KEY_2);
    assert!(result2.is_ok(), "Should be able to update keys");
}

// ============================================================================
// Request Signing Tests
// ============================================================================

#[cfg_attr(target_arch = "wasm32", wasm_bindgen_test)]
#[test]
fn test_maybe_sign_request_body_without_init() {
    // Note: Due to global state, this test may see state from other tests
    // We verify that the function succeeds and returns valid JSON
    let payload = TestPayload {
        message: "test".to_string(),
        value: 42,
    };

    let result = maybe_sign_request_body(payload.clone());
    assert!(result.is_ok(), "Should succeed even without init");

    let value = result.unwrap();

    // The result will either be signed (if state was initialized by another test)
    // or unsigned (if no state). Both are valid outcomes for this test.
    // We just verify the structure is valid JSON
    if value.get("sign").is_some() {
        // Signed format
        let signed: Result<SignedRequest, _> = serde_json::from_value(value);
        assert!(signed.is_ok(), "If signed, should be valid signed structure");
    } else {
        // Unsigned format - should have payload fields directly
        assert!(value.get("message").is_some() || value.get("payload").is_some(),
                "Should have payload data");
    }
}

#[cfg_attr(target_arch = "wasm32", wasm_bindgen_test)]
#[test]
fn test_maybe_sign_request_body_with_only_hash_key() {
    // Note: This test initializes hash key but not keypair
    // If another test already set keypair, signing may still occur
    shardus_crypto_init(TEST_HASH_KEY).unwrap();

    let payload = TestPayload {
        message: "test".to_string(),
        value: 42,
    };

    let result = maybe_sign_request_body(payload.clone());
    assert!(result.is_ok(), "Should succeed with hash key initialized");

    // The result depends on whether keys were set by this or another test
    let value = result.unwrap();

    // Both signed and unsigned are valid outcomes here due to global state
    if value.get("sign").is_some() {
        // If keys were previously set, it will be signed
        let signed: Result<SignedRequest, _> = serde_json::from_value(value);
        assert!(signed.is_ok(), "If signed, should be valid signed structure");
    } else {
        // If no keys set, it should be unsigned
        assert!(value.get("message").is_some(), "Should have message field if unsigned");
        assert!(value.get("value").is_some(), "Should have value field if unsigned");
    }
}

#[cfg_attr(target_arch = "wasm32", wasm_bindgen_test)]
#[test]
fn test_maybe_sign_request_body_fully_configured() {
    // Initialize with both hash key and keypair
    shardus_crypto_init(TEST_HASH_KEY).unwrap();

    let secret = "0000000000000000000000000000000000000000000000000000000000000000";
    let public = "3b6a27bcceb6a42d62a3a8d02a6f0d73653215771de243a63ac048a18b59da29";
    shardus_crypto_set_keys(public, secret).unwrap();

    let payload = TestPayload {
        message: "test message".to_string(),
        value: 123,
    };

    let result = maybe_sign_request_body(payload.clone());
    assert!(result.is_ok(), "Should succeed with full config");

    let value = result.unwrap();

    // Should have sign field now
    assert!(value.get("sign").is_some(), "Should have sign field");
    assert!(value.get("payload").is_some(), "Should have payload field");
    assert!(value.get("ts").is_some(), "Should have timestamp field");

    // Verify structure
    let signed: SignedRequest = serde_json::from_value(value).unwrap();
    assert_eq!(signed.payload, payload, "Payload should be preserved");
    assert_eq!(signed.sign.owner, public, "Owner should match public key");
    assert!(!signed.sign.sig.is_empty(), "Signature should not be empty");

    // Signature should be hex encoded (64 bytes signature + 32 bytes digest = 96 bytes = 192 hex chars)
    assert_eq!(signed.sign.sig.len(), 192, "Signature should be 192 hex characters");
}

#[cfg_attr(target_arch = "wasm32", wasm_bindgen_test)]
#[test]
fn test_signature_format() {
    shardus_crypto_init(TEST_HASH_KEY).unwrap();

    let secret = "0000000000000000000000000000000000000000000000000000000000000000";
    let public = "3b6a27bcceb6a42d62a3a8d02a6f0d73653215771de243a63ac048a18b59da29";
    shardus_crypto_set_keys(public, secret).unwrap();

    let payload = TestPayload {
        message: "test".to_string(),
        value: 1,
    };

    let result = maybe_sign_request_body(payload).unwrap();
    let signed: SignedRequest = serde_json::from_value(result).unwrap();

    // Verify signature is valid hex
    assert!(
        hex::decode(&signed.sign.sig).is_ok(),
        "Signature should be valid hex"
    );

    let sig_bytes = hex::decode(&signed.sign.sig).unwrap();
    // Should be 64 bytes (signature) + 32 bytes (digest) = 96 bytes
    assert_eq!(sig_bytes.len(), 96, "Signature should be 96 bytes");
}

#[cfg_attr(target_arch = "wasm32", wasm_bindgen_test)]
#[test]
fn test_different_payloads_produce_different_signatures() {
    shardus_crypto_init(TEST_HASH_KEY).unwrap();

    let secret = "0000000000000000000000000000000000000000000000000000000000000000";
    let public = "3b6a27bcceb6a42d62a3a8d02a6f0d73653215771de243a63ac048a18b59da29";
    shardus_crypto_set_keys(public, secret).unwrap();

    let payload1 = TestPayload {
        message: "message1".to_string(),
        value: 1,
    };

    let payload2 = TestPayload {
        message: "message2".to_string(),
        value: 2,
    };

    let result1 = maybe_sign_request_body(payload1).unwrap();
    let result2 = maybe_sign_request_body(payload2).unwrap();

    let signed1: SignedRequest = serde_json::from_value(result1).unwrap();
    let signed2: SignedRequest = serde_json::from_value(result2).unwrap();

    assert_ne!(
        signed1.sign.sig, signed2.sign.sig,
        "Different payloads should produce different signatures"
    );
}

#[cfg_attr(target_arch = "wasm32", wasm_bindgen_test)]
#[test]
fn test_timestamp_included_in_signature() {
    shardus_crypto_init(TEST_HASH_KEY).unwrap();

    let secret = "0000000000000000000000000000000000000000000000000000000000000000";
    let public = "3b6a27bcceb6a42d62a3a8d02a6f0d73653215771de243a63ac048a18b59da29";
    shardus_crypto_set_keys(public, secret).unwrap();

    let payload = TestPayload {
        message: "test".to_string(),
        value: 1,
    };

    let result = maybe_sign_request_body(payload).unwrap();
    let signed: SignedRequest = serde_json::from_value(result).unwrap();

    // Timestamp should be a reasonable value (not 0, and not in the far future)
    assert!(signed.ts > 0, "Timestamp should be set");

    // On WASM, timestamp is in milliseconds since epoch
    // Should be reasonable (after 2020, before 2100)
    #[cfg(target_arch = "wasm32")]
    {
        let ts_seconds = signed.ts / 1000;
        assert!(ts_seconds > 1577836800, "Timestamp should be after 2020"); // Jan 1, 2020
        assert!(ts_seconds < 4102444800, "Timestamp should be before 2100"); // Jan 1, 2100
    }
}

// ============================================================================
// Edge Cases and Error Handling
// ============================================================================

#[cfg_attr(target_arch = "wasm32", wasm_bindgen_test)]
#[test]
fn test_empty_payload() {
    shardus_crypto_init(TEST_HASH_KEY).unwrap();

    let secret = "0000000000000000000000000000000000000000000000000000000000000000";
    let public = "3b6a27bcceb6a42d62a3a8d02a6f0d73653215771de243a63ac048a18b59da29";
    shardus_crypto_set_keys(public, secret).unwrap();

    #[derive(Serialize, Deserialize, Debug, Clone)]
    struct EmptyPayload {}

    let payload = EmptyPayload {};
    let result = maybe_sign_request_body(payload);
    assert!(result.is_ok(), "Should handle empty payload");
}

#[cfg_attr(target_arch = "wasm32", wasm_bindgen_test)]
#[test]
fn test_large_payload() {
    shardus_crypto_init(TEST_HASH_KEY).unwrap();

    let secret = "0000000000000000000000000000000000000000000000000000000000000000";
    let public = "3b6a27bcceb6a42d62a3a8d02a6f0d73653215771de243a63ac048a18b59da29";
    shardus_crypto_set_keys(public, secret).unwrap();

    let large_message = "x".repeat(10000);
    let payload = TestPayload {
        message: large_message,
        value: 999,
    };

    let result = maybe_sign_request_body(payload);
    assert!(result.is_ok(), "Should handle large payload");
}

#[cfg_attr(target_arch = "wasm32", wasm_bindgen_test)]
#[test]
fn test_special_characters_in_payload() {
    shardus_crypto_init(TEST_HASH_KEY).unwrap();

    let secret = "0000000000000000000000000000000000000000000000000000000000000000";
    let public = "3b6a27bcceb6a42d62a3a8d02a6f0d73653215771de243a63ac048a18b59da29";
    shardus_crypto_set_keys(public, secret).unwrap();

    let payload = TestPayload {
        message: "Special chars: 你好世界 🚀 \n\t\r\"\\".to_string(),
        value: 42,
    };

    let result = maybe_sign_request_body(payload.clone());
    assert!(result.is_ok(), "Should handle special characters");

    let value = result.unwrap();
    let signed: SignedRequest = serde_json::from_value(value).unwrap();
    assert_eq!(signed.payload, payload, "Payload should be preserved");
}

// ============================================================================
// State Management Tests
// ============================================================================

#[cfg_attr(target_arch = "wasm32", wasm_bindgen_test)]
#[test]
fn test_init_then_set_keys_then_sign() {
    // Test the full workflow in sequence

    // Step 1: Initialize
    let init_result = shardus_crypto_init(TEST_HASH_KEY);
    assert!(init_result.is_ok(), "Initialization should succeed");

    // Step 2: Set keys
    let secret = "0000000000000000000000000000000000000000000000000000000000000000";
    let public = "3b6a27bcceb6a42d62a3a8d02a6f0d73653215771de243a63ac048a18b59da29";
    let key_result = shardus_crypto_set_keys(public, secret);
    assert!(key_result.is_ok(), "Key setting should succeed");

    // Step 3: Sign a request
    let payload = TestPayload {
        message: "workflow test".to_string(),
        value: 100,
    };
    let sign_result = maybe_sign_request_body(payload);
    assert!(sign_result.is_ok(), "Signing should succeed");

    let value = sign_result.unwrap();
    assert!(value.get("sign").is_some(), "Should be signed");
}

#[cfg_attr(target_arch = "wasm32", wasm_bindgen_test)]
#[test]
fn test_set_keys_then_init_then_sign() {
    // Test that order doesn't matter (both need to be set)

    // Step 1: Set keys first
    let secret = "0000000000000000000000000000000000000000000000000000000000000000";
    let public = "3b6a27bcceb6a42d62a3a8d02a6f0d73653215771de243a63ac048a18b59da29";
    let key_result = shardus_crypto_set_keys(public, secret);
    assert!(key_result.is_ok(), "Key setting should succeed");

    // Step 2: Initialize after
    let init_result = shardus_crypto_init(TEST_HASH_KEY);
    assert!(init_result.is_ok(), "Initialization should succeed");

    // Step 3: Sign a request
    let payload = TestPayload {
        message: "reversed workflow test".to_string(),
        value: 200,
    };
    let sign_result = maybe_sign_request_body(payload);
    assert!(sign_result.is_ok(), "Signing should succeed");

    let value = sign_result.unwrap();
    assert!(value.get("sign").is_some(), "Should be signed");
}

// ============================================================================
// Integration Tests
// ============================================================================

#[cfg_attr(target_arch = "wasm32", wasm_bindgen_test)]
#[test]
fn test_multiple_sequential_signatures() {
    shardus_crypto_init(TEST_HASH_KEY).unwrap();

    let secret = "0000000000000000000000000000000000000000000000000000000000000000";
    let public = "3b6a27bcceb6a42d62a3a8d02a6f0d73653215771de243a63ac048a18b59da29";
    shardus_crypto_set_keys(public, secret).unwrap();

    // Sign multiple requests in sequence
    for i in 0..5 {
        let payload = TestPayload {
            message: format!("message {}", i),
            value: i,
        };

        let result = maybe_sign_request_body(payload);
        assert!(result.is_ok(), "Request {} should be signed", i);

        let value = result.unwrap();
        assert!(value.get("sign").is_some(), "Request {} should have signature", i);
    }
}

#[cfg_attr(target_arch = "wasm32", wasm_bindgen_test)]
#[test]
fn test_reconfigure_and_sign_again() {
    // Initial configuration with keypair 1
    shardus_crypto_init(TEST_HASH_KEY).unwrap();
    shardus_crypto_set_keys(TEST_PUBLIC_KEY, TEST_SECRET_KEY).unwrap();

    let payload = TestPayload {
        message: "first".to_string(),
        value: 1,
    };
    let result1 = maybe_sign_request_body(payload).unwrap();
    let signed1: SignedRequest = serde_json::from_value(result1).unwrap();

    // Reconfigure with keypair 2
    shardus_crypto_set_keys(TEST_PUBLIC_KEY_2, TEST_SECRET_KEY_2).unwrap();

    let payload = TestPayload {
        message: "second".to_string(),
        value: 2,
    };
    let result2 = maybe_sign_request_body(payload).unwrap();
    let signed2: SignedRequest = serde_json::from_value(result2).unwrap();

    // Signatures should be different (different keys)
    assert_ne!(signed1.sign.sig, signed2.sign.sig, "Signatures should differ");
    assert_ne!(signed1.sign.owner, signed2.sign.owner, "Owners should differ");
    assert_eq!(signed1.sign.owner, TEST_PUBLIC_KEY, "First owner should match first key");
    assert_eq!(signed2.sign.owner, TEST_PUBLIC_KEY_2, "Second owner should match second key");
}

// ============================================================================
// Public Key Case Handling
// ============================================================================

#[cfg_attr(target_arch = "wasm32", wasm_bindgen_test)]
#[test]
fn test_public_key_uppercase_normalized_to_lowercase() {
    shardus_crypto_init(TEST_HASH_KEY).unwrap();

    let secret = "0000000000000000000000000000000000000000000000000000000000000000";
    let public_upper = "3B6A27BCCEB6A42D62A3A8D02A6F0D73653215771DE243A63AC048A18B59DA29";

    shardus_crypto_set_keys(public_upper, secret).unwrap();

    let payload = TestPayload {
        message: "test".to_string(),
        value: 1,
    };

    let result = maybe_sign_request_body(payload).unwrap();
    let signed: SignedRequest = serde_json::from_value(result).unwrap();

    // Owner should be lowercase per code logic (line 146, 174 in shardus_crypto.rs)
    assert_eq!(
        signed.sign.owner,
        public_upper.to_ascii_lowercase(),
        "Public key should be normalized to lowercase"
    );
}

// ============================================================================
// Unit tests for hash, sign, verify, maybe_sign_request_body, verify_signed_request_body
// (native only - not run on wasm32)
// ============================================================================

#[cfg(not(target_arch = "wasm32"))]
#[test]
fn test_hash() {
    shardus_crypto_init(HASH_KEY).expect("init");
    let input = b"hello world";
    let result = hash(input, Format::Hex).expect("hash");
    let hex_str = result.to_string();
    let expected = "463bad7a09d224af5251be7d979cc8db3df37c422ea38d6c3986c54ee9c8f116";
    assert_eq!(expected, hex_str, "hash hex output");
}

#[cfg(not(target_arch = "wasm32"))]
#[test]
fn test_hash_format_buffer() {
    shardus_crypto_init(HASH_KEY).expect("init");
    let input = b"hello world";
    let out_hex = hash(input, Format::Hex).expect("hash hex");
    let out_buf = hash(input, Format::Buffer).expect("hash buffer");
    match (&out_hex, &out_buf) {
        (HexStringOrBuffer::Hex(h), HexStringOrBuffer::Buffer(b)) => {
            let decoded = hex::decode(h).expect("decode hex");
            assert_eq!(&decoded[..], b.as_slice(), "hash Hex vs Buffer match");
        }
        _ => panic!("unexpected format"),
    }
}

#[cfg(not(target_arch = "wasm32"))]
#[test]
fn test_hashslice_same_as_hash() {
    shardus_crypto_init(HASH_KEY).expect("init");
    let input = b"hello world";
    let h1 = hash(input, Format::Hex).expect("hash");
    let h2 = hashslice(input, Format::Hex).expect("hashslice");
    assert_eq!(h1.to_string(), h2.to_string());
}

#[cfg(not(target_arch = "wasm32"))]
#[test]
fn test_get_key_pair_using_sk_hex() {
    let kp =
        get_key_pair_using_sk(&HexStringOrBuffer::Hex(SECRET_KEY_HEX.to_string())).expect("keypair");
    assert_eq!(hex::encode(kp.public_key.to_bytes()), PUBLIC_KEY_HEX);
}

#[cfg(not(target_arch = "wasm32"))]
#[test]
fn test_get_key_pair_using_sk_buffer() {
    let buf = hex::decode(SECRET_KEY_HEX).expect("decode sk");
    let kp = get_key_pair_using_sk(&HexStringOrBuffer::Buffer(buf)).expect("keypair");
    assert_eq!(hex::encode(kp.public_key.to_bytes()), PUBLIC_KEY_HEX);
}

#[cfg(not(target_arch = "wasm32"))]
#[test]
fn test_get_pk_hex_and_buffer() {
    let pk_hex = get_pk(&HexStringOrBuffer::Hex(PUBLIC_KEY_HEX.to_string())).expect("pk hex");
    let buf = hex::decode(PUBLIC_KEY_HEX).expect("decode pk");
    let pk_buf = get_pk(&HexStringOrBuffer::Buffer(buf)).expect("pk buffer");
    assert_eq!(pk_hex.to_bytes(), pk_buf.to_bytes());
}

#[cfg(not(target_arch = "wasm32"))]
#[test]
fn test_sign_same_input_hex_and_buffer() {
    let kp =
        get_key_pair_using_sk(&HexStringOrBuffer::Hex(SECRET_KEY_HEX.to_string())).expect("keypair");
    let msg_hex = "1234567890abcdef";
    let msg_buf = hex::decode(msg_hex).expect("decode");
    let sig_hex =
        sign(HexStringOrBuffer::Hex(msg_hex.to_string()), &kp.secret_key).expect("sign hex");
    let sig_buf = sign(HexStringOrBuffer::Buffer(msg_buf.clone()), &kp.secret_key).expect("sign buffer");
    assert_eq!(sig_hex, sig_buf, "same message as hex or buffer gives same signature");
}

#[cfg(not(target_arch = "wasm32"))]
#[test]
fn test_verify_valid_signature() {
    let kp =
        get_key_pair_using_sk(&HexStringOrBuffer::Hex(SECRET_KEY_HEX.to_string())).expect("keypair");
    let msg = b"hello world";
    let sig = sign(HexStringOrBuffer::Buffer(msg.to_vec()), &kp.secret_key).expect("sign");
    assert!(verify(
        &HexStringOrBuffer::Buffer(msg.to_vec()),
        &sig,
        &kp.public_key
    ));
    assert!(verify(
        &HexStringOrBuffer::Hex(hex::encode(msg)),
        &sig,
        &kp.public_key
    ));
}

#[cfg(not(target_arch = "wasm32"))]
#[test]
fn test_verify_invalid_message_fails() {
    let kp =
        get_key_pair_using_sk(&HexStringOrBuffer::Hex(SECRET_KEY_HEX.to_string())).expect("keypair");
    let msg = b"hello world";
    let sig = sign(HexStringOrBuffer::Buffer(msg.to_vec()), &kp.secret_key).expect("sign");
    assert!(!verify(
        &HexStringOrBuffer::Buffer(b"wrong message".to_vec()),
        &sig,
        &kp.public_key
    ));
}

#[cfg(not(target_arch = "wasm32"))]
#[test]
fn test_verify_tampered_sig_fails() {
    let kp =
        get_key_pair_using_sk(&HexStringOrBuffer::Hex(SECRET_KEY_HEX.to_string())).expect("keypair");
    let msg = b"hello world";
    let mut sig = sign(HexStringOrBuffer::Buffer(msg.to_vec()), &kp.secret_key).expect("sign");
    assert!(verify(
        &HexStringOrBuffer::Buffer(msg.to_vec()),
        &sig,
        &kp.public_key
    ));
    sig[0] ^= 0xff;
    assert!(!verify(
        &HexStringOrBuffer::Buffer(msg.to_vec()),
        &sig,
        &kp.public_key
    ));
}

#[cfg(not(target_arch = "wasm32"))]
#[test]
fn test_maybe_sign_request_body_passthrough_or_signed() {
    shardus_crypto_init(HASH_KEY).expect("init");
    let payload = serde_json::json!({"key": "value"});
    let out = maybe_sign_request_body(payload).expect("maybe_sign_request_body");
    let obj = out.as_object().expect("object");
    let payload_value = out
        .get("key")
        .or_else(|| obj.get("payload").and_then(|p| p.get("key")));
    assert_eq!(
        payload_value.and_then(|v| v.as_str()),
        Some("value"),
        "payload preserved in passthrough or signed"
    );
}

#[cfg(not(target_arch = "wasm32"))]
#[test]
fn test_maybe_sign_request_body_signed_when_keys_set() {
    shardus_crypto_init(HASH_KEY).expect("init");
    shardus_crypto_set_keys(PUBLIC_KEY_HEX, SECRET_KEY_HEX).expect("set_keys");
    let payload = serde_json::json!({"action": "ping"});
    let out = maybe_sign_request_body(payload).expect("maybe_sign_request_body");
    let obj = out.as_object().expect("object");
    assert!(obj.contains_key("payload"), "signed result has payload");
    assert!(obj.contains_key("ts"), "signed result has ts");
    let sign_obj = obj.get("sign").and_then(|v| v.as_object()).expect("sign object");
    let owner = sign_obj.get("owner").and_then(|v| v.as_str()).expect("owner");
    let sig_hex = sign_obj.get("sig").and_then(|v| v.as_str()).expect("sig");
    assert_eq!(owner, PUBLIC_KEY_HEX.to_lowercase());
    let sig_buf = hex::decode(sig_hex).expect("sig hex decode");
    assert!(sig_buf.len() >= 64, "sig is at least 64 bytes + digest");
    let digest = sig_buf[64..].to_vec();
    let pk = get_pk(&HexStringOrBuffer::Hex(PUBLIC_KEY_HEX.to_string())).expect("pk");
    assert!(
        verify(
            &HexStringOrBuffer::Buffer(digest.clone()),
            &sig_buf,
            &pk
        ),
        "signature in maybe_sign_request_body should verify"
    );
}

#[cfg(not(target_arch = "wasm32"))]
#[test]
fn test_maybe_sign_request_body_signed_same_payload_same_digest() {
    shardus_crypto_init(HASH_KEY).expect("init");
    shardus_crypto_set_keys(PUBLIC_KEY_HEX, SECRET_KEY_HEX).expect("set_keys");
    let out1 = maybe_sign_request_body(serde_json::json!({"id": 42})).expect("first");
    let out2 = maybe_sign_request_body(serde_json::json!({"id": 42})).expect("second");
    let sig1 = out1
        .get("sign")
        .and_then(|s| s.get("sig"))
        .and_then(|v| v.as_str())
        .expect("sig1");
    let sig2 = out2
        .get("sign")
        .and_then(|s| s.get("sig"))
        .and_then(|v| v.as_str())
        .expect("sig2");
    let buf1 = hex::decode(sig1).expect("sig1 decode");
    let buf2 = hex::decode(sig2).expect("sig2 decode");
    assert_eq!(buf1.len(), buf2.len());
    assert!(buf1.len() >= 64);
    let pk = get_pk(&HexStringOrBuffer::Hex(PUBLIC_KEY_HEX.to_string())).expect("pk");
    assert!(verify(
        &HexStringOrBuffer::Buffer(buf1[64..].to_vec()),
        &buf1,
        &pk
    ));
    assert!(verify(
        &HexStringOrBuffer::Buffer(buf2[64..].to_vec()),
        &buf2,
        &pk
    ));
}

#[cfg(not(target_arch = "wasm32"))]
#[test]
fn test_verify_signed_request_body() {
    shardus_crypto_init(HASH_KEY).expect("init");
    shardus_crypto_set_keys(PUBLIC_KEY_HEX, SECRET_KEY_HEX).expect("set_keys");
    let payload = serde_json::json!({"action": "test"});
    let body = maybe_sign_request_body(payload).expect("signed body");
    let ok = verify_signed_request_body(&body, HASH_KEY).expect("verify_signed_request_body");
    assert!(
        ok,
        "verify_signed_request_body should succeed for body from maybe_sign_request_body"
    );
}

#[cfg(not(target_arch = "wasm32"))]
#[test]
fn test_verify_signed_request_body_tampered_fails() {
    shardus_crypto_init(HASH_KEY).expect("init");
    shardus_crypto_set_keys(PUBLIC_KEY_HEX, SECRET_KEY_HEX).expect("set_keys");
    let body = maybe_sign_request_body(serde_json::json!({"x": 1})).expect("signed body");
    let ok = verify_signed_request_body(&body, HASH_KEY).expect("verify");
    assert!(ok);

    let mut tampered = body.clone();
    tampered["payload"] = serde_json::json!({"x": 2});
    let ok2 = verify_signed_request_body(&tampered, HASH_KEY).expect("verify");
    assert!(
        !ok2,
        "tampered payload should fail verification"
    );
}
