// Vinyl panel: start/stop, status, budget and options, recent records, previews.
(() => {
  const p = TG.plugin('vinyl');
  const $p = sel => p.el(sel);
  let st = null;
  const art = new Map();

  async function loadArt(url) {
    if (!url) return null;
    if (!art.has(url)) {
      const img = await new Promise((res, rej) => {
        const i = new Image(); i.onload = () => res(i); i.onerror = rej;
        i.src = '/api/vinyl/art?u=' + encodeURIComponent(url);
      }).catch(() => null);
      if (!img) return null;
      art.set(url, vnArtColours(img));
    }
    return art.get(url);
  }

  p.preview = async () => st && renderVinyl(st.track, st.track ? await loadArt(st.track.art) : null, st.active ? st.status : 'Switched off');

  const call = async (path, body) => { try { apply(await p.api(path, body)); } catch (e) { log('Vinyl: ' + e.message, 'e'); $p('#vnStatus').textContent = e.message; } };

  function apply(s) {
    const firstTrack = !st || (s.track && (!st.track || st.track.title !== s.track.title));
    st = s;
    $p('#vnSetup').hidden = s.hasToken;
    $p('#vnTokenNote').textContent = s.hasToken ? 'To change the AudD token, open this page on the computer running the controller, or one it trusts.' : '';
    $p('#vnToggle').textContent = s.active ? 'Stop listening' : 'Start listening';
    $p('#vnToggle').disabled = !s.hasToken;
    $p('#vnNow').disabled = !s.hasToken || s.phase === 'identifying';
    const off = s.active && s.until ? ` (until ${new Date(s.until).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })})` : '';
    $p('#vnStatus').textContent = s.status + off;
    $p('#vnUsage').textContent = `${s.used} of ${s.cap} requests used this month.`;
    if (document.activeElement !== $p('#vnCap')) $p('#vnCap').value = s.cap;
    $p('#vnAutoOff').value = s.autoOffMin;
    $p('#vnAutoShow').checked = s.autoShow;
    const h = $p('#vnHistory');
    h.innerHTML = s.history.length ? '<table class="wx"></table>' : '';
    for (const t of s.history) {
      const tr = document.createElement('tr');
      tr.innerHTML = '<td></td><td></td><td class="hint"></td>';
      tr.children[0].textContent = t.title;
      tr.children[1].textContent = t.artist + (t.album ? ' — ' + t.album : '');
      tr.children[2].textContent = new Date(t.at).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' });
      h.firstChild.append(tr);
    }
    if (firstTrack && s.track) p.runPreview().catch(() => {});
    syncWave();
  }
  p.onState(apply);

  // Live waveform while it's listening or identifying: only on this page, never on the Times Gate.
  // The server streams peaks (one per 23 ms) and the latest 23 ms of sound (/api/vinyl/wave).
  const WAVE_LEN = 400;  // about 9 seconds of peaks
  let es = null, hist = [];
  function syncWave() {
    const want = !!st && (st.active || st.phase === 'identifying') && !document.hidden;
    if (want && !es) {
      es = new EventSource('/api/vinyl/wave');
      es.onmessage = e => { try { drawWave(JSON.parse(e.data)); } catch {} };
      $p('#vnWaveBox').hidden = false;
    } else if (!want && es) {
      es.close(); es = null; hist = [];
      $p('#vnWaveBox').hidden = true;
    }
  }
  document.addEventListener('visibilitychange', syncWave);

  function fitCanvas(c) {  // sharp on high-density screens
    const r = devicePixelRatio || 1, w = Math.round(c.clientWidth * r), h = Math.round(c.clientHeight * r);
    if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
    return r;
  }
  function drawWave(m) {
    for (const v of m.peaks) hist.push({ v, clip: m.phase === 'identifying' });
    if (hist.length > WAVE_LEN) hist.splice(0, hist.length - WAVE_LEN);
    const css = getComputedStyle(document.documentElement), col = n => css.getPropertyValue(n).trim();
    const accent = col('--accent'), ink = col('--ink'), muted = col('--muted');

    // Scrolling history, mirrored around the middle. Square root so quiet passages still show.
    const c = $p('#vnWave'), r = fitCanvas(c), g = c.getContext('2d'), W = c.width, H = c.height, mid = H / 2;
    g.clearRect(0, 0, W, H);
    const bw = W / WAVE_LEN;
    hist.forEach((h, i) => {
      const x = W - (hist.length - i) * bw, a = Math.max(r, Math.sqrt(h.v / 100) * (mid - 2 * r));
      g.fillStyle = h.clip ? accent : muted;
      g.fillRect(x, mid - a, Math.max(r, bw - (bw > 3 ? r : 0)), a * 2);
    });

    // The sound right now, scaled up so quiet sound is visible.
    const s = $p('#vnScope'), q = s.getContext('2d');
    fitCanvas(s);
    q.clearRect(0, 0, s.width, s.height);
    if (m.scope.length) {
      const max = Math.max(6, ...m.scope.map(Math.abs));
      q.strokeStyle = m.phase === 'identifying' ? accent : ink; q.lineWidth = 1.5 * r; q.lineJoin = 'round';
      q.beginPath();
      m.scope.forEach((v, i) => {
        const x = i / (m.scope.length - 1) * s.width, y = s.height / 2 - v / max * (s.height / 2 - 3 * r);
        i ? q.lineTo(x, y) : q.moveTo(x, y);
      });
      q.stroke();
    }
    $p('#vnWaveInfo').textContent = m.db > -98
      ? `${m.phase === 'identifying' ? 'Recording a clip for AudD (orange)' : 'Listening'} · ${m.db} dB`
      : 'Microphone off';
  }

  $p('#vnToggle').onclick = () => call(st && st.active ? 'off' : 'on', {});
  // Poll faster while it's listening, so "Listening… / Identifying…" and the result show promptly.
  $p('#vnNow').onclick = async () => {
    await call('now', {});
    for (let i = 0; i < 20 && st && st.phase === 'identifying'; i++) {
      await new Promise(r => setTimeout(r, 1000));
      try { apply(await (await fetch('/api/engine/state')).json().then(s => s.plugins.vinyl)); } catch {}
    }
  };
  $p('#vnSaveToken').onclick = () => { call('options', { token: $p('#vnToken').value }); $p('#vnToken').value = ''; };
  $p('#vnAutoOff').onchange = e => call('options', { autoOffMin: Number(e.target.value) });
  $p('#vnCap').onchange = e => call('options', { cap: Number(e.target.value) });
  $p('#vnAutoShow').onchange = e => call('options', { autoShow: e.target.checked });
})();
