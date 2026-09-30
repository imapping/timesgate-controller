// Plugins: each folder in plugins/ adds a feature (Weather, Spotify, Claude status, …). This file
// loads them, gives each one its toolkit (`tg`), mounts its HTTP routes at /api/<id>/, serves its
// page files at /plugins/<id>/, and installs, enables or removes plugins from the web page.
// How to write one: PLUGINS.md.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const { createCanvas, loadImage, GlobalFonts } = require('@napi-rs/canvas');
const mic = require('./mic');
globalThis.makeCanvas = (w, h) => createCanvas(w, h);

// Screens use `system-ui, "Segoe UI", sans-serif`. Linux (a Raspberry Pi) has no Segoe UI, so use Noto
// Sans (installed by scripts/install-pi.sh), or else DejaVu Sans, under those names.
if (process.platform !== 'win32' && !GlobalFonts.has('Segoe UI')) {
  for (const dir of ['/usr/share/fonts/truetype/noto', '/usr/share/fonts/truetype/dejavu']) {
    let files = [];
    try { files = fs.readdirSync(dir).filter(f => /^(NotoSans|DejaVuSans)(-(Regular|Medium|SemiBold|Bold|ExtraBold|Black))?\.ttf$/.test(f)); } catch {}
    for (const f of files) for (const name of ['Segoe UI', 'system-ui']) GlobalFonts.registerFromPath(path.join(dir, f), name);
    if (files.length) break;
  }
}

const PLUGIN_DIR = path.join(__dirname, 'plugins');
const DATA_DIR = path.join(__dirname, 'data');
const CONF_FILE = path.join(DATA_DIR, 'plugins.json');
const ID_RE = /^[a-z0-9][a-z0-9-]{1,31}$/;
// /api/<id>/ routes that belong to the server itself.
const RESERVED = new Set(['device', 'engine', 'picid', 'cloud', 'upload', 'uploads', 'plugins', 'actions', 'mic', 'buttons', 'core']);
const MAX_ZIP = 20 * 1024 * 1024, MAX_UNZIPPED = 50 * 1024 * 1024;

fs.mkdirSync(PLUGIN_DIR, { recursive: true });
fs.mkdirSync(DATA_DIR, { recursive: true });
let conf = { disabled: [], pin: null };  // pin: { salt, hash } — lets other devices install/remove
try { conf = { ...conf, ...JSON.parse(fs.readFileSync(CONF_FILE, 'utf8')) }; } catch {}
const saveConf = () => fs.writeFileSync(CONF_FILE, JSON.stringify(conf, null, 2));

const log = (...a) => console.log(new Date().toLocaleTimeString(), ...a);
const readJson = (f, fallback) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return fallback; } };

const plugins = new Map();  // id -> { id, dir, manifest, enabled, impl, tg, timers, pollTimer, error }
let engine = null, deps = null;

