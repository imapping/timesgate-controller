# TimesGate controller

A web controller for the [Divoom Times Gate](https://divoom.com/) (five 128×128 screens), running
as a small Node server on your own network. Use it from a PC or phone browser, and it keeps
working with the page closed.

- Pictures, animations, banners, effects, scenes, a timer, a scoreboard and light shows
- **Plugins** for everything that shows live data. The built-in ones are Weather, Spotify
  now playing, Claude Code status, a music visualizer and vinyl record recognition.
  They can be installed or removed from the page.
- A **USB microphone** for the visualizer (beat-synced lights) and for recognising records (AudD)
- A **USB button box** or game controller: map each button to any action
- **Several Times Gates**, each with its own screens and settings

## Getting started

You need [Node.js](https://nodejs.org/) 18 or newer, on a PC or a Raspberry Pi on the same network
as the Times Gate.

```bash
npm install
npm start
```

Open `http://localhost:8080` (or `http://<this computer's IP>:8080` from a phone) and press
**Find on network** to connect to your Times Gate. Give the Times Gate a fixed address (a DHCP
reservation in your router) so it's always found in the same place.

Optional extras:
- **Microphone:** [ffmpeg](https://ffmpeg.org/) on Windows, or `arecord` (alsa-utils) on Linux.
- **Button box:** works through `node-hid`, installed by `npm install`.

## Writing plugins

See [PLUGINS.md](PLUGINS.md), which can also be read from the page, and copy `examples/hello/` to
start. [CLAUDE.md](CLAUDE.md) describes the architecture.

## Third-party services

Some plugins use online services. Each user sets up their own account or key; none are included.

- **Weather:** data by [Open-Meteo.com](https://open-meteo.com/), licensed CC BY 4.0. The free API
  is for non-commercial use.
- **Spotify:** needs your own Client ID from the
  [Spotify developer dashboard](https://developer.spotify.com/dashboard). Use is subject to
  Spotify's developer terms.
- **Vinyl:** uses [AudD](https://audd.io/) music recognition, a paid service with your own API token.
  The plugin only listens on request and has a monthly cap.
- **Divoom cloud:** used only to find Times Gates on your network, and to list clock faces.

Settings, logins and tokens are saved in `data/`, which is never served by the web server and is
excluded from git.

## Disclaimer

This is an unofficial project, not affiliated with or endorsed by Divoom, Spotify, AudD or
Anthropic. Divoom and Times Gate are trademarks of Divoom; Spotify is a trademark of Spotify AB;
Claude is a trademark of Anthropic.

## License

[MIT](LICENSE) © 2026 Gary Nicholson

The dependencies are also permissively licensed: `@napi-rs/canvas` (MIT, bundles Skia, BSD-3),
`node-hid` (MIT/X11, with hidapi used under its BSD licence), `node-addon-api` and
`pkg-prebuilds` (MIT). ffmpeg and arecord are separate programs. They are not included and are
only run when needed.
