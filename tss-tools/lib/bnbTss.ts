import * as fs from 'node:fs'
import Module from 'node:module'
import * as path from 'node:path'
import {spawn, spawnSync} from 'node:child_process'
import {ethers} from 'ethers'
import {loadParamsConfig, ParamsConfig} from '../../shared/config'
import {resolveProjectRoot} from '../../shared/utils/paths'

export {}

export const DEFAULT_VAULT_NAME = 'default';
const DEFAULT_GO_VERSION = '1.20.3';
const DEFAULT_MISE_VERSION = 'v2026.3.8';
const DEFAULT_BINARY_NAME = 'tss';
const DEFAULT_DERIVE_BINARY_NAME = 'tss-derive-pubkey';
const DEFAULT_PATCH_PEER_ADDRS_BINARY_NAME = 'patch-peer-addrs';
export const SIGNING_TIMEOUT_ERROR = 'signing-timeout';

const REGROUP_LISTEN_PORT_OFFSET = 1000;


type ExecOptions = {
  cwd?: string
  env?: NodeJS.ProcessEnv
  timeoutMs?: number
  timeoutErrorMessage?: string
  printLogs?: boolean
}

type CommandResult = {
  stdout: string
  stderr: string
}

type InitializedParty = {
  home: string
  vaultName: string
  binary: string
  tssRoot: string
}

type StoredVaultConfig = {
  listen?: string
}

type DerivedPubkeyAll = {
  compressed: string
  ethereum_address: string
  ethereum_pubkey: string
  [key: string]: string
}

export type DerivePubkeyFormat = 'compressed' | 'ethereum-pubkey' | 'ethereum-address' | 'all'

export type BasePartyOptions = {
  partyIdx?: number
  chainId: number
  password?: string
  logLevel?: string
  vaultName?: string
  homeRoot?: string
  homePath?: string
  binary?: string
  signerRoot?: string
  tssRoot?: string
  useDefaultSlotPath?: boolean
}

export const DEFAULT_SLOT_PARTY_IDX = 1;

export type InitPartyOptions = BasePartyOptions & {
  moniker?: string
  listenAddr?: string
  listenPort?: number
}

export type KeygenOptions = BasePartyOptions & {
  channelId?: string
  channelPassword?: string
  threshold?: number
  parties?: number
  peerAddrs?: string[]
  useLocalPeerAddrs?: boolean
  extraArgs?: string[]
}

export type RegroupOptions = BasePartyOptions & {
  channelId?: string
  channelPassword?: string
  threshold?: number
  parties?: number
  newThreshold?: number
  newParties?: number
  newPeerAddrs?: string[]
  newListenAddr?: string
  pubkey?: string
  isOld?: boolean
  isNewMember?: boolean
  extraArgs?: string[]
}

export type VerifyOptions = BasePartyOptions & {
  format?: DerivePubkeyFormat
}

export type SignEthereumTxOptions = BasePartyOptions & {
  txFile?: string
  tx?: ethers.TransactionLike
  channelId?: string
  channelPassword?: string
  signDiscoveryTimeout?: string
  timeoutMs?: number
  printLogs?: boolean
  extraArgs?: string[]
}

type CommitteeTopologySnapshot = {
  peerAddrs: string[]
  expectedPeers: string[]
  listenAddr?: string
  newListenAddr?: string
  peerId?: string
  moniker?: string
}

type SignDigestResult = {
  digest: string
  messageDecimal: string
  r: string
  s: string
  recoveryParam: number
  v: number
  ethereumAddress: string
  publicKeyEthereum: string
  publicKeyCompressed: string
  signatureHex: string
}

type SignEthereumTransactionResult = SignDigestResult & {
  signedTx: string
  txHash: string
}

type LocalRegroupPeerAddrsOptions = {
  chainId: number
  parties: number
  threshold: number
  newParties: number
  partyIdx: number
  isOld?: boolean
  isNewMember?: boolean
}

export function resolveOverlayRoot(signerRoot = resolveProjectRoot()): string {
  return path.join(signerRoot, 'tss-tools');
}

export function resolveToolingRoot(signerRoot = resolveProjectRoot()): string {
  return path.join(signerRoot, '.tooling');
}

export function resolveTssToolingRoot(tssRoot: string): string {
  return path.join(tssRoot, '.tooling');
}

export function resolveTssRoot(signerRoot = resolveProjectRoot()): string {
  const candidates = [];
  if (process.env.BNB_TSS_ROOT) {
    candidates.push(path.resolve(process.env.BNB_TSS_ROOT));
  }
  candidates.push(path.join(signerRoot, 'tss'));
  for (const candidate of candidates) {
    if (fs.existsSync(path.join(candidate, 'go.mod')) && fs.existsSync(path.join(candidate, 'cmd'))) {
      return candidate;
    }
  }
  throw new Error(
    `Unable to locate tss repo. Clone submodules first with git submodule update --init --recursive`,
  );
}

function resolvePatchPath(signerRoot = resolveProjectRoot()): string {
  return path.join(resolveOverlayRoot(signerRoot), 'patches', 'tss-source.patch');
}

