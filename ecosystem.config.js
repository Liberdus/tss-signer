module.exports = {
  apps: [
    {
      name: 'tss-party-1',
      script: './dist/tss-party.js',
      args: '1',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '2G', // Increase memory limit
      node_args: '--max-old-space-size=2048 --expose-gc', // Set Node.js heap size and enable GC
      env: {
        NODE_ENV: 'production',
        NODE_OPTIONS: '--max-old-space-size=2048 --expose-gc' // Alternative way to set heap size
      },
      error_file: './logs/tss-party-1-error.log',
      out_file: './logs/tss-party-1-out.log',
      log_file: './logs/tss-party-1-combined.log',
      time: true
    },
    {
      name: 'tss-party-2',
      script: './dist/tss-party.js',
      args: '2',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '2G', // Increase memory limit
      node_args: '--max-old-space-size=2048 --expose-gc', // Set Node.js heap size and enable GC
      env: {
        NODE_ENV: 'production',
        NODE_OPTIONS: '--max-old-space-size=2048 --expose-gc' // Alternative way to set heap size
      },
      error_file: './logs/tss-party-2-error.log',
      out_file: './logs/tss-party-2-out.log',
      log_file: './logs/tss-party-2-combined.log',
      time: true
    },
    {
      name: 'tss-party-3',
      script: './dist/tss-party.js',
      args: '3',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '2G', // Increase memory limit
      node_args: '--max-old-space-size=2048 --expose-gc', // Set Node.js heap size and enable GC
      env: {
        NODE_ENV: 'production',
        NODE_OPTIONS: '--max-old-space-size=2048 --expose-gc' // Alternative way to set heap size
      },
      error_file: './logs/tss-party-3-error.log',
      out_file: './logs/tss-party-3-out.log',
      log_file: './logs/tss-party-3-combined.log',
      time: true
    },
    {
      name: 'tss-party-4',
      script: './dist/tss-party.js',
      args: '4',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '2G', // Increase memory limit
      node_args: '--max-old-space-size=2048 --expose-gc', // Set Node.js heap size and enable GC
      env: {
        NODE_ENV: 'production',
        NODE_OPTIONS: '--max-old-space-size=2048 --expose-gc' // Alternative way to set heap size
      },
      error_file: './logs/tss-party-4-error.log',
      out_file: './logs/tss-party-4-out.log',
      log_file: './logs/tss-party-4-combined.log',
      time: true
    },
    {
      name: 'tss-party-5',
      script: './dist/tss-party.js',
      args: '5',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '2G', // Increase memory limit
      node_args: '--max-old-space-size=2048 --expose-gc', // Set Node.js heap size and enable GC
      env: {
        NODE_ENV: 'production',
        NODE_OPTIONS: '--max-old-space-size=2048 --expose-gc' // Alternative way to set heap size
      },
      error_file: './logs/tss-party-5-error.log',
      out_file: './logs/tss-party-5-out.log',
      log_file: './logs/tss-party-5-combined.log',
      time: true
    }
  ]
};
