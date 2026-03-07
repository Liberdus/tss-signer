#![allow(dead_code)]

use crate::curv::elliptic::curves::traits::{ECPoint, ECScalar};
use crate::errors::TssError;
#[cfg(target_arch = "wasm32")]
use crate::log;

use aes_gcm::aead::{Aead, NewAead};
use aes_gcm::{Aes256Gcm, Nonce};
use rand::{rngs::OsRng, RngCore};

use crate::curv::{
    arithmetic::num_bigint::BigInt,
    arithmetic::traits::Converter,
    elliptic::curves::secp256_k1::{Secp256k1Point as Point, Secp256k1Scalar as Scalar},
};

use futures::future::{select, Either};
use futures::pin_mut;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use sha3::{Digest, Keccak256};
use std::future::Future;

use crate::errors::Result;
use crate::shardus_crypto::maybe_sign_request_body;

pub type Key = String;

#[allow(dead_code)]
pub const AES_KEY_BYTES_LEN: usize = 32;

#[derive(Clone, PartialEq, Debug, Serialize, Deserialize)]
pub struct AEAD {
    pub ciphertext: Vec<u8>,
    pub tag: Vec<u8>,
}

#[derive(Clone, PartialEq, Debug, Serialize, Deserialize)]
pub struct PartySignup {
    pub number: u16,
    pub uuid: String,
}

#[derive(Clone, PartialEq, Debug, Serialize, Deserialize)]
pub struct Index {
    pub key: Key,
}

#[derive(Clone, PartialEq, Debug, Serialize, Deserialize)]
pub struct Entry {
    pub key: Key,
    pub value: String,
}

#[derive(Serialize, Deserialize)]
pub struct Params {
    pub parties: String,
    pub threshold: String,
}

#[allow(dead_code)]
pub fn aes_encrypt(key: &[u8], plaintext: &[u8]) -> Result<AEAD> {
    let aes_key = aes_gcm::Key::from_slice(key);
    let cipher = Aes256Gcm::new(aes_key);

    let mut nonce = [0u8; 12];
    let mut rng = OsRng::new()?;
    rng.fill_bytes(&mut nonce);
    let nonce = Nonce::from_slice(&nonce);

    let ciphertext = cipher
        .encrypt(nonce, plaintext)
        .map_err(|_e| TssError::UnknownError {
            msg: ("encryption failure!").to_string(),
            line: (line!()),
        })?;
    Ok(AEAD {
        ciphertext: ciphertext,
        tag: nonce.to_vec(),
    })
}

#[allow(dead_code)]
pub fn aes_decrypt(key: &[u8], aead_pack: AEAD) -> Result<Vec<u8>> {
    let aes_key = aes_gcm::Key::from_slice(key);
    let nonce = Nonce::from_slice(&aead_pack.tag);
    let gcm = Aes256Gcm::new(aes_key);

    let out = gcm
        .decrypt(nonce, aead_pack.ciphertext.as_slice())
        .map_err(|_e| TssError::UnknownError {
            msg: ("aes_decrypt").to_string(),
            line: (line!()),
        });
    out
}

#[cfg(target_arch = "wasm32")]
#[wasm_bindgen::prelude::wasm_bindgen]
extern "C" {
    // Binds to globalThis.setTimeout — works in both browser and Node.js,
    // unlike web_sys::window().set_timeout_with_... which is browser-only.
    #[wasm_bindgen::prelude::wasm_bindgen(js_name = setTimeout)]
    fn set_timeout_global(closure: &js_sys::Function, ms: i32) -> f64;
}

#[cfg(target_arch = "wasm32")]
pub async fn sleep(ms: u32) {
    let before = js_sys::Date::now();
    let promise = js_sys::Promise::new(&mut |resolve, _| {
        set_timeout_global(&resolve, ms as i32);
    });
    let _ = wasm_bindgen_futures::JsFuture::from(promise).await;
    let after = js_sys::Date::now();
    if POLL_DEBUG_LOGS {
        crate::console_log!("[sleep] requested {}ms, actual elapsed {}ms", ms, (after - before) as u32);
    }
}

