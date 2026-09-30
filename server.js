// TimesGate web controller: serves the control page and relays commands to the
// Divoom device (which has no CORS headers, so a browser can't call it directly).
// Zero dependencies — needs Node 18+.  Run:  node server.js   (PORT env var optional)

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const engine = require('./engine');
const plugins = require('./plugin-host');
const mic = require('./mic');
const buttons = require('./buttons');

const PORT = Number(process.env.PORT) || 8080;
const PUBLIC_DIR = path.join(__dirname, 'public');
const UPLOAD_DIR = path.join(__dirname, 'uploads');
const CLOUD = 'https://app.divoom-gz.com';
const MAX_BODY = 20 * 1024 * 1024;

fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.gif': 'image/gif', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.md': 'text/plain; charset=utf-8',
};

// Only relay to private LAN addresses so this can't be used as an open proxy.
function isPrivateIp(ip) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip || '');
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

// Pick this PC's IPv4 address on the same subnet as the device, so the device can fetch uploaded GIFs.
function lanAddressFor(deviceIp) {
  const all = Object.values(os.networkInterfaces()).flat()
    .filter(i => i && i.family === 'IPv4' && !i.internal).map(i => i.address);
  const prefix = (deviceIp || '').split('.').slice(0, 3).join('.') + '.';
  return all.find(a => a.startsWith(prefix)) || all[0] || '127.0.0.1';
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', c => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error('Body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sendJson(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

async function relay(url, method, body) {
  const r = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(10000),
  });
  const text = await r.text();
  try { return JSON.parse(text); } catch { return { raw: text }; }
}

