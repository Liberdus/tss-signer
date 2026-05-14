import express, { Request, Response, Router } from "express";
import fs from "fs";
import net from "net";
import path from "path";
import { spawn } from "child_process";
import { pipeline } from "stream/promises";
import axios from "axios";
import { chainConfigsRaw } from "../shared/config";
import { deriveSelfObserverUrl, loadObserverUrlsFromRoot } from "../shared/utils/observerPeers";
import { resolveProjectRoot } from "../shared/utils/paths";

const ADMIN_SIGNAL_FILE = "admin-signal.json";
const ADMIN_LOG_PREFIX = "[observer/admin]";
const LOG_FETCH_TIMEOUT_MS = 5 * 60 * 1000;
const LOG_ARCHIVE_TIMEOUT_MS = 5 * 60 * 1000;
const RESTART_TIMEOUT_MS = 10 * 1000;
const RESTART_DELAY_MS = 1000;
const PROCESS_NAME_PATTERN = /^(observer|tss-party)(-[1-9][0-9]*)?$/;

type AdminSignal =
  | { action: "collect-logs"; target: "all" | string }
  | { action: "restart"; target: "all" | string; name: string };

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

interface RestartResult {
  url: string;
  requestedName: string;
  resolvedName?: string;
  status: "scheduled" | "failed";
  durationMs: number;
  error?: string;
}

interface LogCollectionResult {
  url: string;
  filename: string;
  status: "ok" | "failed";
  size: number;
  durationMs: number;
  error?: string;
}

export interface AdminContext {
  partyIndex: number;
  projectRoot: string;
  observerUrls: string[];
  observerInfos: ObserverUrlInfo[];
  selfObserverUrl: string;
}

export type AdminContextProvider = () => AdminContext | null;

let adminSignalInProgress = false;
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

function isSelfObserverUrl(targetUrl: string, selfObserverUrl: string): boolean {
  return normalizeObserverUrl(targetUrl) === normalizeObserverUrl(selfObserverUrl);
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

  if (/-[1-9][0-9]*$/.test(trimmed)) return trimmed;

  const names = await listPm2ProcessNames();
  return resolvePm2ProcessNameFromSet(trimmed, partyIndex, names);
}

export function resolvePm2ProcessNameFromSet(requestedName: string, partyIndex: number, names: Set<string>): string {
  const trimmed = requestedName.trim();
  if (!isValidAdminProcessName(trimmed)) {
    throw new Error(`Invalid PM2 process name: ${requestedName}`);
  }

  if (/-[1-9][0-9]*$/.test(trimmed)) return trimmed;

  if (names.has(trimmed)) return trimmed;

  const indexed = `${trimmed}-${partyIndex}`;
  if (names.has(indexed)) return indexed;

  throw new Error(`PM2 process not found for ${trimmed}; tried ${trimmed} and ${indexed}`);
}

async function restartPm2Process(resolvedName: string): Promise<CommandResult> {
  return runCommand("pm2", ["restart", resolvedName], { timeoutMs: RESTART_TIMEOUT_MS });
}

function scheduleResolvedPm2Restart(requestedName: string, resolvedName: string): void {
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

function createLocalLogsArchive(projectRoot: string, outputPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const logsDir = path.join(projectRoot, "logs");
    if (!fs.existsSync(logsDir)) {
      reject(new Error("logs directory not found"));
      return;
    }
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    const tar = spawn("tar", ["-czf", outputPath, "logs"], {
      cwd: projectRoot,
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    let settled = false;
    const archiveTimeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      tar.kill("SIGTERM");
      reject(new Error(`tar timed out after ${LOG_ARCHIVE_TIMEOUT_MS}ms`));
    }, LOG_ARCHIVE_TIMEOUT_MS);
    tar.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    tar.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(archiveTimeout);
      reject(error);
    });
    tar.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(archiveTimeout);
      if (code === 0) resolve();
      else reject(new Error(`tar failed with code ${code}: ${sanitizeLogValue(stderr.trim())}`));
    });
  });
}

async function downloadPeerLogs(observerUrl: string, outputPath: string): Promise<number> {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  try {
    const response = await axios.get(`${normalizeObserverUrl(observerUrl)}/admin/logs/archive`, {
      responseType: "stream",
      timeout: LOG_FETCH_TIMEOUT_MS,
      maxRedirects: 0,
      validateStatus: () => true,
    });
    if (response.status < 200 || response.status >= 300) {
      response.data?.destroy?.();
      throw new Error(`HTTP ${response.status}`);
    }

    let bytes = 0;
    response.data.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
    });
    await pipeline(response.data, fs.createWriteStream(outputPath));
    return bytes;
  } catch (error) {
    try {
      fs.unlinkSync(outputPath);
    } catch {
      // Best-effort cleanup of partial archives.
    }
    throw error;
  }
}

