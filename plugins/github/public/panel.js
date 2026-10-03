// GitHub panel: repositories, their numbers, the token, celebration options and previews.
// The data comes from the server (which checks GitHub every 10 minutes); render.js draws it.
(() => {
  const p = TG.plugin('github');
  const $p = sel => p.el(sel);
  let st = null, lastParty = 0;

  p.preview = async () => {
    if (!st || !st.repos.length) return null;
    const v = await p.api('view');
    return { speed: GH_SPEED, parts: renderGithub(v).map((sc, i) => ({ key: sc.key, jobs: [{ screen: i, frames: sc.frames }] })) };
  };

  const call = async (path, body) => {
    try { apply(await p.api(path, body)); return true; } catch (e) { log('GitHub: ' + e.message, 'e'); p.info(e.message); return false; }
  };

  function cell(tr, text, cls) { const td = document.createElement('td'); td.textContent = text; if (cls) td.className = cls; tr.append(td); return td; }

  function apply(s) {
    const firstData = s.stats.length && (!st || !st.stats.length);
    st = s;
    $p('#ghSetup').hidden = s.hasToken;
    $p('#ghTokenRow').style.display = s.hasToken ? '' : 'none';  // (.row's display:flex overrides hidden)
    $p('#ghTokenInfo').textContent = s.hasToken ? `Token saved${s.login ? ` (signed in as ${s.login})` : ''}${s.contribError ? ` · contribution graph: ${s.contribError}` : ''}.` : '';
    for (const [id, v] of [['#ghEvStars', s.events.stars], ['#ghEvForks', s.events.forks], ['#ghEvIssues', s.events.issues], ['#ghRainbow', s.rainbow]]) $p(id).checked = v;
    const rate = s.rate ? ` GitHub requests left this hour: ${s.rate.left} of ${s.rate.limit}.` : '';
    $p('#ghNote').textContent = (s.error ? 'Last check failed: ' + s.error + '.' : s.checkedAt ? `Checked ${new Date(s.checkedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}.` : '') + rate;

    // One row per repository.
    const box = $p('#ghStats');
    box.innerHTML = '';
    if (!s.repos.length) box.innerHTML = '<p class="hint">Add a repository to start, e.g. <b>imapping/timesgate-controller</b>.</p>';
    else {
      const t = document.createElement('table'); t.className = 'wx';
      for (const name of s.repos) {
        const d = s.stats.find(x => x.name === name), tr = document.createElement('tr');
        const a = document.createElement('a'); a.href = 'https://github.com/' + name; a.target = '_blank'; a.rel = 'noopener'; a.textContent = name;
        const td = document.createElement('td'); td.append(a); if (name === s.current && s.repos.length > 1) td.append(' ◂'); tr.append(td);
        if (d) {
          cell(tr, `★ ${d.stars}${d.today > 0 ? ` (+${d.today} today)` : ''}`);
          cell(tr, d.views == null ? (d.traffic === 'no access' ? 'visitors: token needs Administration: read' : '') : `${d.views} views (${d.uniques} unique)`, 'hint');
          cell(tr, d.clones == null ? '' : `${d.clones} clones`, 'hint');
          cell(tr, `${d.forks} forks · ${d.issues} issues · ${d.prs} PRs`, 'hint');
        } else cell(tr, 'loading…', 'hint');
        const x = document.createElement('button'); x.textContent = '×'; x.title = 'Stop following this repository';
        x.onclick = () => call('repos', { remove: name });
        const tdx = document.createElement('td'); tdx.style.textAlign = 'right'; tdx.append(x); tr.append(tdx);
        t.append(tr);
      }
      box.append(t);
    }

    // Recent celebrations.
    const r = $p('#ghRecent');
    r.innerHTML = '';
    if (s.recent.length) {
      const t = document.createElement('table'); t.className = 'wx';
      for (const ev of s.recent) {
        const tr = document.createElement('tr');
        cell(tr, { star: '★ New star', fork: 'New fork', issue: 'New issue', pr: 'New pull request' }[ev.kind] || ev.kind);
        cell(tr, (ev.who ? '@' + ev.who + ' · ' : '') + ev.repo, 'hint');
        cell(tr, new Date(ev.at).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' }), 'hint');
        t.append(tr);
      }
      r.append(t);
    }
    // Preview once the first numbers arrive, and when there's something new to celebrate.
    const newest = s.recent[0]?.at || 0;
    if (firstData || (lastParty && newest > lastParty)) p.runPreview().catch(() => {});
    lastParty = newest || 1;
  }
  p.onState(apply);

  const add = async () => {
    const v = $p('#ghAdd').value.trim();
    if (!v) return;
    p.info('Adding…');
    if (await call('repos', { add: v })) { $p('#ghAdd').value = ''; p.info(''); p.runPreview().catch(() => {}); }
  };
  $p('#ghAddBtn').onclick = add;
  $p('#ghAdd').onkeydown = e => { if (e.key === 'Enter') add(); };
  $p('#ghCheck').onclick = async () => { p.info('Checking…'); if (await call('check', {})) { p.info(''); p.runPreview().catch(() => {}); } };
  $p('#ghSaveToken').onclick = async () => {
    const token = $p('#ghToken').value.trim();
    if (!token) return;
    p.info('Checking the token…');
    if (await call('options', { token })) { $p('#ghToken').value = ''; p.info('Token saved.'); p.runPreview().catch(() => {}); }
  };
  $p('#ghForget').onclick = () => confirm('Remove the GitHub token from this controller?') && call('options', { token: '' });
  const opt = () => call('options', { rainbow: $p('#ghRainbow').checked,
    events: { stars: $p('#ghEvStars').checked, forks: $p('#ghEvForks').checked, issues: $p('#ghEvIssues').checked } });
  for (const id of ['#ghRainbow', '#ghEvStars', '#ghEvForks', '#ghEvIssues']) $p(id).onchange = opt;
  $p('#ghTest').onclick = async () => {
    try {
      await fetch('/api/plugins/action', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: 'github.test', args: {} }) });
    } catch (e) { log('GitHub: ' + e.message, 'e'); }
  };
})();
