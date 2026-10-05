// Sends your Claude usage limits (the 5-hour session and the 7-day week) to the TimesGate controller,
// which shows them on the Times Gate (the Claude status plugin). It's a Claude Code mod, so it works
// wherever Claude Code runs it, the desktop app included; the terminal-only status-line script
// (claude-statusline.js) isn't needed.
// Claude Code pushes the figures (session.measure) after each turn and whenever a window moves a whole
// point; they're POSTed to the controller's /api/claude/usage in the shape the status-line script used.
// The controller's address is the mod's "url" setting (see the plugin.json).

type Window = { used_percentage: number; resets_at?: number };

export function register(on: any, options: { url?: string }) {
  const base = String(options?.url || 'http://127.0.0.1:8080').replace(/\/+$/, '');
  on('session.measure', async ($: any, e: any, next: any) => {
    const out: Record<string, Window> = {};
    for (const w of e.rateLimits || []) {
      if (w.kind !== 'five_hour' && w.kind !== 'seven_day') continue;
      const at = w.resetsAt ? Date.parse(w.resetsAt) : NaN;
      out[w.kind] = { used_percentage: w.percentUsed, ...(Number.isFinite(at) ? { resets_at: Math.round(at / 1000) } : {}) };
    }
    if (out.five_hour || out.seven_day) {
      try {
        await $.http.fetch(base + '/api/claude/usage', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ rate_limits: out }),
        });
      } catch {}   // the controller isn't reachable: nothing to do
    }
    return next(e);
  });
}