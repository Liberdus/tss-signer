//! Unit tests for shardus_crypto (hash, sign, verify, maybe_sign_request_body, verify_signed_request_body).
//! Loaded from lib.rs only when `cfg(all(test, not(target_arch = "wasm32")))`.

mod tests {
    use crate::shardus_crypto::{
        get_key_pair_using_sk, get_pk, hash, hashslice, maybe_sign_request_body,
        shardus_crypto_init, shardus_crypto_set_keys, sign, verify, verify_signed_request_body,
        Format, HexStringOrBuffer,
    };

    const HASH_KEY: &str = "64f152869ca2d473e4ba64ab53f49ccdb2edae22da192c126850970e788af347";
    const SECRET_KEY_HEX: &str = "c3774b92cc8850fb4026b073081290b82cab3c0f66cac250b4d710ee9aaf83ed8088b37f6f458104515ae18c2a05bde890199322f62ab5114d20c77bde5e6c9d";
    const PUBLIC_KEY_HEX: &str = "8088b37f6f458104515ae18c2a05bde890199322f62ab5114d20c77bde5e6c9d";

    #[test]
    fn test_hash() {
        shardus_crypto_init(HASH_KEY).expect("init");
        let input = b"hello world";
        let result = hash(input, Format::Hex).expect("hash");
        let hex_str = result.to_string();
        let expected = "463bad7a09d224af5251be7d979cc8db3df37c422ea38d6c3986c54ee9c8f116";
        assert_eq!(expected, hex_str, "hash hex output");
    }

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

    #[test]
    fn test_hashslice_same_as_hash() {
        shardus_crypto_init(HASH_KEY).expect("init");
        let input = b"hello world";
        let h1 = hash(input, Format::Hex).expect("hash");
        let h2 = hashslice(input, Format::Hex).expect("hashslice");
        assert_eq!(h1.to_string(), h2.to_string());
    }

    #[test]
    fn test_get_key_pair_using_sk_hex() {
        let kp = get_key_pair_using_sk(&HexStringOrBuffer::Hex(SECRET_KEY_HEX.to_string())).expect("keypair");
        assert_eq!(hex::encode(kp.public_key.to_bytes()), PUBLIC_KEY_HEX);
    }

    #[test]
    fn test_get_key_pair_using_sk_buffer() {
        let buf = hex::decode(SECRET_KEY_HEX).expect("decode sk");
        let kp = get_key_pair_using_sk(&HexStringOrBuffer::Buffer(buf)).expect("keypair");
        assert_eq!(hex::encode(kp.public_key.to_bytes()), PUBLIC_KEY_HEX);
    }

    #[test]
    fn test_get_pk_hex_and_buffer() {
        let pk_hex = get_pk(&HexStringOrBuffer::Hex(PUBLIC_KEY_HEX.to_string())).expect("pk hex");
        let buf = hex::decode(PUBLIC_KEY_HEX).expect("decode pk");
        let pk_buf = get_pk(&HexStringOrBuffer::Buffer(buf)).expect("pk buffer");
        assert_eq!(pk_hex.to_bytes(), pk_buf.to_bytes());
    }

    #[test]
    fn test_sign_same_input_hex_and_buffer() {
        let kp = get_key_pair_using_sk(&HexStringOrBuffer::Hex(SECRET_KEY_HEX.to_string())).expect("keypair");
        let msg_hex = "1234567890abcdef";
        let msg_buf = hex::decode(msg_hex).expect("decode");
        let sig_hex = sign(HexStringOrBuffer::Hex(msg_hex.to_string()), &kp.secret_key).expect("sign hex");
        let sig_buf = sign(HexStringOrBuffer::Buffer(msg_buf.clone()), &kp.secret_key).expect("sign buffer");
        assert_eq!(sig_hex, sig_buf, "same message as hex or buffer gives same signature");
    }