export function resolveMisePlatform(platform = process.platform, arch = process.arch): string {
  const normalizedPlatform = (() => {
    switch (platform) {
      case 'darwin':
        return 'darwin';
      case 'linux':
        return 'linux';
      default:
        throw new Error(
          `Unsupported platform '${platform}/${arch}'. Supported platforms: darwin/arm64, linux/x64, linux/arm64. Windows is not supported by this bootstrap flow.`,
        );
    }
  })();

  const normalizedArch = (() => {
    switch (arch) {
      case 'arm64':
        return 'arm64';
      case 'x64':
        return 'x64';
      default:
        throw new Error(
          `Unsupported platform '${platform}/${arch}'. Supported platforms: darwin/arm64, linux/x64, linux/arm64. Windows is not supported by this bootstrap flow.`,
        );
    }
  })();

  const misePlatform = `${normalizedPlatform}-${normalizedArch}`;
  switch (misePlatform) {
    case 'darwin-arm64':
    case 'linux-x64':
    case 'linux-arm64':
      return misePlatform;
    default:
      throw new Error(
        `Unsupported platform '${platform}/${arch}'. Supported platforms: darwin/arm64, linux/x64, linux/arm64. Windows is not supported by this bootstrap flow.`,
      );
  }
}

function resolveMiseArchiveName(platform = process.platform, arch = process.arch): string {
  return `mise-${DEFAULT_MISE_VERSION}-${resolveMisePlatform(platform, arch)}.tar.gz`;
}

function resolveGoBinary(tssRoot: string): string | null {
  if (process.env.GO_BIN && fs.existsSync(process.env.GO_BIN)) {
    return process.env.GO_BIN;
  }
  const systemGo = spawnSync('go', ['version'], {encoding: 'utf8'});
  if (systemGo.status === 0) {
    return 'go';
  }
  const vendoredGo = path.join(
    tssRoot,
    '.tooling',
    'mise',
    'data',
    'installs',
    'go',
    DEFAULT_GO_VERSION,
    'bin',
    'go',
  );
  if (fs.existsSync(vendoredGo)) {
    return vendoredGo;
  }
  return null;
}

function ensureGoBinary(tssRoot: string): string {
  const existing = resolveGoBinary(tssRoot);
  if (existing) {
    return existing;
  }

  const miseRoot = path.join(tssRoot, '.tooling', 'mise');
  const miseBin = path.join(miseRoot, 'bin', 'mise', 'bin', 'mise');
  fs.mkdirSync(path.join(miseRoot, 'bin'), {recursive: true});
  fs.mkdirSync(path.join(miseRoot, 'data'), {recursive: true});
  fs.mkdirSync(path.join(miseRoot, 'config'), {recursive: true});

  if (!fs.existsSync(miseBin)) {
    const archiveName = resolveMiseArchiveName();
    const archivePath = path.join('/tmp', archiveName);
    runOrThrow('curl', [
      '-fL',
      '--retry',
      '5',
      '--retry-delay',
      '2',
      '--retry-all-errors',
      `https://github.com/jdx/mise/releases/download/${DEFAULT_MISE_VERSION}/${archiveName}`,
      '-o',
      archivePath,
    ]);
    runOrThrow('tar', ['-xzf', archivePath, '-C', path.join(miseRoot, 'bin')]);
  }

  const miseEnv = {
    MISE_DATA_DIR: path.join(miseRoot, 'data'),
    MISE_CONFIG_DIR: path.join(miseRoot, 'config'),
    MISE_TRUSTED_CONFIG_PATHS: tssRoot,
  };
  runOrThrow(miseBin, ['install', `go@${DEFAULT_GO_VERSION}`], {cwd: tssRoot, env: miseEnv});

  const vendoredGo = path.join(
    tssRoot,
    '.tooling',
    'mise',
    'data',
    'installs',
    'go',
    DEFAULT_GO_VERSION,
    'bin',
    'go',
  );
  if (!fs.existsSync(vendoredGo)) {
    throw new Error(`Failed to bootstrap Go ${DEFAULT_GO_VERSION} via mise`);
  }
  return vendoredGo;
}

function buildGoEnv(signerRoot: string, tssRoot: string): NodeJS.ProcessEnv {
  const tssToolingRoot = resolveTssToolingRoot(tssRoot);
  const goCache = path.join(tssToolingRoot, 'go-cache');
  const goModCache = path.join(tssToolingRoot, 'go-modcache');
  return {
    ...process.env,
    GOCACHE: process.env.GOCACHE || goCache,
    GOMODCACHE: process.env.GOMODCACHE || goModCache,
  };
}

function runOrThrow(command: string, args: any[], options: ExecOptions = {}): CommandResult {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env ? {...process.env, ...options.env} : process.env,
    encoding: 'utf8',
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    const output = (result.stderr || result.stdout || '').trim();
    throw new Error(output || `${path.basename(command)} exited with status ${result.status}`);
  }
  return {
    stdout: result.stdout || '',
    stderr: result.stderr || '',
  };
}

function runWithLiveLogs(command: string, args: any[], options: ExecOptions = {}): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const shouldPrintLogs = options.printLogs !== false;
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ? {...process.env, ...options.env} : process.env,
      stdio: ['inherit', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let stdoutPending = '';
    let settled = false;
    let timedOut = false;
    const timeoutMs = options.timeoutMs;
    const timeoutErrorMessage = options.timeoutErrorMessage || 'Command timed out';
    let forceKillTimer: NodeJS.Timeout | undefined;
    const timeoutTimer = timeoutMs && timeoutMs > 0
      ? setTimeout(() => {
          if (settled) {
            return;
          }
          timedOut = true;
          child.kill('SIGTERM');
          forceKillTimer = setTimeout(() => {
            if (!settled) {
              child.kill('SIGKILL');
            }
          }, 2000);
        }, timeoutMs)
      : undefined;

    const cleanupTimers = () => {
      if (timeoutTimer) {
        clearTimeout(timeoutTimer);
      }
      if (forceKillTimer) {
        clearTimeout(forceKillTimer);
      }
    };

    child.stdout.on('data', (chunk) => {
      const text = chunk.toString();
      stdout += text;
      stdoutPending += text;
      const lines = stdoutPending.split(/\r?\n/);
      stdoutPending = lines.pop() || '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
          continue;
        }
        if (shouldPrintLogs) {
          process.stderr.write(`${line}\n`);
        }
      }
    });

    child.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      stderr += text;
      if (shouldPrintLogs) {
        process.stderr.write(text);
      }
    });

    child.on('error', (error) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanupTimers();
      if (timedOut) {
        reject(new Error(timeoutErrorMessage));
      } else {
        reject(error);
      }
    });

    child.on('close', (code) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanupTimers();
      if (timedOut) {
        reject(new Error(timeoutErrorMessage));
        return;
      }
      if (code !== 0) {
        const output = (stderr || stdout || '').trim();
        reject(new Error(output || `${path.basename(command)} exited with status ${code}`));
        return;
      }
      resolve({stdout, stderr});
    });
  });
}