#[cfg(not(target_arch = "wasm32"))]
pub async fn sleep(ms: u32) {
    std::thread::sleep(core::time::Duration::from_millis(ms as u64));
}

pub async fn postb<T>(client: &Client, addr: &str, path: &str, body: T) -> Result<String>
where
    T: serde::ser::Serialize,
{
    let url = format!("{}/{}", addr, path);
    #[cfg(target_arch = "wasm32")]
    crate::debug_console_log!("postb -> {}", url);
    let body = maybe_sign_request_body(body)?;
    let body_json = serde_json::to_string(&body)?;
    #[cfg(target_arch = "wasm32")]
    crate::debug_console_log!("postb body bytes={} path={}", body_json.len(), path);
    let retries = 3;
    for _i in 1..retries {
        let res = client
            .post(url.clone())
            .header("Content-Type", "application/json; charset=utf-8")
            .header("Accept", "application/json; charset=utf-8")
            .body(body_json.clone())
            .send()
            .await;
        if let Ok(res) = res {
            #[cfg(target_arch = "wasm32")]
            crate::debug_console_log!("postb <- {} status {}", path, res.status().as_u16());
            return Ok(res.text().await?);
        } else {
            #[cfg(target_arch = "wasm32")]
            crate::debug_console_log!("postb retry {} failed for {}", _i, path);
        }
    }
    Err(TssError::UnknownError {
        msg: ("postb").to_string(),
        line: (line!()),
    })
}

pub async fn broadcast(
    client: &Client,
    addr: &str,
    party_num: u16,
    round: &str,
    data: String,
    sender_uuid: String,
) -> Result<()> {
    let key = format!("{}-{}-{}", party_num, round, sender_uuid);
    let entry = Entry { key, value: data };
    let res_body = postb(client, addr, "set", entry).await?;
    let response: serde_json::Value = serde_json::from_str(&res_body)?;
    if response.get("Ok").is_some() {
        return Ok(());
    }
    Err(TssError::UnknownError {
        msg: format!("broadcast failed: {}", res_body),
        line: line!(),
    })
}

pub async fn sendp2p(
    client: &Client,
    addr: &str,
    party_from: u16,
    party_to: u16,
    round: &str,
    data: String,
    sender_uuid: String,
) -> Result<()> {
    let key = format!("{}-{}-{}-{}", party_from, party_to, round, sender_uuid);

    let entry = Entry { key, value: data };

    let res_body = postb(client, addr, "set", entry).await?;
    let response: serde_json::Value = serde_json::from_str(&res_body)?;
    if response.get("Ok").is_some() {
        return Ok(());
    }
    Err(TssError::UnknownError {
        msg: format!("sendp2p failed: {}", res_body),
        line: line!(),
    })
}

/// Max time to wait for the whole round; the promise will resolve (with timeout error) within this time.
const ROUND_TIMEOUT_MS: u32 = 60_000; // 1 minute
const MAX_POLL_ATTEMPTS: u32 = 10_000; // safety cap on iterations per party
const POLL_DEBUG_LOGS: bool = false;

/// Runs a future and returns its result, or a timeout error if it doesn't complete within `timeout_ms`.
async fn with_timeout<F, T>(timeout_ms: u32, future: F) -> Result<T>
where
    F: Future<Output = Result<T>>,
{
    let timeout_fut = async move {
        sleep(timeout_ms).await;
        Err(TssError::UnknownError {
            msg: format!("operation timed out after {} ms", timeout_ms),
            line: line!(),
        })
    };
    pin_mut!(future);
    pin_mut!(timeout_fut);
    match select(future, timeout_fut).await {
        Either::Left((res, _)) => res,
        Either::Right((err, _)) => err,
    }
}

