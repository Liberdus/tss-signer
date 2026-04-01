// Single-party-per-machine deployment config.
// Each machine runs one observer and one TSS party, both using the default-slot vault path.
// Usage:
//   pm2 start ecosystem.remote.config.js

const commonNodeArgs = '--max-old-space-size=4096 --expose-gc';
const commonRestartPolicy = {
  autorestart: true,
  min_uptime: '10s',
  max_restarts: 10,
  restart_delay: 5000,
};
const commonEnv = {
  NODE_ENV: 'production',
  NODE_OPTIONS: '--max-old-space-size=4096 --expose-gc',
};

module.exports = {
  apps: [
    {
      name: 'observer',
      script: './dist/observer/index.js',
      instances: 1,
      ...commonRestartPolicy,
      watch: false,
      max_memory_restart: '4G',
      node_args: commonNodeArgs,
      env: {
        ...commonEnv,
        PARTY_INDEX: '1',
      },
      merge_logs: true,
      error_file: './logs/observer-error.log',
      out_file: './logs/observer-out.log',
      log_file: './logs/observer-combined.log',
      time: true,
    },
    {
      name: 'tss-party',
      script: './dist/scripts/tss-party.js',
      instances: 1,
      ...commonRestartPolicy,
      watch: false,
      max_memory_restart: '4G',
      node_args: commonNodeArgs,
      env: commonEnv,
      merge_logs: true,
      error_file: './logs/tss-party-error.log',
      out_file: './logs/tss-party-out.log',
      log_file: './logs/tss-party-combined.log',
      time: true,
    },
  ],
};