    #[test]
    fn test_verify_valid_signature() {
        let kp = get_key_pair_using_sk(&HexStringOrBuffer::Hex(SECRET_KEY_HEX.to_string())).expect("keypair");
        let msg = b"hello world";
        let sig = sign(HexStringOrBuffer::Buffer(msg.to_vec()), &kp.secret_key).expect("sign");
        assert!(verify(&HexStringOrBuffer::Buffer(msg.to_vec()), &sig, &kp.public_key));
        assert!(verify(&HexStringOrBuffer::Hex(hex::encode(msg)), &sig, &kp.public_key));
    }

    #[test]
    fn test_verify_invalid_message_fails() {
        let kp = get_key_pair_using_sk(&HexStringOrBuffer::Hex(SECRET_KEY_HEX.to_string())).expect("keypair");
        let msg = b"hello world";
        let sig = sign(HexStringOrBuffer::Buffer(msg.to_vec()), &kp.secret_key).expect("sign");
        assert!(!verify(&HexStringOrBuffer::Buffer(b"wrong message".to_vec()), &sig, &kp.public_key));
    }

    #[test]
    fn test_verify_tampered_sig_fails() {
        let kp = get_key_pair_using_sk(&HexStringOrBuffer::Hex(SECRET_KEY_HEX.to_string())).expect("keypair");
        let msg = b"hello world";
        let mut sig = sign(HexStringOrBuffer::Buffer(msg.to_vec()), &kp.secret_key).expect("sign");
        assert!(verify(&HexStringOrBuffer::Buffer(msg.to_vec()), &sig, &kp.public_key));
        sig[0] ^= 0xff;
        assert!(!verify(&HexStringOrBuffer::Buffer(msg.to_vec()), &sig, &kp.public_key));
    }

    #[test]
    fn test_maybe_sign_request_body_passthrough_or_signed() {
        shardus_crypto_init(HASH_KEY).expect("init");
        let payload = serde_json::json!({"key": "value"});
        let out = maybe_sign_request_body(payload).expect("maybe_sign_request_body");
        let obj = out.as_object().expect("object");
        let payload_value = out.get("key").or_else(|| obj.get("payload").and_then(|p| p.get("key")));
        assert_eq!(payload_value.and_then(|v| v.as_str()), Some("value"), "payload preserved in passthrough or signed");
    }

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

    #[test]
    fn test_maybe_sign_request_body_signed_same_payload_same_digest() {
        shardus_crypto_init(HASH_KEY).expect("init");
        shardus_crypto_set_keys(PUBLIC_KEY_HEX, SECRET_KEY_HEX).expect("set_keys");
        let out1 = maybe_sign_request_body(serde_json::json!({"id": 42})).expect("first");
        let out2 = maybe_sign_request_body(serde_json::json!({"id": 42})).expect("second");
        let sig1 = out1.get("sign").and_then(|s| s.get("sig")).and_then(|v| v.as_str()).expect("sig1");
        let sig2 = out2.get("sign").and_then(|s| s.get("sig")).and_then(|v| v.as_str()).expect("sig2");
        let buf1 = hex::decode(sig1).expect("sig1 decode");
        let buf2 = hex::decode(sig2).expect("sig2 decode");
        assert_eq!(buf1.len(), buf2.len());
        assert!(buf1.len() >= 64);
        let pk = get_pk(&HexStringOrBuffer::Hex(PUBLIC_KEY_HEX.to_string())).expect("pk");
        assert!(verify(&HexStringOrBuffer::Buffer(buf1[64..].to_vec()), &buf1, &pk));
        assert!(verify(&HexStringOrBuffer::Buffer(buf2[64..].to_vec()), &buf2, &pk));
    }

    #[test]
    fn test_verify_signed_request_body() {
        shardus_crypto_init(HASH_KEY).expect("init");
        shardus_crypto_set_keys(PUBLIC_KEY_HEX, SECRET_KEY_HEX).expect("set_keys");
        let payload = serde_json::json!({"action": "test"});
        let body = maybe_sign_request_body(payload).expect("signed body");
        let ok = verify_signed_request_body(&body, HASH_KEY).expect("verify_signed_request_body");
        assert!(ok, "verify_signed_request_body should succeed for body from maybe_sign_request_body");
    }

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
        assert!(!ok2, "tampered payload should fail verification");
    }
}