pub async fn poll_for_broadcasts(
    client: &Client,
    addr: &str,
    party_num: u16,
    n: u16,
    round: &str,
    sender_uuid: String,
    delay: u32,
) -> Result<Vec<String>> {
    let addr = addr.to_string();
    let round = round.to_string();
    with_timeout(
        ROUND_TIMEOUT_MS,
        poll_for_broadcasts_inner(client, &addr, party_num, n, &round, sender_uuid, delay),
    )
    .await
}

async fn poll_for_broadcasts_inner(
    client: &Client,
    addr: &str,
    party_num: u16,
    n: u16,
    round: &str,
    sender_uuid: String,
    delay: u32,
) -> Result<Vec<String>> {
    println!("[{:?}] party {:?} {:?} {:?} => poll_for_broadcast", round, party_num, n, sender_uuid);
    #[cfg(target_arch = "wasm32")]
    if POLL_DEBUG_LOGS {
        crate::console_log!("[{:?}] poll_for_broadcasts delay={}ms", round, delay);
    }
    let mut ans_vec = Vec::new();
    for i in 1..=n {
        if i != party_num {
            let key = format!("{}-{}-{}", i, round, sender_uuid);
            let index = Index { key };
            let mut attempts = 0u32;
            loop {
                sleep(delay).await;
                attempts += 1;
                if attempts > MAX_POLL_ATTEMPTS {
                    return Err(TssError::UnknownError {
                        msg: format!(
                            "poll_for_broadcasts too many attempts waiting for party {} in round {} ({} attempts)",
                            i, round, attempts
                        ),
                        line: line!(),
                    });
                }
                let res_body = postb(client, addr, "get", index.clone()).await?;
                let answer: std::result::Result<Entry, ()> = serde_json::from_str(&res_body)?;
                if let Ok(answer) = answer {
                    ans_vec.push(answer.value);
                    println!("[{:?}] party {:?} => party {:?}", round, i, party_num);
                    break;
                }
            }
        }
    }
    Ok(ans_vec)
}

pub async fn poll_for_p2p(
    client: &Client,
    addr: &str,
    party_num: u16,
    n: u16,
    delay: u32,
    round: &str,
    sender_uuid: String,
) -> Result<Vec<String>> {
    let addr = addr.to_string();
    let round = round.to_string();
    with_timeout(
        ROUND_TIMEOUT_MS,
        poll_for_p2p_inner(client, &addr, party_num, n, delay, &round, sender_uuid),
    )
    .await
}

async fn poll_for_p2p_inner(
    client: &Client,
    addr: &str,
    party_num: u16,
    n: u16,
    delay: u32,
    round: &str,
    sender_uuid: String,
) -> Result<Vec<String>> {
    #[cfg(target_arch = "wasm32")]
    if POLL_DEBUG_LOGS {
        crate::console_log!("[{:?}] poll_for_p2p delay={}ms", round, delay);
    }
    let mut ans_vec = Vec::new();
    for i in 1..=n {
        if i != party_num {
            let key = format!("{}-{}-{}-{}", i, party_num, round, sender_uuid);
            let index = Index { key };
            let mut attempts = 0u32;
            loop {
                sleep(delay).await;
                attempts += 1;
                if attempts > MAX_POLL_ATTEMPTS {
                    return Err(TssError::UnknownError {
                        msg: format!(
                            "poll_for_p2p too many attempts waiting for party {} in round {} ({} attempts)",
                            i, round, attempts
                        ),
                        line: line!(),
                    });
                }
                let res_body = postb(client, addr, "get", index.clone()).await?;
                let answer: std::result::Result<Entry, ()> = serde_json::from_str(&res_body)?;
                if let Ok(answer) = answer {
                    ans_vec.push(answer.value);
                    println!("[{:?}] party {:?} => party {:?}", round, i, party_num);
                    break;
                }
            }
        }
    }
    Ok(ans_vec)
}

