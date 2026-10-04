// Reverse proxy that injects the WebGPU Spector hook into any page, so it can be tested in a
// browser without the extension installed (e.g. an embedded browser):
//
//   node tools/inject-proxy.mjs http://localhost:1234 [port]
//
// HTML responses get dist/hook.js + dist/devbridge.js as the first scripts in <head>;
// everything else (including websockets for HMR) is passed through.
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const target = new URL(process.argv[2] ?? 'http://localhost:1234');
const port = Number(process.argv[3] ?? process.env.PORT ?? 5190);
const dist = path.resolve('dist');
const INJECT = '<script src="/__wgs/hook.js"></script><script src="/__wgs/devbridge.js"></script>';

function inject(html)
{
  const m = html.match(/<head[^>]*>/i);
  if (m) return html.replace(m[0], m[0] + INJECT);
  return INJECT + html;
}

const server = http.createServer((req, res) =>
{
  if (req.url.startsWith('/__wgs/'))
  {
    const file = path.join(dist, req.url.slice(7).split('?')[0]);
    if (!file.startsWith(dist) || !fs.existsSync(file)) { res.writeHead(404); res.end(); return; }
    const type = file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.html') ? 'text/html' : file.endsWith('.png') ? 'image/png' : 'application/octet-stream';
    res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' });
    fs.createReadStream(file).pipe(res);
    return;
  }

  const headers = { ...req.headers, host: target.host };
  delete headers['accept-encoding'];
  const up = http.request({ hostname: target.hostname, port: target.port, path: req.url, method: req.method, headers }, (ur) =>
  {
    const type = ur.headers['content-type'] ?? '';
    if (!type.includes('text/html'))
    {
      res.writeHead(ur.statusCode ?? 502, ur.headers);
      ur.pipe(res);
      return;
    }
    const chunks = [];
    ur.on('data', (c) => chunks.push(c));
    ur.on('end', () =>
    {
      let body = Buffer.concat(chunks);
      const enc = ur.headers['content-encoding'];
      if (enc === 'gzip') body = zlib.gunzipSync(body);
      else if (enc === 'br') body = zlib.brotliDecompressSync(body);
      const out = Buffer.from(inject(body.toString('utf8')));
      const h = { ...ur.headers, 'content-length': out.length };
      delete h['content-encoding'];
      delete h['content-security-policy'];
      res.writeHead(ur.statusCode ?? 200, h);
      res.end(out);
    });
  });
  up.on('error', (e) => { res.writeHead(502); res.end(`proxy error: ${e.message}`); });
  req.pipe(up);
});

// Websockets (Vite HMR): raw passthrough.
server.on('upgrade', (req, socket, head) =>
{
  const up = net.connect(Number(target.port || 80), target.hostname, () =>
  {
    let raw = `${req.method} ${req.url} HTTP/${req.httpVersion}\r\n`;
    for (let i = 0; i < req.rawHeaders.length; i += 2)
    {
      const k = req.rawHeaders[i];
      raw += `${k}: ${k.toLowerCase() === 'host' ? target.host : req.rawHeaders[i + 1]}\r\n`;
    }
    up.write(raw + '\r\n');
    if (head?.length) up.write(head);
    up.pipe(socket);
    socket.pipe(up);
  });
  up.on('error', () => socket.destroy());
  socket.on('error', () => up.destroy());
});

server.listen(port, () => console.log(`WebGPU Spector inject proxy: http://localhost:${port} -> ${target.href}`));
