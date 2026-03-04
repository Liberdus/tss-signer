use crate::errors::{Result, TssError};
use blake2::digest::{Update, VariableOutput};
use blake2::VarBlake2b;
use ed25519_dalek::{Keypair, PublicKey, SecretKey, Signer};
use lazy_static::lazy_static;
use serde::Serialize;
use std::sync::Mutex;

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

lazy_static! {
    static ref SHARDUS_CRYPTO_STATE: Mutex<Option<ShardusCryptoState>> = Mutex::new(None);
}

pub fn shardus_crypto_init(hash_key_hex: &str) -> Result<()> {
    let hash_key = decode_hex(hash_key_hex)?;
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

pub fn maybe_sign_request_body<T>(payload: T) -> Result<serde_json::Value>
where
    T: Serialize,
{
    let ts = current_unix_timestamp_ms();

    let state = SHARDUS_CRYPTO_STATE
        .lock()
        .map_err(|_| TssError::UnknownError {
            msg: "maybe_sign_request_body lock".to_string(),
            line: line!(),
        })?;

    let Some(crypto_state) = state.as_ref() else {
        return Ok(serde_json::to_value(payload)?);
    };

    if crypto_state.hash_key.is_empty() || crypto_state.public_key_hex.is_empty() {
        return Ok(serde_json::to_value(payload)?);
    }

    let unsigned = UnsignedRequest { payload, ts };
    let serialized_unsigned = serde_json::to_string(&unsigned)?;
    let digest = hash_with_shardus_key(serialized_unsigned.as_bytes(), &crypto_state.hash_key);

    let signature = crypto_state.keypair.sign(&digest);

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

    Ok(serde_json::to_value(signed)?)
}

fn hash_with_shardus_key(input: &[u8], hash_key: &[u8]) -> Vec<u8> {
    let mut hasher = VarBlake2b::new_keyed(hash_key, 32);
    hasher.update(input);
    let mut digest = vec![0u8; 32];
    hasher.finalize_variable(|res| {
        digest.copy_from_slice(res);
    });
    digest
}

fn decode_hex(input: &str) -> Result<Vec<u8>> {
    hex::decode(input).map_err(|_| TssError::UnknownError {
        msg: "Invalid hex".to_string(),
        line: line!(),
    })
}

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