function checkCommand(command: string, args: any[], options: ExecOptions = {}) {
  return spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env ? {...process.env, ...options.env} : process.env,
    encoding: 'utf8',
  });
}

function ensurePatchApplied(signerRoot = resolveProjectRoot()): 'applied' | 'already_applied' {
  const tssRoot = resolveTssRoot(signerRoot);
  const patchPath = resolvePatchPath(signerRoot);
  if (!fs.existsSync(patchPath)) {
    throw new Error(`Missing TSS patch file at ${patchPath}`);
  }
  const forwardCheck = checkCommand('git', ['apply', '--check', patchPath], {cwd: tssRoot});
  if (forwardCheck.status === 0) {
    runOrThrow('git', ['apply', patchPath], {cwd: tssRoot});
    return 'applied';
  }
  const reverseCheck = checkCommand('git', ['apply', '-R', '--check', patchPath], {cwd: tssRoot});
  if (reverseCheck.status === 0) {
    return 'already_applied';
  }
  const errorOutput = (forwardCheck.stderr || forwardCheck.stdout || reverseCheck.stderr || reverseCheck.stdout || '').trim();
  throw new Error(`TSS patch could not be applied cleanly.\n${errorOutput}`);
}

export function buildTssBinary(options: any = {}): string {
  const signerRoot = options.signerRoot || resolveProjectRoot();
  const tssRoot = options.tssRoot || resolveTssRoot(signerRoot);
  const toolingRoot = resolveTssToolingRoot(tssRoot);
  const binaryPath = path.join(toolingRoot, 'bin', DEFAULT_BINARY_NAME);
  const deriveBinaryPath = path.join(toolingRoot, 'bin', DEFAULT_DERIVE_BINARY_NAME);
  const helperSourcePath = path.join(resolveOverlayRoot(signerRoot), 'derive-pubkey', 'main.go');
  const helperDir = path.join(resolveTssToolingRoot(tssRoot), 'derive-pubkey');
  const helperMainPath = path.join(helperDir, 'main.go');
  const patchStatus = ensurePatchApplied(signerRoot);
  if (
    !options.force &&
    patchStatus === 'already_applied' &&
    fs.existsSync(binaryPath) &&
    fs.existsSync(deriveBinaryPath)
  ) {
    return binaryPath;
  }

  const goBin = ensureGoBinary(tssRoot);
  const goEnv = buildGoEnv(signerRoot, tssRoot);
  fs.mkdirSync(path.join(toolingRoot, 'bin'), {recursive: true});
  fs.mkdirSync(goEnv.GOCACHE, {recursive: true});
  fs.mkdirSync(goEnv.GOMODCACHE, {recursive: true});
  if (!fs.existsSync(helperSourcePath)) {
    throw new Error(`Missing derive-pubkey helper source at ${helperSourcePath}`);
  }
  fs.mkdirSync(helperDir, {recursive: true});
  const helperSource = fs.readFileSync(helperSourcePath, 'utf8');
  if (!fs.existsSync(helperMainPath) || fs.readFileSync(helperMainPath, 'utf8') !== helperSource) {
    fs.writeFileSync(helperMainPath, helperSource);
  }
  runOrThrow(goBin, ['build', '-o', binaryPath, './main.go'], {
    cwd: tssRoot,
    env: goEnv,
  });
  runOrThrow(goBin, ['build', '-o', deriveBinaryPath, './.tooling/derive-pubkey/main.go'], {
    cwd: tssRoot,
    env: goEnv,
  });
  return binaryPath;
}

export function ensureTssPrepared(options: any = {}): string {
  const signerRoot = options.signerRoot || resolveProjectRoot();
  const tssRoot = options.tssRoot || resolveTssRoot(signerRoot);
  const binaryPath =
    options.binary ||
    process.env.BNB_TSS_BINARY ||
    path.join(resolveTssToolingRoot(tssRoot), 'bin', DEFAULT_BINARY_NAME);
  ensurePatchApplied(signerRoot);
  if (!fs.existsSync(binaryPath) || options.forceBuild) {
    return buildTssBinary({...options, signerRoot, tssRoot});
  }
  return binaryPath;
}

