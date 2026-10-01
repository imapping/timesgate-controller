// Vinyl panel: start/stop, status, budget and options, recent records, previews.
(() => {
  const p = TG.plugin('vinyl');
  const $p = sel => p.el(sel);
  let st = null, changingKeys = false, changingDc = false, learnedOpen = false;   // changingKeys: showing the key fields to replace saved keys
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
    // Which service, and whether each one it needs is set up (the keys stay in the server).
    const usesAudd = s.provider !== 'acr', usesAcr = s.provider !== 'audd';
    if (document.activeElement !== $p('#vnProvider')) $p('#vnProvider').value = s.provider;
    $p('#vnSetup').hidden = !(usesAudd && (!s.auddSet || changingKeys));
    $p('#vnAcrSetup').hidden = !(usesAcr && (!s.acrSet || changingKeys));
    $p('#vnKeys').textContent = [usesAudd && `AudD ${s.auddSet ? '✓' : '(not set up)'}`,
      usesAcr && `ACRCloud ${s.acrSet ? '✓ ' + s.acrHost : '(not set up)'}`].filter(Boolean).join(' · ');
    $p('#vnChangeKeys').style.display = (usesAudd && s.auddSet) || (usesAcr && s.acrSet) ? '' : 'none';
    $p('#vnTokenNote').textContent = s.hasToken ? 'To change keys, open this page on the computer running the controller, or one it trusts.' : '';
    // Settings open by themselves while nothing is set up (or keys are being changed).
    if (!s.hasToken || changingKeys) $p('#vnSettings').open = true;
    $p('#vnCapAudd').style.display = usesAudd ? '' : 'none';
    $p('#vnCapAcr').style.display = usesAcr ? '' : 'none';
    // Records at the wrong speed aren't recognised: say so when matching is failing.
    $p('#vnTip').style.display = /Not recognised|Couldn't identify/.test(s.status) ? '' : 'none';
    $p('#vnToggle').textContent = s.active ? 'Stop listening' : 'Start listening';
    $p('#vnToggle').disabled = !s.hasToken;
    $p('#vnNow').disabled = !s.hasToken || s.phase === 'identifying';
    const off = s.active && s.until ? ` (until ${new Date(s.until).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })})` : '';
    $p('#vnStatus').textContent = s.status + off;
    $p('#vnUsage').textContent = [usesAudd && `AudD: ${s.used} of ${s.cap}`, usesAcr && `ACRCloud: ${s.acrUsed} of ${s.acrCap}`]
      .filter(Boolean).join(' · ') + ' requests used this month.'
      + (s.learn.available && s.learn.saved ? ` Recognised here: ${s.learn.saved.toLocaleString()}.` : '')
      + (s.logged != null ? ` Listening log: ${s.logged.toLocaleString()} plays saved.` : '');
    // The last clip sent to AudD, to hear what it heard.
    $p('#vnClipRow').style.display = s.lastClip ? '' : 'none';
    if (s.lastClip) {
      $p('#vnClipInfo').textContent = `(${new Date(s.lastClip.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}${s.lastClip.cleaned ? ', cleaned up' : ''}${s.lastClip.speedFixed ? `, corrected from ${s.lastClip.speedFixed} RPM` : ''}): ${s.lastClip.outcome}`;
      $p('#vnClipLink').href = '/api/vinyl/clip?t=' + s.lastClip.at;
    }
    if (document.activeElement !== $p('#vnCap')) $p('#vnCap').value = s.cap;
    if (document.activeElement !== $p('#vnAcrCap')) $p('#vnAcrCap').value = s.acrCap;
    $p('#vnAutoOff').value = s.autoOffMin;
    $p('#vnAutoShow').checked = s.autoShow;
    $p('#vnClean').checked = s.cleanClip;
    $p('#vnClipSec').value = String(s.clipSec || 12);
    if (document.activeElement !== $p('#vnRpm')) $p('#vnRpm').value = s.rpm;
    drawPick();
    // Own recognition: what has been learned so far.
    const L = s.learn;
    $p('#vnLearn').checked = L.on; $p('#vnLearn').disabled = !L.available;
    $p('#vnLearnInfo').textContent = !L.available ? 'Not available on this computer (' + (L.error || 'no database') + ').'
      : !L.tracks ? 'Nothing learned yet.'
      : `${L.tracks.toLocaleString()} ${L.tracks === 1 ? 'track' : 'tracks'} learned (${L.minutes >= 120 ? Math.round(L.minutes / 60) + ' hours' : L.minutes + ' min'}, ${L.mb} MB) · recognised here ${L.saved.toLocaleString()} ${L.saved === 1 ? 'time' : 'times'}`;
    $p('#vnLearnShow').style.display = L.tracks || learnedOpen ? '' : 'none';
    $p('#vnLearnShow').textContent = learnedOpen ? 'Hide learned tracks' : 'Show learned tracks';
    $p('#vnLearned').hidden = !learnedOpen;
    // The Discogs collection: how much of it is loaded (the token stays in the server).
    const d = s.discogs;
    $p('#vnDcSetup').hidden = d.set && !changingDc;
    $p('#vnDcInfo').textContent = !d.set ? 'Discogs (not set up)'
      : d.error ? `Discogs: ${d.user} · ${d.error}`
      : !d.records && d.syncing ? `Discogs: ${d.user} · reading the collection…`
      : `Discogs: ${d.user} · ${d.records.toLocaleString()} records` + (d.loaded < d.records ? ` · track lists ${d.loaded} of ${d.records}${d.syncing ? ' (loading…)' : ''}` : ' ✓');
    for (const id of ['#vnDcRefresh', '#vnDcChange', '#vnDcRemove']) $p(id).style.display = d.set ? '' : 'none';
    if (document.activeElement !== $p('#vnDcUser') && !$p('#vnDcUser').value) $p('#vnDcUser').value = d.user;
    const h = $p('#vnHistory');
    h.innerHTML = s.history.length ? '<table class="wx"></table>' : '';
    for (const t of s.history) {
      const tr = document.createElement('tr');
      tr.innerHTML = '<td></td><td></td><td class="hint"></td><td style="width:1%;padding-right:0;white-space:nowrap"></td>';
      // The song on Spotify (saved with each match), or a Spotify search for older ones.
      const link = document.createElement('a');
      link.href = (t.spotify || '').startsWith('https://open.spotify.com/') ? t.spotify
        : 'https://open.spotify.com/search/' + encodeURIComponent(`${t.title} ${t.artist}`);
      link.target = '_blank'; link.rel = 'noopener'; link.title = 'Open in Spotify'; link.style.color = 'inherit';
      link.textContent = t.title;
      tr.children[0].append(link);
      tr.children[1].textContent = t.artist + (t.album ? ' — ' : '');
      if (t.album && (t.discogs || '').startsWith('https://www.discogs.com/release/')) {   // the record in your collection
        const rec = document.createElement('a');
        rec.href = t.discogs; rec.target = '_blank'; rec.rel = 'noopener'; rec.title = 'Your record on Discogs'; rec.style.color = 'inherit';
        rec.textContent = t.album;
        tr.children[1].append(rec, t.pos ? ` (${t.pos})` : '');
      } else if (t.album) tr.children[1].append(t.album);
      tr.children[2].textContent = new Date(t.at).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' }) + (t.own ? ' · own' : '');
      if (t.own) tr.children[2].title = 'Recognised from your own recordings, without a request';
      if (t.picked) { tr.children[2].append(' · chosen'); tr.children[2].title = 'Named from the record and side you chose'; }
      // Your note on this play (it skips, crackles…), kept in the listening log.
      const marks = TG.noteText(t);
      if (marks) { const m = document.createElement('span'); m.className = 'play-note'; m.textContent = marks; tr.children[1].append(m); }
      if ('fav' in t) tr.children[3].append(TG.favButton(t));   // a favourite song (kept in the listening log)
      if (t.id) {
        const nb = document.createElement('button');
        nb.className = 'note-btn'; nb.textContent = marks ? 'Edit note' : 'Note'; nb.title = 'Mark this track: skips, crackles, poor quality… and add a comment';
        nb.onclick = async () => { if (await TG.editNote(t)) apply(await p.api('state')); };
        tr.children[3].append(nb);
      }
      h.firstChild.append(tr);
    }
    if (firstTrack && s.track) p.runPreview().catch(() => {});
    syncWave();
  }
  p.onState(apply);

  // Live waveform while it's listening or identifying: only on this page, never on the Times Gate.
  // The server streams peaks (one per 23 ms) and the shape of the last 70 ms (/api/vinyl/wave).
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

    // The last 70 ms, scaled up so quiet sound is visible: each slice's range as a soft band, and
    // a smooth curve through the averages.
    const s = $p('#vnScope'), q = s.getContext('2d');
    fitCanvas(s);
    const SW = s.width, SH = s.height, n = (m.avg || []).length;
    q.clearRect(0, 0, SW, SH);
    if (n > 1) {
      const color = m.phase === 'identifying' ? accent : ink;
      const max = Math.max(6, ...m.hi, ...m.lo.map(v => -v));
      const X = i => i / (n - 1) * SW, Y = v => SH / 2 - v / max * (SH / 2 - 3 * r);
      q.beginPath();
      m.hi.forEach((v, i) => (i ? q.lineTo(X(i), Y(v)) : q.moveTo(X(i), Y(v))));
      for (let i = n - 1; i >= 0; i--) q.lineTo(X(i), Y(m.lo[i]));
      q.closePath();
      q.globalAlpha = 0.18; q.fillStyle = color; q.fill(); q.globalAlpha = 1;
      q.beginPath(); q.moveTo(X(0), Y(m.avg[0]));
      for (let i = 1; i < n - 1; i++) {  // curve through the midpoints
        const xm = (X(i) + X(i + 1)) / 2, ym = (Y(m.avg[i]) + Y(m.avg[i + 1])) / 2;
        q.quadraticCurveTo(X(i), Y(m.avg[i]), xm, ym);
      }
      q.lineTo(X(n - 1), Y(m.avg[n - 1]));
      q.strokeStyle = color; q.lineWidth = 2 * r; q.lineJoin = q.lineCap = 'round'; q.stroke();
    }
    $p('#vnWaveInfo').textContent = m.db > -98
      ? `${m.phase === 'identifying' ? 'Recording a clip to identify (orange)' : 'Listening'} · ${m.db} dB`
      : 'Microphone off';
  }

  $p('#vnToggle').onclick = () => call(st && st.active ? 'off' : 'on', {});
  // Poll faster while it's listening, so "Listening… / Identifying…" and the result show promptly.
  $p('#vnNow').onclick = async () => {
    await call('now', {});
    for (let i = 0; i < 40 && st && st.phase === 'identifying'; i++) {  // a 12 s clip plus sending
      await new Promise(r => setTimeout(r, 1000));
      try { apply(await (await fetch('/api/engine/state')).json().then(s => s.plugins.vinyl)); } catch {}
    }
  };
  $p('#vnChangeKeys').onclick = () => { changingKeys = !changingKeys; if (st) apply(st); };
  $p('#vnProvider').onchange = e => call('options', { provider: e.target.value });
  $p('#vnSaveToken').onclick = async () => { await call('options', { token: $p('#vnToken').value }); $p('#vnToken').value = ''; changingKeys = false; if (st) apply(st); };
  $p('#vnSaveAcr').onclick = async () => {
    await call('options', { acr: { host: $p('#vnAcrHost').value, key: $p('#vnAcrKey').value, secret: $p('#vnAcrSecret').value } });
    $p('#vnAcrKey').value = $p('#vnAcrSecret').value = ''; changingKeys = false; if (st) apply(st);
  };
  $p('#vnDcSave').onclick = async () => {
    await call('options', { discogs: { user: $p('#vnDcUser').value, token: $p('#vnDcToken').value } });
    $p('#vnDcToken').value = ''; changingDc = false; if (st) apply(st);
  };
  $p('#vnDcChange').onclick = () => { changingDc = !changingDc; if (st) apply(st); };
  $p('#vnDcRefresh').onclick = () => call('discogs', {});
  $p('#vnDcRemove').onclick = () => { if (confirm('Remove your Discogs details and the saved copy of your collection from the controller?')) { $p('#vnDcUser').value = ''; call('options', { discogs: {} }); } };
  // Choosing the record by hand: find it in the Discogs collection and pick a side; then its track list is shown,
  // with what's playing and what's next.
  let records = null, recordsFor = null;
  const sideName = side => (side === '' ? 'Whole record' : /^Disc /.test(side) ? side : 'Side ' + side);
  function drawPick() {
    if (!st) return;
    const c = st.cue, d = st.discogs;
    $p('#vnPickNow').hidden = !c;
    $p('#vnPickFind').hidden = !d.set || !d.records;
    if (!d.set) $p('#vnPickHint').textContent = 'Add your Discogs collection under Settings → Your collection first. Then you can pick the record and side you\u2019re about to play, and its track list names each track: no recognition service needed.';
    if (c) {
      $p('#vnPickTitle').textContent = `${c.artist} — ${c.album}${c.side === '' ? '' : ' · ' + sideName(c.side)}`;
      const box = $p('#vnPickTracks'), playing = st.phase === 'playing' && st.track ? c.index - 1 : -1, key = JSON.stringify([c.id, c.side, c.index, playing]);
      if (box.dataset.key !== key) {
        box.dataset.key = key;
        box.innerHTML = '<table class="wx"></table>';
        c.tracks.forEach((t, i) => {
          const tr = document.createElement('tr');
          tr.innerHTML = '<td style="width:3.5em" class="hint"></td><td></td><td class="hint"></td><td style="width:1%;padding-right:0"><button class="note-btn">This is playing</button></td>';
          tr.children[0].textContent = t.pos;
          tr.children[1].textContent = t.title;
          if (i === playing) tr.children[1].style.fontWeight = '700';
          tr.children[2].textContent = i === playing ? '▶ playing' : i === c.index ? 'next' : i < c.index ? 'played' : '';
          tr.querySelector('button').onclick = () => call('cue', { index: i });
          box.firstChild.append(tr);
        });
      }
    }
    if ($p('#vnPick').open && d.set && recordsFor !== d.loaded) loadRecords();
  }
  async function loadRecords() {
    recordsFor = st.discogs.loaded;
    try { records = (await p.api('records')).records; drawRecords(); } catch (e) { log('Vinyl: ' + e.message, 'e'); }
  }
  function drawRecords() {
    const box = $p('#vnPickList'), words = $p('#vnPickQ').value.toLowerCase().split(/\s+/).filter(Boolean);
    if (!records) return;
    const found = records.filter(r => { const hay = `${r.artist} ${r.title}`.toLowerCase(); return words.every(w => hay.includes(w)); });
    box.innerHTML = found.length ? '<table class="wx"></table>' : `<div class="hint">${records.length ? 'Nothing found.' : 'No records loaded yet.'}</div>`;
    for (const r of found.slice(0, 12)) {
      const tr = document.createElement('tr');
      tr.innerHTML = '<td></td><td></td><td style="white-space:nowrap;text-align:right;padding-right:0"></td>';
      tr.children[0].textContent = r.title + (r.year ? ` (${r.year})` : '');
      tr.children[1].textContent = r.artist;
      for (const sd of r.sides) {
        const b = document.createElement('button');
        b.className = 'note-btn'; b.style.marginLeft = '6px';
        b.textContent = sideName(sd.side); b.title = `${sd.tracks} ${sd.tracks === 1 ? 'track' : 'tracks'}`;
        b.onclick = () => call('cue', { id: r.id, side: sd.side });
        tr.children[2].append(b);
      }
      box.firstChild.append(tr);
    }
    if (found.length > 12) box.append(Object.assign(document.createElement('div'), { className: 'hint', textContent: `Showing 12 of ${found.length}: type more to narrow it down.` }));
  }
  $p('#vnPickQ').oninput = drawRecords;
  $p('#vnPick').ontoggle = () => drawPick();
  $p('#vnPickStop').onclick = () => call('cue', {});

  // The learned tracks (the latest 50, or those matching the search), each with a Forget button.
  function drawLearned(tracks) {
    const box = $p('#vnLearnList');
    box.innerHTML = tracks.length ? '<table class="wx"></table>' : '<div class="hint">Nothing found.</div>';
    for (const t of tracks) {
      const tr = document.createElement('tr');
      tr.innerHTML = '<td></td><td></td><td class="hint"></td><td style="width:1%;padding-right:0"><button class="note-btn">Forget</button></td>';
      tr.children[0].textContent = t.title;
      tr.children[1].textContent = t.artist + (t.album ? ' — ' + t.album : '') + (t.position ? ` (${t.position})` : '');
      tr.children[2].textContent = `${Math.floor(t.secs / 60)}:${String(Math.round(t.secs % 60)).padStart(2, '0')} learned`;
      tr.querySelector('button').onclick = async () => {
        try { const r = await p.api('forget', { id: t.id, q: $p('#vnLearnQ').value }); drawLearned(r.tracks); apply(r); } catch (e) { log('Vinyl: ' + e.message, 'e'); }
      };
      box.firstChild.append(tr);
    }
  }
  const loadLearned = async () => { try { drawLearned((await p.api('learned?q=' + encodeURIComponent($p('#vnLearnQ').value))).tracks); } catch (e) { log('Vinyl: ' + e.message, 'e'); } };
  $p('#vnLearn').onchange = e => call('options', { learn: e.target.checked });
  $p('#vnLearnShow').onclick = () => { learnedOpen = !learnedOpen; if (st) apply(st); if (learnedOpen) loadLearned(); };
  let learnTimer = null;
  $p('#vnLearnQ').oninput = () => { clearTimeout(learnTimer); learnTimer = setTimeout(loadLearned, 300); };
  $p('#vnForgetAll').onclick = async () => {
    if (!confirm('Forget every learned track? Records will be learned again as you play them, using the recognition service.')) return;
    try { const r = await p.api('forget', { id: 'all' }); drawLearned(r.tracks); apply(r); } catch (e) { log('Vinyl: ' + e.message, 'e'); }
  };
  $p('#vnAcrCap').onchange = e => call('options', { acrCap: Number(e.target.value) });
  $p('#vnAutoOff').onchange = e => call('options', { autoOffMin: Number(e.target.value) });
  $p('#vnCap').onchange = e => call('options', { cap: Number(e.target.value) });
  $p('#vnAutoShow').onchange = e => call('options', { autoShow: e.target.checked });
  $p('#vnRpm').onchange = e => call('options', { rpm: Number(e.target.value) });
  $p('#vnClipSec').onchange = e => call('options', { clipSec: Number(e.target.value) });
  $p('#vnClean').onchange = e => call('options', { cleanClip: e.target.checked });
})();
