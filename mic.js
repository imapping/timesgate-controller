// The microphone (or a direct input such as a turntable), shared by plugins. It only runs while
// something is using it: plugins call listen() (beats and levels, ~43 times a second) or record() (a
// short WAV clip), and the capture process is stopped as soon as the last one lets go. Nothing is
// saved to disk.
// The capture is 44.1 kHz stereo, which the full-quality live stream passes on as it is. Everything
// else (analysis, clips, the mono stream) uses mono at 22.05 kHz, made by averaging each pair of
// stereo frames.
// Windows: ffmpeg (DirectShow). Linux / Raspberry Pi: arecord (ALSA), or ffmpeg if arecord is missing.

const fs = require('fs');
const path = require('path');
const { spawn, execFile } = require('child_process');

const RATE = 22050;           // samples per second, mono 16-bit: what plugins get
const CAP_RATE = RATE * 2, CAP_CH = 2;   // what's captured: 44.1 kHz stereo
const CAP_BLOCK = CAP_CH * 2 * 2;        // bytes that make one mono sample: two stereo frames
const HOP = 512;              // samples per analysis frame (~23 ms)
const CONF_FILE = path.join(__dirname, 'data', 'mic.json');
const WIN = process.platform === 'win32';

// shared: the devices marked as a direct connection (a turntable or line-in, not a room microphone),
// which any device on the network may listen to live.
let conf = { device: null, shared: {} };
try { conf = { ...conf, ...JSON.parse(fs.readFileSync(CONF_FILE, 'utf8')) }; } catch {}
const saveConf = () => { fs.mkdirSync(path.dirname(CONF_FILE), { recursive: true }); fs.writeFileSync(CONF_FILE, JSON.stringify(conf, null, 2)); };
const log = (...a) => console.log(new Date().toLocaleTimeString(), '[mic]', ...a);

// ---------- finding the capture tool ----------
function findFfmpeg() {
  if (process.env.FFMPEG && fs.existsSync(process.env.FFMPEG)) return process.env.FFMPEG;
  const exe = WIN ? 'ffmpeg.exe' : 'ffmpeg';
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    const f = path.join(dir, exe);
    if (dir && fs.existsSync(f)) return f;
  }
  if (WIN) {  // installed by winget (not on PATH until the next logon)
    const pk = path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WinGet', 'Packages');
    try {
      for (const d of fs.readdirSync(pk).filter(d => /ffmpeg/i.test(d)))
        for (const sub of fs.readdirSync(path.join(pk, d))) {
          const f = path.join(pk, d, sub, 'bin', 'ffmpeg.exe');
          if (fs.existsSync(f)) return f;
        }
    } catch {}
  }
  return null;
}
const findArecord = () => (!WIN && ['/usr/bin/arecord', '/bin/arecord'].find(f => fs.existsSync(f))) || null;

// The recording devices, for the page's picker: [{ id, name }]
function devices() {
  return new Promise(resolve => {
    const arecord = findArecord();
    if (arecord) {
      // arecord lists each mic several ways (hw, plughw, default, sysdefault…). Keep one per mic:
      // plughw, which converts the rate and channels to what the controller asks for.
      return execFile(arecord, ['-L'], (err, out) => {
        const list = [];
        (out || '').split('\n').forEach((line, i, all) => {
          const m = /^plughw:CARD=([^,\s]+),DEV=(\d+)/.exec(line);
          if (!m) return;
          const desc = (all[i + 1] || '').trim().split(',')[0] || m[1];  // "Yeti Stereo Microphone, USB Audio" → the first part
          list.push({ id: line.trim(), name: desc + (m[2] !== '0' ? ` (input ${Number(m[2]) + 1})` : '') });
        });
        resolve(list);
      });
    }
    const ff = findFfmpeg();
    if (!ff || !WIN) return resolve([]);
    execFile(ff, ['-hide_banner', '-list_devices', 'true', '-f', 'dshow', '-i', 'dummy'], (err, out, errOut) => {
      const list = [];
      for (const m of String(errOut).matchAll(/"([^"]+)" \(audio\)/g)) list.push({ id: m[1], name: m[1] });
      resolve(list);
    });
  });
}

