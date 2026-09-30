// Shared animation plumbing: uploading per-screen frame loops to the device, animating the
// on-page screen tiles, and decoding animated GIFs.
// Relies on globals from index.html: $, cmd, log, previews, mask, nextPicId, tileJpeg.

// A "job" is { screen: 0-4, frames: [canvas...], x: offset of this screen's 128px tile in each frame }.
// Frames can be 128-wide tiles (x = 0) or a 640-wide strip covering all five screens (x = screen * 128).

const isOk = r => !r.error && (r.error_code === 0 || r.error_code === undefined || r.error_code === 'DeviceToken is err');

// Upload modes (Settings → Multi-screen upload):
//  batch       one Draw/CommandList per frame carrying every screen — screens finish together, so they stay in sync
//  interleave  frame 0 for every screen, then frame 1 … — screens finish close together
//  sequential  one screen at a time — most compatible, but screens start at different moments
// (The server's engine sees these uploads and stops whatever it was keeping updated on the screens.)
async function sendScreens(jobs, speed, progress = () => {}) {
  let mode = $('uploadMode').value;
  if (jobs.length === 1 && mode === 'batch') mode = 'sequential';
  const N = Math.max(...jobs.map(j => j.frames.length));
  for (;;) {
    const ids = {};
    for (const j of jobs) ids[j.screen] = await nextPicId();
    const packet = (j, f) => ({ Command: 'Draw/SendHttpGif', LcdArray: mask([j.screen]), PicNum: j.frames.length,
      PicWidth: 128, PicOffset: f, PicID: ids[j.screen], PicSpeed: speed, PicData: tileJpeg(j.frames[f], j.x || 0) });

    if (mode === 'batch') {
      let failed = false;
      for (let f = 0; f < N; f++) {
        const r = await cmd({ Command: 'Draw/CommandList', CommandList: jobs.filter(j => f < j.frames.length).map(j => packet(j, f)) }, true);
        if (!isOk(r)) { failed = true; break; }
        progress((f + 1) / N);
      }
      if (!failed) return;
      log('This device did not accept batched uploads — switching to interleaved.', 'e');
      $('uploadMode').value = mode = 'interleave';
      continue;  // start again with fresh PicIDs
    }

    const total = jobs.reduce((n, j) => n + j.frames.length, 0);
    let done = 0;
    if (mode === 'interleave') {
      for (let f = 0; f < N; f++) for (const j of jobs) {
        if (f < j.frames.length) { await cmd(packet(j, f), true); progress(++done / total); }
      }
    } else {
      for (const j of jobs) for (let f = 0; f < j.frames.length; f++) { await cmd(packet(j, f), true); progress(++done / total); }
    }
    return;
  }
}

// ---------- on-page tile animation (one animator shared by every feature) ----------
let tileTimer = null;
function playTiles(jobs, speed) {
  stopTiles();
  let k = 0;
  const show = () => {
    for (const j of jobs) {
      const fr = j.frames[k % j.frames.length];
      previews[j.screen].getContext('2d').drawImage(fr, j.x || 0, 0, 128, 128, 0, 0, 128, 128);
    }
    k++;
  };
  show();
  if (Math.max(...jobs.map(j => j.frames.length)) > 1) tileTimer = setInterval(show, speed);
}
function stopTiles() { clearInterval(tileTimer); tileTimer = null; }

// Jobs for a 640-wide strip, limited to the given screens.
const stripJobs = (frames, screens = [0, 1, 2, 3, 4]) => screens.map(s => ({ screen: s, frames, x: s * 128 }));

// ---------- GIF decoding ----------
// Returns { frames: [canvas], speed } with at most maxFrames frames (evenly sampled), or null if the
// browser can't decode animations (ImageDecoder is available in Chrome and Edge).
async function decodeGif(file, maxFrames = 40) {
  if (!('ImageDecoder' in window)) return null;
  const dec = new ImageDecoder({ data: await file.arrayBuffer(), type: 'image/gif' });
  await dec.tracks.ready;
  const count = dec.tracks.selectedTrack.frameCount;
  const step = Math.max(1, Math.ceil(count / maxFrames));
  const frames = [];
  let dur = 0;
  for (let i = 0; i < count; i += step) {
    const { image } = await dec.decode({ frameIndex: i });
    const c = document.createElement('canvas');
    c.width = image.displayWidth; c.height = image.displayHeight;
    c.getContext('2d').drawImage(image, 0, 0);
    dur += image.duration || 100000;  // microseconds
    image.close();
    frames.push(c);
  }
  dec.close();
  const speed = Math.max(20, Math.min(2000, Math.round(dur / frames.length / 1000 * step)));
  return { frames, speed };
}
