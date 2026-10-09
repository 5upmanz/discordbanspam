module.exports = {
  apps: [
    {
      name: 'Banbot-weaponbet',
      cwd: __dirname,
      script: 'dist/index.js',
      interpreter: '/home/deploy/.nvm/versions/node/v24.21.0/bin/node',
      node_args: '--env-file=.env',
      // SQLite requires one process. Do not use cluster mode or multiple instances.
      exec_mode: 'fork',
      instances: 1,
      autorestart: true,
      watch: false,
      restart_delay: 5000,
      // Allow the application's 15-second shutdown drain to finish.
      kill_timeout: 25000,
      env: {
        NODE_ENV: 'production',
      },
    },
  ],
};
