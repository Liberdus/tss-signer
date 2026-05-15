import express, { Request, Response, Router } from "express";
import fs from "fs";
import net from "net";
import path from "path";
import { spawn } from "child_process";
import { chainConfigsRaw } from "../shared/config";
import { deriveSelfObserverUrl, loadObserverUrlsFromRoot } from "../shared/utils/observerPeers";
import { resolveProjectRoot } from "../shared/utils/paths";

const ADMIN_LOG_PREFIX = "[observer/admin]";
const LOG_ARCHIVE_TIMEOUT_MS = 5 * 60 * 1000; // Local tar creation timeout.
const RESTART_TIMEOUT_MS = 10 * 1000; // PM2 command timeout.
const RESTART_DELAY_MS = 1000; // Delay before invoking PM2 restart.
const PROCESS_NAME_PATTERN = /^(observer|tss-party)$/; // Restart only this machine's observer/TSS pair.

interface ObserverUrlInfo {
  url: string;
  hostname: string;
  port: string;
  isIpLiteral: boolean;
}

interface AllowlistDecision {
  rawRemoteAddress: string;
  normalizedRemoteAddress: string;
  allowed: boolean;
  matchedObserverUrl?: string;
}

interface CommandResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export interface AdminContext {
  partyIndex: number;
  projectRoot: string;
  // Loaded once at startup.
  observerUrls: string[];
  observerInfos: ObserverUrlInfo[];
  selfObserverUrl: string;
}

export type AdminContextProvider = () => AdminContext | null;

let warnedDnsHosts = new Set<string>();
export function normalizeRemoteAddress(address?: string | null): string {
  const raw = `${address ?? ""}`.trim();
  if (raw.startsWith("::ffff:")) return raw.slice("::ffff:".length);
  if (raw === "::1") return "::1";
  return raw;
}

function normalizeObserverUrl(rawUrl: string): string {
  return rawUrl.trim().replace(/\/$/, "");
}

function isLocalhostAddress(address: string): boolean {
  return address === "127.0.0.1" || address === "::1";
}

export function isAdminRequesterAllowed(
  remoteAddress: string,
  observerUrls: string[],
  isRemote: boolean,
): { allowed: boolean; matchedObserverUrl?: string; ignoredDnsHosts: string[] } {
  const normalizedRemoteAddress = normalizeRemoteAddress(remoteAddress);
  const ignoredDnsHosts: string[] = [];
  for (const rawUrl of observerUrls) {
    const info = parseObserverUrl(rawUrl);
    if (!info) continue;
    // Only IP-literal observer URLs authorize admin callers.
    if (!info.isIpLiteral) {
      ignoredDnsHosts.push(info.hostname);
      continue;
    }
    if (info.hostname === normalizedRemoteAddress) {
      return { allowed: true, matchedObserverUrl: info.url, ignoredDnsHosts };
    }
  }
  if (!isRemote && isLocalhostAddress(normalizedRemoteAddress)) {
    return { allowed: true, matchedObserverUrl: "localhost-dev", ignoredDnsHosts };
  }
  return { allowed: false, ignoredDnsHosts };
}

export function isValidAdminProcessName(name: unknown): name is string {
  return typeof name === "string" && PROCESS_NAME_PATTERN.test(name.trim());
}

export function sanitizeArchiveFilenamePart(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "_");
}

function sanitizeLogValue(value: unknown): string {
  return `${value ?? ""}`.replace(/[\r\n\t\x00-\x1F\x7F]/g, " ").slice(0, 2000);
}

export function formatAdminTimestamp(date = new Date()): string {
  const pad = (value: number) => `${value}`.padStart(2, "0");
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
  ].join("-") + "-" + [
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds()),
  ].join("-");
}

function parseObserverUrl(rawUrl: string): ObserverUrlInfo | null {
  try {
    const parsed = new URL(rawUrl);
    const hostname = parsed.hostname.replace(/^\[/, "").replace(/\]$/, "");
    return {
      url: normalizeObserverUrl(parsed.href),
      hostname,
      port: parsed.port || (parsed.protocol === "https:" ? "443" : "80"),
      isIpLiteral: net.isIP(hostname) !== 0,
    };
  } catch {
    return null;
  }
}

function parseObserverUrlInfos(observerUrls: string[]): ObserverUrlInfo[] {
  return observerUrls
    .map(parseObserverUrl)
    .filter((entry): entry is ObserverUrlInfo => entry !== null);
}

