// Servers: checks each server's health page every minute (see iis/health.ashx for IIS / ASP.NET; any
// server can answer the same JSON) and shows which are up, and their CPU, memory, disks and databases.
// Settings in data/servers.json: { servers: [{ id, name, url, key, insecure }], limits, rainbow }.
// The keys are set from this computer (or a trusted one) only, and never sent to the page.
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { svParts, SV_SPEED } = require('./public/render.js');

const CHECK_MS = 60 * 1000;
const LIMITS = { cpu: 90, memory: 90, disk: 90, diskCritical: 95 };   // percent: warn at, and red at for disks

module.exports = tg => {
  const s = tg.settings;
  s.servers ??= []; s.rainbow ??= true; s.limits = { ...LIMITS, ...(s.limits || {}) };
  const live = {};   // id → { level, problems, reading, ms, checkedAt, error, downSince, cpu: [last few] }

  // GET the health page, with the key; resolves { status, body, ms }. insecure: accept a self-signed certificate.
  function get(server) {
    return new Promise((resolve, reject) => {
      const u = new URL(server.url), lib = u.protocol === 'https:' ? https : http, t0 = Date.now();
      const req = lib.request(u, { method: 'GET', timeout: 10000, rejectUnauthorized: !server.insecure,
        headers: { Authorization: 'Bearer ' + server.key, Accept: 'application/json', 'User-Agent': 'TimesGate-Servers' } }, res => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', c => { if (body.length < 256 * 1024) body += c; });
        res.on('end', () => resolve({ status: res.statusCode, body, ms: Date.now() - t0 }));
      });
      req.on('timeout', () => req.destroy(new Error('no answer in 10 s')));
      req.on('error', reject);
      req.end();
    });
  }

  // A reading → its problems (each { level: 'warn'|'crit', text }) and the overall level.
  function judge(r, l) {
    const p = [], L = s.limits;
    const cpu = l.cpu.length ? l.cpu.reduce((a, b) => a + b, 0) / l.cpu.length : null;   // the last 3 readings, so one busy moment isn't a problem
    if (cpu != null && cpu >= L.cpu) p.push({ level: 'warn', text: `CPU ${Math.round(cpu)}%` });
    if (r.memory && r.memory.percent >= L.memory) p.push({ level: r.memory.percent >= 97 ? 'crit' : 'warn', text: `memory ${r.memory.percent}%` });
    for (const d of r.disks || []) {
      if (d.percentUsed >= L.diskCritical) p.push({ level: 'crit', text: `${d.name} ${d.percentUsed}% full` });
      else if (d.percentUsed >= L.disk) p.push({ level: 'warn', text: `${d.name} ${d.percentUsed}% full` });
    }
    for (const db of r.databases || []) if (!db.ok) p.push({ level: 'crit', text: `database ${db.name} failed` });
    if (r.restartPending) p.push({ level: 'warn', text: 'restart pending' });
    return { problems: p, level: p.some(x => x.level === 'crit') ? 'crit' : p.length ? 'warn' : 'ok' };
  }

  async function checkOne(server) {
    const l = live[server.id] ||= { cpu: [] }, was = l.level;
    try {
      const r = await get(server);
      if (r.status === 401) throw new Error('the server refused the key');
      if (r.status === 503) throw new Error('the health page has no HealthKey set');
      if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
      const d = JSON.parse(r.body);
      if (d.apiVersion !== 1) throw new Error('not a health page');
      if (Number.isFinite(d.cpuPercent)) { l.cpu.push(d.cpuPercent); if (l.cpu.length > 3) l.cpu.shift(); }
      const j = judge(d, l);
      Object.assign(l, { reading: d, ms: r.ms, error: '', downSince: null, level: j.level, problems: j.problems });
    } catch (e) {
      const msg = e instanceof SyntaxError ? 'not a health page'
        : e.code === 'ECONNREFUSED' ? 'connection refused'
        : e.code === 'ENOTFOUND' || e.code === 'EAI_AGAIN' ? 'address not found'
        : e.code === 'ECONNRESET' ? 'connection dropped'
        : /CERT|SELF_SIGNED|UNABLE_TO_VERIFY/.test(e.code || '') ? 'certificate not trusted (tick "Accept a self-signed certificate" if it\'s your own)'
        : e.message;
      Object.assign(l, { error: msg, ms: null, level: 'crit', problems: [{ level: 'crit', text: msg }] });
      l.downSince ||= Date.now();
    }
    l.checkedAt = Date.now();
    if (l.level === 'crit' && was && was !== 'crit') {   // newly in trouble (not on the first check after starting)
      tg.log(`${server.name}: ${l.problems.map(p => p.text).join(', ')}`);
      if (s.rainbow) tg.device.edgeRainbow(60 * 1000);
    }
  }
  let checking = null;
  function check() {
    if (!checking) checking = Promise.all(s.servers.map(checkOne)).then(() => tg.update()).finally(() => { checking = null; });
    return checking;
  }
  tg.after(3000, check);
  tg.every(CHECK_MS, check);

  // What the page and the screens see (never the keys).
  const ORDER = { crit: 0, warn: 1, ok: 2, undefined: 3 };
  function view() {
    const list = s.servers.map(sv => {
      const l = live[sv.id] || {}, r = l.reading || {};
      const disk = (r.disks || []).reduce((a, d) => (!a || d.percentUsed > a.percentUsed ? d : a), null);
      return {
        id: sv.id, name: sv.name, url: sv.url, insecure: !!sv.insecure, level: l.level || null, problems: l.problems || [], error: l.error || '',
        down: !!l.error, downSince: l.downSince || null, checkedAt: l.checkedAt || null, ms: l.ms ?? null,
        cpu: r.cpuPercent ?? null, memory: r.memory?.percent ?? null, disk: disk ? { name: disk.name, percent: disk.percentUsed, freeGb: disk.freeGb } : null,
        databases: (r.databases || []).map(d => ({ name: d.name, ok: d.ok, ms: d.ms })), uptime: r.uptimeSeconds ?? null,
        restartPending: !!r.restartPending, host: r.server || null, os: r.os || null,
      };
    });
    list.sort((a, b) => ORDER[a.level] - ORDER[b.level] || a.name.localeCompare(b.name));
    return { servers: list, limits: s.limits, now: Date.now() };
  }

  const localOnly = ctx => { if (!ctx.local) throw Object.assign(new Error('Add servers and keys from the computer running the controller, or one it trusts.'), { status: 403 }); };
  const state = () => ({ rainbow: s.rainbow, ...view() });

  return {
    render: () => {
      if (!s.servers.length) throw Object.assign(new Error('Add a server in the Servers card first.'), { status: 400 });
      return { speed: SV_SPEED, parts: svParts(view()) };
    },
    state,
    routes: {
      'GET /view': () => view(),
      'POST /check': async () => { await check(); return state(); },
      // { add: { name, url, key, insecure } } (trusted computers only), { remove: id }, { rainbow }, { limits: { cpu, memory, disk, diskCritical } }
      'POST /options': async ctx => {
        const b = ctx.body || {};
        if (b.add) {
          localOnly(ctx);
          const name = String(b.add.name || '').trim().slice(0, 40), key = String(b.add.key || '').trim();
          let url;
          try { url = new URL(String(b.add.url || '').trim()); } catch {}
          if (!name) throw Object.assign(new Error('Give the server a name.'), { status: 400 });
          if (!url || !/^https?:$/.test(url.protocol)) throw Object.assign(new Error('The health page address starts with https:// (or http://).'), { status: 400 });
          if (key.length < 16) throw Object.assign(new Error('The key is the HealthKey from the server\'s web.config (at least 16 characters).'), { status: 400 });
          const sv = { id: crypto.randomBytes(4).toString('hex'), name, url: url.href, key, insecure: !!b.add.insecure };
          s.servers.push(sv);
          tg.save();
          await checkOne(sv);
          tg.update();
        }
        if (typeof b.remove === 'string') { s.servers = s.servers.filter(x => x.id !== b.remove); delete live[b.remove]; tg.update(); }
        if (typeof b.rainbow === 'boolean') s.rainbow = b.rainbow;
        if (b.limits) for (const k of Object.keys(LIMITS)) if (Number.isFinite(b.limits[k]) && b.limits[k] >= 50 && b.limits[k] <= 100) s.limits[k] = Math.round(b.limits[k]);
        tg.save();
        return state();
      },
    },
    actions: {
      check: { label: 'check the servers now', run: () => check() },
    },
  };
};
