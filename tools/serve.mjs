#!/usr/bin/env node
/**
 * serve.mjs - Tiny static file server for local tests (no dependencies).
 *
 *   node tools/serve.mjs [port]        serves the repository root (default port 8765)
 *
 * Also importable: `const { server, port, close } = await startServer({ root, port })`
 * (port 0 = any free port).
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
};

export function startServer(opts) {
  const root = path.resolve((opts && opts.root) || REPO_ROOT);
  const wantPort = (opts && opts.port !== undefined) ? opts.port : 8765;
  const server = http.createServer((req, res) => {
    let rel;
    try {
      rel = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    } catch (e) {
      res.writeHead(400); res.end('Bad request'); return;
    }
    let file = path.resolve(root, '.' + rel);
    if (file !== root && !file.startsWith(root + path.sep)) {
      res.writeHead(403); res.end('Forbidden'); return;
    }
    fs.stat(file, (err, st) => {
      if (!err && st.isDirectory()) {
        file = path.join(file, 'index.html');
      }
      fs.readFile(file, (err2, data) => {
        if (err2) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('Not found'); return; }
        const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
        res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
        res.end(data);
      });
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(wantPort, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({ server, port, close: () => new Promise(r => server.close(() => r())) });
    });
  });
}

// Run directly: node tools/serve.mjs [port]
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const port = parseInt(process.argv[2], 10);
  startServer({ port: isNaN(port) ? 8765 : port }).then(({ port: p }) => {
    console.log('Serving ' + REPO_ROOT + ' at http://127.0.0.1:' + p + '/');
  }, (e) => {
    console.error('Could not start the server: ' + e.message);
    process.exit(1);
  });
}