// ---------- the toolkit each plugin's server.js gets ----------
function makeToolkit(rec) {
  const id = rec.id, dataFile = path.join(DATA_DIR, id + '.json');
  const track = t => { rec.timers.add(t); return t; };
  const guard = fn => async () => { try { await fn(); } catch (e) { tg.log('Error:', e.message); } };
  const tg = {
    id, dir: rec.dir,
    port: deps.port,                                 // this server's port (e.g. for OAuth redirect URLs)
    log: (...a) => log(`[${id}]`, ...a),
    // Saved settings/data, kept in data/<id>.json. Change tg.settings, then call tg.save().
    settings: readJson(dataFile, {}),
    save: () => fs.writeFileSync(dataFile, JSON.stringify(tg.settings, null, 2)),
    // Screens. `unit` is a Times Gate's id (from ctx.unit / args.unit); leave it out for the first one.
    units: () => engine.units(),                     // [{ id, name, ip, feed, … }]
    liveUnits: () => engine.liveUnits(id),           // ids of the units keeping this plugin updated
    isLive: unit => unit ? engine.liveUnits(id).includes(unit) : engine.liveUnits(id).length > 0,
    update: () => engine.feedChanged(id),            // redraw on every unit showing it (only changed screens are re-sent)
    show: unit => engine.unit(unit).sendOnce(id),    // show once now
    // Start keeping it updated on a unit; stop on that unit, or (no unit) everywhere.
    setLive(on, unit) {
      if (on) return engine.setOptions(unit, { feed: id });
      for (const u of unit ? [unit] : engine.liveUnits(id)) if (engine.liveUnits(id).includes(u)) engine.setOptions(u, { feed: null });
    },
    // Timers that are cleared when the plugin is disabled or removed
    every: (ms, fn) => track(setInterval(guard(fn), ms)),
    after: (ms, fn) => { const t = track(setTimeout(() => { rec.timers.delete(t); guard(fn)(); }, ms)); return t; },
    clear: t => { clearTimeout(t); rec.timers.delete(t); },
    // Drawing (the same calls work in the page, where makeCanvas is also global)
    makeCanvas: (w, h) => createCanvas(w, h),
    async loadImage(src) {
      if (typeof src === 'string' && /^https?:/.test(src)) {
        const r = await fetch(src, { signal: AbortSignal.timeout(15000) });
        if (!r.ok) throw new Error(`Image download failed (${r.status})`);
        src = Buffer.from(await r.arrayBuffer());
      }
      return loadImage(src);
    },
    // The device
    // The devices. `unit`: one id, 'all', or left out (send: all units; alerts: units with alerts on).
    device: {
      send: (payload, unit) => engine.sendTo(payload, unit),        // any Divoom API command; resolves to the first reply
      beep: (opts, unit) => engine.beep(opts, unit),                // { on, off, total } in ms
      edgeRainbow: (ms, unit) => engine.edgeAlert(ms, unit),        // rainbow edge light, then back to how it was
      stopLightShow: unit => engine.stopLightShow(unit),            // before driving the lights yourself
    },
    // The microphone (runs only while something listens or records)
    mic: {
      listen(fn, opts) {
        const off = mic.listen(fn, id, opts);
        const stop = () => { off(); rec.cleanups.delete(stop); };
        rec.cleanups.add(stop);
        return stop;
      },
      record: ms => mic.record(ms),
      status: () => mic.status(),
    },
  };
  return tg;
}

// ---------- loading ----------
function load(folder) {
  const dir = path.join(PLUGIN_DIR, folder);
  const manifest = readJson(path.join(dir, 'plugin.json'), null);
  if (!manifest) return null;
  const id = manifest.id;
  if (!ID_RE.test(id || '') || RESERVED.has(id) || id !== folder) {
    log(`Plugin in plugins/${folder} skipped: its id must match the folder name (lowercase letters, digits, dashes).`);
    return null;
  }
  const rec = { id, dir, manifest, enabled: !conf.disabled.includes(id), impl: {}, tg: null, timers: new Set(), cleanups: new Set(), pollTimer: null, error: null };
  plugins.set(id, rec);
  if (rec.enabled) start(rec);
  return rec;
}

function start(rec) {
  rec.error = null;
  rec.tg = makeToolkit(rec);
  const file = path.join(rec.dir, rec.manifest.server || 'server.js');
  if (!fs.existsSync(file)) { rec.impl = {}; return; }
  try {
    const mod = require(file);
    rec.impl = (typeof mod === 'function' ? mod(rec.tg) : mod) || {};
    log(`Plugin ${rec.id} ${rec.manifest.version || ''} loaded.`);
  } catch (e) {
    rec.impl = {}; rec.error = e.message;
    log(`Plugin ${rec.id} failed to load:`, e.stack || e.message);
  }
}

function unload(rec) {
  engine.stopFeedEverywhere(rec.id);
  live(rec.id, false);
  try { rec.impl.stop?.(); } catch (e) { log(`Plugin ${rec.id} stop():`, e.message); }
  rec.timers.forEach(t => clearTimeout(t)); rec.timers.clear();
  [...rec.cleanups].forEach(fn => fn());
  for (const k of Object.keys(require.cache)) if (k.startsWith(rec.dir + path.sep)) delete require.cache[k];
  rec.impl = {};
}