function validateAdminSignal(raw: unknown): AdminSignal {
  if (!raw || typeof raw !== "object") {
    throw new Error("admin signal must be an object");
  }
  const signal = raw as Record<string, unknown>;
  if (signal.action !== "collect-logs" && signal.action !== "restart") {
    throw new Error("admin signal action must be collect-logs or restart");
  }
  if (typeof signal.target !== "string" || !signal.target.trim()) {
    throw new Error("admin signal target must be a non-empty string");
  }
  if (signal.target !== "all") {
    let parsed: URL;
    try {
      parsed = new URL(signal.target);
    } catch {
      throw new Error("admin signal target must be all or an observer URL");
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error("admin signal target URL must use http or https");
    }
  }
  if (signal.action === "restart") {
    if (!isValidAdminProcessName(signal.name)) {
      throw new Error("admin signal restart name must be observer, observer-N, tss-party, or tss-party-N");
    }
    return { action: "restart", target: signal.target, name: signal.name.trim() };
  }
  return { action: "collect-logs", target: signal.target };
}

function resolveSignalTargets(signalTarget: string, observerUrls: string[]): string[] {
  if (signalTarget === "all") return Array.from(new Set(observerUrls));

  const normalizedTarget = normalizeObserverUrl(signalTarget);
  if (!observerUrls.includes(normalizedTarget)) {
    throw new Error(`admin signal target ${signalTarget} is not present in observer-list.json`);
  }
  return Array.from(new Set([normalizedTarget]));
}

function formatUniqueAdminTimestamp(date = new Date()): string {
  return `${formatAdminTimestamp(date)}-${`${date.getMilliseconds()}`.padStart(3, "0")}`;
}

