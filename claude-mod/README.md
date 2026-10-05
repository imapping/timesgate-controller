# Claude usage for the Times Gate (a Claude Code mod)

`timesgate-usage` sends your Claude **session (5-hour) and weekly usage** to the TimesGate
controller, for the Claude status plugin's screens. It's a Claude Code *mod* (a plugin of function
hooks), so it works wherever Claude Code runs it, **the desktop app included**. The older
`claude-statusline.js` only runs in the terminal.

Claude Code hands the mod your usage after each reply, and whenever a limit moves by a whole point;
the mod POSTs it to the controller's `/api/claude/usage`. Nothing else is sent.

## Setting it up

1. Keep the `timesgate-usage` folder where it is (in this project), or copy it somewhere permanent.
2. Load it in every Claude Code session by adding its folder to the `env` section of
   `~/.claude/settings.json` (use the folder's full path):

   ```json
   { "env": { "CLAUDE_CODE_PLUGIN_DIRS": "D:\\path\\to\\timesgate-controller\\claude-mod\\timesgate-usage" } }
   ```

   Several folders are separated by `;` on Windows and `:` elsewhere.
3. Tell it where the controller is, if it isn't on the same computer (the default is
   `http://127.0.0.1:8080`): in Claude Code, open `/config` and set **TimesGate controller address**,
   e.g. `http://192.168.1.128:8080` for a Raspberry Pi. That's stored in `~/.claude/settings.json`
   under `pluginConfigs`.
4. Start a new session and send a message. The Claude status card shows your usage within a few seconds
   of the reply.

The controller accepts usage only from its own computer or one listed in its `data/trusted.json`, the
same as the Claude Code hooks.

If you also use the status line (`claude-statusline.js`), both send the same figures; that's harmless,
and you can drop the status line once the mod works.

`claude plugin validate claude-mod/timesgate-usage` checks the mod without loading it.