// ---------- what the engine asks ----------
const active = id => { const r = plugins.get(id); return r && r.enabled && !r.error ? r : null; };
const hasFeed = id => !!active(id)?.impl.render;
async function render(id, unit) {
  const r = active(id);
  if (!r?.impl.render) throw new Error(`No plugin "${id}" to show`);
  return r.impl.render(unit);
}
// Called by the engine when a plugin starts being kept updated on some unit (on), or on none any
// more (off). Repeats are ignored, so live() and poll only run on the change.
function live(id, on) {
  const r = plugins.get(id);
  if (!r || !!r.isLive === !!on) return;
  r.isLive = !!on;
  clearInterval(r.pollTimer); r.pollTimer = null;
  if (on && !active(id)) { r.isLive = false; return; }
  const poll = r.impl.poll;
  if (on && poll?.every && poll.run) {
    r.pollTimer = setInterval(async () => { try { await poll.run(); } catch (e) { r.tg.log('Error:', e.message); } }, Math.max(1000, poll.every));
  }
  try { r.impl.live?.(on); } catch (e) { r.tg?.log('live():', e.message); }
}
// The page changed the lights or started the light show: plugins driving the lights should stop.
function pageCommand(payload, unit) {
  for (const r of plugins.values()) {
    if (!active(r.id) || !r.impl.pageCommand) continue;
    try { r.impl.pageCommand(payload, unit); } catch (e) { r.tg.log('pageCommand():', e.message); }
  }
}

function states(unit) {
  const out = {};
  for (const r of plugins.values()) {
    if (!active(r.id)) continue;
    try { out[r.id] = r.impl.state?.(unit) || {}; } catch (e) { out[r.id] = { error: e.message }; }
  }
  return out;
}

// ---------- HTTP ----------
// Plugin routes: /api/<id>/<path>. Returns false if the URL isn't a plugin's.
async function route(req, res, url) {
  const m = /^\/api\/([a-z0-9-]+)(\/.*)?$/.exec(url.pathname);
  if (!m || RESERVED.has(m[1]) || !plugins.has(m[1])) return false;
  const r = active(m[1]);
  if (!r) { deps.sendJson(res, 404, { error: `The ${m[1]} plugin is turned off.` }); return true; }
  const handler = (r.impl.routes || {})[`${req.method} ${m[2] || '/'}`];
  if (!handler) { deps.sendJson(res, 404, { error: 'Not found' }); return true; }
  const raw = req.method === 'GET' || req.method === 'HEAD' ? null : await deps.readBody(req);
  let body = {};
  if (raw && raw.length) { try { body = JSON.parse(raw.toString()); } catch { body = null; } }
  try {
    // ctx.unit: the Times Gate the page has selected (X-TG-Unit header, or ?unit=)
    const unit = req.headers['x-tg-unit'] || url.searchParams.get('unit') || undefined;
    const out = await handler({ req, res, url, query: url.searchParams, body, raw, local: deps.isLoopback(req), unit });
    if (res.headersSent || res.writableEnded) return true;
    if (out === undefined || out === null) { res.writeHead(204); res.end(); }
    else deps.sendJson(res, 200, out);
  } catch (e) {
    if (!res.headersSent) deps.sendJson(res, e.status || 500, { error: e.message });
    else res.end();
  }
  return true;
}

// Page files: /plugins/<id>/<file> comes from plugins/<id>/public/<file>. Returns a path or null.
function publicFile(urlPath) {
  const m = /^\/plugins\/([a-z0-9-]+)\/(.+)$/.exec(urlPath);
  if (!m || !active(m[1])) return null;
  const base = path.join(plugins.get(m[1]).dir, 'public');
  const file = path.join(base, path.normalize(decodeURIComponent(m[2])));
  return file.startsWith(base + path.sep) ? file : null;
}

