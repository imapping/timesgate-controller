// Claude Code status: Claude Code hooks POST their event JSON to /api/claude/hook, and
// claude-statusline.js POSTs the session/weekly rate limits to /api/claude/usage. Only the fields
// needed for the display are kept (never prompt text or replies), in memory only.
// Also turns the edge light rainbow when a session needs you.
const { renderClaude, CL_SPEED } = require('./public/render.js');

module.exports = tg => {
  const claude = { sessions: {}, usage: null, seq: 0 };
  const SESSION_MAX_AGE = 12 * 3600 * 1000;
  const opts = tg.settings;  // { rainbow }
  delete opts.beep;   // (the Times Gate has no buzzer)

  // True when the last line of Claude's reply is a question (ignoring trailing markdown/emoji).
  function endsWithQuestion(text) {
    if (typeof text !== 'string') return false;
    const lines = text.trim().split('\n').map(l => l.trim()).filter(Boolean);
    const last = (lines.pop() || '').replace(/[*_`)\]\s\p{Extended_Pictographic}]+$/u, '');
    return last.endsWith('?');
  }

  function alert() {
    if (opts.rainbow) tg.device.edgeRainbow(2 * 60 * 1000);
  }

  function hookEvent(ev) {
    const id = ev.session_id;
    if (!id) return;
    if (ev.hook_event_name === 'SessionEnd') { delete claude.sessions[id]; claude.seq++; tg.update(); return; }
    const s = claude.sessions[id] || (claude.sessions[id] = { id, state: 'idle' });
    if (ev.cwd) s.cwd = ev.cwd;
    if (ev.session_title) s.title = ev.session_title;
    const prev = s.state;
    switch (ev.hook_event_name) {
      case 'SessionStart': s.state = 'idle'; break;
      case 'UserPromptSubmit': case 'PostToolUse': s.state = 'working'; break;
      // Claude asking a multiple-choice question or for plan approval (PreToolUse hook matched to these tools).
      case 'PreToolUse': if (/^(AskUserQuestion|ExitPlanMode)$/.test(ev.tool_name || '')) s.state = 'question'; break;
      // Finished its turn — your move. If the reply ends by asking something, it's waiting on an answer.
      case 'Stop': s.state = endsWithQuestion(ev.last_assistant_message) ? 'question' : 'done'; break;
      case 'StopFailure': s.state = 'error'; break;
      case 'Notification': {
        const t = ev.notification_type;
        if (t === 'permission_prompt') s.state = 'permission';
        else if (t === 'agent_needs_input' || t === 'elicitation_dialog' || t === 'elicitation_url_dialog') s.state = 'question';
        // idle_prompt is just "still waiting" — it doesn't change what Claude is waiting for.
        break;
      }
    }
    s.updated = Date.now();
    if (s.state !== prev) s.since = s.updated;
    claude.seq++;
    if (s.state !== prev && (s.state === 'question' || s.state === 'permission')) alert();
    tg.update();
  }

  function status() {
    const now = Date.now();
    for (const [id, s] of Object.entries(claude.sessions)) if (now - s.updated > SESSION_MAX_AGE) delete claude.sessions[id];
    const sessions = Object.values(claude.sessions).sort((a, b) => b.updated - a.updated)
      .map(({ id, state, cwd, title, since, updated }) => ({
        id: id.slice(0, 8), state, since, updated,
        name: title || (cwd && cwd.split(/[\\/]/).filter(Boolean).pop()) || 'session',
      }));
    return { seq: claude.seq, now, sessions, usage: claude.usage };
  }

  // Writes only from this computer (hooks and the status-line script run locally).
  const localOnly = ctx => { if (!ctx.local) throw Object.assign(new Error('Only from the computer running the controller, or one it trusts'), { status: 403 }); };

  return {
    render: () => ({ speed: CL_SPEED, parts: renderClaude(status()).map((sc, i) => ({ key: sc.key, jobs: [{ screen: i, frames: sc.frames }] })) }),
    poll: { every: 60 * 1000, run: () => tg.update() },  // "resets in" times move
    state: () => ({ rainbow: !!opts.rainbow }),
    routes: {
      'GET /status': () => status(),
      'POST /hook': ctx => { localOnly(ctx); hookEvent(ctx.body || {}); },  // empty 2xx = success for Claude Code http hooks
      'POST /usage': ctx => {
        localOnly(ctx);
        const pick = w => w && typeof w.used_percentage === 'number' ? { used: w.used_percentage, resets_at: w.resets_at } : null;
        const rl = (ctx.body || {}).rate_limits || {};
        const u = { five_hour: pick(rl.five_hour), seven_day: pick(rl.seven_day), received: Date.now() };
        if (!u.five_hour && !u.seven_day) return;
        const changed = JSON.stringify([u.five_hour, u.seven_day]) !== JSON.stringify([claude.usage?.five_hour, claude.usage?.seven_day]);
        claude.usage = u;
        if (changed) { claude.seq++; tg.update(); }
      },
      'POST /options': ({ body }) => {
        if (typeof body.rainbow === 'boolean') opts.rainbow = body.rainbow;
        tg.save();
        return { rainbow: !!opts.rainbow };
      },
    },
    actions: {
      test: { label: 'test the alert', run: alert },
    },
  };
};
