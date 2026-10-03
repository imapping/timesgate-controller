// Baseball (MLB) panel: the team, what's on now, the celebration options, and previews.
(() => {
  const p = TG.plugin('mlb');
  const $p = sel => p.el(sel);
  let st = null, teamsLoaded = false;

  p.preview = async () => ({ speed: MB_SPEED, parts: mbParts(await p.api('view'), Date.now()) });
  const call = async (path, body) => { try { apply(await p.api(path, body)); } catch (e) { log('Baseball: ' + e.message, 'e'); $p('#mbInfo').textContent = e.message; } };

  async function loadTeams() {
    teamsLoaded = true;
    try {
      const { teams } = await p.api('teams');
      const sel = $p('#mbTeam');
      sel.innerHTML = '';
      for (const t of teams) sel.append(Object.assign(document.createElement('option'), { value: t.id, textContent: t.name }));
      if (st) sel.value = st.team;
    } catch { teamsLoaded = false; }
  }

  const when = iso => new Date(iso).toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
  function apply(s) {
    const changed = !st || JSON.stringify(st.view) !== JSON.stringify(s.view);
    st = s;
    if (!teamsLoaded) loadTeams();
    if (document.activeElement !== $p('#mbTeam')) $p('#mbTeam').value = s.team;
    $p('#mbBeep').checked = s.beep; $p('#mbRainbow').checked = s.rainbow; $p('#mbAuto').checked = s.autoShow;
    const v = s.view;
    let now = 'Loading…';
    if (v && v.phase === 'none') now = 'No games in the next week.';
    else if (v && v.home) {
      const score = `${v.away.abbr} ${v.away.score ?? 0} – ${v.home.abbr} ${v.home.score ?? 0}`;
      now = v.phase === 'live' ? `Live: ${score} · ${v.inning ? `${v.inning.state === 'Middle' ? 'middle' : v.inning.state === 'End' ? 'end' : v.inning.half === 'Top' ? 'top' : 'bottom'} of the ${v.inning.ordinal}` : ''}${v.inning && !/Middle|End/.test(v.inning.state) ? ` · ${v.count.o} out` : ''}`
        : v.phase === 'final' ? `Final: ${score}`
        : `Next: ${v.away.name} at ${v.home.name}, ${when(v.start)}`;
      if (v.series?.status) now += ` · ${v.series.status}`;
    }
    $p('#mbNow').textContent = now;
    $p('#mbInfo').textContent = s.error ? 'Problem: ' + s.error
      : [v?.next && `Then ${v.next.home ? 'v' : '@'} ${v.next.opp.name}, ${when(v.next.start)}`, s.checkedAt && 'checked ' + new Date(s.checkedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' })]
        .filter(Boolean).join(' · ');
    if (changed && v && v.home) p.runPreview().catch(() => {});
  }
  p.onState(apply);

  $p('#mbTeam').onchange = e => call('options', { team: Number(e.target.value) });
  $p('#mbCheck').onclick = () => call('check', {});
  $p('#mbBeep').onchange = e => call('options', { beep: e.target.checked });
  $p('#mbRainbow').onchange = e => call('options', { rainbow: e.target.checked });
  $p('#mbAuto').onchange = e => call('options', { autoShow: e.target.checked });
  $p('#mbTest').onclick = async () => { try { await fetch('/api/plugins/action', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: 'mlb.test' }) }); } catch {} };
})();
