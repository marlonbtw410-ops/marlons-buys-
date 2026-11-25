// Load settings from .env (built into Node 20.12+).
const path = require('path');
try { process.loadEnvFile(path.join(__dirname, '..', '.env')); } catch {}
