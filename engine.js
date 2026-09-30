// Keeps the Times Gate updated without the web page open. The page is just a remote control:
// what it switches on here (a plugin kept updated on the screens, the timer's "time's up" flash,
// the light show, rainbow alerts) runs in this server, and is saved to engine.json so it carries
// on after a restart. What goes on the screens comes from plugins (plugin-host.js), drawn with
// @napi-rs/canvas using the same code the page uses for its previews.
// Every command to the device, from the page, a plugin or here, goes through send().

const fs = require('fs');
const path = require('path');
const { createCanvas } = require('@napi-rs/canvas');
globalThis.makeCanvas = (w, h) => createCanvas(w, h);
const { timerDoneFrames, blankFrame, TM_SPEED } = require('./public/render/timer-render.js');

const STATE_FILE = path.join(__dirname, 'engine.json');
let saved = {};
try { saved = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch {}
delete saved.place; delete saved.beep; delete saved.rainbow;  // moved to the weather / claude plugins
const st = {
  device: null,        // { ip, hardware, token } — learned from the page's commands
  feed: null,          // id of the plugin kept updated on the screens
  edge: null,          // the page's last edge-light command, to put back after a rainbow alert
  noise: false,        // noise meter on?
  lightShow: null,     // { bpm, mode, color }
  timer: null,         // { label, endsAt } while a labelled countdown runs
  score: { red: 0, blue: 0 },   // last scoreboard shown (so buttons can add to it)
  brightness: 80, screenOn: true,
  lastShow: null,      // last light show settings, for turning it back on
  ...saved,
};
const save = () => fs.writeFileSync(STATE_FILE, JSON.stringify(st, null, 2));
const log = (...a) => console.log(new Date().toLocaleTimeString(), ...a);

let host = null;  // plugin-host.js

// ---------- device ----------
// Commands that change what the screens show.
const SCREEN_CMD = /^(Draw\/|Device\/PlayGif$|Tools\/Set(Timer|StopWatch|ScoreBoard)$|Channel\/(Set5LcdChannelType|Set5LcdWholeClockId|SetClockSelectId|SetEqPosition)$)/;
const isOk = r => !r.error && (r.error_code === 0 || r.error_code === undefined || r.error_code === 'DeviceToken is err');

function learnDevice(ip, hardware, token) {
  const d = { ip, hardware: Number(hardware) || 400, token: Number.isFinite(token) ? token : null };
  if (JSON.stringify(d) !== JSON.stringify(st.device)) { st.device = d; save(); }
}

async function rawSend(payload) {
  const d = st.device;
  if (!d) throw new Error('Device not known yet: open the page and Connect once.');
  const url = d.hardware === 402 ? `http://${d.ip}:9000/divoom_api` : `http://${d.ip}:80/post`;
  const body = payload.LocalToken == null && d.token != null ? { ...payload, LocalToken: d.token } : payload;
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body), signal: AbortSignal.timeout(10000) });
  const text = await r.text();
  try { return JSON.parse(text); } catch { return { raw: text }; }
}

// fromPage: a command the page sent — other content replacing what this engine keeps updated.
async function send(payload, fromPage = false) {
  // The noise meter misbehaves if other content takes over the screens while it's on.
  if (st.noise && SCREEN_CMD.test(payload.Command)) {
    st.noise = false; save();
    await rawSend({ Command: 'Tools/SetNoiseStatus', NoiseStatus: 0 }).catch(() => {});
  }
  if (fromPage) observe(payload);
  return rawSend(payload);
}

function observe(p) {
  const c = p.Command;
  if (c === 'Tools/SetNoiseStatus') { st.noise = p.NoiseStatus === 1; save(); }
  if (c === 'Tools/SetScoreBoard') { st.score = { red: Number(p.RedScore) || 0, blue: Number(p.BlueScore) || 0 }; save(); }
  if (c === 'Channel/SetBrightness') { st.brightness = Number(p.Brightness); save(); }
  if (c === 'Channel/OnOffScreen') { st.screenOn = p.OnOff === 1; save(); }
  if (c === 'Channel/SetRGBInfo') {
    stopLightShow();
    host.pageCommand(p);
    if (p.SelectLightIndex === 1) { const { LocalToken, ...edge } = p; st.edge = edge; save(); cancelEdgeAlert(); }
  }
  if (SCREEN_CMD.test(c)) {
    if (st.feed) { log(`Page sent ${c}: stopping ${st.feed} updates.`); setFeed(null); }
    stopTimerRepeat();
    if (c !== 'Tools/SetTimer') tmShown = false;
    sent = {};
  }
}