function resolvePatchPeerAddrsBinary(options: any = {}): string {
  const signerRoot = options.signerRoot || resolveProjectRoot();
  const tssRoot = options.tssRoot || resolveTssRoot(signerRoot);
  const binaryPath = path.join(resolveTssToolingRoot(tssRoot), 'bin', DEFAULT_PATCH_PEER_ADDRS_BINARY_NAME);
  const sourcePath = path.join(resolveOverlayRoot(signerRoot), 'patch-peer-addrs', 'main.go');
  if (fs.existsSync(binaryPath) && fs.existsSync(sourcePath)) {
    const binaryMtimeMs = fs.statSync(binaryPath).mtimeMs;
    const sourceMtimeMs = fs.statSync(sourcePath).mtimeMs;
    if (binaryMtimeMs >= sourceMtimeMs) {
      return binaryPath;
    }
  }

  const goBin = ensureGoBinary(tssRoot);
  const goEnv = buildGoEnv(signerRoot, tssRoot);
  fs.mkdirSync(path.dirname(binaryPath), {recursive: true});
  fs.mkdirSync(goEnv.GOCACHE, {recursive: true});
  fs.mkdirSync(goEnv.GOMODCACHE, {recursive: true});
  runOrThrow(goBin, ['build', '-o', binaryPath, '.'], {
    cwd: path.join(resolveOverlayRoot(signerRoot), 'patch-peer-addrs'),
    env: goEnv,
  });
  return binaryPath;
}

export function resolveBnbTssBinary(options: any = {}): string {
  const signerRoot = options.signerRoot || resolveProjectRoot();
  const tssRoot = options.tssRoot || resolveTssRoot(signerRoot);
  const toolingRoot = resolveTssToolingRoot(tssRoot);
  const candidates = [];
  if (options.binary) candidates.push(path.resolve(options.binary));
  if (process.env.BNB_TSS_BINARY) candidates.push(path.resolve(process.env.BNB_TSS_BINARY));
  candidates.push(path.join(toolingRoot, 'bin', DEFAULT_BINARY_NAME));
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return ensureTssPrepared({...options, signerRoot, tssRoot});
}

function getVaultName(explicitVaultName?: string): string {
  return explicitVaultName || process.env.BNB_TSS_VAULT_NAME || DEFAULT_VAULT_NAME;
}

function getHomeRoot(signerRoot = resolveProjectRoot(), explicitHomeRoot?: string): string {
  return path.resolve(explicitHomeRoot || process.env.BNB_TSS_HOME_ROOT || path.join(signerRoot, 'keystores', 'bnbtss'));
}

function getIndexedPartyHomePath(homeRoot: string, partyIdx: number, chainId: number): string {
  return path.join(homeRoot, `party-${partyIdx}`, `chain-${chainId}`)
}

function getDefaultSlotHomePath(homeRoot: string, chainId: number): string {
  return path.join(homeRoot, `chain-${chainId}`)
}

function getVaultConfigPath(home: string, vaultName: string): string {
  return path.join(home, vaultName, 'config.json')
}

export function readStoredListenAddr(home: string, vaultName = DEFAULT_VAULT_NAME): string | undefined {
  const configPath = getVaultConfigPath(home, vaultName);
  if (!fs.existsSync(configPath)) {
    return undefined;
  }
  const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8')) as StoredVaultConfig;
  return typeof parsed.listen === 'string' && parsed.listen.trim() ? parsed.listen.trim() : undefined;
}

function getEffectivePartyIdx(options: BasePartyOptions): number {
  if (Number.isInteger(options.partyIdx) && Number(options.partyIdx) >= 1) {
    return Number(options.partyIdx);
  }
  if (options.useDefaultSlotPath) {
    return DEFAULT_SLOT_PARTY_IDX;
  }
  throw new Error('partyIdx is required unless useDefaultSlotPath is enabled');
}

export function getPartyHome(options: any): string {
  if (options.homePath) {
    return path.resolve(options.homePath);
  }
  const signerRoot = options.signerRoot || resolveProjectRoot();
  const homeRoot = getHomeRoot(signerRoot, options.homeRoot);
  if (!options.useDefaultSlotPath) {
    return getIndexedPartyHomePath(homeRoot, getEffectivePartyIdx(options), options.chainId);
  }
  const vaultName = getVaultName(options.vaultName);
  const defaultSlotHome = getDefaultSlotHomePath(homeRoot, options.chainId);
  const legacySlotHome = getIndexedPartyHomePath(homeRoot, 1, options.chainId);
  if (fs.existsSync(getVaultConfigPath(defaultSlotHome, vaultName))) {
    return defaultSlotHome;
  }
  if (fs.existsSync(getVaultConfigPath(legacySlotHome, vaultName))) {
    return legacySlotHome;
  }
  return defaultSlotHome;
}

export function getVaultDir(options: any): string {
  return path.join(getPartyHome(options), getVaultName(options.vaultName));
}

export function getMoniker(partyIdx: number, chainId: number): string {
  return `party-${partyIdx}-chain-${chainId}`;
}

export function getIpBasedMoniker(chainId: number, ip: string): string {
  const normalizedIp = `${ip || ''}`.trim()
  const octets = normalizedIp.split('.')
  if (
    octets.length !== 4 ||
    octets.some((octet) => !/^\d+$/.test(octet) || Number.parseInt(octet, 10) < 0 || Number.parseInt(octet, 10) > 255)
  ) {
    throw new Error(`Invalid IPv4 address for moniker derivation: ${ip}`)
  }
  return `ip-${octets.join('-')}-chain-${chainId}`
}

function getDefaultSlotMoniker(chainId: number, home: string): string {
  return `default-chain-${chainId}`;
}

export function getDeterministicListenPort(chainId: number, partyIdx: number): number {
  if (!Number.isInteger(chainId) || !Number.isInteger(partyIdx) || partyIdx < 1) {
    throw new Error(`Invalid deterministic listen port inputs: chainId=${chainId}, partyIdx=${partyIdx}`);
  }
  return 40000 + (Math.abs(chainId) % 1000) * 10 + partyIdx;
}

