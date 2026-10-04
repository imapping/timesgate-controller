# Now Playing

A full-screen page showing what's playing, for a separate display: a small HDMI screen on the Pi, a
tablet, an old phone or a TV. It draws nothing on the Times Gate.

Open `http://<controller>:8080/plugins/nowplaying/now.html` (add `?kiosk` on a touch screen to hide
the mouse pointer). For a screen plugged into the Pi, `scripts/install-kiosk.sh` shows it full-screen
from boot, with no desktop needed (see "A screen on the Pi" in the main README).

It shows:
- **Spotify**, while a song plays: its cover (640 px), title, artist, album and year, and a progress bar.
- **Vinyl**, while it's listening: the record's cover (from your Discogs collection when it matches),
  the side and track, and a progress bar when the track's length is known (a side chosen from Discogs,
  or a track Vinyl has learned). Between tracks, or before anything is recognised, it says what Vinyl is doing.
- A paused Spotify song, when Vinyl isn't listening.
- Otherwise a large clock.

With nothing playing, the screen dims after 2 minutes and goes black after 30. Music starting, or a
touch, brings it back (a touch on a dimmed screen only wakes it, so it never presses a button by
accident). Vinyl listening counts as playing, even between tracks. Change the times with `?dim=` and
`?dark=` in minutes, or 0 for never, e.g. `now.html?kiosk&dim=5&dark=0`. On the Pi's screen, set them
with `KIOSK_URL` when running `install-kiosk.sh`. Black still leaves the screen's backlight on.

By touch:
- **★** makes the song a favourite (the same favourites as the main page).
- **Identify** asks Vinyl what's playing now.
- **Listen to the record** (on the clock screen) switches Vinyl's listening on. It switches itself off
  after the usual time.

The page asks `GET /api/nowplaying/now` every 2 seconds. Vinyl and Spotify each answer from what they
already know, so this uses no AudD/ACRCloud requests and no extra Spotify calls (they're shared, every 3 s).

Needs the Spotify and/or Vinyl plugins. Either one alone works.
