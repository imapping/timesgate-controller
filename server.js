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

// Requests from this computer count as local: allowed to change setup, tokens and plugins. So do the
// addresses in data/trusted.json { "hosts": ["192.168.1.20"] }, e.g. your PC when the controller runs
// on a Raspberry Pi with no screen (scripts/install-pi.sh adds the computer it's run from).
const TRUSTED_FILE = path.join(__dirname, 'data', 'trusted.json');
let trusted = [];
const loadTrusted = () => { try { trusted = JSON.parse(fs.readFileSync(TRUSTED_FILE, 'utf8')).hosts || []; } catch { trusted = []; } };
loadTrusted();
fs.watchFile(TRUSTED_FILE, { interval: 5000 }, loadTrusted);
// How hard this computer is working, for the page: sampled every 5 seconds.
let sys = { cpu: null, proc: null }, sysLast = null;
function sampleSystem() {
  const t = os.cpus().reduce((a, c) => { const x = c.times; a.idle += x.idle; a.total += x.user + x.nice + x.sys + x.idle + x.irq; return a; }, { idle: 0, total: 0 });
  const now = { ...t, proc: process.cpuUsage(), at: Date.now() };
  if (sysLast && now.total > sysLast.total) {
    sys.cpu = Math.round(100 * (1 - (now.idle - sysLast.idle) / (now.total - sysLast.total)));
    const used = (now.proc.user + now.proc.system - sysLast.proc.user - sysLast.proc.system) / 1000;   // ms of CPU by the controller
    sys.proc = Math.round(100 * used / (now.at - sysLast.at));   // % of one core
  }
  sysLast = now;
}
sampleSystem(); setInterval(sampleSystem, 5000).unref();
function systemStats() {
  let temp = null;
  try { temp = Math.round(Number(fs.readFileSync('/sys/class/thermal/thermal_zone0/temp', 'utf8')) / 100) / 10; } catch {}   // a Pi's CPU temperature
  let free = os.freemem();
  try { free = Number(/MemAvailable:s+(d+)/.exec(fs.readFileSync('/proc/meminfo', 'utf8'))[1]) * 1024; } catch {}   // Linux: free memory, not counting the disk cache
  return { host: os.hostname(), platform: process.platform, cores: os.cpus().length, cpu: sys.cpu, controllerCpu: sys.proc, temp,
    load: Math.round(os.loadavg()[0] * 100) / 100, memTotalMB: Math.round(os.totalmem() / 1048576), memUsedMB: Math.round((os.totalmem() - free) / 1048576),
    controllerMB: Math.round(process.memoryUsage().rss / 1048576), uptimeS: Math.round(os.uptime()), runningS: Math.round(process.uptime()), node: process.version };
}

