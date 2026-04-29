import fs from "fs";
import path from "path";
import { resolveProjectRoot } from "./paths";

interface KeygenConfigLike {
  partyIps: string[];
}

function parseObserverUrlsFromEnv(): string[] {
  const raw = `${process.env.TSS_OBSERVER_URLS ?? ""}`.trim();
  if (!raw) return [];
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function tryLoadPartyIpsFromKeygenConfig(rootDir: string): string[] {
  const configPath = path.join(rootDir, "keygen-config.json");
  if (!fs.existsSync(configPath)) return [];
  try {
    const raw = JSON.parse(fs.readFileSync(configPath, "utf8")) as KeygenConfigLike;
    if (!Array.isArray(raw.partyIps)) return [];
    return raw.partyIps.map((entry) => `${entry || ""}`.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

export function buildObserverUrls(parties: number, rootDir = resolveProjectRoot()): string[] {
  const fromEnv = parseObserverUrlsFromEnv();
  if (fromEnv.length > 0) return fromEnv;

  const partyIps = tryLoadPartyIpsFromKeygenConfig(rootDir);
  if (partyIps.length > 0) {
    return partyIps.map((ip, index) => `http://${ip}:${8101 + index}`);
  }

  const count = Math.max(1, parties);
  return Array.from({ length: count }, (_, index) => `http://127.0.0.1:${8101 + index}`);
}

export function getPeerObserverUrls(
  parties: number,
  selfPartyIdx: number,
  rootDir = resolveProjectRoot(),
): string[] {
  const urls = buildObserverUrls(parties, rootDir);
  const selfIndex = Math.max(1, selfPartyIdx) - 1;
  return urls.filter((_, index) => index !== selfIndex);
}

