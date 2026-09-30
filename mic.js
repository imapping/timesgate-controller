// The microphone, shared by plugins. It only runs while something is using it: plugins call
// listen() (beats and levels, ~43 times a second) or record() (a short WAV clip), and the capture
// process is stopped as soon as the last one lets go. Nothing is saved to disk.
// Windows: ffmpeg (DirectShow). Linux / Raspberry Pi: arecord (ALSA), or ffmpeg if arecord is missing.

const fs = require('fs');
const path = require('path');
const { spawn, execFile } = require('child_process');

const RATE = 22050;           // samples per second, mono 16-bit
const HOP = 512;              // samples per analysis frame (~23 ms)
const CONF_FILE = path.join(__dirname, 'data', 'mic.json');
const WIN = process.platform === 'win32';

let conf = { device: null };
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
      return execFile(arecord, ['-L'], (err, out) => {
        const list = [];
        (out || '').split('\n').forEach((line, i, all) => {
          if (/^(default|plughw|sysdefault|hw):/.test(line) || line === 'default')
            list.push({ id: line.trim(), name: `${(all[i + 1] || '').trim()} (${line.trim()})` });
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
  if (arecord) return [arecord, ['-q', '-D', device || 'default', '-f', 'S16_LE', '-c', '1', '-r', String(RATE), '-t', 'raw']];
  const ff = findFfmpeg();
  if (!ff) throw new Error(WIN ? 'ffmpeg is not installed (winget install Gyan.FFmpeg)' : 'Install alsa-utils (arecord) or ffmpeg');
  const input = WIN ? ['-f', 'dshow', '-audio_buffer_size', '50', '-i', `audio=${device}`] : ['-f', 'alsa', '-i', device || 'default'];
  return [ff, ['-hide_banner', '-loglevel', 'error', ...input, '-ac', '1', '-ar', String(RATE), '-f', 's16le', '-']];
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
const recorders = new Set();  // { chunks, need, got, resolve }

function start() {
  if (proc || restartTimer) return;
  let cmd;
  try { cmd = captureCommand(conf.device || (WIN ? defaultWinDevice : null)); }
  catch (e) { error = e.message; return; }
  if (WIN && !conf.device && !defaultWinDevice) { error = 'Choose a microphone first'; return; }
  error = null; analyse = makeAnalyser(); pending = Buffer.alloc(0);
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
const inUse = () => listeners.size > 0 || recorders.size > 0;

function onData(buf) {
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
    const fr = analyse(all.subarray(f * HOP, (f + 1) * HOP), sens);
    last = fr;
    for (const l of listeners.values()) { try { l.fn(fr); } catch (e) { log(`${l.who}:`, e.message); } }
  }
  pending = pending.subarray(frames * HOP * 2);
  if (!inUse()) stop();
}

function wav(pcm) {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(RATE, 24); h.writeUInt32LE(RATE * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

// ---------- API ----------
let nextToken = 1;
// fn({ t, level 0..1, db, beat, bpm }) about 43 times a second. Returns a function that stops listening.
// opts.sensitivity 0..1 (beat detection; higher = more beats).
function listen(fn, who = '?', opts = {}) {
  const token = nextToken++;
  listeners.set(token, { fn, who, sensitivity: opts.sensitivity });
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
  return { running: !!proc, error, device: conf.device || defaultWinDevice || 'default', users: [...new Set([...listeners.values()].map(l => l.who))],
    recording: recorders.size > 0, level: last.level, db: last.db, bpm: last.bpm,
    tool: findArecord() ? 'arecord' : findFfmpeg() ? 'ffmpeg' : null };
}

function setDevice(device) {
  conf.device = device ? String(device).slice(0, 200) : null; saveConf();
  if (proc) { const p = proc; proc = null; p.kill(); }
  clearTimeout(restartTimer); restartTimer = null;
  if (inUse()) start();  // carry on with the new device
}

// On Windows there's no "default" DirectShow device, so pick one that looks like a microphone.
let defaultWinDevice = null;
if (WIN && !conf.device) devices().then(list => {
  const pick = list.find(d => /microphone|mic|yeti/i.test(d.name)) || list[0];
  if (pick) defaultWinDevice = pick.id;
});

module.exports = { listen, record, status, devices, setDevice, RATE, makeAnalyser, HOP };
