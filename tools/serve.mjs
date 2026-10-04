// Static file server for the test scenes and the dev harness (no dependencies).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(process.argv[2] ?? '.');
const port = Number(process.env.PORT ?? 5180);
const types = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml', '.map': 'application/json', '.wasm': 'application/wasm'
};

http.createServer((req, res) =>
{
  const url = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  let file = path.join(root, url);
  if (!file.startsWith(root)) { res.writeHead(403); res.end(); return; }
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
  fs.readFile(file, (err, data) =>
  {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'content-type': types[path.extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(data);
  });
}).listen(port, () => console.log(`serving ${root} on http://localhost:${port}`));