const isLoopback = req => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    // Plugins: the manager at /api/plugins/…, and each plugin's own routes at /api/<id>/…
    if (url.pathname === '/api/plugins' || url.pathname.startsWith('/api/plugins/')) return await plugins.manage(req, res, url);
    if (await plugins.route(req, res, url)) return;

    // The microphone: status and level, the device list, and choosing one.
    if (url.pathname === '/api/mic') {
      if (req.method === 'GET') return sendJson(res, 200, mic.status());
      const body = JSON.parse((await readBody(req)).toString() || '{}');
      if ('device' in body) mic.setDevice(body.device);
      if (body.test) {  // listen for a few seconds so the page can show the level
        const off = mic.listen(() => {}, 'test');
        setTimeout(off, Math.min(30, Number(body.test) || 10) * 1000);
      }
      return sendJson(res, 200, mic.status());
    }
    if (req.method === 'GET' && url.pathname === '/api/mic/devices') return sendJson(res, 200, await mic.devices());

    // Button boxes / game controllers (buttons.js): status and which action each input runs.
    if (url.pathname === '/api/buttons') {
      if (req.method === 'GET') return sendJson(res, 200, { ...buttons.status(url.searchParams.has('full')), actions: plugins.actions() });
      const b = JSON.parse((await readBody(req)).toString() || '{}');
      if (b.forget) buttons.forget(b.forget);
      else if ('device' in b) buttons.useDevice(b.device);
      else if (b.input) buttons.setInput(b.input, b);
      return sendJson(res, 200, { ...buttons.status(true), actions: plugins.actions() });
    }

    // Send a command to the device:  { ip, hardware?, payload: { Command: ..., LocalToken, ... } }
    // Hardware revision 402 listens on :9000/divoom_api; everything else (e.g. 400) on :80/post.
    if (req.method === 'POST' && url.pathname === '/api/device') {
      const { ip, hardware, payload } = JSON.parse((await readBody(req)).toString() || '{}');
      if (!isPrivateIp(ip)) return sendJson(res, 400, { error: 'ip must be a private LAN IPv4 address' });
      if (!payload || typeof payload.Command !== 'string') return sendJson(res, 400, { error: 'payload.Command required' });
      // Through the engine, so it knows the device and sees what the page changes (see engine.js).
      engine.learnDevice(ip, hardware, payload.LocalToken);
      return sendJson(res, 200, await engine.send(payload, true));
    }

    // Draw/SendHttpGif ids, shared by the page and the engine so they always increase.
    if (req.method === 'POST' && url.pathname === '/api/picid') return sendJson(res, 200, { id: await engine.nextPicId() });
    if (req.method === 'POST' && url.pathname === '/api/picid/reset') { engine.resetPicId(); return sendJson(res, 200, { ok: true }); }

    // Things that keep running without the page open (engine.js).
    if (url.pathname.startsWith('/api/engine/')) {
      if (req.method === 'GET' && url.pathname === '/api/engine/state') return sendJson(res, 200, engine.state());
      if (req.method !== 'POST') { res.writeHead(405); return res.end(); }
      const body = JSON.parse((await readBody(req)).toString() || '{}');
      switch (url.pathname) {
        case '/api/engine/options': engine.setOptions(body); break;           // { feed: plugin id or null }
        case '/api/engine/send': await engine.sendOnce(body.what); break;     // { what: plugin id }
        case '/api/engine/timer':                                             // { ms, label } or { stop: true }
          if (body.stop) await engine.timerStop(); else engine.timerStart(Number(body.ms), body.label); break;
        case '/api/engine/lightshow':                                         // { bpm, mode, color } or { stop: true }
          if (body.stop) engine.stopLightShow(); else engine.startLightShow(body); break;
        default: res.writeHead(404); return res.end();
      }
      return sendJson(res, 200, engine.state());
    }

    // Divoom cloud helpers (LAN discovery, clock face lists):  POST /api/cloud/<Path>  { method?, body? }
    if (req.method === 'POST' && url.pathname.startsWith('/api/cloud/')) {
      const apiPath = url.pathname.slice('/api/cloud/'.length);
      if (!/^[A-Za-z0-9/]+$/.test(apiPath)) return sendJson(res, 400, { error: 'bad path' });
      const { method = 'POST', body } = JSON.parse((await readBody(req)).toString() || '{}');
      return sendJson(res, 200, await relay(`${CLOUD}/${apiPath}`, method === 'GET' ? 'GET' : 'POST', method === 'GET' ? null : (body || {})));
    }

    // Upload a GIF; returns a URL on this PC that the device can download it from.
    if (req.method === 'POST' && url.pathname === '/api/upload') {
      const ip = url.searchParams.get('ip');
      const buf = await readBody(req);
      if (buf.slice(0, 3).toString() !== 'GIF') return sendJson(res, 400, { error: 'Only GIF files are supported' });
      const name = crypto.randomBytes(6).toString('hex') + '.gif';
      fs.writeFileSync(path.join(UPLOAD_DIR, name), buf);
      return sendJson(res, 200, { url: `http://${lanAddressFor(ip)}:${PORT}/uploads/${name}` });
    }

    // Static files
    if (req.method === 'GET') {
      let file;
      if (url.pathname.startsWith('/uploads/')) file = path.join(UPLOAD_DIR, path.basename(url.pathname));
      else if (url.pathname.startsWith('/plugins/')) file = plugins.publicFile(url.pathname);  // null if not allowed
      else if (url.pathname === '/PLUGINS.md') file = path.join(__dirname, 'PLUGINS.md');
      else {
        file = path.join(PUBLIC_DIR, url.pathname === '/' ? 'index.html' : path.normalize(url.pathname));
        if (!file.startsWith(PUBLIC_DIR)) file = null;
      }
      if (!file) { res.writeHead(404); return res.end('Not found'); }
      return fs.readFile(file, (err, data) => {
        if (err) { res.writeHead(404); return res.end('Not found'); }
        res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
        res.end(data);
      });
    }

    res.writeHead(405); res.end();
  } catch (e) {
    sendJson(res, 502, { error: e.name === 'TimeoutError' ? 'Device did not respond (timeout)' : e.message });
  }
});

plugins.init(engine, { readBody, sendJson, isLoopback, port: PORT });
engine.init(plugins);
buttons.init((id, args) => plugins.runAction(id, args));

server.listen(PORT, () => {
  const lan = Object.values(os.networkInterfaces()).flat()
    .filter(i => i && i.family === 'IPv4' && !i.internal).map(i => `http://${i.address}:${PORT}`);
  console.log(`TimesGate controller running:\n  http://localhost:${PORT}\n  ${lan.join('\n  ')}`);
});
