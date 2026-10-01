// Listening reports panel: the period and source pickers, headline figures, ranked lists and bar charts.
// The server summarises the listening log (GET /api/reports/summary); render.js draws the screens.
(() => {
  const p = TG.plugin('reports');
  const $p = sel => p.el(sel);
  let data = null, knownPlays = null, loading = false;

  const SOURCE = { vinyl: 'the turntable (Vinyl)', spotify: 'Spotify' };
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const plural = (n, one, many) => `${n.toLocaleString()} ${n === 1 ? one : many}`;

  p.preview = async () => {
    if (!data) await load();
    return data && { speed: RP_SPEED, parts: rpRender(data).map((sc, i) => ({ key: sc.key, jobs: [{ screen: i, frames: sc.frames }] })) };
  };

  // A ranked list: name (and a second line), count, and a thin bar for its share of the top entry.
  function list(box, rows, what) {
    box.innerHTML = '';
    if (!rows.length) { box.append(el('div', 'rp-empty', 'Nothing in this period.')); return; }
    const top = rows[0].n;
    for (const r of rows) {
      const row = el('div', 'rp-row'), name = el('div', 'rp-name');
      if (r.link) { const a = el('a', null, r.name); a.href = r.link; a.target = '_blank'; a.rel = 'noopener'; a.title = 'Open in Spotify'; name.append(a); }
      else name.textContent = r.name;
      if (r.sub) name.append(' ', el('span', 'rp-sub', r.sub));
      name.title = r.name + (r.sub ? ' — ' + r.sub : '');
      const track = el('div', 'rp-track'), fill = el('i');
      fill.style.width = Math.max(2, 100 * r.n / top) + '%';
      track.append(fill);
      row.append(name, el('div', 'rp-n', r.n.toLocaleString()), track);
      row.setAttribute('aria-label', `${r.name}: ${plural(r.n, 'play', 'plays')}`);
      box.append(row);
    }
  }

  // A bar chart: one thin bar per point, a tooltip on hover or tap, and the first, middle and last labels underneath.
  function chart(box, points, axis) {
    box.innerHTML = '';
    const max = Math.max(0, ...points.map(pt => pt.n));
    if (!max) { box.append(el('div', 'rp-empty', 'Nothing in this period.')); return; }
    box.append(el('div', 'rp-max', `Most: ${plural(max, 'play', 'plays')}`));
    const bars = el('div', 'rp-bars'), tip = el('div', 'rp-tip');
    tip.hidden = true;
    const show = (col, pt) => {
      bars.querySelectorAll('.on').forEach(c => c.classList.remove('on'));
      col.classList.add('on');
      tip.textContent = `${pt.label}: ${plural(pt.n, 'play', 'plays')}`;
      tip.hidden = false;
      const x = col.offsetLeft + col.offsetWidth / 2, half = tip.offsetWidth / 2;
      tip.style.left = Math.max(half, Math.min(box.clientWidth - half, x)) + 'px';
    };
    const hide = () => { tip.hidden = true; bars.querySelectorAll('.on').forEach(c => c.classList.remove('on')); };
    for (const pt of points) {
      const col = el('div', pt.n ? null : 'rp-zero'), bar = el('i');
      bar.style.height = pt.n ? Math.max(3, 100 * pt.n / max) + '%' : '0';
      col.append(bar);
      col.setAttribute('aria-label', `${pt.label}: ${plural(pt.n, 'play', 'plays')}`);
      col.onmouseenter = col.onclick = () => show(col, pt);
      bars.append(col);
    }
    bars.onmouseleave = hide;
    const ax = el('div', 'rp-axis');
    for (const a of axis) ax.append(el('span', null, a));
    box.append(tip, bars, ax);
  }

  function draw(d) {
    data = d;
    $p('#rpRange').querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.range === d.range));
    // The sources that have plays in this period.
    const sel = $p('#rpSource'), want = ['all', ...d.sources.map(s => s.source)];
    if (!want.includes(d.source)) want.push(d.source);
    if (sel.dataset.have !== want.join()) {
      sel.dataset.have = want.join(); sel.innerHTML = '';
      for (const v of want) {
        const o = el('option', null, v === 'all' ? 'everything' : SOURCE[v] || v);
        o.value = v; sel.append(o);
      }
    }
    sel.value = d.source;

    const t = d.totals, tiles = $p('#rpTiles');
    tiles.innerHTML = '';
    for (const [label, value] of [['Plays', t.plays.toLocaleString()], ['Listening time', t.ms == null ? '–' : rpTime(t.ms).replace(' h', ' hours')],
      ['Artists', t.artists.toLocaleString()], ['Different songs', t.songs.toLocaleString()]]) {
      const tile = el('div', 'rp-tile');
      tile.append(el('small', null, label), el('b', null, value));
      tiles.append(tile);
    }
    $p('#rpInfo').textContent = t.plays && t.first ? `since ${new Date(Math.max(t.first, d.since || 0)).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' })}` : '';

    list($p('#rpArtists'), d.topArtists.map(r => ({ name: r.artist, n: r.n })), 'artist');
    list($p('#rpSongs'), d.topSongs.map(r => ({ name: r.title, sub: r.artist, n: r.n,
      link: (r.spotify || '').startsWith('https://open.spotify.com/') ? r.spotify : 'https://open.spotify.com/search/' + encodeURIComponent(`${r.title} ${r.artist}`) })), 'song');
    list($p('#rpAlbums'), d.topAlbums.map(r => ({ name: r.album, sub: r.artist, n: r.n })), 'album');

    const pts = d.series.points;
    $p('#rpSeriesTitle').textContent = d.series.unit === 'month' ? 'Plays by month' : 'Plays by day';
    chart($p('#rpSeries'), pts, pts.length > 2 ? [pts[0].label, pts[pts.length >> 1].label, pts[pts.length - 1].label] : pts.map(pt => pt.label));
    const hour = h => `${h % 12 || 12} ${h < 12 ? 'am' : 'pm'}`;
    chart($p('#rpHours'), d.hours.map((n, h) => ({ label: `${hour(h)} to ${hour((h + 1) % 24)}`, n })), ['midnight', '6 am', 'noon', '6 pm', 'midnight']);

    const box = $p('#rpRecent');
    box.innerHTML = '';
    if (!d.recent.length) box.append(el('div', 'rp-empty', 'Nothing in this period.'));
    else {
      const table = el('table', 'wx rp-recent');
      for (const r of d.recent) {
        const tr = el('tr'), td = el('td'), a = el('a', null, r.title);
        a.href = (r.spotify || '').startsWith('https://open.spotify.com/') ? r.spotify : 'https://open.spotify.com/search/' + encodeURIComponent(`${r.title} ${r.artist}`);
        a.target = '_blank'; a.rel = 'noopener'; a.style.color = 'inherit'; a.title = 'Open in Spotify';
        td.append(a);
        tr.append(td, el('td', null, r.artist), el('td', 'hint', SOURCE[r.source] ? (r.source === 'vinyl' ? 'turntable' : 'Spotify') : r.source),
          el('td', 'hint', new Date(r.at).toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })));
        table.append(tr);
      }
      box.append(table);
    }
  }

  async function load(options) {
    if (loading) return;
    loading = true;
    try { draw(await p.api(options ? 'options' : 'summary', options)); p.info(''); }
    catch (e) { p.info(e.message); }
    finally { loading = false; }
  }

  $p('#rpRange').querySelectorAll('button').forEach(b => b.onclick = () => load({ range: b.dataset.range }));
  $p('#rpSource').onchange = e => load({ source: e.target.value });
  // Reload when the log grows (or the period is changed from another browser).
  p.onState(s => {
    if (!s.available) { p.info('The listening log isn\'t available on this computer.'); return; }
    if (knownPlays !== s.plays || !data || data.range !== s.range || data.source !== s.source) { knownPlays = s.plays; load(); }
  });
})();