export function getDefaultSlotListenPort(chainId: number): number {
  return getDeterministicListenPort(chainId, DEFAULT_SLOT_PARTY_IDX);
}

export function getLocalListenAddr(chainId: number, partyIdx: number): string {
  return `/ip4/0.0.0.0/tcp/${getDeterministicListenPort(chainId, partyIdx)}`;
}

export function getDefaultSlotListenAddr(chainId: number): string {
  return `/ip4/0.0.0.0/tcp/${getDefaultSlotListenPort(chainId)}`;
}

export function getLocalPeerAddr(chainId: number, partyIdx: number): string {
  return `/ip4/127.0.0.1/tcp/${getDeterministicListenPort(chainId, partyIdx)}`;
}

export function getDefaultSlotPeerAddr(chainId: number): string {
  return `/ip4/127.0.0.1/tcp/${getDefaultSlotListenPort(chainId)}`;
}

export function getDeterministicRegroupListenPort(chainId: number, partyIdx: number): number {
  return getDeterministicListenPort(chainId, partyIdx) + REGROUP_LISTEN_PORT_OFFSET;
}

export function getLocalRegroupListenAddr(chainId: number, partyIdx: number): string {
  return `/ip4/0.0.0.0/tcp/${getDeterministicRegroupListenPort(chainId, partyIdx)}`;
}

export function getLocalRegroupPeerAddr(chainId: number, partyIdx: number): string {
  return `/ip4/127.0.0.1/tcp/${getDeterministicRegroupListenPort(chainId, partyIdx)}`;
}


function deriveActiveOldParticipantIndexes(parties: number, threshold: number): number[] {
  const count = threshold + 1;
  if (!Number.isInteger(parties) || parties < 2) {
    throw new Error(`parties must be an integer >= 2, received ${parties}`);
  }
  if (!Number.isInteger(threshold) || threshold < 1) {
    throw new Error(`threshold must be an integer >= 1, received ${threshold}`);
  }
  if (count !== parties) {
    throw new Error(`parties must equal threshold + 1 (${count}), received ${parties}`);
  }

  const indexes: number[] = [];
  for (let idx = 1; idx <= parties; idx += 1) {
    indexes.push(idx);
  }
  return indexes;
}

function deriveDefaultNewCommitteeIndexes(newParties: number): number[] {
  if (!Number.isInteger(newParties) || newParties < 2) {
    throw new Error(`newParties must be an integer >= 2, received ${newParties}`);
  }

  const indexes: number[] = [];
  for (let idx = 1; idx <= newParties; idx += 1) {
    indexes.push(idx);
  }
  return indexes;
}

function pushUniqueAddr(target: string[], addr: string) {
  if (!target.includes(addr)) {
    target.push(addr);
  }
}

export function deriveLocalRegroupPeerAddrs(options: LocalRegroupPeerAddrsOptions): string[] {
  const {chainId, parties, threshold, newParties, partyIdx, isOld = false, isNewMember = false} = options;
  if (isOld && isNewMember) {
    throw new Error('Local regroup wrapper roles are mutually exclusive: use --is-old for a carry-over member or --is-new-member for a fresh new member.');
  }
  if (!isOld && !isNewMember) {
    throw new Error('Local regroup peer derivation requires either --is-old or --is-new-member.');
  }
  const oldParticipantIdxs = deriveActiveOldParticipantIndexes(parties, threshold);
  const newCommitteeIdxs = deriveDefaultNewCommitteeIndexes(newParties);
  const oldAndNewIdxs = oldParticipantIdxs.filter((idx) => newCommitteeIdxs.includes(idx));
  const newOnlyIdxs = newCommitteeIdxs.filter((idx) => !oldParticipantIdxs.includes(idx));

  if (isOld && (!oldParticipantIdxs.includes(partyIdx) || !newCommitteeIdxs.includes(partyIdx))) {
    throw new Error(
      `party ${partyIdx} is marked old, but the local deterministic regroup default expects carry-over members to be within both active old parties 1..${parties} and new committee parties 1..${newParties}.`,
    );
  }
  if (isNewMember && (!newCommitteeIdxs.includes(partyIdx) || oldParticipantIdxs.includes(partyIdx))) {
    throw new Error(
      `party ${partyIdx} is marked new, but the local deterministic regroup default expects fresh new members to be within new committee parties 1..${newParties} and outside active old parties 1..${parties}.`,
    );
  }

  const peerAddrs: string[] = [];

  for (const idx of oldParticipantIdxs) {
    if (idx === partyIdx) {
      if (isOld) {
        continue;
      }
      pushUniqueAddr(peerAddrs, getLocalPeerAddr(chainId, idx));
      continue;
    }
    pushUniqueAddr(peerAddrs, getLocalPeerAddr(chainId, idx));
  }

  for (const idx of oldAndNewIdxs) {
    if (idx === partyIdx) {
      if (isOld) {
        pushUniqueAddr(peerAddrs, getLocalRegroupPeerAddr(chainId, idx));
      }
      continue;
    }
    pushUniqueAddr(peerAddrs, getLocalRegroupPeerAddr(chainId, idx));
  }

  for (const idx of newOnlyIdxs) {
    if (idx === partyIdx) {
      continue;
    }
    pushUniqueAddr(peerAddrs, getLocalPeerAddr(chainId, idx));
  }

  const expectedCount = threshold + newParties;
  if (peerAddrs.length !== expectedCount) {
    throw new Error(
      `Derived ${peerAddrs.length} regroup peer addrs for party ${partyIdx}, expected ${expectedCount}. ` +
        `This local deterministic wrapper expects exactly ${threshold + 1} active old parties (parties=threshold+1) and the new committee as parties 1..${newParties}.`,
    );
  }

  return peerAddrs;
}

