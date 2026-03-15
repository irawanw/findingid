// PM2 configuration for finding.id backend
// Usage:
//   pm2 start ecosystem.config.js --env production
//   pm2 scale findingid 4  (horizontal scaling)
module.exports = {
  apps: [
    {
      name:         'findingid',
      script:       'server.js',
      cwd:          __dirname,
      instances:    2,             // 2 workers — leave cores for vLLM/RAG
      exec_mode:    'cluster',     // PM2 cluster mode (stateless Node.js)
      watch:        false,
      max_memory_restart: '512M',
      env: {
        NODE_ENV: 'development',
        PORT:     3002,
      },
      env_production: {
        NODE_ENV: 'production',
        PORT:     3002,
      },
      error_file:  '/data/www/findingid/logs/error.log',
      out_file:    '/data/www/findingid/logs/out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    },
    {
      name:         'findingid-admin',
      script:       'node_modules/.bin/next',
      args:         'start -p 3191',
      cwd:          '/data/www/findingid/admin',
      instances:    1,
      exec_mode:    'fork',
      watch:        false,
      max_memory_restart: '512M',
      env: {
        NODE_ENV: 'production',
        PORT:     3191,
      },
      error_file:  '/data/www/findingid/logs/admin-error.log',
      out_file:    '/data/www/findingid/logs/admin-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    },
    {
      name:         'shortvideo-render',
      script:       '../tools/shortvideo_render_worker.js',
      cwd:          __dirname,
      instances:    1,
      exec_mode:    'fork',
      watch:        false,
      max_memory_restart: '1G',
      env_production: { NODE_ENV: 'production' },
      error_file:  '/data/www/findingid/logs/shortvideo-error.log',
      out_file:    '/data/www/findingid/logs/shortvideo-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    },
  ],
};