function captureCommand(device) {
  const arecord = findArecord();
  if (arecord) return [arecord, ['-q', '-D', device || 'default', '-f', 'S16_LE', '-c', String(CAP_CH), '-r', String(CAP_RATE), '-t', 'raw']];
  const ff = findFfmpeg();
  if (!ff) throw new Error(WIN ? 'ffmpeg is not installed (winget install Gyan.FFmpeg)' : 'Install alsa-utils (arecord) or ffmpeg');
  const input = WIN ? ['-f', 'dshow', '-audio_buffer_size', '50', '-i', `audio=${device}`] : ['-f', 'alsa', '-i', device || 'default'];
  return [ff, ['-hide_banner', '-loglevel', 'error', ...input, '-ac', String(CAP_CH), '-ar', String(CAP_RATE), '-f', 's16le', '-']];
}

// ---------- analysis: level and beats ----------
// Beats come from bass energy: a low-pass filter (~150 Hz), then a jump well above the average of
// the last second counts as a beat. The tempo is the median gap between recent beats.
function makeAnalyser() {
  const a = Math.exp(-2 * Math.PI * 150 / RATE);
  let lp = 0, levelSmooth = 0, lastBeat = 0, t = 0;
  const hist = [], gaps = [];
  let bpm = null, bpmSmooth = null;
  return (samples, sensitivity = 0.5) => {
    let sum = 0, low = 0;
    for (let i = 0; i < samples.length; i++) {
      const x = samples[i] / 32768;
      sum += x * x;
      lp = (1 - a) * x + a * lp;
      low += lp * lp;
    }
    t += samples.length / RATE * 1000;
    const rms = Math.sqrt(sum / samples.length), lowE = low / samples.length;
    const db = 20 * Math.log10(rms + 1e-9);
    const level = Math.max(0, Math.min(1, (db + 60) / 60));
    levelSmooth = Math.max(level, levelSmooth * 0.9);
    const avg = hist.length ? hist.reduce((s, v) => s + v, 0) / hist.length : lowE;
    hist.push(lowE); if (hist.length > 43) hist.shift();
    // sensitivity 0..1 → needs 1.8× .. 1.15× the recent average, above a floor so silence never beats
    const need = 1.8 - 0.65 * sensitivity, floor = 2e-5 * (1.5 - sensitivity);
    let beat = false;
    if (lowE > avg * need && lowE > floor && t - lastBeat > 280) {
      if (lastBeat && t - lastBeat < 1500) {
        gaps.push(t - lastBeat); if (gaps.length > 16) gaps.shift();
        if (gaps.length >= 4) {
          // Each gap is only measured to one frame (~23 ms, about ±3 BPM at 120), so average the gaps
          // near the median (dropping missed and doubled beats): the rounding errors cancel out.
          const med = [...gaps].sort((x, y) => x - y)[gaps.length >> 1];
          const near = gaps.filter(g => Math.abs(g - med) < med * 0.15);
          let b = 60000 / (near.reduce((s, g) => s + g, 0) / near.length);
          while (b < 80) b *= 2;
          while (b > 170) b /= 2;
          bpmSmooth = bpmSmooth && Math.abs(b - bpmSmooth) < 8 ? bpmSmooth * 0.7 + b * 0.3 : b;  // settle, but follow a new song at once
          bpm = Math.round(bpmSmooth);
        }
      }
      lastBeat = t; beat = true;
    }
    if (t - lastBeat > 4000) { gaps.length = 0; bpm = null; bpmSmooth = null; }  // music stopped
    return { t, level: levelSmooth, db: Math.round(db), beat, bpm };
  };
}

// ---------- running the capture ----------
const listeners = new Map();  // token -> { fn, who, sensitivity }
let proc = null, restartTimer = null, error = null, last = { level: 0, db: -99, bpm: null }, analyse = null;
let pending = Buffer.alloc(0);
let rawRest = Buffer.alloc(0);   // captured bytes that don't yet make a whole mono sample
const recorders = new Set();  // { chunks, need, got, resolve }
const hqListeners = new Set(); // fn(buffer of whole stereo frames): the full-quality live streams