async function collectLogsFromTargets(targets: string[], selfObserverUrl: string, projectRoot: string): Promise<string> {
  const timestamp = formatUniqueAdminTimestamp();
  const outputDir = path.join(projectRoot, "collected-logs", timestamp);
  fs.mkdirSync(outputDir, { recursive: true });

  const results: LogCollectionResult[] = [];
  await Promise.all(targets.map(async (observerUrl) => {
    const started = Date.now();
    const filename = getArchiveFilenameForObserverUrl(observerUrl);
    const outputPath = path.join(outputDir, filename);
    try {
      let size = 0;
      if (isSelfObserverUrl(observerUrl, selfObserverUrl)) {
        await createLocalLogsArchive(projectRoot, outputPath);
        size = fs.statSync(outputPath).size;
      } else {
        size = await downloadPeerLogs(observerUrl, outputPath);
      }
      results.push({
        url: observerUrl,
        filename,
        status: "ok",
        size,
        durationMs: Date.now() - started,
      });
    } catch (error) {
      results.push({
        url: observerUrl,
        filename,
        status: "failed",
        size: 0,
        durationMs: Date.now() - started,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }));

  const manifestPath = path.join(outputDir, "manifest.json");
  fs.writeFileSync(
    manifestPath,
    JSON.stringify({ action: "collect-logs", createdAt: new Date().toISOString(), results }, null, 2),
  );
  console.log(`${ADMIN_LOG_PREFIX} collect-logs manifest=${manifestPath}`);
  return manifestPath;
}

async function postPeerRestart(observerUrl: string, requestedName: string): Promise<{ resolvedName?: string }> {
  const response = await axios.post(
    `${normalizeObserverUrl(observerUrl)}/admin/pm2/restart`,
    { name: requestedName },
    {
      timeout: RESTART_TIMEOUT_MS,
      maxRedirects: 0,
      validateStatus: () => true,
    },
  );
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`HTTP ${response.status}: ${JSON.stringify(response.data)}`);
  }
  return { resolvedName: response.data?.resolvedName };
}

async function restartTargets(targets: string[], requestedName: string, partyIndex: number, selfObserverUrl: string, projectRoot: string): Promise<{ manifestPath: string; deferredSelfRestarts: Array<{ requestedName: string; resolvedName: string }> }> {
  const timestamp = formatUniqueAdminTimestamp();
  const outputDir = path.join(projectRoot, "admin-results");
  fs.mkdirSync(outputDir, { recursive: true });
  const manifestPath = path.join(outputDir, `restart-${timestamp}.json`);
  const selfTargets = targets.filter((url) => isSelfObserverUrl(url, selfObserverUrl));
  const peerTargets = targets.filter((url) => !isSelfObserverUrl(url, selfObserverUrl));
  const results: RestartResult[] = [];
  const deferredSelfRestarts: Array<{ requestedName: string; resolvedName: string }> = [];

  await Promise.all(peerTargets.map(async (observerUrl) => {
    const started = Date.now();
    try {
      const peer = await postPeerRestart(observerUrl, requestedName);
      results.push({
        url: observerUrl,
        requestedName,
        resolvedName: peer.resolvedName,
        status: "scheduled",
        durationMs: Date.now() - started,
      });
    } catch (error) {
      results.push({
        url: observerUrl,
        requestedName,
        status: "failed",
        durationMs: Date.now() - started,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }));

  for (const observerUrl of selfTargets) {
    const started = Date.now();
    try {
      const resolvedName = await resolvePm2ProcessName(requestedName, partyIndex);
      deferredSelfRestarts.push({ requestedName, resolvedName });
      results.push({
        url: observerUrl,
        requestedName,
        resolvedName,
        status: "scheduled",
        durationMs: Date.now() - started,
      });
    } catch (error) {
      results.push({
        url: observerUrl,
        requestedName,
        status: "failed",
        durationMs: Date.now() - started,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  fs.writeFileSync(
    manifestPath,
    JSON.stringify({ action: "restart", createdAt: new Date().toISOString(), requestedName, results }, null, 2),
  );
  console.log(`${ADMIN_LOG_PREFIX} restart manifest=${sanitizeLogValue(manifestPath)}`);
  return { manifestPath, deferredSelfRestarts };
}

async function handleAdminSignal(
  getAdminContext: AdminContextProvider,
): Promise<void> {
  if (adminSignalInProgress) {
    console.warn(`${ADMIN_LOG_PREFIX} admin signal already in progress, ignoring`);
    return;
  }
  adminSignalInProgress = true;

  const adminContext = getAdminContext();
  if (!adminContext) {
    console.error(`${ADMIN_LOG_PREFIX} admin context unavailable; no admin signal action taken`);
    adminSignalInProgress = false;
    return;
  }
  const { partyIndex, projectRoot, selfObserverUrl } = adminContext;
  const signalPath = path.join(projectRoot, ADMIN_SIGNAL_FILE);
  try {
    if (!fs.existsSync(signalPath)) {
      console.warn(`${ADMIN_LOG_PREFIX} ${signalPath} not found; no admin signal action taken`);
      return;
    }

    let signal: AdminSignal;
    try {
      signal = validateAdminSignal(JSON.parse(fs.readFileSync(signalPath, "utf8")));
    } catch (error) {
      console.error(
        `${ADMIN_LOG_PREFIX} Failed to parse or validate ${signalPath}: ${error instanceof Error ? error.message : String(error)}. No action taken.`,
      );
      return;
    }

    let targets: string[];
    try {
      targets = resolveSignalTargets(signal.target, adminContext.observerUrls);
    } catch (error) {
      console.error(
        `${ADMIN_LOG_PREFIX} Invalid ${signalPath}: ${error instanceof Error ? error.message : String(error)}. No action taken.`,
      );
      return;
    }
    let manifestPath: string;
    let deferredSelfRestarts: Array<{ requestedName: string; resolvedName: string }> = [];
    console.log(`${ADMIN_LOG_PREFIX} SIGUSR2 action=${sanitizeLogValue(signal.action)} target=${sanitizeLogValue(signal.target)}`);
    if (signal.action === "collect-logs") {
      manifestPath = await collectLogsFromTargets(targets, selfObserverUrl, projectRoot);
    } else {
      const restartResult = await restartTargets(targets, signal.name, partyIndex, selfObserverUrl, projectRoot);
      manifestPath = restartResult.manifestPath;
      deferredSelfRestarts = restartResult.deferredSelfRestarts;
    }
    console.log(`${ADMIN_LOG_PREFIX} admin signal processed manifest=${sanitizeLogValue(manifestPath)}`);
    for (const restart of deferredSelfRestarts) {
      scheduleResolvedPm2Restart(restart.requestedName, restart.resolvedName);
    }
  } catch (error) {
    console.error(`${ADMIN_LOG_PREFIX} admin signal failed:`, error);
  } finally {
    adminSignalInProgress = false;
  }
}

export function registerAdminSignalHandler(getAdminContext: AdminContextProvider): void {
  process.on("SIGUSR2", () => {
    handleAdminSignal(getAdminContext).catch((error) => {
      console.error(`${ADMIN_LOG_PREFIX} unhandled admin signal error:`, error);
    });
  });
}

export function createAdminRouter(getAdminContext: AdminContextProvider): Router {
  const router = express.Router();
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
    const filename = `logs-${hostname}-${port}-${formatUniqueAdminTimestamp()}.tar.gz`;
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