function warnIgnoredDnsHosts(infos: ObserverUrlInfo[]): void {
  for (const info of infos) {
    if (info.isIpLiteral || warnedDnsHosts.has(info.hostname)) continue;
    warnedDnsHosts.add(info.hostname);
    console.warn(`${ADMIN_LOG_PREFIX} DNS observer URL ignored for admin source-IP allowlist: ${sanitizeLogValue(info.url)}`);
  }
}

export function getArchiveFilenameForObserverUrl(observerUrl: string): string {
  const info = parseObserverUrl(observerUrl);
  if (!info) {
    return `${sanitizeArchiveFilenamePart(observerUrl)}.tar.gz`;
  }
  return `${sanitizeArchiveFilenamePart(info.hostname)}-${sanitizeArchiveFilenamePart(info.port)}.tar.gz`;
}

export async function createAdminContext(partyIndex: number, projectRoot = resolveProjectRoot()): Promise<AdminContext> {
  const isRemote = chainConfigsRaw.isRemote === true;
  const observerUrls = Array.from(new Set(loadObserverUrlsFromRoot(projectRoot).map(normalizeObserverUrl)));
  const observerInfos = parseObserverUrlInfos(observerUrls);
  warnIgnoredDnsHosts(observerInfos);
  const selfObserverUrl = await deriveSelfObserverUrl(partyIndex, {
    isRemote,
    rootDir: projectRoot,
    observerUrls,
  }).then(normalizeObserverUrl);
  if ((isRemote || observerUrls.length > 0) && !observerUrls.includes(selfObserverUrl)) {
    throw new Error(
      `${selfObserverUrl} is this observer URL but is not present in observer-list.json; update observer-list.json or TSS_SELF_OBSERVER_URL`,
    );
  }
  console.log(`${ADMIN_LOG_PREFIX} loaded admin observer context self=${sanitizeLogValue(selfObserverUrl)} observers=${observerUrls.length}`);
  return { partyIndex, projectRoot, observerUrls, observerInfos, selfObserverUrl };
}

function computeAllowlistDecision(req: Request, adminContext: AdminContext): AllowlistDecision {
  const rawRemoteAddress = `${req.socket.remoteAddress ?? ""}`;
  const normalizedRemoteAddress = normalizeRemoteAddress(rawRemoteAddress);
  const decision = isAdminRequesterAllowed(
    rawRemoteAddress,
    adminContext.observerUrls,
    chainConfigsRaw.isRemote === true,
  );
  return {
    rawRemoteAddress,
    normalizedRemoteAddress,
    allowed: decision.allowed,
    matchedObserverUrl: decision.matchedObserverUrl,
  };
}

function logAdminRequest(req: Request, decision: AllowlistDecision, result: string): void {
  const forwardedFor = req.headers["x-forwarded-for"];
  const forwarded = typeof forwardedFor === "string" ? ` xff=${sanitizeLogValue(forwardedFor)}` : "";
  console.log(
    `${ADMIN_LOG_PREFIX} request method=${sanitizeLogValue(req.method)} path=${sanitizeLogValue(req.path)} remote=${sanitizeLogValue(decision.rawRemoteAddress)} normalized=${sanitizeLogValue(decision.normalizedRemoteAddress)} allowed=${decision.allowed} matched=${sanitizeLogValue(decision.matchedObserverUrl ?? "none")} result=${sanitizeLogValue(result)}${forwarded}`,
  );
}

function runCommand(command: string, args: string[], options: { cwd?: string; timeoutMs?: number } = {}): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    const timeout = options.timeoutMs
      ? setTimeout(() => {
          if (settled) return;
          settled = true;
          child.kill("SIGTERM");
          reject(new Error(`${command} ${args.join(" ")} timed out after ${options.timeoutMs}ms`));
        }, options.timeoutMs)
      : null;

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      resolve({ code, stdout, stderr });
    });
  });
}

async function listPm2ProcessNames(): Promise<Set<string>> {
  const result = await runCommand("pm2", ["jlist"], { timeoutMs: RESTART_TIMEOUT_MS });
  if (result.code !== 0) {
    throw new Error(`pm2 jlist failed: ${result.stderr || result.stdout || `exit ${result.code}`}`);
  }
  const parsed = JSON.parse(result.stdout || "[]") as Array<{ name?: string }>;
  return new Set(parsed.map((entry) => entry.name).filter((name): name is string => typeof name === "string"));
}

