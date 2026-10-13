// 3D printer: a Bambu Lab printer's progress, read straight from the printer on your network (its local MQTT
// reports on port 8883, with the LAN access code from the printer's screen). Nothing goes through Bambu's cloud.
// The printer pushes a report every second or so while printing; the screens are redrawn when something shown
// changes (at most every 15 seconds, at once when the state changes).
// Settings in data/printer.json: { host, serial, code, rainbow, autoShow }. The access code is set from this
// computer (or a trusted one) only, and never sent to the page.
const crypto = require('crypto');
const { connect } = require('./mqtt.js');
const { prParts, PR_SPEED } = require('./public/render.js');

const PUSHALL_MS = 10 * 60 * 1000;   // a full report now and then (Bambu asks that it isn't more often than every 5 minutes)
const REDRAW_MS = 15 * 1000;
const STAGES = { 1: 'Levelling the bed', 2: 'Heating the bed', 4: 'Changing filament', 7: 'Heating the nozzle',
  8: 'Calibrating extrusion', 9: 'Scanning the bed', 13: 'Homing', 14: 'Cleaning the nozzle', 22: 'Loading filament' };

// Objects are merged (the printer sends only what changed); anything else, arrays too, is replaced.
function merge(into, from) {
  for (const [k, v] of Object.entries(from)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && into[k] && typeof into[k] === 'object' && !Array.isArray(into[k])) merge(into[k], v);
    else into[k] = v;
  }
  return into;
}
const num = v => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));