// Draw/SendHttpGif ids must strictly increase; shared with the page (POST /api/picid).
let picId = null, picReset = null;
async function nextPicId() {
  if (picId === null) {
    picReset = picReset || rawSend({ Command: 'Draw/ResetHttpGifId' }).then(() => { picId = 0; }).finally(() => { picReset = null; });
    await picReset;
  }
  return ++picId;
}
const resetPicId = () => { picId = null; };

function tileJpeg(src, x = 0) {
  const t = createCanvas(128, 128);
  t.getContext('2d').drawImage(src, x, 0, 128, 128, 0, 0, 128, 128);
  return t.toDataURL('image/jpeg', 0.95).split(',')[1];
}

// Upload per-screen frame loops. jobs: [{ screen, frames: [canvas], x? }]. One Draw/CommandList per
// frame carrying every screen, so the screens start together; a single screen is sent directly.
async function sendScreens(jobs, speed) {
  const ids = {};
  for (const j of jobs) ids[j.screen] = await nextPicId();
  const packet = (j, f) => ({ Command: 'Draw/SendHttpGif', LcdArray: [0, 1, 2, 3, 4].map(i => i === j.screen ? 1 : 0),
    PicNum: j.frames.length, PicWidth: 128, PicOffset: f, PicID: ids[j.screen], PicSpeed: speed, PicData: tileJpeg(j.frames[f], j.x) });
  const N = Math.max(...jobs.map(j => j.frames.length));
  for (let f = 0; f < N; f++) {
    const now = jobs.filter(j => f < j.frames.length);
    const r = now.length === 1 ? await send(packet(now[0], f))
      : await send({ Command: 'Draw/CommandList', CommandList: now.map(j => packet(j, f)) });
    if (!isOk(r)) throw new Error('Device error: ' + JSON.stringify(r));
  }
}

// ---------- feeds: a plugin's screens kept up to date ----------
// A plugin's render() returns { speed, parts: [{ key, jobs: [{ screen, frames, x? }] }] } — see PLUGINS.md.
let sent = {};             // screen -> key of what's on it, so only changed screens are re-sent

// Updates run one at a time; requests that arrive meanwhile are merged into one more pass.
// onError gets the error if this request's pass fails (the returned promise never rejects).
let running = null, pending = null;
function update(what = st.feed, once = false, onError = null) {
  if (!what) return Promise.resolve();
  if (!(pending && pending.once && !once)) pending = { what, once, onError };  // a feed refresh never replaces a one-off send
  if (!running) running = (async () => {
    while (pending) {
      const job = pending; pending = null;
      if (!job.once && job.what !== st.feed) continue;  // feed switched off meanwhile
      try {
        const { speed, parts } = await host.render(job.what);
        const changed = parts.filter(p => sent[p.jobs[0].screen] !== p.key);
        if (changed.length) {
          await sendScreens(changed.flatMap(p => p.jobs), speed);
          changed.forEach(p => { sent[p.jobs[0].screen] = p.key; });
        }
      } catch (e) {
        log(`Updating ${job.what} failed:`, e.message);
        sent = {};
        if (job.onError) job.onError(e);
      }
    }
    running = null;
  })();
  return running;
}

function setFeed(feed) {
  const old = st.feed;
  st.feed = feed || null; save();
  sent = {};
  if (old) host.live(old, false);
  if (st.feed) { host.live(st.feed, true); log(`Keeping ${st.feed} updated.`); update(); }
}

// Show something once. Anything other than the current feed replaces it.
async function sendOnce(what) {
  if (!host.hasFeed(what)) throw new Error(`Nothing called "${what}" to show`);
  if (st.feed !== what) setFeed(null);
  stopTimerRepeat(); tmShown = false;
  sent = {};
  let err = null;
  await update(what, true, e => { err = e; });
  if (err) throw err;
}

// A plugin calls this (tg.update) when its data changes.
function feedChanged(id) { if (st.feed === id) update(); }

// ---------- device alerts for plugins ----------
const EDGE_OFF = { Command: 'Channel/SetRGBInfo', SelectLightIndex: 1, Brightness: 100, OnOff: 0, Color: '#ff5500', ColorCycle: 0,
  LightList: [{ SelectEffect: 0 }, { SelectEffect: 0 }, { SelectEffect: 0 }] };
let edgeTimer = null;

