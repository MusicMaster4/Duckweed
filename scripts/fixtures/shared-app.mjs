// Synthetic app for the opt-in public-browser test. Never serves project files.
import http from "node:http";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";

const listen = (server) => new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const backend = http.createServer(async (request, response) => {
  if (request.url === "/events") {
    response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
    response.write("data: live\n\n");
    return;
  }
  if (request.url === "/login") {
    response.writeHead(302, { Location: `http://localhost:${backend.address().port}/session`, "Set-Cookie": "session=ok; Domain=localhost; Path=/; HttpOnly" });
    response.end();
    return;
  }
  if (request.url === "/session") {
    response.end(request.headers.cookie?.includes("session=ok") ? "session-ok" : "missing-cookie");
    return;
  }
  if (request.url === "/upload") {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    response.end(Buffer.concat(chunks));
    return;
  }
  if (request.url === "/cors") {
    response.end(request.headers.origin === `http://localhost:${frontend.address().port}` ? "origin-ok" : `wrong-origin:${request.headers.origin}`);
    return;
  }
  response.setHeader("Content-Type", "application/json");
  response.end('{"ok":true}');
});
backend.on("upgrade", (request, socket) => {
  const accept = createHash("sha1").update(request.headers["sec-websocket-key"] + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  socket.on("data", bytes => (bytes[0] & 15) === 8
    ? socket.end(Buffer.from([0x88, 0]))
    : socket.write(Buffer.from([0x81, 2, 111, 107])));
  socket.on("error", () => {});
});
await listen(backend);

const frontend = http.createServer((request, response) => {
  if (request.url === "/wait.svg") {
    // Keep the load event pending while real network callbacks complete.
    // Virtual browser time can jump past WebSocket/SSE events immediately.
    setTimeout(() => {
      response.setHeader("Content-Type", "image/svg+xml");
      response.end('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>');
    }, 12000);
    return;
  }
  if (request.url === "/asset.js") {
    response.setHeader("Content-Type", "text/javascript");
    response.end("window.assetLoaded = true;");
    return;
  }
  const api = `http://localhost:${backend.address().port}`;
  const html = `<!doctype html><html lang="en"><head><title>Sharing test</title>
  <script src="http://localhost:${frontend.address().port}/asset.js"></script></head>
  <body><img hidden src="/wait.svg"><p id="result">Testing</p><script>
  const api = ${JSON.stringify(api)};
  const pending = ['fetch', 'upload', 'origin', 'cookies', 'XHR', 'SSE', 'WebSocket'];
  const timeout = setTimeout(() => { document.querySelector('#result').textContent = 'FAIL: timeout ' + pending.join(','); }, 20000);
  Promise.all([
    fetch(api + '/api').then(r => r.json()).then(r => { if (!r.ok) throw Error('fetch'); }),
    fetch(api + '/upload', { method: 'POST', body: 'upload-ok' }).then(r => r.text()).then(r => { if (r !== 'upload-ok') throw Error('upload'); }),
    fetch(api + '/cors', { method: 'POST' }).then(r => r.text()).then(r => { if (r !== 'origin-ok') throw Error(r); }),
    fetch(api + '/login', { credentials: 'include' }).then(r => r.text()).then(r => { if (r !== 'session-ok') throw Error('cookie redirect'); }),
    new Promise((resolve, reject) => { const xhr = new XMLHttpRequest(); xhr.open('GET', api + '/api'); xhr.onload = () => xhr.status === 200 ? resolve() : reject(Error('XHR')); xhr.onerror = reject; xhr.send(); }),
    new Promise((resolve, reject) => { const events = new EventSource(api + '/events'); events.onmessage = e => { events.close(); e.data === 'live' ? resolve() : reject(Error('SSE')); }; events.onerror = () => { events.close(); reject(Error('SSE')); }; }),
    new Promise((resolve, reject) => { const ws = new WebSocket(api.replace('http:', 'ws:') + '/socket'); ws.onopen = () => ws.send('ping'); ws.onmessage = e => { ws.close(); e.data === 'ok' ? resolve() : reject(Error('WebSocket')); }; ws.onerror = () => reject(Error('WebSocket')); }),
  ].map((promise, index) => { const name = pending[index]; return promise.then(() => {
    pending.splice(pending.indexOf(name), 1);
    document.querySelector('#result').textContent = 'Pending: ' + pending.join(',');
  }); })).then(() => {
    if (!window.assetLoaded) throw Error('asset');
    if (document.compatMode !== 'CSS1Compat') throw Error('doctype');
    clearTimeout(timeout); document.querySelector('#result').textContent = 'PASS: fetch upload origin cookies XHR SSE WebSocket assets doctype';
  }).catch(error => { clearTimeout(timeout); document.querySelector('#result').textContent = 'FAIL: ' + error; });
  </script></body></html>`;
  response.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8", "Content-Encoding": "gzip",
    "Content-Security-Policy": "default-src 'self'; script-src 'self' 'unsafe-inline'; connect-src 'self' http://localhost:" + backend.address().port + " ws://localhost:" + backend.address().port,
  });
  response.end(gzipSync(html));
});
await listen(frontend);
process.stdout.write(JSON.stringify({ frontend: frontend.address().port, backend: backend.address().port }) + "\n");