export async function resolvePm2ProcessName(requestedName: string, partyIndex: number): Promise<string> {
  const trimmed = requestedName.trim();
  if (!isValidAdminProcessName(trimmed)) {
    throw new Error(`Invalid PM2 process name: ${requestedName}`);
  }

  const names = await listPm2ProcessNames();
  return resolvePm2ProcessNameFromSet(trimmed, partyIndex, names);
}

export function resolvePm2ProcessNameFromSet(requestedName: string, partyIndex: number, names: Set<string>): string {
  const trimmed = requestedName.trim();
  if (!isValidAdminProcessName(trimmed)) {
    throw new Error(`Invalid PM2 process name: ${requestedName}`);
  }

  if (names.has(trimmed)) return trimmed;

  // Generic names resolve to this party's indexed PM2 process.
  const indexed = `${trimmed}-${partyIndex}`;
  if (names.has(indexed)) return indexed;

  throw new Error(`PM2 process not found for ${trimmed}; tried ${trimmed} and ${indexed}`);
}

async function restartPm2Process(resolvedName: string): Promise<CommandResult> {
  return runCommand("pm2", ["restart", resolvedName], { timeoutMs: RESTART_TIMEOUT_MS });
}

function scheduleResolvedPm2Restart(requestedName: string, resolvedName: string): void {
  // Let responses/manifests flush before PM2 may restart this process.
  setTimeout(() => {
    restartPm2Process(resolvedName)
      .then((result) => {
        const ok = result.code === 0;
        console.log(
          `${ADMIN_LOG_PREFIX} restart ${ok ? "completed" : "failed"} requested=${sanitizeLogValue(requestedName)} resolved=${sanitizeLogValue(resolvedName)} code=${result.code}`,
        );
        if (!ok) {
          console.error(`${ADMIN_LOG_PREFIX} restart stderr resolved=${sanitizeLogValue(resolvedName)}: ${sanitizeLogValue(result.stderr || result.stdout)}`);
        }
      })
      .catch((error) => {
        console.error(`${ADMIN_LOG_PREFIX} restart failed requested=${sanitizeLogValue(requestedName)} resolved=${sanitizeLogValue(resolvedName)}:`, error);
      });
  }, RESTART_DELAY_MS);
}

async function schedulePm2Restart(requestedName: string, partyIndex: number): Promise<string> {
  const resolvedName = await resolvePm2ProcessName(requestedName, partyIndex);
  scheduleResolvedPm2Restart(requestedName, resolvedName);
  return resolvedName;
}