function info(r) {
  const m = r.manifest;
  return { id: r.id, name: m.name || r.id, version: m.version || '', description: m.description || '', author: m.author || '',
    enabled: r.enabled, error: r.error, feed: !!r.impl.render, readme: fs.existsSync(path.join(r.dir, 'README.md')), panel: m.panel || null, scripts: m.scripts || [],
    liveLabel: m.liveLabel || null, order: m.order ?? 100 };
}
function list() {
  return [...plugins.values()].map(info).sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));
}

// ---------- actions (for buttons, scenes and other plugins) ----------
// Plugins that can be kept updated on the screens, in page order (for "next / previous feature").
const feedIds = () => list().filter(p => p.enabled && !p.error && p.feed).map(p => p.id);

function actions() {
  const out = engine.coreActions();
  for (const r of plugins.values()) {
    if (!active(r.id)) continue;
    const name = r.manifest.name || r.id;
    if (r.impl.render) {
      out.push({ id: `${r.id}.show`, plugin: r.id, label: `${name}: show` });
      out.push({ id: `${r.id}.live`, plugin: r.id, label: `${name}: keep updated on/off` });
    }
    for (const [k, a] of Object.entries(r.impl.actions || {})) out.push({ id: `${r.id}.${k}`, plugin: r.id, label: `${name}: ${a.label || k}` });
  }
  return out;
}
// args.unit: the Times Gate to act on (an id, or 'all'); left out = the first one.
async function runAction(fullId, args = {}) {
  const [id, name] = String(fullId).split('.');
  if (id === 'core') return engine.runCoreAction(fullId, args.unit);
  const r = active(id);
  if (!r) throw Object.assign(new Error(`No plugin "${id}"`), { status: 404 });
  if (name === 'show' || name === 'live') {
    const units = args.unit === 'all' ? engine.units().map(u => u.id) : [engine.unit(args.unit).id];
    if (name === 'show' && r.impl.render) return Promise.all(units.map(u => r.tg.show(u)));
    if (name === 'live' && r.impl.render) {
      const on = args.on ?? !units.some(u => r.tg.isLive(u));  // toggle
      return units.forEach(u => r.tg.setLive(on, u));
    }
  }
  const a = (r.impl.actions || {})[name];
  if (!a) throw Object.assign(new Error(`No action "${fullId}"`), { status: 404 });
  return a.run(args);
}

// ---------- install / remove (from this computer or a trusted one, or with the PIN) ----------
const hashPin = (pin, salt) => crypto.scryptSync(String(pin), salt, 32).toString('hex');
function setPin(pin) {
  if (!pin) { conf.pin = null; saveConf(); return; }
  if (!/^\d{4,12}$/.test(String(pin))) throw Object.assign(new Error('The PIN must be 4–12 digits.'), { status: 400 });
  const salt = crypto.randomBytes(12).toString('hex');
  conf.pin = { salt, hash: hashPin(pin, salt) }; saveConf();
}
async function allowedToManage(req) {
  if (deps.isLoopback(req)) return true;
  const pin = req.headers['x-tg-pin'];
  if (conf.pin && pin && crypto.timingSafeEqual(Buffer.from(hashPin(pin, conf.pin.salt), 'hex'), Buffer.from(conf.pin.hash, 'hex'))) return true;
  await new Promise(r => setTimeout(r, 1000));  // slow down guessing
  return false;
}

function setEnabled(id, on) {
  const r = plugins.get(id);
  if (!r) throw Object.assign(new Error(`No plugin "${id}"`), { status: 404 });
  if (r.enabled === !!on) return;
  r.enabled = !!on;
  conf.disabled = conf.disabled.filter(x => x !== id).concat(on ? [] : [id]); saveConf();
  if (on) start(r); else unload(r);
}