function beep({ on = 150, off = 100, total = 500 } = {}) {
  return send({ Command: 'Device/PlayBuzzer', ActiveTimeInCycle: on, OffTimeInCycle: off, PlayTotalTime: total }).catch(() => {});
}
// Rainbow edge light for a while (2 minutes by default), then back to what the page last set.
// Another alert restarts the wait.
function edgeAlert(ms = 2 * 60 * 1000) {
  clearTimeout(edgeTimer);
  edgeTimer = setTimeout(() => { edgeTimer = null; send(st.edge || EDGE_OFF).catch(() => {}); }, ms);
  const color = (st.edge && st.edge.Color) || '#ff5500';
  send({ Command: 'Channel/SetRGBInfo', SelectLightIndex: 1, Brightness: 100, OnOff: 1, Color: color, ColorCycle: 1,
    LightList: [{ SelectEffect: 0 }, { SelectEffect: 10, Color: color, ColorCycle: 1 }, { SelectEffect: 0 }] }).catch(() => {});
}
function cancelEdgeAlert() { clearTimeout(edgeTimer); edgeTimer = null; }

// ---------- countdown timer label ----------
// The device runs the countdown; when time is up, screen 2 flashes the label. The device's alarm
// then shows "End", so the flash is re-sent every 15 s for 3 minutes (other content stops that).
let tmEnd = null, tmRepeat = null, tmShown = false;

function timerStart(ms, label) {
  timerCancel();
  label = String(label || '').trim().slice(0, 40);
  st.timer = label && ms > 0 ? { label, endsAt: Date.now() + ms } : null;
  save();
  if (st.timer) scheduleTimer();
}
function scheduleTimer() {
  const t = st.timer;
  tmEnd = setTimeout(() => timerDone(t.label), Math.max(0, t.endsAt - Date.now()));
}
function timerDone(label) {
  tmEnd = null; st.timer = null; save();
  setFeed(null);
  const frames = timerDoneFrames(label), until = Date.now() + 3 * 60 * 1000;
  const show = () => { tmShown = true; sendScreens([{ screen: 1, frames }], TM_SPEED).catch(e => log('Timer flash failed:', e.message)); };
  log(`Timer "${label}" is done.`);
  show();
  tmRepeat = setInterval(() => Date.now() > until ? stopTimerRepeat() : show(), 15000);
}
function stopTimerRepeat() { clearInterval(tmRepeat); tmRepeat = null; }
function timerCancel() { clearTimeout(tmEnd); tmEnd = null; stopTimerRepeat(); }
async function timerStop() {
  timerCancel();
  st.timer = null; save();
  if (tmShown) { tmShown = false; await sendScreens([{ screen: 1, frames: [blankFrame()] }], 1000); }
}