pub fn check_sig(r: &Scalar, s: &Scalar, msg: &BigInt, pk: &Point) -> Result<bool> {
    let r_vec = BigInt::to_vec(&r.to_big_int());
    let s_vec = BigInt::to_vec(&s.to_big_int());

    let mut signature_a = [0u8; 64];
    // Pad r_vec to 32 bytes (BigInt::to_vec may strip leading zeros)
    let r_offset = 32 - r_vec.len();
    for i in 0..r_vec.len() {
        signature_a[r_offset + i] = r_vec[i];
    }
    // Pad s_vec to 32 bytes (BigInt::to_vec may strip leading zeros)
    let s_offset = 32 + (32 - s_vec.len());
    for i in 0..s_vec.len() {
        signature_a[s_offset + i] = s_vec[i];
    }

    let signature = secp256k1::Signature::parse(&signature_a);

    let msg_vec = BigInt::to_vec(msg);
    // Pad msg_vec to 32 bytes (BigInt::to_vec may strip leading zeros)
    let mut msg_bytes = [0u8; 32];
    let msg_offset = 32 - msg_vec.len();
    for i in 0..msg_vec.len() {
        msg_bytes[msg_offset + i] = msg_vec[i];
    }

    let message = secp256k1::Message::parse(&msg_bytes);

    let pubkey_a = pk.get_element().serialize();

    let pubkey = secp256k1::PublicKey::parse(&pubkey_a)?;

    #[cfg(target_arch = "wasm32")]
    crate::console_log!("pubkey: {:?}", pubkey);
    #[cfg(target_arch = "wasm32")]
    crate::console_log!(
        "Rust address: {:?}",
        checksum(&hex::encode(public_key_address(&pubkey)))
    );
    #[cfg(target_arch = "wasm32")]
    crate::console_log!(
        "Rust public key: {:?}",
        hex::encode(&pubkey.serialize())
    );
    
    // message in hex
    #[cfg(target_arch = "wasm32")]
    crate::console_log!(
        "Rust message hex: {:?}",
        hex::encode(&message.serialize())
    );
    
    // signature in hex
    #[cfg(target_arch = "wasm32")]
    crate::console_log!(
        "Rust signature hex: {:?}",
        hex::encode(&signature.serialize())
    );


    println!("Rust pubkey hex: {:?}", hex::encode(&pubkey.serialize()));
    // log message digest
    println!("Rust message hex: {:?}", hex::encode(&message.serialize()));
    Ok(secp256k1::verify(&message, &signature, &pubkey))
}

pub fn public_key_address(public_key: &secp256k1::PublicKey) -> [u8; 20] {
    let public_key = public_key.serialize();
    println!("Rust public_key hex: {:?}", hex::encode(public_key));
    debug_assert_eq!(public_key[0], 0x04);
    let hash = keccak256(&public_key[1..]);
    hash[12..32].try_into().unwrap()
}

pub fn keccak256(bytes: &[u8]) -> [u8; 32] {
    use tiny_keccak::{Hasher, Keccak};
    let mut output = [0u8; 32];
    let mut hasher = Keccak::v256();
    hasher.update(bytes);
    hasher.finalize(&mut output);
    output
}

const PREFIX: &str = "0x";

pub fn checksum(address: &str) -> Result<String> {
    let stripped = String::from(address.to_ascii_lowercase().trim_start_matches(PREFIX));

    let mut hasher = Keccak256::new();
    hasher.update(stripped.clone());
    let hash_vec = hasher.finalize().to_vec();
    let hash = hex::encode(hash_vec);

    let mut checksum = String::new();

    if address.len() != stripped.len() {
        checksum.push_str(PREFIX);
    }

    for (pos, char) in hash.chars().enumerate() {
        if pos > 39 {
            break;
        }
        if u32::from_str_radix(&char.to_string()[..], 16)? > 7 {
            checksum.push_str(&stripped[pos..pos + 1].to_ascii_uppercase());
        } else {
            checksum.push_str(&stripped[pos..pos + 1].to_ascii_lowercase());
        }
    }

    Ok(checksum)
}
