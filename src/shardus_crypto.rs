use crate::errors::{Result, TssError};
#[cfg(target_arch = "wasm32")]
use crate::log;
use blake2::digest::{Update, VariableOutput};
use blake2::VarBlake2b;
use core::fmt;
use ed25519_dalek::{Keypair, PublicKey, SecretKey, Signature, Signer, Verifier};
use serde::Serialize;
#[cfg(not(target_arch = "wasm32"))]
use lazy_static::lazy_static;
#[cfg(not(target_arch = "wasm32"))]
use std::sync::Mutex;
#[cfg(target_arch = "wasm32")]
use std::{cell::RefCell, thread_local};

pub enum Format {
    Hex,
    Buffer,
}

pub enum HexStringOrBuffer {
    Hex(String),
    Buffer(Vec<u8>),
}

impl fmt::Display for HexStringOrBuffer {
    fn fmt(&self, f: &mut fmt::Formatter) -> fmt::Result {
        match self {
            HexStringOrBuffer::Hex(s) => write!(f, "{}", s),
            HexStringOrBuffer::Buffer(bytes) => {
                for b in bytes {
                    write!(f, "{:02X}", b)?;
                }
                Ok(())
            }
        }
    }
}

pub struct ShardusKeyPair {
    pub public_key: PublicKey,
    pub secret_key: SecretKey,
}

// --- Internal state ---

struct ShardusCryptoState {
    hash_key: Vec<u8>,
    public_key_hex: String,
    keypair: Keypair,
}

#[derive(Serialize)]
struct SignField {
    owner: String,
    sig: String,
}

#[derive(Serialize)]
struct SignedRequest<T>
where
    T: Serialize,
{
    payload: T,
    ts: u64,
    sign: SignField,
}

#[derive(Serialize)]
struct UnsignedRequest<T>
where
    T: Serialize,
{
    payload: T,
    ts: u64,
}

#[cfg(not(target_arch = "wasm32"))]
lazy_static! {
    static ref SHARDUS_CRYPTO_STATE: Mutex<Option<ShardusCryptoState>> = Mutex::new(None);
}

#[cfg(target_arch = "wasm32")]
thread_local! {
    static SHARDUS_CRYPTO_STATE: RefCell<Option<ShardusCryptoState>> = const { RefCell::new(None) };
}

pub fn shardus_crypto_init(hash_key_hex: &str) -> Result<()> {
    let hash_key = decode_hex(hash_key_hex)?;

    #[cfg(target_arch = "wasm32")]
    {
        SHARDUS_CRYPTO_STATE.with(|state| {
            let mut state = state.borrow_mut();
            if let Some(existing) = state.as_mut() {
                existing.hash_key = hash_key.clone();
                return;
            }

            *state = Some(ShardusCryptoState {
                hash_key: hash_key.clone(),
                public_key_hex: String::new(),
                keypair: empty_keypair().expect("empty_keypair failed"),
            });
        });
        return Ok(());
    }

    #[cfg(not(target_arch = "wasm32"))]
    {
    let mut state = SHARDUS_CRYPTO_STATE
        .lock()
        .map_err(|_| TssError::UnknownError {
            msg: "shardus_crypto_init lock".to_string(),
            line: line!(),
        })?;

    if let Some(existing) = state.as_mut() {
        existing.hash_key = hash_key;
        return Ok(());
    }

    *state = Some(ShardusCryptoState {
        hash_key,
        public_key_hex: String::new(),
        keypair: empty_keypair()?,
    });

    Ok(())
    }
}

