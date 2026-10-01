// Keeps the Times Gates updated without the web page open. The page is just a remote control:
// what it switches on here (a plugin kept updated on the screens, the timer's "time's up" flash,
// the light show, rainbow alerts) runs in this server, and is saved to engine.json so it carries
// on after a restart. What goes on the screens comes from plugins (plugin-host.js), drawn with
// @napi-rs/canvas using the same code the page uses for its previews.
//
// Several Times Gates ("units") can be controlled. Each unit has its own state: what's on its
// screens, its picture ids, timer, score, brightness, lights. Every command to a device, from the
// page, a plugin or here, goes through that unit's send().

const fs = require('fs');
const path = require('path');
const { createCanvas } = require('@napi-rs/canvas');
globalThis.makeCanvas = (w, h) => createCanvas(w, h);
const { timerDoneFrames, blankFrame, TM_SPEED } = require('./public/render/timer-render.js');

const STATE_FILE = path.join(__dirname, 'engine.json');
const log = (...a) => console.log(new Date().toLocaleTimeString(), ...a);
let host = null;  // plugin-host.js

// Commands that change what the screens show.
const SCREEN_CMD = /^(Draw\/|Device\/PlayGif$|Tools\/Set(Timer|StopWatch|ScoreBoard)$|Channel\/(Set5LcdChannelType|Set5LcdWholeClockId|SetClockSelectId|SetEqPosition)$)/;
const isOk = r => !r.error && (r.error_code === 0 || r.error_code === undefined || r.error_code === 'DeviceToken is err');
const EDGE_OFF = { Command: 'Channel/SetRGBInfo', SelectLightIndex: 1, Brightness: 100, OnOff: 0, Color: '#ff5500', ColorCycle: 0,
  LightList: [{ SelectEffect: 0 }, { SelectEffect: 0 }, { SelectEffect: 0 }] };

function tileJpeg(src, x = 0) {
  const t = createCanvas(128, 128);
  t.getContext('2d').drawImage(src, x, 0, 128, 128, 0, 0, 128, 128);
  return t.toDataURL('image/jpeg', 0.95).split(',')[1];
}
function hsv(h, s, v) {
  h = (h - Math.floor(h)) * 6;
  const i = Math.floor(h), f = h - i, p = v * (1 - s), q = v * (1 - s * f), u = v * (1 - s * (1 - f));
  return [[v, u, p], [q, v, p], [p, v, u], [p, q, v], [u, p, v], [v, p, q]][i % 6].map(c => c * 255 | 0);
}
const hex = rgb => '#' + rgb.map(c => c.toString(16).padStart(2, '0')).join('');

// ---------- one Times Gate ----------
class Unit {
  constructor(data) {
    Object.assign(this, {
      id: 'u1', name: 'Times Gate',
      ip: null, hardware: 400, token: null, deviceId: null,  // learned from the page's commands / discovery
      alerts: true,        // gets beeps / rainbow alerts from plugins (e.g. Claude needs you)
      feed: null,          // id of the plugin kept updated on its screens
      edge: null,          // the page's last edge-light command, to put back after a rainbow alert
      noise: false,        // noise meter on?
      lightShow: null, lastShow: null,  // { bpm, mode, color }
      timer: null,         // { label, endsAt } while a labelled countdown runs
      score: { red: 0, blue: 0 }, brightness: 80, screenOn: true,
    }, data);
    // Not saved: counters, timers and what's on the screens right now.
    Object.defineProperty(this, 'rt', { enumerable: false, value: {
      picId: null, picReset: null, sent: {}, running: null, pending: null, edgeTimer: null,
      tmEnd: null, tmRepeat: null, tmShown: false, showTimer: null, showBusy: false, showBeat: 0,
    } });
  }
  get label() { return this.name || this.id; }

