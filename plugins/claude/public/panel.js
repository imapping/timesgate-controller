// Claude status panel: the summary on the page, previews, and the rainbow option.
// The screens are drawn by render.js (also used by server.js to update the device).
(() => {
  const p = TG.plugin('claude');
  let data = null;

  function summarise(d) {
    const u = d.usage;
    const usage = u ? `Session ${u.five_hour ? Math.round(u.five_hour.used) + '% (' + resetText(u.five_hour.resets_at) + ')' : '—'} · ` +
      `Week ${u.seven_day ? Math.round(u.seven_day.used) + '% (' + resetText(u.seven_day.resets_at) + ')' : '—'}`
      : 'Usage: waiting for the status line to report (it updates as you use Claude Code)';
    const rows = d.sessions.map(s => {
      const st = CL_STATES[s.state] || CL_STATES.idle;
      const tr = document.createElement('tr');
      tr.innerHTML = '<td></td><td></td>';
      tr.firstChild.textContent = s.name;
      tr.lastChild.innerHTML = `<span style="color:${st.color};font-weight:600"></span>`;
      tr.lastChild.firstChild.textContent = st.short;
      return tr;
    });
    const box = p.el('#clSummary');
    box.innerHTML = '<p style="margin:0 0 8px"></p><table class="wx"></table>';
    box.firstChild.textContent = usage;
    if (rows.length) rows.forEach(r => box.lastChild.append(r));
    else box.lastChild.outerHTML = '<p class="hint">No Claude Code sessions reported yet. Once the hooks are set up, sessions appear here as you use Claude.</p>';
  }

  let seq = -1, minute = -1;
  async function poll() {
    try {
      const d = await p.api('status');
      const m = Math.floor(Date.now() / 60000);
      if (d.seq === seq && m === minute) return;  // reset countdowns move each minute
      seq = d.seq; minute = m; data = d;
      summarise(d);
    } catch {}
  }

  p.preview = async () => {
    if (!data) await poll();
    return data && { speed: CL_SPEED, parts: renderClaude(data).map((sc, i) => ({ key: sc.key, jobs: [{ screen: i, frames: sc.frames }] })) };
  };

  const setOpt = o => p.api('options', o).catch(e => log('Claude: ' + e.message, 'e'));
  p.el('#clRainbow').onchange = e => setOpt({ rainbow: e.target.checked });
  p.onState(s => { p.el('#clRainbow').checked = !!s.rainbow; });

  poll();
  setInterval(poll, 2000);
})();