export function readParams(signerRoot = resolveProjectRoot()): ParamsConfig {
  return loadParamsConfig(signerRoot)
}

function requireTypeScriptModule(filePath: string): any {
  let ts;
  try {
    ts = require('typescript');
  } catch (error) {
    throw new Error(`typescript is required to load ${path.basename(filePath)} at runtime`);
  }

  const source = fs.readFileSync(filePath, 'utf8');
  const transpiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
    fileName: filePath,
  });
  const tsModule = new Module(filePath, module);
  tsModule.filename = filePath;
  tsModule.paths = (Module as any)._nodeModulePaths(path.dirname(filePath));
  ;(tsModule as any)._compile(transpiled.outputText, filePath);
  return tsModule.exports;
}

let committeeTopologyModule = null;

function getCommitteeTopologyModule(signerRoot = resolveProjectRoot()): any {
  if (committeeTopologyModule) {
    return committeeTopologyModule;
  }
  const helperPath = path.join(resolveOverlayRoot(signerRoot), 'lib', 'committeeTopology.ts');
  committeeTopologyModule = requireTypeScriptModule(helperPath);
  return committeeTopologyModule;
}

function lastNonEmptyLine(text: string): string | undefined {
  return (text || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .pop();
}

function extractSignatureHex(text: string): string {
  const matches = Array.from(text.matchAll(/received signature:\s*([0-9a-fA-F]{128})\b/g));
  const signatureHex = matches.length > 0 ? matches[matches.length - 1][1] : undefined;
  if (!signatureHex) {
    throw new Error(`Failed to locate compact signature in signer output.\n${text}`);
  }
  return `0x${signatureHex.toLowerCase()}`;
}

function parseCompactSignature(signatureHex: string): {r: string; s: string} {
  const normalized = signatureHex.startsWith('0x') ? signatureHex.slice(2) : signatureHex;
  if (!/^[0-9a-fA-F]{128}$/.test(normalized)) {
    throw new Error(`Expected a 64-byte compact signature, got ${signatureHex}`);
  }
  return {
    r: `0x${normalized.slice(0, 64)}`,
    s: `0x${normalized.slice(64)}`,
  };
}

function requireEnvOrValue(value: string | undefined, envKey: string, label: string): string {
  const resolved = value || process.env[envKey] || '';
  if (!resolved) {
    throw new Error(`${label} is required (${envKey})`);
  }
  return resolved;
}

export function getVaultPasswordEnvKey(chainId: number): string {
  if (!Number.isFinite(chainId)) {
    throw new Error(`chainId must be a finite number, got: ${chainId}`);
  }
  return `TSS_PASSWORD_CHAIN_${chainId}`;
}

export function requireVaultPassword(chainId: number, value?: string): string {
  return requireEnvOrValue(value, getVaultPasswordEnvKey(chainId), 'BNB TSS vault password');
}

export function buildKeygenArgs({
  home,
  vaultName,
  password,
  logLevel,
  channelId,
  channelPassword,
  threshold,
  parties,
  peerAddrs,
  extraArgs,
}): string[] {
  const args = [
    'keygen',
    '--home',
    home,
    '--vault_name',
    vaultName,
    '--password',
    password,
    '--log_level',
    logLevel || 'debug',
    '--channel_id',
    channelId,
    '--channel_password',
    channelPassword,
    '--threshold',
    String(threshold),
    '--parties',
    String(parties),
  ];
  if (Array.isArray(peerAddrs) && peerAddrs.length > 0) {
    args.push('--p2p.peer_addrs', peerAddrs.join(','));
  }
  if (Array.isArray(extraArgs) && extraArgs.length > 0) {
    args.push(...extraArgs);
  }
  return args;
}

export function buildSignArgs({
  home,
  vaultName,
  password,
  logLevel,
  channelId,
  channelPassword,
  messageDecimal,
  signDiscoveryTimeout,
  extraArgs,
}: {
  home: string
  vaultName: string
  password: string
  logLevel?: string
  channelId: string
  channelPassword: string
  messageDecimal: string
  signDiscoveryTimeout?: string
  extraArgs?: string[]
}): string[] {
  const args = [
    'sign',
    '--home',
    home,
    '--vault_name',
    vaultName,
    '--password',
    password,
    '--log_level',
    logLevel || 'debug',
    '--channel_id',
    channelId,
    '--channel_password',
    channelPassword,
    '--message',
    messageDecimal,
  ];
  if (signDiscoveryTimeout) {
    args.push('--sign_discovery_timeout', signDiscoveryTimeout);
  }
  if (Array.isArray(extraArgs) && extraArgs.length > 0) {
    args.push(...extraArgs);
  }
  return args;
}

export async function initParty(options: InitPartyOptions = {} as InitPartyOptions): Promise<InitializedParty> {
  const signerRoot = options.signerRoot || resolveProjectRoot();
  const tssRoot = options.tssRoot || resolveTssRoot(signerRoot);
  const binary = resolveBnbTssBinary({...options, signerRoot, tssRoot});
  const home = getPartyHome({...options, signerRoot});
  const vaultName = getVaultName(options.vaultName);
  const partyIdx = getEffectivePartyIdx(options);
  const vaultPassword = requireVaultPassword(options.chainId, options.password);
  const configPath = getVaultConfigPath(home, vaultName);
  if (fs.existsSync(configPath)) {
    return {home, vaultName, binary, tssRoot};
  }
  fs.mkdirSync(home, {recursive: true});
  await runWithLiveLogs(
    binary,
    [
      'init',
      '--home',
      home,
      '--vault_name',
      vaultName,
      '--moniker',
      options.moniker || (options.useDefaultSlotPath ? getDefaultSlotMoniker(options.chainId, home) : getMoniker(partyIdx, options.chainId)),
      '--password',
      vaultPassword,
      '--log_level',
      options.logLevel || 'debug',
      '--p2p.listen',
      options.listenAddr || getLocalListenAddr(options.chainId, partyIdx),
    ],
    {
      cwd: tssRoot,
      env: {TSS_PASSWORD: vaultPassword},
    },
  );
  return {home, vaultName, binary, tssRoot};
}

export function requireInitialized(options: BasePartyOptions = {} as BasePartyOptions): InitializedParty {
  const signerRoot = options.signerRoot || resolveProjectRoot();
  const tssRoot = options.tssRoot || resolveTssRoot(signerRoot);
  const binary = resolveBnbTssBinary({...options, signerRoot, tssRoot});
  const home = getPartyHome({...options, signerRoot});
  const vaultName = getVaultName(options.vaultName);
  const configPath = getVaultConfigPath(home, vaultName);
  if (!fs.existsSync(configPath)) {
    const initCommand = options.useDefaultSlotPath
      ? `node tss-tools/init.js --chain-id ${options.chainId}`
      : `node tss-tools/init.js --party ${getEffectivePartyIdx(options)} --chain-id ${options.chainId}`;
    throw new Error(
      `Missing initialized party config at ${configPath}. Run ${initCommand} first.`,
    );
  }
  return {home, vaultName, binary, tssRoot};
}

export function normalizeStoredPostRegroupPorts(options: BasePartyOptions): void {
  const signerRoot = options.signerRoot || resolveProjectRoot();
  const tssRoot = options.tssRoot || resolveTssRoot(signerRoot);
  const {home, vaultName} = requireInitialized({...options, signerRoot, tssRoot});
  const password = requireVaultPassword(options.chainId, options.password);
  const patchBinary = resolvePatchPeerAddrsBinary({signerRoot, tssRoot});
  runOrThrow(
    patchBinary,
    [
      '--normalize-regroup-ports',
      '--config-path',
      getVaultConfigPath(home, vaultName),
      '--chain-id',
      String(options.chainId),
      '--password',
      password,
      ...(options.useDefaultSlotPath ? ['--use-default-slot-path'] : []),
      ...(Number.isInteger(options.partyIdx) ? ['--party', String(getEffectivePartyIdx(options))] : []),
    ],
    {
      cwd: tssRoot,
      env: {
        TSS_PASSWORD: password,
      },
    },
  );
}

export function derivePubkey(options: VerifyOptions = {} as VerifyOptions): DerivedPubkeyAll | string {
  const signerRoot = options.signerRoot || resolveProjectRoot();
  const tssRoot = options.tssRoot || resolveTssRoot(signerRoot);
  ensureTssPrepared({signerRoot, tssRoot});
  const vaultPassword = requireVaultPassword(options.chainId, options.password);
  const helperBinary = path.join(resolveTssToolingRoot(tssRoot), 'bin', DEFAULT_DERIVE_BINARY_NAME);
  if (!fs.existsSync(helperBinary)) {
    buildTssBinary({signerRoot, tssRoot, force: true});
  }
  const args = [
    '--home',
    getVaultDir({...options, signerRoot}),
    '--password',
    vaultPassword,
    '--format',
    options.format || 'all',
  ];
  const result = runOrThrow(helperBinary, args, {
    cwd: tssRoot,
    env: {
      TSS_PASSWORD: vaultPassword,
    },
  });
  const line = lastNonEmptyLine(result.stdout);
  if (!line) {
    throw new Error('derive-pubkey produced no output');
  }
  if ((options.format || 'all') === 'all') {
    return JSON.parse(line);
  }
  return line;
}

export function deriveLocalPeerAddrs(options: KeygenOptions = {} as KeygenOptions): string[] {
  const signerRoot = options.signerRoot || resolveProjectRoot();
  const helper = getCommitteeTopologyModule(signerRoot);
  return helper.deriveLocalPeerAddrs(options);
}

export function describeVault(options: (BasePartyOptions & {initialized?: InitializedParty}) = {} as BasePartyOptions & {initialized?: InitializedParty}): string {
  const signerRoot = options.signerRoot || resolveProjectRoot();
  const tssRoot = options.tssRoot || resolveTssRoot(signerRoot);
  const binary = resolveBnbTssBinary({...options, signerRoot, tssRoot});
  const {home, vaultName} =
    options.initialized || requireInitialized({...options, signerRoot, tssRoot, binary});
  const password = requireVaultPassword(options.chainId, options.password);
  const args = [
    'describe',
    '--home',
    home,
    '--vault_name',
    vaultName,
    '--password',
    password,
  ];
  return runOrThrow(binary, args, {
    cwd: tssRoot,
    env: {
      TSS_PASSWORD: password,
    },
  }).stdout;
}

export function getCommitteeTopology(options: BasePartyOptions & {describeOutput?: string} = {} as BasePartyOptions & {describeOutput?: string}): CommitteeTopologySnapshot {
  const signerRoot = options.signerRoot || resolveProjectRoot();
  const helper = getCommitteeTopologyModule(signerRoot);
  return helper.extractCommitteeTopologyFromDescribeOutput(
    options.describeOutput || describeVault({...options, signerRoot}),
  );
}

export function validatePartyVaults(options: Omit<BasePartyOptions, 'chainId'> & {chainIds?: number[]; expectedAddressesByChainId?: Record<number, string>} = {} as Omit<BasePartyOptions, 'chainId'> & {chainIds?: number[]; expectedAddressesByChainId?: Record<number, string>}): Array<DerivedPubkeyAll & {chainId: number; home: string; vaultDir: string}> {
  const results = [];
  const chainIds = options.chainIds || [];
  const partyIdx = getEffectivePartyIdx({partyIdx: options.partyIdx, useDefaultSlotPath: options.useDefaultSlotPath, chainId: 1});
  for (const chainId of chainIds) {
    const home = getPartyHome({...options, chainId});
    const vaultDir = getVaultDir({...options, chainId});
    const pkPath = path.join(vaultDir, 'pk.json');
    const skPath = path.join(vaultDir, 'sk.json');
    if (!fs.existsSync(pkPath) || !fs.existsSync(skPath)) {
      throw new Error(`Missing BNB TSS vault files for party ${partyIdx} chain ${chainId} at ${vaultDir}`);
    }
    const derived = derivePubkey({...options, chainId, format: 'all'}) as DerivedPubkeyAll;
    const expectedAddress = options.expectedAddressesByChainId?.[chainId];
    if (expectedAddress) {
      if (ethers.getAddress(derived.ethereum_address) !== ethers.getAddress(expectedAddress)) {
        throw new Error(
          `BNB TSS address mismatch for chain ${chainId}: derived ${derived.ethereum_address}, expected ${expectedAddress}`,
        );
      }
    }
    results.push({
      chainId,
      home,
      vaultDir,
      ...derived,
    });
  }
  return results;
}

function toMessageDecimal(digestHex: string): string {
  return BigInt(digestHex).toString(10);
}

function deriveRecoveryId(digestHex: string, signature: {r: string; s: string}, expectedAddress: string): number {
  const normalized = ethers.getAddress(expectedAddress);
  for (const recoveryParam of [0, 1]) {
    const recovered = ethers.recoverAddress(digestHex, ethers.Signature.from({
      r: signature.r,
      s: signature.s,
      v: 27 + recoveryParam,
    }));
    if (ethers.getAddress(recovered) === normalized) {
      return recoveryParam;
    }
  }
  throw new Error(`Unable to derive recovery id for ${expectedAddress}`);
}

export async function signDigest(options: SignEthereumTxOptions & {digest: string} = {} as SignEthereumTxOptions & {digest: string}): Promise<SignDigestResult> {
  const signerRoot = options.signerRoot || resolveProjectRoot();
  const tssRoot = options.tssRoot || resolveTssRoot(signerRoot);
  const binary = resolveBnbTssBinary({...options, signerRoot, tssRoot});
  const {home, vaultName} = requireInitialized({...options, signerRoot, tssRoot, binary});
  const password = requireVaultPassword(options.chainId, options.password);
  const channelId = requireEnvOrValue(options.channelId, 'BNB_TSS_CHANNEL_ID', 'BNB TSS channel id');
  const channelPassword = requireEnvOrValue(
    options.channelPassword,
    'BNB_TSS_CHANNEL_PASSWORD',
    'BNB TSS channel password',
  );
  const messageDecimal = toMessageDecimal(options.digest);
  const args = buildSignArgs({
    home,
    vaultName,
    password,
    channelId,
    channelPassword,
    messageDecimal,
    signDiscoveryTimeout: options.signDiscoveryTimeout,
    extraArgs: options.extraArgs,
  });
  // console.log(`Running ${binary} ${args.join(' ')}`);
  const result: any = await runWithLiveLogs(binary, args, {
    cwd: tssRoot,
    env: {
      TSS_PASSWORD: password,
    },
    timeoutMs: options.timeoutMs,
    timeoutErrorMessage: SIGNING_TIMEOUT_ERROR,
    printLogs: options.printLogs,
  });
  const signatureHex = extractSignatureHex(`${result.stdout}\n${result.stderr}`);
  const signature = parseCompactSignature(signatureHex);
  const derived = derivePubkey({...options, signerRoot, tssRoot, format: 'all'}) as DerivedPubkeyAll;
  const ethereumAddress = ethers.getAddress(derived.ethereum_address);
  const recoveryParam = deriveRecoveryId(options.digest, signature, ethereumAddress);
  return {
    digest: options.digest,
    messageDecimal,
    r: signature.r,
    s: signature.s,
    recoveryParam,
    v: 27 + recoveryParam,
    ethereumAddress,
    publicKeyEthereum: `0x${derived.ethereum_pubkey}`,
    publicKeyCompressed: `0x${derived.compressed}`,
    signatureHex,
  };
}

export async function signEthereumTransaction(options: SignEthereumTxOptions = {} as SignEthereumTxOptions): Promise<SignEthereumTransactionResult> {
  const digest = ethers.keccak256(ethers.Transaction.from(options.tx).unsignedSerialized);
  const signed = await signDigest({...options, digest});
  const signature = ethers.Signature.from({ r: signed.r, s: signed.s, v: signed.v });
  const signedTx = ethers.Transaction.from({ ...options.tx, signature }).serialized;
  const recovered = ethers.recoverAddress(digest, signature);
  if (ethers.getAddress(recovered) !== signed.ethereumAddress) {
    throw new Error(`Recovered signer ${recovered} does not match ${signed.ethereumAddress}`);
  }
  return {
    signedTx,
    txHash: ethers.keccak256(signedTx),
    digest,
    ...signed,
  };
}
