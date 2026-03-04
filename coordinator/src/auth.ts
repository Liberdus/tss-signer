import fs from "fs";
import path from "path";
import { NextFunction, Request, Response } from "express";
import * as shardusCrypto from "@shardus/crypto-utils";

type SignedRequestBody = {
  payload: unknown;
  ts: number;
  sign: {
    owner: string;
    sig: string;
  };
};

type AllowedTSSSignersFile = {
  allowedTSSSigners: string[];
};

type ChainConfig = {
  enableShardusCryptoAuth?: boolean;
};

const chainConfigPath = path.resolve(__dirname, "../../chain-config.json");

function loadAuthEnabledFromChainConfig(): boolean {
  try {
    const config = readJsonFile<ChainConfig>(chainConfigPath, "chain config");
    return config.enableShardusCryptoAuth === true;
  } catch (error) {
    console.warn("[auth] Could not load enableShardusCryptoAuth from chain-config.json:", error);
    return false;
  }
}

const authEnabled =
  process.env.ENABLE_SHARDUS_CRYPTO_AUTH != null
    ? process.env.ENABLE_SHARDUS_CRYPTO_AUTH === "true"
    : loadAuthEnabledFromChainConfig();

const allowedTssSignerFilePath =
  process.env.COORDINATOR_ALLOWED_TSS_SIGNER_FILE ||
  path.resolve(__dirname, "../allowed-tss-signers.json");

const shardusHashKey = process.env.SHARDUS_CRYPTO_HASH_KEY || "69fa4195670576c0160d660c3be36556ff8d504725be8a59b5a96509e0c994bc";

const whitelist = new Set<string>();

function readJsonFile<T>(filePath: string, label: string): T {
  let raw = "";
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch (error) {
    throw new Error(`[auth] Failed to read ${label} file at ${filePath}: ${String(error)}`);
  }

  try {
    return JSON.parse(raw) as T;
  } catch (error) {
    throw new Error(`[auth] Failed to parse ${label} file at ${filePath}: ${String(error)}`);
  }
}

function isHexWithLength(value: string, length: number): boolean {
  return value.length === length && /^[0-9a-fA-F]+$/.test(value);
}

function loadAllowedTSSSigners(): void {
  const config = readJsonFile<AllowedTSSSignersFile>(
    allowedTssSignerFilePath,
    "allowed TSS signers"
  );

  if (!Array.isArray(config.allowedTSSSigners) || config.allowedTSSSigners.length === 0) {
    throw new Error(
      `[auth] allowedTSSSigners must be a non-empty array in ${allowedTssSignerFilePath}`
    );
  }

  for (const key of config.allowedTSSSigners) {
    if (typeof key !== "string" || key.trim().length === 0) {
      throw new Error(
        `[auth] Invalid public key entry in ${allowedTssSignerFilePath}: ${String(key)}`
      );
    }
    const normalized = key.trim().toLowerCase();
    if (!isHexWithLength(normalized, 64)) {
      throw new Error(
        `[auth] Invalid TSS signer public key format in ${allowedTssSignerFilePath}: expected 64-char hex`
      );
    }
    whitelist.add(normalized);
  }
}

if (authEnabled) {
  if (shardusHashKey.length === 0) {
    throw new Error("[auth] SHARDUS_CRYPTO_HASH_KEY is required when ENABLE_SHARDUS_CRYPTO_AUTH=true");
  }

  shardusCrypto.init(shardusHashKey);
  loadAllowedTSSSigners();
}

export function logCoordinatorAuthConfig(): void {
  if (!authEnabled) {
    console.warn("[auth] Coordinator Shardus Crypto auth disabled (local development mode)");
    return;
  }

  console.log("[auth] Coordinator Shardus Crypto auth enabled");
  console.log(`[auth] Whitelist file: ${allowedTssSignerFilePath}`);
  console.log(`[auth] Whitelisted signer keys: ${whitelist.size}`);
}

function isSignedRequestBody(body: unknown): body is SignedRequestBody {
  if (!body || typeof body !== "object") {
    return false;
  }

  const candidate = body as SignedRequestBody;
  return (
    "payload" in candidate &&
    typeof candidate.ts === "number" &&
    !!candidate.sign &&
    typeof candidate.sign.owner === "string" &&
    typeof candidate.sign.sig === "string"
  );
}

export function verifySignedCoordinatorRequest(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  if (!authEnabled) {
    next();
    return;
  }
  // console.log(`[auth] Verifying signed request for ${req.path}`);
  // console.log("[auth] Request body:", req.body);

  if (!isSignedRequestBody(req.body)) {
    console.warn(`[auth] Reject ${req.path}: missing or invalid signed request body`);
    res.status(401).json({ Err: "Missing or invalid signed request body" });
    return;
  }

  const owner = req.body.sign.owner.toLowerCase();
  if (!whitelist.has(owner)) {
    console.warn(`[auth] Reject ${req.path}: signer not whitelisted owner=${owner}`);
    res.status(403).json({ Err: "Signer public key is not whitelisted" });
    return;
  }

  const verified = shardusCrypto.verifyObj(req.body as any);
  if (!verified) {
    console.warn(`[auth] Reject ${req.path}: invalid request signature owner=${owner}`);
    res.status(401).json({ Err: "Invalid request signature" });
    return;
  }

  req.body = req.body.payload;
  next();
}