pub fn shardus_crypto_set_keys(public_key_hex: &str, secret_key_hex: &str) -> Result<()> {
    let provided_public = decode_hex(public_key_hex)?;
    if provided_public.len() != 32 {
        return Err(TssError::UnknownError {
            msg: "Invalid shardus crypto public key length".to_string(),
            line: line!(),
        });
    }

    let secret_key_bytes = decode_hex(secret_key_hex)?;
    if secret_key_bytes.len() != 32 && secret_key_bytes.len() != 64 {
        return Err(TssError::UnknownError {
            msg: "Invalid shardus crypto secret key length".to_string(),
            line: line!(),
        });
    }

    let seed_bytes = if secret_key_bytes.len() == 64 {
        secret_key_bytes[..32].to_vec()
    } else {
        secret_key_bytes
    };

    let secret = SecretKey::from_bytes(&seed_bytes).map_err(|_| TssError::UnknownError {
        msg: "Invalid shardus crypto secret key".to_string(),
        line: line!(),
    })?;
    let derived_public = PublicKey::from(&secret);

    if derived_public.as_bytes() != provided_public.as_slice() {
        return Err(TssError::UnknownError {
            msg: "Shardus crypto public key mismatch".to_string(),
            line: line!(),
        });
    }

    #[cfg(target_arch = "wasm32")]
    {
        let keypair = Keypair {
            secret,
            public: derived_public,
        };
        SHARDUS_CRYPTO_STATE.with(|state| {
            let mut state = state.borrow_mut();
            if let Some(existing) = state.as_mut() {
                existing.public_key_hex = public_key_hex.to_ascii_lowercase();
                existing.keypair = keypair;
                return;
            }

            *state = Some(ShardusCryptoState {
                hash_key: Vec::new(),
                public_key_hex: public_key_hex.to_ascii_lowercase(),
                keypair,
            });
        });
        return Ok(());
    }

    #[cfg(not(target_arch = "wasm32"))]
    {
    let keypair = Keypair {
        secret,
        public: derived_public,
    };
    let mut state = SHARDUS_CRYPTO_STATE
        .lock()
        .map_err(|_| TssError::UnknownError {
            msg: "shardus_crypto_set_keys lock".to_string(),
            line: line!(),
        })?;

    if let Some(existing) = state.as_mut() {
        existing.public_key_hex = public_key_hex.to_ascii_lowercase();
        existing.keypair = keypair;
        return Ok(());
    }

    *state = Some(ShardusCryptoState {
        hash_key: Vec::new(),
        public_key_hex: public_key_hex.to_ascii_lowercase(),
        keypair,
    });

    Ok(())
    }
}

