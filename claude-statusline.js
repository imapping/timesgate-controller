// Claude Code status line that also forwards your usage limits to the TimesGate controller.
// Claude Code runs this with session JSON on stdin; we POST the rate limits to the local server
// (ignored if it isn't running) and print a one-line status for the terminal.
// Configure in ~/.claude/settings.json:  "statusLine": { "type": "command", "command": "node /path/to/TimesGate/claude-statusline.js" }

// 127.0.0.1 rather than localhost: resolving "localhost" can take seconds on Windows.
const SERVER = process.env.TIMESGATE_URL || 'http://127.0.0.1:8080';

let input = '';
process.stdin.on('data', c => { input += c; });
process.stdin.on('end', async () => {
  let d = {};
  try { d = JSON.parse(input.replace(/^﻿/, '')); } catch {}
  const rl = d.rate_limits;

  if (rl && (rl.five_hour || rl.seven_day)) {
    try {
      await fetch(SERVER + '/api/claude/usage', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rate_limits: rl }), signal: AbortSignal.timeout(800),
      });
    } catch {}  // server not running — just show the status line
  }

  const parts = [];
  if (d.model?.display_name) parts.push(d.model.display_name);
  const ctx = d.context_window?.used_percentage;
  if (ctx != null) parts.push(`ctx ${Math.round(ctx)}%`);
  if (rl?.five_hour) parts.push(`session ${Math.round(rl.five_hour.used_percentage)}%`);
  if (rl?.seven_day) parts.push(`week ${Math.round(rl.seven_day.used_percentage)}%`);
  process.stdout.write(parts.join(' · '));
});