function streamLogsArchive(res: Response, projectRoot: string, filename: string): void {
  const logsDir = path.join(projectRoot, "logs");
  if (!fs.existsSync(logsDir)) {
    res.status(404).json({ Err: "logs directory not found" });
    return;
  }

  console.log(`${ADMIN_LOG_PREFIX} archive start filename=${sanitizeLogValue(filename)}`);
  res.setHeader("Content-Type", "application/gzip");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);

  const tar = spawn("tar", ["-czf", "-", "logs"], {
    cwd: projectRoot,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  let bytes = 0;
  let tarClosed = false;
  let responseFinished = false;
  const archiveTimeout = setTimeout(() => {
    if (!tarClosed) {
      console.error(`${ADMIN_LOG_PREFIX} archive timed out filename=${sanitizeLogValue(filename)} after ${LOG_ARCHIVE_TIMEOUT_MS}ms; terminating tar`);
      tar.kill("SIGTERM");
    }
  }, LOG_ARCHIVE_TIMEOUT_MS);
  tar.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  tar.stdout.on("data", (chunk) => {
    bytes += chunk.length;
  });
  tar.stdout.pipe(res);
  res.on("finish", () => {
    responseFinished = true;
  });
  res.on("close", () => {
    if (!responseFinished && !tarClosed) {
      // Do not leave tar running after client aborts.
      console.warn(`${ADMIN_LOG_PREFIX} archive client disconnected filename=${sanitizeLogValue(filename)}; terminating tar`);
      tar.kill("SIGTERM");
    }
  });
  tar.on("error", (error) => {
    clearTimeout(archiveTimeout);
    console.error(`${ADMIN_LOG_PREFIX} archive spawn failed filename=${sanitizeLogValue(filename)}:`, error);
    if (!res.headersSent) res.status(500).json({ Err: "Failed to create logs archive" });
    else res.destroy(error);
  });
  tar.on("close", (code) => {
    tarClosed = true;
    clearTimeout(archiveTimeout);
    if (code === 0) {
      console.log(`${ADMIN_LOG_PREFIX} archive complete filename=${sanitizeLogValue(filename)} bytes=${bytes}`);
      return;
    }
    console.error(`${ADMIN_LOG_PREFIX} archive failed filename=${sanitizeLogValue(filename)} code=${code} stderr=${sanitizeLogValue(stderr.trim())}`);
    if (!res.headersSent) res.status(500).json({ Err: "Failed to create logs archive" });
    else res.destroy(new Error(`tar failed with code ${code}`));
  });
}

export function createAdminRouter(getAdminContext: AdminContextProvider): Router {
  const router = express.Router();
  // Keep allowlist/audit before JSON parsing.
  router.use((req, res, next) => {
    const adminContext = getAdminContext();
    if (!adminContext) {
      console.error(`${ADMIN_LOG_PREFIX} admin context unavailable for request path=${sanitizeLogValue(req.path)}`);
      res.status(503).json({ Err: "Admin context unavailable" });
      return;
    }
    res.locals.adminContext = adminContext;
    const decision = computeAllowlistDecision(req, adminContext);
    if (!decision.allowed) {
      logAdminRequest(req, decision, "denied");
      res.status(403).json({ Err: "Admin endpoint not allowed from requester IP" });
      return;
    }
    res.locals.adminAllowlistDecision = decision;
    logAdminRequest(req, decision, "allowed");
    next();
  });
  router.use(express.json({ limit: "16kb" }));
  router.use((error: any, req: Request, res: Response, next: express.NextFunction) => {
    if (!error || typeof error.status !== "number") {
      next(error);
      return;
    }
    const decision = res.locals.adminAllowlistDecision as AllowlistDecision | undefined;
    console.warn(
      `${ADMIN_LOG_PREFIX} invalid request body requester=${sanitizeLogValue(decision?.normalizedRemoteAddress ?? normalizeRemoteAddress(req.socket.remoteAddress))} path=${sanitizeLogValue(req.path)} status=${error.status}: ${sanitizeLogValue(error.message)}`,
    );
    const bodyError =
      error.status === 413
        ? "Request body too large"
        : error.status === 415
          ? "Unsupported request body type"
          : "Invalid JSON body";
    res.status(error.status).json({ Err: bodyError });
  });

  router.get("/logs/archive", async (_req, res) => {
    const adminContext = res.locals.adminContext as AdminContext;
    const { partyIndex, projectRoot, selfObserverUrl } = adminContext;
    const selfUrl = selfObserverUrl;
    const info = parseObserverUrl(selfUrl);
    const hostname = info ? sanitizeArchiveFilenamePart(info.hostname) : `party-${partyIndex}`;
    const port = info ? sanitizeArchiveFilenamePart(info.port) : `${8100 + partyIndex}`;
    const filename = `logs-${hostname}-${port}-${formatAdminTimestamp()}.tar.gz`;
    streamLogsArchive(res, projectRoot, filename);
  });

  router.post("/pm2/restart", async (req, res) => {
    const adminContext = res.locals.adminContext as AdminContext;
    const { partyIndex } = adminContext;
    const requestedName = typeof req.body?.name === "string" ? req.body.name.trim() : "";
    const decision = res.locals.adminAllowlistDecision as AllowlistDecision | undefined;
    if (!isValidAdminProcessName(requestedName)) {
      console.warn(
        `${ADMIN_LOG_PREFIX} restart rejected requester=${sanitizeLogValue(decision?.normalizedRemoteAddress ?? "unknown")} requested=${sanitizeLogValue(requestedName || "missing")}`,
      );
      res.status(400).json({ Err: "Invalid PM2 process name" });
      return;
    }

    try {
      const resolvedName = await schedulePm2Restart(requestedName, partyIndex);
      console.log(
        `${ADMIN_LOG_PREFIX} restart scheduled requester=${sanitizeLogValue(decision?.normalizedRemoteAddress ?? "unknown")} requested=${sanitizeLogValue(requestedName)} resolved=${sanitizeLogValue(resolvedName)}`,
      );
      res.status(202).json({ Ok: "restart_scheduled", requestedName, resolvedName });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`${ADMIN_LOG_PREFIX} restart rejected requested=${sanitizeLogValue(requestedName)}: ${sanitizeLogValue(message)}`);
      res.status(500).json({ Err: message });
    }
  });

  return router;
}