pub fn maybe_sign_request_body<T>(payload: T) -> Result<serde_json::Value>
where
    T: Serialize,
{
    #[cfg(target_arch = "wasm32")]
    crate::debug_console_log!("shardus_crypto maybe_sign_request_body: start");
    let ts = current_unix_timestamp_ms();

    #[cfg(target_arch = "wasm32")]
    {
        return SHARDUS_CRYPTO_STATE.with(|state| -> Result<serde_json::Value> {
            let state = state.borrow();

            let Some(crypto_state) = state.as_ref() else {
                #[cfg(target_arch = "wasm32")]
                crate::debug_console_log!("shardus_crypto maybe_sign_request_body: no state, passthrough");
                return Ok(serde_json::to_value(payload)?);
            };

            if crypto_state.hash_key.is_empty() || crypto_state.public_key_hex.is_empty() {
                #[cfg(target_arch = "wasm32")]
                crate::debug_console_log!("shardus_crypto maybe_sign_request_body: missing hash/public key, passthrough");
                return Ok(serde_json::to_value(payload)?);
            }

            #[cfg(target_arch = "wasm32")]
            crate::debug_console_log!(
                "shardus_crypto maybe_sign_request_body: hash_key_len={} public_key_len={}",
                crypto_state.hash_key.len(),
                crypto_state.public_key_hex.len()
            );
            let unsigned = UnsignedRequest { payload, ts };
            let serialized_unsigned = serde_json::to_string(&unsigned)?;
            #[cfg(target_arch = "wasm32")]
            crate::debug_console_log!(
                "shardus_crypto maybe_sign_request_body: serialized_unsigned_len={}",
                serialized_unsigned.len()
            );
            let digest = hash_with_shardus_key(serialized_unsigned.as_bytes(), &crypto_state.hash_key);
            #[cfg(target_arch = "wasm32")]
            crate::debug_console_log!(
                "shardus_crypto maybe_sign_request_body: digest_len={}",
                digest.len()
            );

            let signature = crypto_state.keypair.sign(&digest);
            #[cfg(target_arch = "wasm32")]
            crate::debug_console_log!("shardus_crypto maybe_sign_request_body: signed");

            let mut signed_msg = Vec::with_capacity(signature.to_bytes().len() + digest.len());
            signed_msg.extend_from_slice(&signature.to_bytes());
            signed_msg.extend_from_slice(&digest);

            let signed = SignedRequest {
                payload: unsigned.payload,
                ts,
                sign: SignField {
                    owner: crypto_state.public_key_hex.clone(),
                    sig: hex::encode(signed_msg),
                },
            };

            #[cfg(target_arch = "wasm32")]
            crate::debug_console_log!("shardus_crypto maybe_sign_request_body: done");
            Ok(serde_json::to_value(signed)?)
        });
    }

    #[cfg(not(target_arch = "wasm32"))]
    {
    let state = SHARDUS_CRYPTO_STATE
        .lock()
        .map_err(|_| TssError::UnknownError {
            msg: "maybe_sign_request_body lock".to_string(),
            line: line!(),
        })?;

    let Some(crypto_state) = state.as_ref() else {
        #[cfg(target_arch = "wasm32")]
        crate::console_log!("shardus_crypto maybe_sign_request_body: no state, passthrough");
        return Ok(serde_json::to_value(payload)?);
    };

    if crypto_state.hash_key.is_empty() || crypto_state.public_key_hex.is_empty() {
        #[cfg(target_arch = "wasm32")]
        crate::console_log!("shardus_crypto maybe_sign_request_body: missing hash/public key, passthrough");
        return Ok(serde_json::to_value(payload)?);
    }

    #[cfg(target_arch = "wasm32")]
    crate::console_log!(
        "shardus_crypto maybe_sign_request_body: hash_key_len={} public_key_len={}",
        crypto_state.hash_key.len(),
        crypto_state.public_key_hex.len()
    );
    let unsigned = UnsignedRequest { payload, ts };
    let serialized_unsigned = serde_json::to_string(&unsigned)?;
    #[cfg(target_arch = "wasm32")]
    crate::console_log!(
        "shardus_crypto maybe_sign_request_body: serialized_unsigned_len={}",
        serialized_unsigned.len()
    );
    let digest = hash_with_shardus_key(serialized_unsigned.as_bytes(), &crypto_state.hash_key);
    #[cfg(target_arch = "wasm32")]
    crate::console_log!(
        "shardus_crypto maybe_sign_request_body: digest_len={}",
        digest.len()
    );

    let signature = crypto_state.keypair.sign(&digest);
    #[cfg(target_arch = "wasm32")]
    crate::console_log!("shardus_crypto maybe_sign_request_body: signed");

    let mut signed_msg = Vec::with_capacity(signature.to_bytes().len() + digest.len());
    signed_msg.extend_from_slice(&signature.to_bytes());
    signed_msg.extend_from_slice(&digest);

    let signed = SignedRequest {
        payload: unsigned.payload,
        ts,
        sign: SignField {
            owner: crypto_state.public_key_hex.clone(),
            sig: hex::encode(signed_msg),
        },
    };

    #[cfg(target_arch = "wasm32")]
    crate::console_log!("shardus_crypto maybe_sign_request_body: done");
    Ok(serde_json::to_value(signed)?)
    }
}

fn hash_with_shardus_key(input: &[u8], hash_key: &[u8]) -> Vec<u8> {
    #[cfg(target_arch = "wasm32")]
    crate::debug_console_log!(
        "shardus_crypto hash_with_shardus_key: input_len={} key_len={}",
        input.len(),
        hash_key.len()
    );
    let mut hasher = VarBlake2b::new_keyed(hash_key, 32);
    hasher.update(input);
    let mut digest = Vec::new();
    hasher.finalize_variable(|res| {
        digest = res.to_vec();
    });
    digest
}

fn decode_hex(input: &str) -> Result<Vec<u8>> {
    hex::decode(input).map_err(|_| TssError::UnknownError {
        msg: "Invalid hex".to_string(),
        line: line!(),
    })
}

#[cfg(target_arch = "wasm32")]
fn current_unix_timestamp_ms() -> u64 {
    js_sys::Date::now() as u64
}

#[cfg(not(target_arch = "wasm32"))]
fn current_unix_timestamp_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn empty_keypair() -> Result<Keypair> {
    let secret = SecretKey::from_bytes(&[1u8; 32]).map_err(|_| TssError::UnknownError {
        msg: "empty_keypair secret".to_string(),
        line: line!(),
    })?;
    let public = PublicKey::from(&secret);
    Ok(Keypair { secret, public })
}
