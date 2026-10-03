# Claude status

Shows what your Claude Code sessions are doing.
- **Screen 1:** the overall state. It flashes when a session needs you.
- **Screens 2–3:** your session and weekly usage.
- **Screens 4–5:** each session.

It can also turn the edge light rainbow for 2 minutes when a session asks a question or needs
permission.

Setup: Claude Code hooks POST to `http://127.0.0.1:8080/api/claude/hook`, and the status line runs
`claude-statusline.js`, which POSTs usage to `/api/claude/usage`. Both are accepted only from the computer running the controller, or one listed in
`data/trusted.json` (e.g. your PC, when the controller runs on a Raspberry Pi).
