const fs = require('node:fs');
const path = require('node:path');
const {spawn, spawnSync} = require('node:child_process');
const {ethers} = require('ethers');

const DEFAULT_VAULT_NAME = 'default';
const DEFAULT_GO_VERSION = '1.20.3';
const DEFAULT_MISE_VERSION = 'v2026.3.8';
const DEFAULT_BINARY_NAME = 'tss';
const DEFAULT_DERIVE_BINARY_NAME = 'tss-derive-pubkey';

function resolveSignerRoot(startDir = __dirname) {
  let current = path.resolve(startDir);
  while (true) {
    if (
      fs.existsSync(path.join(current, 'package.json')) &&
      fs.existsSync(path.join(current, 'chain-config.json'))
    ) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      throw new Error('Unable to resolve tss-signer root');
    }
    current = parent;
  }
}

function resolveOverlayRoot(signerRoot = resolveSignerRoot()) {
  return path.join(signerRoot, 'tss-tools');
}

function resolveToolingRoot(signerRoot = resolveSignerRoot()) {
  return path.join(signerRoot, '.tooling');
}

function resolveTssToolingRoot(tssRoot) {
  return path.join(tssRoot, '.tooling');
}

function hasDirectoryEntries(dirPath) {
  try {
    return fs.readdirSync(dirPath).length > 0;
  } catch {
    return false;
  }
}

function resolveTssRoot(signerRoot = resolveSignerRoot()) {
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

function resolvePatchPath(signerRoot = resolveSignerRoot()) {
  return path.join(resolveOverlayRoot(signerRoot), 'patches', 'tss-source.patch');
}

function resolveGoBinary(tssRoot) {
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

function ensureGoBinary(tssRoot) {
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
    const archivePath = path.join('/tmp', 'mise-macos-arm64.tar.gz');
    runOrThrow('curl', [
      '-fL',
      '--retry',
      '5',
      '--retry-delay',
      '2',
      '--retry-all-errors',
      `https://github.com/jdx/mise/releases/download/${DEFAULT_MISE_VERSION}/mise-${DEFAULT_MISE_VERSION}-macos-arm64.tar.gz`,
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

function pickCachePath(preferredPath, fallbackPath) {
  if (hasDirectoryEntries(preferredPath)) {
    return preferredPath;
  }
  if (hasDirectoryEntries(fallbackPath)) {
    return fallbackPath;
  }
  return preferredPath;
}

function buildGoEnv(signerRoot, tssRoot) {
  const toolingRoot = resolveTssToolingRoot(tssRoot);
  const preferredGoCache = path.join(toolingRoot, 'go-cache');
  const preferredGoModCache = path.join(toolingRoot, 'go-modcache');
  return {
    ...process.env,
    GOCACHE:
      process.env.GOCACHE ||
      pickCachePath(preferredGoCache, path.join(tssRoot, '.tooling', 'go-cache')),
    GOMODCACHE:
      process.env.GOMODCACHE ||
      pickCachePath(preferredGoModCache, path.join(tssRoot, '.tooling', 'go-modcache')),
  };
}

function runOrThrow(command, args, options = {}) {
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

function runWithLiveLogs(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ? {...process.env, ...options.env} : process.env,
      stdio: ['inherit', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let stdoutPending = '';

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
        process.stderr.write(`${line}\n`);
      }
    });

    child.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      stderr += text;
      process.stderr.write(text);
    });

    child.on('error', (error) => {
      reject(error);
    });

    child.on('close', (code) => {
      if (code !== 0) {
        const output = (stderr || stdout || '').trim();
        reject(new Error(output || `${path.basename(command)} exited with status ${code}`));
        return;
      }
      resolve({stdout, stderr});
    });
  });
}

function checkCommand(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env ? {...process.env, ...options.env} : process.env,
    encoding: 'utf8',
  });
}