module.exports = tg => {
  const s = tg.settings;
  s.host ??= ''; s.serial ??= ''; s.code ??= ''; s.rainbow ??= true; s.autoShow ??= false;
  let m = null, connected = false, error = '', report = {}, reportAt = 0, retryMs = 5000, retry = null, pushTimer = null;
  let lastState = null, finishedAt = null, drawnKey = '', drawnAt = 0, gen = 0;

  const ready = () => s.host && s.serial && s.code;

  function start() {
    stop();
    if (!ready()) return;
    const my = ++gen;
    m = connect({ host: s.host, username: 'bblp', password: s.code, clientId: 'timesgate-' + crypto.randomBytes(3).toString('hex') });
    m.on('connect', () => {
      connected = true; error = ''; retryMs = 5000;
      m.subscribe(`device/${s.serial}/report`);
      pushall();
      pushTimer = setInterval(pushall, PUSHALL_MS);
      tg.update();
    });
    m.on('message', (topic, buf) => {
      let d;
      try { d = JSON.parse(buf.toString('utf8')); } catch { return; }
      if (!d.print) return;
      merge(report, d.print);
      reportAt = Date.now();
      changed();
    });
    m.on('close', err => {
      if (my !== gen) return;
      const was = connected;
      connected = false; m = null; clearInterval(pushTimer);
      error = err.refused === 4 || err.refused === 5 ? 'the printer refused the access code' + (err.refused === 5 ? ' (it may only allow Bambu\'s own apps)' : '')
        : err.code === 'ECONNREFUSED' ? 'the printer refused the connection (is it on, and is LAN access allowed?)'
        : err.code === 'EHOSTUNREACH' || err.code === 'ENETUNREACH' || err.code === 'ETIMEDOUT' || /no answer/.test(err.message) ? 'no answer from the printer (is it on?)'
        : err.message;
      if (was) tg.log('Lost the printer:', error);
      // A refused code won't change by itself: try again only every 10 minutes (or when the settings change).
      retry = setTimeout(start, err.refused ? 10 * 60 * 1000 : retryMs);
      retryMs = Math.min(retryMs * 2, 2 * 60 * 1000);
      tg.update();
    });
  }
  function stop() {
    gen++;
    clearTimeout(retry); clearInterval(pushTimer);
    if (m) { m.end(); m = null; }
    connected = false;
  }
  const pushall = () => { if (m && connected) m.publish(`device/${s.serial}/request`, JSON.stringify({ pushing: { sequence_id: String(Date.now() % 1e6), command: 'pushall' } })); };

  // Temperatures: the older reports' nozzle_temper / bed_temper, or the newer device block, where each
  // temperature packs the current value in the low 16 bits and the target in the high 16.
  function temps(r) {
    const packed = t => (num(t) == null ? null : { cur: num(t) & 0xFFFF, target: num(t) >>> 16 });
    const ex = r.device?.extruder?.info, nozzleNew = Array.isArray(ex) && ex.length ? packed(ex[0].temp) : null;
    return {
      nozzle: num(r.nozzle_temper) != null ? { cur: num(r.nozzle_temper), target: num(r.nozzle_target_temper) } : nozzleNew,
      bed: num(r.bed_temper) != null ? { cur: num(r.bed_temper), target: num(r.bed_target_temper) } : packed(r.device?.bed?.info?.temp),
      chamber: num(r.chamber_temper) != null && num(r.chamber_temper) > 0 ? { cur: num(r.chamber_temper), target: null } : packed(r.device?.ctc?.info?.temp),
    };
  }

  // The AMS slots (and the spool holder at the back), with the one in use.
  function trays(r) {
    const now = num(r.ams?.tray_now), out = [];
    for (const unit of r.ams?.ams || []) for (const t of unit.tray || []) {
      const idx = num(unit.id) * 4 + num(t.id);
      out.push({ slot: `${String.fromCharCode(65 + num(unit.id))}${num(t.id) + 1}`, color: t.tray_color ? '#' + String(t.tray_color).slice(0, 6) : null,
        type: t.tray_type || '', active: now === idx });
    }
    const vt = r.vt_tray || (Array.isArray(r.vir_slot) ? r.vir_slot[0] : null);   // (the P2S calls it vir_slot)
    if (vt && (vt.tray_type || out.length === 0)) out.push({ slot: 'Ext', color: vt.tray_color ? '#' + String(vt.tray_color).slice(0, 6) : null, type: vt.tray_type || '', active: now === 254 });
    return out.slice(0, 9);
  }

  function view() {
    const r = report, st = String(r.gcode_state || (reportAt ? 'IDLE' : '')).toUpperCase();
    const state = !ready() ? 'setup' : !connected && !reportAt ? 'offline' : !connected ? 'offline'
      : st === 'RUNNING' ? 'printing' : st === 'PREPARE' || st === 'SLICING' ? 'preparing' : st === 'PAUSE' ? 'paused'
      : st === 'FINISH' ? 'finished' : st === 'FAILED' ? 'failed' : 'idle';
    const remaining = num(r.mc_remaining_time);
    const job = String(r.subtask_name || r.gcode_file || '').replace(/^.*[\\/]/, '').replace(/(\.gcode)?(\.3mf|\.stl|\.step|\.obj)?$/i, '');
    return {
      state, error: connected ? '' : error, job, stage: STAGES[num(r.stg_cur)] || '',
      percent: num(r.mc_percent), remainingMin: remaining, finishAt: state === 'printing' && remaining != null ? Date.now() + remaining * 60000 : null,
      finishedAt, layer: num(r.layer_num), layers: num(r.total_layer_num),
      ...temps(r), trays: trays(r), errorCode: num(r.print_error) ? num(r.print_error).toString(16).toUpperCase().padStart(8, '0') : null,
      updatedAt: reportAt || null, now: Date.now(),
    };
  }

  // A report arrived: notice a print starting, finishing or failing, and redraw if something shown changed.
  function changed() {
    const v = view();
    if (lastState && lastState !== v.state) {
      const busy = x => x === 'printing' || x === 'preparing';
      if (v.state === 'finished' && busy(lastState)) { finishedAt = Date.now(); alert(`Print finished: ${v.job || 'your print'}`); }
      else if (v.state === 'failed' && lastState !== 'failed') alert(`Print failed: ${v.job || 'your print'}` + (v.errorCode ? ` (error ${v.errorCode})` : ''));
      else if (busy(v.state) && !busy(lastState) && lastState !== 'paused') {
        finishedAt = null;
        tg.log(`Print started: ${v.job || 'a print'}`);
        if (s.autoShow && !tg.isLive()) tg.setLive(true);
      }
    }
    const key = JSON.stringify([v.state, v.job, v.stage, v.percent, v.remainingMin, v.layer, v.layers, v.nozzle, v.bed, v.chamber, v.trays, v.errorCode]);
    const now = Date.now();
    if (key !== drawnKey && (lastState !== v.state || now - drawnAt >= REDRAW_MS)) { drawnKey = key; drawnAt = now; tg.update(); }
    lastState = v.state;
  }
  function alert(what) {
    tg.log(what);
    if (s.rainbow) tg.device.edgeRainbow(60 * 1000);
  }
  // Catch the last change before a quiet spell, and keep "x min ago" style text current.
  tg.every(REDRAW_MS, () => { if (reportAt) changed(); });

  tg.after(1500, start);

  const localOnly = ctx => { if (!ctx.local) throw Object.assign(new Error('Set up the printer from the computer running the controller, or one it trusts.'), { status: 403 }); };
  const state = () => ({ host: s.host, serial: s.serial, hasCode: !!s.code, rainbow: s.rainbow, autoShow: s.autoShow, connected, ...view() });

  return {
    render: () => {
      if (!ready()) throw Object.assign(new Error('Set up the printer in the 3D printer card first.'), { status: 400 });
      return { speed: PR_SPEED, parts: prParts(view()) };
    },
    state,
    stop,
    routes: {
      'GET /view': () => view(),
      // The printer's whole last report, to see what a new model sends (trusted computers only).
      'GET /raw': ctx => { localOnly(ctx); return { connected, reportAt, report }; },
      'POST /refresh': () => { pushall(); return state(); },
      // { host, serial, code } (trusted computers only), { rainbow }, { autoShow }
      'POST /options': ctx => {
        const b = ctx.body || {};
        if (b.host != null || b.serial != null || b.code != null) {
          localOnly(ctx);
          const host = String(b.host ?? s.host).trim(), serial = String(b.serial ?? s.serial).trim().toUpperCase(), code = String(b.code || '').trim() || s.code;
          if (!/^[a-z0-9.-]{1,253}$/i.test(host)) throw Object.assign(new Error('The printer\'s address is its IP address, e.g. 192.168.1.60 (shown in its network settings).'), { status: 400 });
          if (!/^[A-Z0-9]{8,24}$/.test(serial)) throw Object.assign(new Error('The serial number is the letters and numbers on the printer\'s Device page.'), { status: 400 });
          if (!/^\S{6,32}$/.test(code)) throw Object.assign(new Error('The access code is the 8 characters on the printer\'s network (LAN) settings.'), { status: 400 });
          const moved = host !== s.host || serial !== s.serial || code !== s.code;
          Object.assign(s, { host, serial, code });
          if (moved) { report = {}; reportAt = 0; lastState = null; finishedAt = null; error = ''; retryMs = 5000; start(); }
        }
        for (const k of ['rainbow', 'autoShow']) if (typeof b[k] === 'boolean') s[k] = b[k];
        tg.save();
        return state();
      },
    },
    actions: {
      refresh: { label: 'ask the printer for a full report', run: () => pushall() },
      test: { label: 'test the "print finished" light', run: () => alert('Test: print finished') },
    },
  };
};