function start() {
  if (proc || restartTimer) return;
  let cmd;
  try { cmd = captureCommand(device()); }
  catch (e) { error = e.message; return; }
  if (WIN && !device()) { error = 'Choose a microphone first'; return; }
  error = null; analyse = makeAnalyser(); pending = Buffer.alloc(0); rawRest = Buffer.alloc(0);
  const p = proc = spawn(cmd[0], cmd[1], { windowsHide: true });
  log('Listening.');
  let errText = '';
  p.stderr.on('data', d => { errText = (errText + d).slice(-500); });
  p.stdout.on('data', onData);
  p.on('error', e => { error = e.message; });
  p.on('close', code => {
    if (proc !== p) return;
    proc = null;
    if (!inUse()) return;
    error = (errText.trim().split('\n').pop() || `capture stopped (${code})`).slice(0, 200);
    log('Capture stopped:', error, '— retrying in 5 s.');
    restartTimer = setTimeout(() => { restartTimer = null; if (inUse()) start(); }, 5000);
  });
}
function stop() {
  clearTimeout(restartTimer); restartTimer = null;
  if (proc) { const p = proc; proc = null; p.kill(); log('Stopped (nothing is using it).'); }
  last = { level: 0, db: -99, bpm: null };
}
const inUse = () => listeners.size > 0 || recorders.size > 0 || hqListeners.size > 0;

// The capture's stereo bytes: pass whole frames to the full-quality streams, and turn them into mono.
function onData(buf) {
  const raw = rawRest.length ? Buffer.concat([rawRest, buf]) : buf;
  const n = Math.floor(raw.length / CAP_BLOCK);
  rawRest = raw.subarray(n * CAP_BLOCK);
  if (!n) return;
  if (hqListeners.size) { const whole = raw.subarray(0, n * CAP_BLOCK); for (const fn of hqListeners) fn(whole); }
  // One mono sample per two stereo frames: the average of their four values (L, R, L, R).
  const mono = Buffer.allocUnsafe(n * 2);
  for (let i = 0, o = 0; i < n; i++, o += CAP_BLOCK)
    mono.writeInt16LE((raw.readInt16LE(o) + raw.readInt16LE(o + 2) + raw.readInt16LE(o + 4) + raw.readInt16LE(o + 6)) >> 2, i * 2);
  onMono(mono);
}

function onMono(buf) {
  for (const r of recorders) {
    const take = Math.min(buf.length, r.need - r.got);
    if (take > 0) { r.chunks.push(Buffer.from(buf.subarray(0, take))); r.got += take; }
    if (r.got >= r.need) { recorders.delete(r); r.resolve(wav(Buffer.concat(r.chunks))); }
  }
  pending = pending.length ? Buffer.concat([pending, buf]) : buf;
  const whole = pending.length - (pending.length % 2);
  const all = new Int16Array(pending.buffer.slice(pending.byteOffset, pending.byteOffset + whole));
  // analyse in HOP-sized frames, keep the remainder for next time
  const frames = Math.floor(all.length / HOP);
  const sens = listeners.size ? Math.max(...[...listeners.values()].map(l => l.sensitivity ?? 0.5)) : 0.5;
  for (let f = 0; f < frames; f++) {
    const samples = all.subarray(f * HOP, (f + 1) * HOP);
    const fr = analyse(samples, sens);
    last = fr;
    for (const l of listeners.values()) { try { l.fn(l.samples ? { ...fr, samples } : fr); } catch (e) { log(`${l.who}:`, e.message); } }
  }
  pending = pending.subarray(frames * HOP * 2);
  if (!inUse()) stop();
}