function ensurePatchApplied(signerRoot = resolveSignerRoot()) {
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

function buildTssBinary(options = {}) {
  const signerRoot = options.signerRoot || resolveSignerRoot();
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

function ensureTssPrepared(options = {}) {
  const signerRoot = options.signerRoot || resolveSignerRoot();
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

function resolveBnbTssBinary(options = {}) {
  const signerRoot = options.signerRoot || resolveSignerRoot();
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

function getVaultName(explicitVaultName) {
  return explicitVaultName || process.env.BNB_TSS_VAULT_NAME || DEFAULT_VAULT_NAME;
}

function getHomeRoot(signerRoot = resolveSignerRoot(), explicitHomeRoot) {
  return path.resolve(explicitHomeRoot || process.env.BNB_TSS_HOME_ROOT || path.join(signerRoot, 'keystores', 'bnbtss'));
}

function getPartyHome(options) {
  if (options.homePath) {
    return path.resolve(options.homePath);
  }
  const signerRoot = options.signerRoot || resolveSignerRoot();
  const homeRoot = getHomeRoot(signerRoot, options.homeRoot);
  return path.join(homeRoot, `party-${options.partyIdx}`, `chain-${options.chainId}`);
}

function getVaultDir(options) {
  return path.join(getPartyHome(options), getVaultName(options.vaultName));
}

function getMoniker(partyIdx, chainId) {
  return `party-${partyIdx}-chain-${chainId}`;
}

function getDeterministicListenPort(chainId, partyIdx) {
  if (!Number.isInteger(chainId) || !Number.isInteger(partyIdx) || partyIdx < 1) {
    throw new Error(`Invalid deterministic listen port inputs: chainId=${chainId}, partyIdx=${partyIdx}`);
  }
  return 40000 + (Math.abs(chainId) % 1000) * 10 + partyIdx;
}

function getLocalListenAddr(chainId, partyIdx) {
  return `/ip4/0.0.0.0/tcp/${getDeterministicListenPort(chainId, partyIdx)}`;
}

function getLocalPeerAddr(chainId, partyIdx) {
  return `/ip4/127.0.0.1/tcp/${getDeterministicListenPort(chainId, partyIdx)}`;
}

function readParams(signerRoot = resolveSignerRoot()) {
  return JSON.parse(fs.readFileSync(path.join(signerRoot, 'params.json'), 'utf8'));
}

function lastNonEmptyLine(text) {
  return (text || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .pop();
}

function extractJsonLine(text) {
  const lines = (text || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const jsonLine = [...lines].reverse().find((line) => line.startsWith('{') && line.endsWith('}'));
  if (!jsonLine) {
    throw new Error(`Failed to locate JSON output.\n${text}`);
  }
  return JSON.parse(jsonLine);
}

function requireEnvOrValue(value, envKey, label) {
  const resolved = value || process.env[envKey] || '';
  if (!resolved) {
    throw new Error(`${label} is required (${envKey})`);
  }
  return resolved;
}

function initParty(options = {}) {
  const signerRoot = options.signerRoot || resolveSignerRoot();
  const tssRoot = options.tssRoot || resolveTssRoot(signerRoot);
  const binary = resolveBnbTssBinary({...options, signerRoot, tssRoot});
  const home = getPartyHome({...options, signerRoot});
  const vaultName = getVaultName(options.vaultName);
  const vaultPassword = requireEnvOrValue(options.password, 'BNB_TSS_PASSWORD', 'BNB TSS vault password');
  const configPath = path.join(home, vaultName, 'config.json');
  if (fs.existsSync(configPath)) {
    return {home, vaultName, binary, tssRoot};
  }
  fs.mkdirSync(home, {recursive: true});
  runOrThrow(
    binary,
    [
      'init',
      '--home',
      home,
      '--vault_name',
      vaultName,
      '--moniker',
      options.moniker || getMoniker(options.partyIdx, options.chainId),
      '--password',
      vaultPassword,
      '--p2p.listen',
      options.listenAddr || getLocalListenAddr(options.chainId, options.partyIdx),
    ],
    {
      cwd: tssRoot,
      env: {TSS_PASSWORD: vaultPassword},
    },
  );
  return {home, vaultName, binary, tssRoot};
}

function requireInitialized(options = {}) {
  const signerRoot = options.signerRoot || resolveSignerRoot();
  const tssRoot = options.tssRoot || resolveTssRoot(signerRoot);
  const binary = resolveBnbTssBinary({...options, signerRoot, tssRoot});
  const home = getPartyHome({...options, signerRoot});
  const vaultName = getVaultName(options.vaultName);
  const configPath = path.join(home, vaultName, 'config.json');
  if (!fs.existsSync(configPath)) {
    throw new Error(
      `Missing initialized party config at ${configPath}. Run node tss-tools/init.js --party ${options.partyIdx} --chain-id ${options.chainId} first.`,
    );
  }
  return {home, vaultName, binary, tssRoot};
}

function derivePubkey(options = {}) {
  const signerRoot = options.signerRoot || resolveSignerRoot();
  const tssRoot = options.tssRoot || resolveTssRoot(signerRoot);
  ensureTssPrepared({signerRoot, tssRoot});
  const vaultPassword = requireEnvOrValue(options.password, 'BNB_TSS_PASSWORD', 'BNB TSS vault password');
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

function validatePartyVaults(options = {}) {
  const results = [];
  const chainIds = options.chainIds || [];
  for (const chainId of chainIds) {
    const home = getPartyHome({...options, chainId});
    const vaultDir = getVaultDir({...options, chainId});
    const pkPath = path.join(vaultDir, 'pk.json');
    const skPath = path.join(vaultDir, 'sk.json');
    if (!fs.existsSync(pkPath) || !fs.existsSync(skPath)) {
      throw new Error(`Missing BNB TSS vault files for party ${options.partyIdx} chain ${chainId} at ${vaultDir}`);
    }
    const derived = derivePubkey({...options, chainId, format: 'all'});
    const expectedAddress = options.expectedAddressesByChainId?.[chainId];
    if (expectedAddress) {
      if (ethers.utils.getAddress(derived.ethereum_address) !== ethers.utils.getAddress(expectedAddress)) {
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

function toMessageDecimal(digestHex) {
  return BigInt(digestHex).toString(10);
}

function deriveRecoveryId(digestHex, signature, expectedAddress) {
  const normalized = ethers.utils.getAddress(expectedAddress);
  for (const recoveryParam of [0, 1]) {
    const recovered = ethers.utils.recoverAddress(digestHex, {
      r: signature.r,
      s: signature.s,
      recoveryParam,
    });
    if (ethers.utils.getAddress(recovered) === normalized) {
      return recoveryParam;
    }
  }
  throw new Error(`Unable to derive recovery id for ${expectedAddress}`);
}

async function signDigest(options = {}) {
  const signerRoot = options.signerRoot || resolveSignerRoot();
  const tssRoot = options.tssRoot || resolveTssRoot(signerRoot);
  const binary = resolveBnbTssBinary({...options, signerRoot, tssRoot});
  const {home, vaultName} = requireInitialized({...options, signerRoot, tssRoot, binary});
  const password = requireEnvOrValue(options.password, 'BNB_TSS_PASSWORD', 'BNB TSS vault password');
  const channelId = requireEnvOrValue(options.channelId, 'BNB_TSS_CHANNEL_ID', 'BNB TSS channel id');
  const channelPassword = requireEnvOrValue(
    options.channelPassword,
    'BNB_TSS_CHANNEL_PASSWORD',
    'BNB TSS channel password',
  );
  const messageDecimal = toMessageDecimal(options.digest);
  const args = [
    'sign',
    '--home',
    home,
    '--vault_name',
    vaultName,
    '--password',
    password,
    '--channel_id',
    channelId,
    '--channel_password',
    channelPassword,
    '--message',
    messageDecimal,
    '--json',
  ];
  if (Array.isArray(options.extraArgs) && options.extraArgs.length > 0) {
    args.push(...options.extraArgs);
  }
  console.log(`Running ${binary} ${args.join(' ')}`);
  const result = await runWithLiveLogs(binary, args, {
    cwd: tssRoot,
    env: {
      TSS_PASSWORD: password,
    },
  });
  const parsed = extractJsonLine(result.stdout);
  const signature = {
    r: `0x${parsed.r}`,
    s: `0x${parsed.s}`,
  };
  const recoveryParam = deriveRecoveryId(options.digest, signature, parsed.ethereum_address);
  return {
    digest: options.digest,
    messageDecimal,
    r: signature.r,
    s: signature.s,
    recoveryParam,
    v: 27 + recoveryParam,
    ethereumAddress: ethers.utils.getAddress(parsed.ethereum_address),
    publicKeyEthereum: `0x${parsed.public_key_ethereum}`,
    publicKeyCompressed: `0x${parsed.public_key_compressed}`,
    signatureHex: `0x${parsed.signature_compact_hex}`,
  };
}

async function signEthereumTransaction(options = {}) {
  const digest = ethers.utils.keccak256(ethers.utils.serializeTransaction(options.tx));
  const signed = await signDigest({...options, digest});
  const signature = {
    r: signed.r,
    s: signed.s,
    v: signed.v,
  };
  const signedTx = ethers.utils.serializeTransaction(options.tx, signature);
  const recovered = ethers.utils.recoverAddress(digest, signature);
  if (ethers.utils.getAddress(recovered) !== signed.ethereumAddress) {
    throw new Error(`Recovered signer ${recovered} does not match ${signed.ethereumAddress}`);
  }
  return {
    signedTx,
    txHash: ethers.utils.keccak256(signedTx),
    digest,
    ...signed,
  };
}

module.exports = {
  DEFAULT_VAULT_NAME,
  buildTssBinary,
  derivePubkey,
  ensurePatchApplied,
  ensureTssPrepared,
  getMoniker,
  getDeterministicListenPort,
  getLocalListenAddr,
  getLocalPeerAddr,
  getPartyHome,
  getVaultDir,
  initParty,
  readParams,
  requireInitialized,
  resolveBnbTssBinary,
  resolveOverlayRoot,
  resolveSignerRoot,
  resolveTssRoot,
  resolveToolingRoot,
  resolveTssToolingRoot,
  signDigest,
  signEthereumTransaction,
  validatePartyVaults,
};