  // ----- device -----
  async rawSend(payload) {
    if (!this.ip) throw new Error(`${this.label}: not connected yet — open the page and Connect once.`);
    const url = this.hardware === 402 ? `http://${this.ip}:9000/divoom_api` : `http://${this.ip}:80/post`;
    const body = payload.LocalToken == null && this.token != null ? { ...payload, LocalToken: this.token } : payload;
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(10000) });
    const text = await r.text();
    try { return JSON.parse(text); } catch { return { raw: text }; }
  }
  // fromPage: a command the page (or a button) sent — other content replacing what's kept updated.
  async send(payload, fromPage = false) {
    // The noise meter misbehaves if other content takes over the screens while it's on.
    if (this.noise && SCREEN_CMD.test(payload.Command)) {
      this.noise = false; save();
      await this.rawSend({ Command: 'Tools/SetNoiseStatus', NoiseStatus: 0 }).catch(() => {});
    }
    if (fromPage) this.observe(payload);
    return this.rawSend(payload);
  }
  observe(p) {
    const c = p.Command, rt = this.rt;
    if (c === 'Tools/SetNoiseStatus') { this.noise = p.NoiseStatus === 1; save(); }
    if (c === 'Tools/SetScoreBoard') { this.score = { red: Number(p.RedScore) || 0, blue: Number(p.BlueScore) || 0 }; save(); }
    if (c === 'Channel/SetBrightness') { this.brightness = Number(p.Brightness); save(); }
    if (c === 'Channel/OnOffScreen') { this.screenOn = p.OnOff === 1; save(); }
    if (c === 'Channel/SetRGBInfo') {
      this.stopLightShow();
      host.pageCommand(p, this.id);
      if (p.SelectLightIndex === 1) { const { LocalToken, ...edge } = p; this.edge = edge; save(); this.cancelEdgeAlert(); }
    }
    if (SCREEN_CMD.test(c)) {
      if (this.feed) { log(`${this.label}: page sent ${c}, stopping ${this.feed} updates.`); this.setFeed(null); }
      this.stopTimerRepeat();
      if (c !== 'Tools/SetTimer') rt.tmShown = false;
      rt.sent = {};
    }
  }

  // Draw/SendHttpGif ids must strictly increase; shared with the page (POST /api/picid).
  async nextPicId() {
    const rt = this.rt;
    if (rt.picId === null) {
      rt.picReset = rt.picReset || this.rawSend({ Command: 'Draw/ResetHttpGifId' }).then(() => { rt.picId = 0; }).finally(() => { rt.picReset = null; });
      await rt.picReset;
    }
    return ++rt.picId;
  }
  resetPicId() { this.rt.picId = null; }

  // Upload per-screen frame loops. jobs: [{ screen, frames: [canvas], x? }]. One Draw/CommandList per
  // frame carrying every screen, so the screens start together; a single screen is sent directly.
  async sendScreens(jobs, speed) {
    const ids = {};
    for (const j of jobs) ids[j.screen] = await this.nextPicId();
    const packet = (j, f) => ({ Command: 'Draw/SendHttpGif', LcdArray: [0, 1, 2, 3, 4].map(i => i === j.screen ? 1 : 0),
      PicNum: j.frames.length, PicWidth: 128, PicOffset: f, PicID: ids[j.screen], PicSpeed: speed, PicData: tileJpeg(j.frames[f], j.x) });
    const N = Math.max(...jobs.map(j => j.frames.length));
    for (let f = 0; f < N; f++) {
      const now = jobs.filter(j => f < j.frames.length);
      const r = now.length === 1 ? await this.send(packet(now[0], f))
        : await this.send({ Command: 'Draw/CommandList', CommandList: now.map(j => packet(j, f)) });
      if (!isOk(r)) throw new Error('Device error: ' + JSON.stringify(r));
    }
  }

  // ----- feeds: a plugin's screens kept up to date -----
  // A plugin's render() returns { speed, parts: [{ key, jobs: [{ screen, frames, x? }] }] } — see PLUGINS.md.
  // Updates run one at a time; requests that arrive meanwhile are merged into one more pass.
  // onError gets the error if this request's pass fails (the returned promise never rejects).
  update(what = this.feed, once = false, onError = null) {
    const rt = this.rt;
    if (!what) return Promise.resolve();
    if (!(rt.pending && rt.pending.once && !once)) rt.pending = { what, once, onError };  // a feed refresh never replaces a one-off send
    if (!rt.running) rt.running = (async () => {
      while (rt.pending) {
        const job = rt.pending; rt.pending = null;
        if (!job.once && job.what !== this.feed) continue;  // feed switched off meanwhile
        try {
          const { speed, parts } = await host.render(job.what, this.id);
          const changed = parts.filter(p => rt.sent[p.jobs[0].screen] !== p.key);
          if (changed.length) {
            await this.sendScreens(changed.flatMap(p => p.jobs), speed);
            changed.forEach(p => { rt.sent[p.jobs[0].screen] = p.key; });
          }
        } catch (e) {
          log(`${this.label}: updating ${job.what} failed:`, e.message);
          rt.sent = {};
          if (job.onError) job.onError(e);
        }
      }
      rt.running = null;
    })();
    return rt.running;
  }
  setFeed(feed) {
    const old = this.feed;
    this.feed = feed || null; save();
    this.rt.sent = {};
    if (old) host.live(old, liveUnits(old).length > 0);
    if (this.feed) { host.live(this.feed, true); log(`${this.label}: keeping ${this.feed} updated.`); this.update(); }
  }
  // Show something once. Anything other than the current feed replaces it.
  async sendOnce(what) {
    if (!host.hasFeed(what)) throw new Error(`Nothing called "${what}" to show`);
    if (this.feed !== what) this.setFeed(null);
    this.stopTimerRepeat(); this.rt.tmShown = false;
    this.rt.sent = {};
    let err = null;
    await this.update(what, true, e => { err = e; });
    if (err) throw err;
  }

  // ----- alerts -----
  beep({ on = 150, off = 100, total = 500 } = {}) {
    return this.send({ Command: 'Device/PlayBuzzer', ActiveTimeInCycle: on, OffTimeInCycle: off, PlayTotalTime: total }).catch(() => {});
  }
  // Rainbow edge light for a while (2 minutes by default), then back to what the page last set.
  // Another alert restarts the wait.
  edgeAlert(ms = 2 * 60 * 1000) {
    const rt = this.rt;
    clearTimeout(rt.edgeTimer);
    rt.edgeTimer = setTimeout(() => { rt.edgeTimer = null; this.send(this.edge || EDGE_OFF).catch(() => {}); }, ms);
    const color = (this.edge && this.edge.Color) || '#ff5500';
    this.send({ Command: 'Channel/SetRGBInfo', SelectLightIndex: 1, Brightness: 100, OnOff: 1, Color: color, ColorCycle: 1,
      LightList: [{ SelectEffect: 0 }, { SelectEffect: 10, Color: color, ColorCycle: 1 }, { SelectEffect: 0 }] }).catch(() => {});
  }
  // A solid colour on the edge light for a moment (e.g. "this one" when the button box switches to
  // this unit), then back to what the page last set.
  edgeFlash(ms = 2500, color = '#00d0ff') {
    const rt = this.rt;
    clearTimeout(rt.edgeTimer);
    rt.edgeTimer = setTimeout(() => { rt.edgeTimer = null; this.send(this.edge || EDGE_OFF).catch(() => {}); }, ms);
    this.send({ Command: 'Channel/SetRGBInfo', SelectLightIndex: 1, Brightness: 100, OnOff: 1, Color: color, ColorCycle: 0,
      LightList: [{ SelectEffect: 0 }, { SelectEffect: 4, Color: color, ColorCycle: 0 }, { SelectEffect: 0 }] }).catch(() => {});
  }
  cancelEdgeAlert() { clearTimeout(this.rt.edgeTimer); this.rt.edgeTimer = null; }

  // ----- countdown timer label -----
  // The device runs the countdown; when time is up, screen 2 flashes the label. The device's alarm
  // then shows "End", so the flash is re-sent every 15 s for 3 minutes (other content stops that).
  timerStart(ms, label) {
    this.timerCancel();
    label = String(label || '').trim().slice(0, 40);
    this.timer = label && ms > 0 ? { label, endsAt: Date.now() + ms } : null;
    save();
    if (this.timer) this.scheduleTimer();
  }
  scheduleTimer() {
    const t = this.timer;
    this.rt.tmEnd = setTimeout(() => this.timerDone(t.label), Math.max(0, t.endsAt - Date.now()));
  }
  timerDone(label) {
    const rt = this.rt;
    rt.tmEnd = null; this.timer = null; save();
    this.setFeed(null);
    const frames = timerDoneFrames(label), until = Date.now() + 3 * 60 * 1000;
    const show = () => { rt.tmShown = true; this.sendScreens([{ screen: 1, frames }], TM_SPEED).catch(e => log(`${this.label}: timer flash failed:`, e.message)); };
    log(`${this.label}: timer "${label}" is done.`);
    show();
    rt.tmRepeat = setInterval(() => Date.now() > until ? this.stopTimerRepeat() : show(), 15000);
  }
  stopTimerRepeat() { clearInterval(this.rt.tmRepeat); this.rt.tmRepeat = null; }
  timerCancel() { clearTimeout(this.rt.tmEnd); this.rt.tmEnd = null; this.stopTimerRepeat(); }
  async timerStop() {
    this.timerCancel();
    this.timer = null; save();
    if (this.rt.tmShown) { this.rt.tmShown = false; await this.sendScreens([{ screen: 1, frames: [blankFrame()] }], 1000); }
  }

  // ----- light show (backlight to a beat) -----
  showColour() {
    const o = this.lightShow, n = ++this.rt.showBeat;
    if (o.mode === 'rainbow') return hsv(n / 12, 1, 1);
    if (o.mode === 'pulse') {
      const rgb = [1, 3, 5].map(i => parseInt(o.color.slice(i, i + 2), 16));
      return n % 2 ? rgb : rgb.map(c => 255 - c);
    }
    return hsv(Math.random(), 1, 1);
  }
  async showStep() {
    const rt = this.rt;
    if (rt.showBusy || !this.lightShow) return;  // never queue requests up if the device is slow
    rt.showBusy = true;
    const colour = hex(this.showColour());
    await this.send({ Command: 'Channel/SetRGBInfo', SelectLightIndex: 2, Brightness: 100, OnOff: 1, Color: colour, ColorCycle: 0,
      LightList: [{ SelectEffect: 0 }, { SelectEffect: 3 }, { SelectEffect: 5, Color: colour, ColorCycle: 0 }] }).catch(() => {});
    rt.showBusy = false;
  }
  startLightShow(o) {
    clearInterval(this.rt.showTimer);
    if (host) host.pageCommand({ Command: 'Engine/LightShow' }, this.id);
    const bpm = Math.max(30, Math.min(240, Number(o.bpm) || 120));
    this.lightShow = this.lastShow = { bpm, mode: String(o.mode || 'random'), color: /^#[0-9a-f]{6}$/i.test(o.color) ? o.color : '#ff5500' };
    save();
    this.showStep();
    this.rt.showTimer = setInterval(() => this.showStep(), 60000 / bpm);
  }
  stopLightShow() {
    clearInterval(this.rt.showTimer); this.rt.showTimer = null;
    if (this.lightShow) { this.lightShow = null; save(); }
  }

  // Stop everything running for this unit (it's being removed).
  shutdown() {
    this.timerCancel(); this.cancelEdgeAlert(); this.stopLightShow();
    if (this.feed) { const f = this.feed; this.feed = null; host.live(f, liveUnits(f).length > 0); }
  }

  summary() {
    const { id, name, ip, hardware, deviceId, alerts, feed } = this;
    return { id, name, ip, hardware, deviceId, alerts, feed };
  }
}