// A 16-bit WAV header (mono at RATE unless told otherwise). With no length (a live stream) it says
// "as long as possible".
function wavHeader(bytes, rate = RATE, channels = 1) {
  const h = Buffer.alloc(44), n = bytes ?? 0xFFFFFFFF - 36;
  h.write('RIFF', 0); h.writeUInt32LE(36 + n, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(channels, 22);
  h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * channels * 2, 28); h.writeUInt16LE(channels * 2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(n, 40);
  return h;
}
function wav(pcm) { return Buffer.concat([wavHeader(pcm.length), pcm]); }

// Streams the live sound to an HTTP response as a never-ending WAV, until the listener disconnects:
// mono at 22.05 kHz, or with hq the capture itself (44.1 kHz stereo, about 176 KB a second).
// If they fall behind (a slow connection), sound is dropped rather than queued.
// With keep (a recording, hq only) nothing is ever dropped: up to KEEP_MAX is queued for a listener
// that falls behind, and past that the connection is closed, so a recording is whole or visibly cut short.
const KEEP_MAX = 64 * 1024 * 1024;   // about 6 minutes of sound
function stream(req, res, hq = false, keep = false) {
  res.writeHead(200, { 'Content-Type': 'audio/wav', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  if (hq) {
    res.write(wavHeader(undefined, CAP_RATE, CAP_CH));
    const fn = keep
      ? buf => { if (res.writableLength < KEEP_MAX) res.write(buf); else res.destroy(); }
      : buf => { if (res.writableLength < 1024 * 1024) res.write(buf); };
    fn.who = keep ? 'recording' : 'live listening';
    hqListeners.add(fn);
    start();
    req.on('close', () => { hqListeners.delete(fn); if (!inUse()) stop(); });
    return;
  }
  res.write(wavHeader());
  const off = listen(f => {
    if (res.writableLength > 256 * 1024) return;
    res.write(Buffer.from(new Uint8Array(f.samples.buffer, f.samples.byteOffset, f.samples.byteLength)));   // a copy: samples is reused
  }, 'live listening', { samples: true });
  req.on('close', off);
}

// ---------- API ----------
let nextToken = 1;
// fn({ t, level 0..1, db, beat, bpm }) about 43 times a second. Returns a function that stops listening.
// opts.sensitivity 0..1 (beat detection; higher = more beats). opts.samples: also pass the raw
// sound, as `samples` (Int16Array of HOP samples, only valid during the call).
function listen(fn, who = '?', opts = {}) {
  const token = nextToken++;
  listeners.set(token, { fn, who, sensitivity: opts.sensitivity, samples: !!opts.samples });
  start();
  return () => { listeners.delete(token); if (!inUse()) stop(); };
}

// The next `ms` of sound as a WAV file (mono, 16-bit, 22.05 kHz).
function record(ms) {
  return new Promise((resolve, reject) => {
    const r = { chunks: [], need: 2 * Math.round(RATE * Math.min(ms, 30000) / 1000), got: 0, resolve };  // bytes
    recorders.add(r);
    start();
    if (error && !proc) { recorders.delete(r); return reject(new Error(error)); }
    setTimeout(() => { if (recorders.delete(r)) { if (!inUse()) stop(); reject(new Error(error || 'No sound from the microphone')); } }, ms + 8000);
  });
}

function status() {
  return { running: !!proc, error, device: device() || 'default',
    users: [...new Set([...[...listeners.values()].map(l => l.who), ...[...hqListeners].map(fn => fn.who)])],
    recording: recorders.size > 0, level: last.level, db: last.db, bpm: last.bpm,
    tool: findArecord() ? 'arecord' : findFfmpeg() ? 'ffmpeg' : null, shared: isShared() };
}

function setDevice(device) {
  conf.device = device ? String(device).slice(0, 200) : null; foreignDevice = false; saveConf();
  if (proc) { const p = proc; proc = null; p.kill(); }
  clearTimeout(restartTimer); restartTimer = null;
  if (inUse()) start();  // carry on with the new device
}

// Without a chosen device, pick one that looks like a microphone: on Windows there's no "default"
// DirectShow device, and on a Pi "default" is usually the built-in audio rather than the USB mic.
// A saved device this computer doesn't have (e.g. settings copied from Windows to a Pi) is ignored.
let autoDevice = null, foreignDevice = false;
const pickDevice = () => devices().then(list => {
  if (!list.length) return;
  foreignDevice = !!conf.device && !list.some(d => d.id === conf.device);
  // (On Linux the list only holds capture devices, one plughw entry per mic.)
  const pick = list.find(d => /yeti|microphone|mic|usb/i.test(d.name)) || list[0];
  autoDevice = pick ? pick.id : WIN ? autoDevice : null;
});
pickDevice();
// On Linux, listing devices is cheap: look again now and then, for a mic plugged in after startup.
if (!WIN) setInterval(pickDevice, 30 * 1000).unref();
const device = () => (conf.device && !foreignDevice ? conf.device : autoDevice);

// Whether the input in use is marked as a direct connection that anyone on the network may listen to.
const isShared = () => !!(device() && conf.shared && conf.shared[device()]);
function setShared(on) {
  if (!device()) throw Object.assign(new Error('Choose the input first'), { status: 400 });
  conf.shared = { ...(conf.shared || {}) };
  if (on) conf.shared[device()] = true; else delete conf.shared[device()];
  saveConf();
}

module.exports = { listen, record, stream, status, devices, setDevice, isShared, setShared, RATE, makeAnalyser, HOP };