const isLoopback = req => {
  const a = String(req.socket.remoteAddress).replace(/^::ffff:/, '');
  return a === '127.0.0.1' || a === '::1' || trusted.includes(a);
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    // Plugins: the manager at /api/plugins/…, and each plugin's own routes at /api/<id>/…
    if (url.pathname === '/api/plugins' || url.pathname.startsWith('/api/plugins/')) return await plugins.manage(req, res, url);
    if (await plugins.route(req, res, url)) return;

    if (req.method === 'GET' && url.pathname === '/api/system') return sendJson(res, 200, systemStats());

    // The microphone: status and level, the device list, and choosing one.
    if (url.pathname === '/api/mic') {
      if (req.method === 'GET') return sendJson(res, 200, { ...mic.status(), local: isLoopback(req) });
      const body = JSON.parse((await readBody(req)).toString() || '{}');
      if ('device' in body) mic.setDevice(body.device);
      if (typeof body.shared === 'boolean') {   // let any device on the network listen live (a direct connection, not a room mic)
        if (!isLoopback(req)) return sendJson(res, 403, { error: 'Change who can listen from the computer running the controller, or one it trusts.' });
        mic.setShared(body.shared);
      }
      if (body.test) {  // listen for a few seconds so the page can show the level
        const off = mic.listen(() => {}, 'test');
        setTimeout(off, Math.min(30, Number(body.test) || 10) * 1000);
      }
      return sendJson(res, 200, { ...mic.status(), local: isLoopback(req) });
    }
    if (req.method === 'GET' && url.pathname === '/api/mic/devices') return sendJson(res, 200, await mic.devices());
    // Listen to the input live (a never-ending WAV). A room microphone is private: only this computer
    // or a trusted one. An input marked as a direct connection (a turntable or line-in) is for everyone
    // on the network.
    if (req.method === 'GET' && url.pathname === '/api/mic/stream') {
      if (!isLoopback(req) && !mic.isShared()) return sendJson(res, 403, { error: 'Live listening only works from the computer running the controller, or one it trusts (unless the input is marked as a direct connection in the Microphone card).' });
      return mic.stream(req, res, url.searchParams.has('hq'));   // ?hq: 44.1 kHz stereo
    }

    // Button boxes / game controllers (buttons.js): status and which action each input runs.
    if (url.pathname === '/api/buttons') {
      const extra = () => ({ actions: [buttons.SWITCH_ACTION, ...plugins.actions()], units: engine.units() });
      if (req.method === 'GET') return sendJson(res, 200, { ...buttons.status(url.searchParams.has('full')), ...extra() });
      const b = JSON.parse((await readBody(req)).toString() || '{}');
      if (b.forget) buttons.forget(b.forget);
      else if ('device' in b) buttons.useDevice(b.device);
      else if (b.input) buttons.setInput(b.input, b);
      else buttons.setOptions(b);   // { selected, switchBeep, switchFlash }
      return sendJson(res, 200, { ...buttons.status(true), ...extra() });
    }

    // Send a command to a device:  { unit?, ip, hardware?, payload: { Command: ..., LocalToken, ... } }
    // Hardware revision 402 listens on :9000/divoom_api; everything else (e.g. 400) on :80/post.
    if (req.method === 'POST' && url.pathname === '/api/device') {
      const { unit, ip, hardware, payload } = JSON.parse((await readBody(req)).toString() || '{}');
      if (!isPrivateIp(ip)) return sendJson(res, 400, { error: 'ip must be a private LAN IPv4 address' });
      if (!payload || typeof payload.Command !== 'string') return sendJson(res, 400, { error: 'payload.Command required' });
      // Through the engine, so it knows the device and sees what the page changes (see engine.js).
      const u = engine.learnDevice(unit, ip, hardware, payload.LocalToken);
      return sendJson(res, 200, await u.send(payload, true));
    }

    // The Times Gates: list, add { add: { name, ip, hardware, deviceId } }, change { id, name?, alerts?, deviceId? },
    // remove { remove: id }.
    if (url.pathname === '/api/units') {
      if (req.method === 'POST') {
        const b = JSON.parse((await readBody(req)).toString() || '{}');
        if (b.add) {
          if (b.add.ip && !isPrivateIp(b.add.ip)) return sendJson(res, 400, { error: 'ip must be a private LAN IPv4 address' });
          const u = engine.addUnit(b.add);
          return sendJson(res, 200, { unit: u.id, units: engine.units() });
        }
        if (b.remove) engine.removeUnit(b.remove);
        else if (b.id) engine.updateUnit(b.id, b);
      }
      return sendJson(res, 200, { units: engine.units() });
    }

    // Draw/SendHttpGif ids, shared by the page and the engine so they always increase (one counter per unit).
    if (req.method === 'POST' && url.pathname.startsWith('/api/picid')) {
      const { unit } = JSON.parse((await readBody(req)).toString() || '{}');
      const u = engine.unit(unit);
      if (url.pathname === '/api/picid') return sendJson(res, 200, { id: await u.nextPicId() });
      if (url.pathname === '/api/picid/reset') { u.resetPicId(); return sendJson(res, 200, { ok: true }); }
    }

    // Things that keep running without the page open (engine.js). Each is for one unit ({ unit }, or the first).
    if (url.pathname.startsWith('/api/engine/')) {
      if (req.method === 'GET' && url.pathname === '/api/engine/state') return sendJson(res, 200, engine.state(url.searchParams.get('unit')));
      if (req.method !== 'POST') { res.writeHead(405); return res.end(); }
      const body = JSON.parse((await readBody(req)).toString() || '{}');
      const u = engine.unit(body.unit);
      switch (url.pathname) {
        case '/api/engine/options': engine.setOptions(u.id, body); break;     // { feed: plugin id or null }
        case '/api/engine/send': await u.sendOnce(body.what); break;          // { what: plugin id }
        case '/api/engine/timer':                                             // { ms, label } or { stop: true }
          if (body.stop) await u.timerStop(); else u.timerStart(Number(body.ms), body.label); break;
        case '/api/engine/lightshow':                                         // { bpm, mode, color } or { stop: true }
          if (body.stop) u.stopLightShow(); else u.startLightShow(body); break;
        default: res.writeHead(404); return res.end();
      }
      return sendJson(res, 200, engine.state(u.id));
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
    sendJson(res, e.status || 502, { error: e.name === 'TimeoutError' ? 'Device did not respond (timeout)' : e.message });
  }
});

plugins.init(engine, { readBody, sendJson, isLoopback, port: PORT });
engine.init(plugins);
buttons.init((id, args) => plugins.runAction(id, args), engine);

server.listen(PORT, () => {
  const lan = Object.values(os.networkInterfaces()).flat()
    .filter(i => i && i.family === 'IPv4' && !i.internal).map(i => `http://${i.address}:${PORT}`);
  console.log(`TimesGate controller running:\n  http://localhost:${PORT}\n  ${lan.join('\n  ')}`);
});