// ---------- light show (backlight to a beat) ----------
let showTimer = null, showBusy = false, showBeat = 0;
function hsv(h, s, v) {
  h = (h - Math.floor(h)) * 6;
  const i = Math.floor(h), f = h - i, p = v * (1 - s), q = v * (1 - s * f), u = v * (1 - s * (1 - f));
  return [[v, u, p], [q, v, p], [p, v, u], [p, q, v], [u, p, v], [v, p, q]][i % 6].map(c => c * 255 | 0);
}
const hex = rgb => '#' + rgb.map(c => c.toString(16).padStart(2, '0')).join('');
function showColour() {
  const o = st.lightShow;
  showBeat++;
  if (o.mode === 'rainbow') return hsv(showBeat / 12, 1, 1);
  if (o.mode === 'pulse') {
    const rgb = [1, 3, 5].map(i => parseInt(o.color.slice(i, i + 2), 16));
    return showBeat % 2 ? rgb : rgb.map(c => 255 - c);
  }
  return hsv(Math.random(), 1, 1);
}
async function showStep() {
  if (showBusy || !st.lightShow) return;  // never queue requests up if the device is slow
  showBusy = true;
  const colour = hex(showColour());
  await send({ Command: 'Channel/SetRGBInfo', SelectLightIndex: 2, Brightness: 100, OnOff: 1, Color: colour, ColorCycle: 0,
    LightList: [{ SelectEffect: 0 }, { SelectEffect: 3 }, { SelectEffect: 5, Color: colour, ColorCycle: 0 }] }).catch(() => {});
  showBusy = false;
}
function startLightShow(o) {
  clearInterval(showTimer);
  if (host) host.pageCommand({ Command: 'Engine/LightShow' });
  const bpm = Math.max(30, Math.min(240, Number(o.bpm) || 120));
  st.lightShow = st.lastShow = { bpm, mode: String(o.mode || 'random'), color: /^#[0-9a-f]{6}$/i.test(o.color) ? o.color : '#ff5500' };
  save();
  showStep();
  showTimer = setInterval(showStep, 60000 / bpm);
}
function stopLightShow() {
  clearInterval(showTimer); showTimer = null;
  if (st.lightShow) { st.lightShow = null; save(); }
}

// ---------- built-in actions (for buttons; listed with the plugins' actions) ----------
// Each sends what the page would, through observe(), so everything stays in step.
const pageSend = p => send(p, true);
const score = (red, blue) => pageSend({ Command: 'Tools/SetScoreBoard', RedScore: Math.max(0, Math.min(999, red)), BlueScore: Math.max(0, Math.min(999, blue)) });
const bright = v => pageSend({ Command: 'Channel/SetBrightness', Brightness: Math.max(0, Math.min(100, v)) });
async function timer(minutes) {
  await pageSend({ Command: 'Tools/SetTimer', Minute: minutes, Second: 0, Status: 1 });
  timerStart(minutes * 60000, '');
}
function cycleFeed(dir) {
  const feeds = host.feedIds();
  if (!feeds.length) return;
  const i = feeds.indexOf(st.feed);
  const next = i < 0 ? (dir > 0 ? 0 : feeds.length - 1) : (i + dir + feeds.length) % feeds.length;
  setFeed(feeds[next]);
}
const CORE_ACTIONS = {
  'core.next':        ['Screens: next feature', () => cycleFeed(1)],
  'core.prev':        ['Screens: previous feature', () => cycleFeed(-1)],
  'core.brightUp':    ['Brightness up', () => bright(st.brightness + 10)],
  'core.brightDown':  ['Brightness down', () => bright(st.brightness - 10)],
  'core.screen':      ['Screen on/off', () => pageSend({ Command: 'Channel/OnOffScreen', OnOff: st.screenOn ? 0 : 1 })],
  'core.beep':        ['Beep', () => beep({ on: 150, off: 100, total: 300 })],
  'core.redUp':       ['Score: Red +1', () => score(st.score.red + 1, st.score.blue)],
  'core.redDown':     ['Score: Red −1', () => score(st.score.red - 1, st.score.blue)],
  'core.blueUp':      ['Score: Blue +1', () => score(st.score.red, st.score.blue + 1)],
  'core.blueDown':    ['Score: Blue −1', () => score(st.score.red, st.score.blue - 1)],
  'core.scoreReset':  ['Score: reset', () => score(0, 0)],
  'core.timer1':      ['Timer: 1 minute', () => timer(1)],
  'core.timer5':      ['Timer: 5 minutes', () => timer(5)],
  'core.timer10':     ['Timer: 10 minutes', () => timer(10)],
  'core.timer25':     ['Timer: 25 minutes', () => timer(25)],
  'core.timerStop':   ['Timer: stop', async () => { await pageSend({ Command: 'Tools/SetTimer', Minute: 0, Second: 0, Status: 0 }); await timerStop(); }],
  'core.lightShow':   ['Light show on/off', () => st.lightShow ? stopLightShow() : startLightShow(st.lastShow || { bpm: 120, mode: 'random' })],
};
const coreActions = () => Object.entries(CORE_ACTIONS).map(([id, [label]]) => ({ id, plugin: 'core', label }));
function runCoreAction(id) {
  const a = CORE_ACTIONS[id];
  if (!a) throw Object.assign(new Error(`No action "${id}"`), { status: 404 });
  return a[1]();
}

// ---------- page API ----------
function state() {
  const { device, feed, noise, lightShow, timer, score, brightness, screenOn } = st;
  return { deviceKnown: !!device, feed, noise, lightShow, timer, score, brightness, screenOn, plugins: host ? host.states() : {} };
}
function setOptions(o) {
  if ('feed' in o && o.feed !== st.feed) setFeed(o.feed && host.hasFeed(o.feed) ? o.feed : null);
}

function init(pluginHost) {
  host = pluginHost;
  // Carry on with whatever was running before the restart.
  if (st.timer && st.timer.endsAt > Date.now()) scheduleTimer();
  else if (st.timer) { st.timer = null; save(); }
  if (st.lightShow) startLightShow(st.lightShow);
  if (st.feed) {
    const feed = st.feed;
    st.feed = null;
    setTimeout(() => { if (host.hasFeed(feed)) setFeed(feed); else save(); }, 3000);
  }
}

module.exports = { init, send, learnDevice, nextPicId, resetPicId, state, setOptions, sendOnce, feedChanged,
  beep, edgeAlert, timerStart, timerStop, startLightShow, stopLightShow, coreActions, runCoreAction };