// A minimal .zip reader (stored and deflated entries), so installing needs no extra packages.
function readZip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('That is not a .zip file.');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16), total = 0;
  const files = [];
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('The .zip file is damaged.');
    const method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20), size = buf.readUInt32LE(p + 24);
    const nlen = buf.readUInt16LE(p + 28), elen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nlen).replace(/\\/g, '/');
    p += 46 + nlen + elen + clen;
    if (name.endsWith('/')) continue;
    if ((total += size) > MAX_UNZIPPED) throw new Error('The plugin is too big.');
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(start, start + csize);
    if (method === 0) files.push({ name, data: raw });
    else if (method === 8) files.push({ name, data: zlib.inflateRawSync(raw, { maxOutputLength: Math.max(1, size) }) });
    else throw new Error(`Unsupported compression in ${name}.`);
  }
  return files;
}

// github.com/owner/repo[/tree/branch/sub/folder] → zip download URLs (+ the folder inside it)
function githubSource(u) {
  const m = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:\/tree\/([^/]+)(\/.*)?)?\/?$/.exec(u);
  if (!m) return null;
  const branches = m[3] ? [m[3]] : ['main', 'master'];
  return { urls: branches.map(b => `https://codeload.github.com/${m[1]}/${m[2]}/zip/refs/heads/${b}`), sub: (m[4] || '').replace(/^\/+|\/+$/g, '') };
}
async function download(u) {
  const gh = githubSource(u);
  if (!gh && !/^https:\/\//.test(u)) throw Object.assign(new Error('Use a GitHub link or an https:// link to a .zip file.'), { status: 400 });
  for (const url of gh ? gh.urls : [u]) {
    const r = await fetch(url, { signal: AbortSignal.timeout(30000) });
    if (r.status === 404 && gh) continue;
    if (!r.ok) throw new Error(`Download failed (${r.status}).`);
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length > MAX_ZIP) throw new Error('The download is too big.');
    return { zip: buf, sub: gh ? gh.sub : '' };
  }
  throw new Error('Could not find that GitHub repository (is it public?).');
}

async function install({ zip, url }) {
  let sub = '';
  if (url) ({ zip, sub } = await download(String(url).trim()));
  if (!zip || !zip.length) throw Object.assign(new Error('Choose a .zip file or paste a link.'), { status: 400 });
  const files = readZip(zip);
  // plugin.json at the top, inside one folder (as GitHub zips are), or in the linked sub-folder
  const want = sub ? new RegExp(`(^|/)${sub.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/plugin\\.json$`) : /(^|\/)plugin\.json$/;
  const mf = files.filter(f => want.test(f.name)).sort((a, b) => a.name.length - b.name.length)[0];
  if (!mf) throw Object.assign(new Error('No plugin.json found in it.'), { status: 400 });
  const root = mf.name.slice(0, -'plugin.json'.length);
  let manifest;
  try { manifest = JSON.parse(mf.data.toString()); } catch { throw Object.assign(new Error('plugin.json is not valid JSON.'), { status: 400 }); }
  const id = manifest.id;
  if (!ID_RE.test(id || '') || RESERVED.has(id)) throw Object.assign(new Error('plugin.json needs an "id" of lowercase letters, digits and dashes.'), { status: 400 });

  const tmp = path.join(PLUGIN_DIR, `.${id}.installing`);
  fs.rmSync(tmp, { recursive: true, force: true });
  for (const f of files) {
    if (!f.name.startsWith(root)) continue;
    const rel = f.name.slice(root.length);
    const target = path.join(tmp, path.normalize(rel));
    if (!target.startsWith(tmp + path.sep)) throw new Error(`Unsafe file path in the zip: ${rel}`);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, f.data);
  }
  const old = plugins.get(id);
  if (old) { unload(old); plugins.delete(id); fs.rmSync(old.dir, { recursive: true, force: true }); }
  fs.renameSync(tmp, path.join(PLUGIN_DIR, id));
  const rec = load(id);
  log(`Plugin ${id} ${manifest.version || ''} installed${old ? ' (replacing the previous version)' : ''}.`);
  return info(rec);
}

