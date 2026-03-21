const PARTIES = [1, 2, 3, 4, 5];

const commonNodeArgs = '--max-old-space-size=2048 --expose-gc';
const commonEnv = {
  NODE_ENV: 'production',
  NODE_OPTIONS: '--max-old-space-size=2048 --expose-gc',
};

const observerApps = PARTIES.map((n) => ({
  name: `observer-${n}`,
  script: './dist/observer/src/index.js',
  instances: 1,
  autorestart: true,
  watch: false,
  max_memory_restart: '1G',
  node_args: commonNodeArgs,
  env: {
    ...commonEnv,
    PARTY_INDEX: String(n),
  },
  error_file: `./logs/observer-${n}-error.log`,
  out_file: `./logs/observer-${n}-out.log`,
  log_file: `./logs/observer-${n}-combined.log`,
  time: true,
}));

const tssPartyApps = PARTIES.map((n) => ({
  name: `tss-party-${n}`,
  script: './dist/scripts/tss-party.js',
  args: String(n),
  instances: 1,
  autorestart: true,
  watch: false,
  max_memory_restart: '2G',
  node_args: commonNodeArgs,
  env: commonEnv,
  error_file: `./logs/tss-party-${n}-error.log`,
  out_file: `./logs/tss-party-${n}-out.log`,
  log_file: `./logs/tss-party-${n}-combined.log`,
  time: true,
}));

module.exports = {
  apps: [...observerApps, ...tssPartyApps],
};
