'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

// Load .env if present locally
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx > 0) {
      const key = trimmed.slice(0, eqIdx).trim();
      const val = trimmed.slice(eqIdx + 1).trim().replace(/^['"]|['"]$/g, '');
      if (process.env[key] === undefined) {
        process.env[key] = val;
      }
    }
  }
}

const { handleRequest } = require('./lib/app');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
};

const publicDir = path.join(__dirname, 'public');

const server = http.createServer(async (req, res) => {
  const handled = await handleRequest(req, res);
  if (handled !== false || res.writableEnded) return;

  // Serve static files from public/
  const urlObj = new URL(req.url || '/', 'http://localhost');
  let reqPath = decodeURIComponent(urlObj.pathname);
  if (reqPath === '/') reqPath = '/index.html';

  const safePath = path.normalize(path.join(publicDir, reqPath));
  if (!safePath.startsWith(publicDir)) {
    res.statusCode = 403;
    return res.end('Forbidden');
  }

  if (fs.existsSync(safePath) && fs.statSync(safePath).isFile()) {
    const ext = path.extname(safePath).toLowerCase();
    res.statusCode = 200;
    res.setHeader('Content-Type', MIME_TYPES[ext] || 'application/octet-stream');
    fs.createReadStream(safePath).pipe(res);
    return;
  }

  res.statusCode = 404;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify({ message: `Route ${req.method}:${urlObj.pathname} not found`, statusCode: 404 }));
});

if (require.main === module) {
  const port = Number(process.env.PORT) || 3000;
  server.listen(port, () => {
    console.log(`BitChord Private Hi-Res Addon running at http://localhost:${port}`);
    console.log(`Manifest URL: http://localhost:${port}/manifest.json`);
  });
}

module.exports = server;
