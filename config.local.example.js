// PhysChat Local Configuration
// Copy this file to config.local.js and fill in your values
// config.local.js is gitignored and will not be committed

const PHYSCHAT_CONFIG = {
  // Your Cloudflare Worker URL (e.g., 'https://physchat-worker.your-subdomain.workers.dev')
  workerUrl: 'https://YOUR_WORKER_NAME.YOUR_SUBDOMAIN.workers.dev',

  // For local development/testing, you can add a token here
  // Leave empty for production (OAuth flow will provide tokens)
  devToken: ''
};