function remove(id) {
  const r = plugins.get(id);
  if (!r) throw Object.assign(new Error(`No plugin "${id}"`), { status: 404 });
  unload(r);
  plugins.delete(id);
  fs.rmSync(r.dir, { recursive: true, force: true });
  log(`Plugin ${id} removed (its saved settings stay in data/${id}.json).`);
}

// /api/plugins/… — the page's plugin manager.
async function manage(req, res, url) {
  const p = url.pathname;
  if (req.method === 'GET' && p === '/api/plugins')
    return deps.sendJson(res, 200, { plugins: list(), local: deps.isLoopback(req), pinSet: !!conf.pin });
  if (req.method === 'GET' && p === '/api/plugins/actions') return deps.sendJson(res, 200, actions());
  if (req.method === 'GET' && p === '/api/plugins/readme') {  // shown by docs.html?plugin=<id>
    const r = plugins.get(url.searchParams.get('id') || '');
    const file = r && path.join(r.dir, 'README.md');
    if (!file || !fs.existsSync(file)) { res.writeHead(404); return res.end('No README'); }
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end(fs.readFileSync(file));
  }
  if (req.method !== 'POST') { res.writeHead(405); return res.end(); }
  const isZip = (req.headers['content-type'] || '').startsWith('application/zip');
  const raw = await deps.readBody(req);
  const body = isZip ? {} : JSON.parse(raw.toString() || '{}');
  switch (p) {
    case '/api/plugins/enable': setEnabled(body.id, body.on); break;
    case '/api/plugins/action': return deps.sendJson(res, 200, { ok: true, result: await runAction(body.id, { unit: req.headers['x-tg-unit'], ...body.args }) ?? null });
    case '/api/plugins/pin':
      if (!deps.isLoopback(req)) return deps.sendJson(res, 403, { error: 'Set the PIN from the computer running the controller, or one it trusts.' });
      setPin(body.pin); break;
    case '/api/plugins/install':
    case '/api/plugins/remove':
      if (!await allowedToManage(req))
        return deps.sendJson(res, 403, { error: conf.pin ? 'Wrong PIN.' : 'Install and remove plugins from the computer running the controller (or one it trusts), or set a PIN there first.' });
      if (p.endsWith('install')) return deps.sendJson(res, 200, await install(isZip ? { zip: raw } : { url: body.url }));
      remove(body.id); break;
    default: res.writeHead(404); return res.end();
  }
  return deps.sendJson(res, 200, { plugins: list(), local: deps.isLoopback(req), pinSet: !!conf.pin });
}

// One-time move of settings kept before plugins existed (engine.json, spotify.json) into data/.
function migrate() {
  const old = readJson(path.join(__dirname, 'engine.json'), {});
  const put = (id, obj) => { const f = path.join(DATA_DIR, id + '.json'); if (!fs.existsSync(f)) fs.writeFileSync(f, JSON.stringify(obj, null, 2)); };
  if (old.place) put('weather', { place: old.place });
  if ('beep' in old || 'rainbow' in old) put('claude', { beep: !!old.beep, rainbow: !!old.rainbow });
  const sp = path.join(__dirname, 'spotify.json');
  if (fs.existsSync(sp) && !fs.existsSync(path.join(DATA_DIR, 'spotify.json'))) fs.renameSync(sp, path.join(DATA_DIR, 'spotify.json'));
}

function init(eng, d) {
  engine = eng; deps = d;
  migrate();
  for (const folder of fs.readdirSync(PLUGIN_DIR)) {
    if (folder.endsWith('.installing')) { fs.rmSync(path.join(PLUGIN_DIR, folder), { recursive: true, force: true }); continue; }  // unfinished install
    if (fs.statSync(path.join(PLUGIN_DIR, folder)).isDirectory()) load(folder);
  }
}

module.exports = { init, route, publicFile, manage, hasFeed, render, live, states, actions, runAction, pageCommand, feedIds };