// ---------- the units ----------
let units = [];
const save = () => fs.writeFileSync(STATE_FILE, JSON.stringify({ units }, null, 2));

(function load() {
  let saved = {};
  try { saved = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch {}
  if (Array.isArray(saved.units)) units = saved.units.map(u => new Unit(u));
  else if (saved.device || saved.feed) {
    // engine.json from before there were several units: it becomes unit 1.
    const { device, place, beep, rainbow, ...rest } = saved;
    units = [new Unit({ ...rest, id: 'u1', name: 'Times Gate', ...(device || {}) })];
  }
})();

const findUnit = id => units.find(u => u.id === id);
// A unit by id; without an id, the first one (so a single Times Gate needs no ids anywhere).
function unit(id) {
  const u = id ? findUnit(id) : units[0];
  if (!u) throw Object.assign(new Error(id ? `No Times Gate "${id}"` : 'No Times Gate set up yet: open the page and Connect.'), { status: 404 });
  return u;
}
// 'all' (or an array) → every unit / those; one id → that unit; nothing → the first.
function unitsFor(sel) {
  if (sel === 'all') return units.slice();
  if (Array.isArray(sel)) return sel.map(unit);
  return [unit(sel)];
}
const liveUnits = pluginId => units.filter(u => u.feed === pluginId);

function addUnit({ name, ip, hardware, deviceId } = {}) {
  const same = units.find(u => (deviceId && u.deviceId === Number(deviceId)) || (ip && u.ip === ip));
  if (same) return same;
  const n = Math.max(0, ...units.map(u => Number(u.id.slice(1)) || 0)) + 1;
  const u = new Unit({ id: 'u' + n, name: String(name || `Times Gate ${n}`).slice(0, 30), ip: ip || null,
    hardware: Number(hardware) || 400, deviceId: Number(deviceId) || null });
  units.push(u); save();
  log(`Added ${u.label} (${u.id})${ip ? ' at ' + ip : ''}.`);
  return u;
}
function updateUnit(id, o) {
  const u = unit(id);
  if (typeof o.name === 'string' && o.name.trim()) u.name = o.name.trim().slice(0, 30);
  if (typeof o.alerts === 'boolean') u.alerts = o.alerts;
  if (Number.isFinite(Number(o.deviceId)) && o.deviceId) u.deviceId = Number(o.deviceId);
  save();
  return u;
}
function removeUnit(id) {
  const u = unit(id);
  u.shutdown();
  units = units.filter(x => x !== u); save();
  log(`Removed ${u.label}.`);
}

// The page's commands tell us each unit's address. Without a unit id (an older page) the unit is
// found by IP, or created.
function learnDevice(unitId, ip, hardware, token) {
  let u = unitId ? findUnit(unitId) : units.find(x => x.ip === ip) || (units.length === 1 && !units[0].ip ? units[0] : null);
  if (!u) u = addUnit({ ip, hardware });
  const d = { ip, hardware: Number(hardware) || 400, token: Number.isFinite(token) ? token : null };
  if (u.ip !== d.ip || u.hardware !== d.hardware || u.token !== d.token) { Object.assign(u, d); save(); }
  return u;
}

// A plugin calls this (tg.update) when its data changes: redraw every unit showing it.
function feedChanged(pluginId) { liveUnits(pluginId).forEach(u => u.update()); }
// A plugin is turned off or removed.
function stopFeedEverywhere(pluginId) { liveUnits(pluginId).forEach(u => u.setFeed(null)); }

// Plugin alerts go to every unit with alerts on (or the one given).
const alertUnits = sel => sel ? unitsFor(sel) : units.filter(u => u.alerts);
const beep = (opts, sel) => Promise.all(alertUnits(sel).map(u => u.beep(opts)));
const edgeAlert = (ms, sel) => alertUnits(sel).forEach(u => u.edgeAlert(ms));
// Any command from a plugin: to the given unit(s), or all of them. Resolves to the first reply.
async function sendTo(payload, sel) {
  const replies = await Promise.all(unitsFor(sel || 'all').map(u => u.send(payload).catch(e => ({ error: e.message }))));
  return replies[0];
}
const stopLightShow = sel => unitsFor(sel || 'all').forEach(u => u.stopLightShow());

// ---------- built-in actions (for buttons; listed with the plugins' actions) ----------
// Each sends what the page would, through observe(), so everything stays in step.
const pageSend = (u, p) => u.send(p, true);
const score = (u, red, blue) => pageSend(u, { Command: 'Tools/SetScoreBoard', RedScore: Math.max(0, Math.min(999, red)), BlueScore: Math.max(0, Math.min(999, blue)) });
const bright = (u, v) => pageSend(u, { Command: 'Channel/SetBrightness', Brightness: Math.max(0, Math.min(100, v)) });
async function timer(u, minutes) {
  await pageSend(u, { Command: 'Tools/SetTimer', Minute: minutes, Second: 0, Status: 1 });
  u.timerStart(minutes * 60000, '');
}
function cycleFeed(u, dir) {
  const feeds = host.feedIds();
  if (!feeds.length) return;
  const i = feeds.indexOf(u.feed);
  const next = i < 0 ? (dir > 0 ? 0 : feeds.length - 1) : (i + dir + feeds.length) % feeds.length;
  u.setFeed(feeds[next]);
}
const CORE_ACTIONS = {
  'core.next':        ['Screens: next feature', u => cycleFeed(u, 1)],
  'core.prev':        ['Screens: previous feature', u => cycleFeed(u, -1)],
  'core.brightUp':    ['Brightness up', u => bright(u, u.brightness + 10)],
  'core.brightDown':  ['Brightness down', u => bright(u, u.brightness - 10)],
  'core.screen':      ['Screen on/off', u => pageSend(u, { Command: 'Channel/OnOffScreen', OnOff: u.screenOn ? 0 : 1 })],
  'core.beep':        ['Beep', u => u.beep({ on: 150, off: 100, total: 300 })],
  'core.redUp':       ['Score: Red +1', u => score(u, u.score.red + 1, u.score.blue)],
  'core.redDown':     ['Score: Red −1', u => score(u, u.score.red - 1, u.score.blue)],
  'core.blueUp':      ['Score: Blue +1', u => score(u, u.score.red, u.score.blue + 1)],
  'core.blueDown':    ['Score: Blue −1', u => score(u, u.score.red, u.score.blue - 1)],
  'core.scoreReset':  ['Score: reset', u => score(u, 0, 0)],
  'core.timer1':      ['Timer: 1 minute', u => timer(u, 1)],
  'core.timer5':      ['Timer: 5 minutes', u => timer(u, 5)],
  'core.timer10':     ['Timer: 10 minutes', u => timer(u, 10)],
  'core.timer25':     ['Timer: 25 minutes', u => timer(u, 25)],
  'core.timerStop':   ['Timer: stop', async u => { await pageSend(u, { Command: 'Tools/SetTimer', Minute: 0, Second: 0, Status: 0 }); await u.timerStop(); }],
  'core.lightShow':   ['Light show on/off', u => u.lightShow ? u.stopLightShow() : u.startLightShow(u.lastShow || { bpm: 120, mode: 'random' })],
};
const coreActions = () => Object.entries(CORE_ACTIONS).map(([id, [label]]) => ({ id, plugin: 'core', label }));
// sel: a unit id, 'all', or nothing (the first unit).
function runCoreAction(id, sel) {
  const a = CORE_ACTIONS[id];
  if (!a) throw Object.assign(new Error(`No action "${id}"`), { status: 404 });
  return Promise.all(unitsFor(sel).map(u => a[1](u)));
}

// ---------- page API ----------
function state(unitId) {
  const u = unitId ? findUnit(unitId) || units[0] : units[0];
  const base = { units: units.map(x => x.summary()), plugins: host ? host.states(u && u.id) : {} };
  if (!u) return { ...base, unit: null, deviceKnown: false };
  const { feed, noise, lightShow, timer, score, brightness, screenOn } = u;
  return { ...base, unit: u.id, deviceKnown: !!u.ip, feed, noise, lightShow, timer, score, brightness, screenOn };
}
function setOptions(unitId, o) {
  const u = unit(unitId);
  if ('feed' in o && o.feed !== u.feed) u.setFeed(o.feed && host.hasFeed(o.feed) ? o.feed : null);
}

function init(pluginHost) {
  host = pluginHost;
  // Carry on with whatever was running before the restart.
  for (const u of units) {
    if (u.timer && u.timer.endsAt > Date.now()) u.scheduleTimer();
    else if (u.timer) { u.timer = null; save(); }
    if (u.lightShow) u.startLightShow(u.lightShow);
    if (u.feed) {
      const feed = u.feed;
      u.feed = null;
      setTimeout(() => { if (host.hasFeed(feed)) u.setFeed(feed); else save(); }, 3000);
    }
  }
}

module.exports = {
  init, unit, units: () => units.map(u => u.summary()), addUnit, updateUnit, removeUnit, learnDevice,
  state, setOptions, feedChanged, stopFeedEverywhere, liveUnits: id => liveUnits(id).map(u => u.id),
  beep, edgeAlert, sendTo, stopLightShow, coreActions, runCoreAction,
};
