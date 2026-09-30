# Vinyl

Identifies the record playing near the microphone using AudD (audd.io), and shows it:
- **Screen 1:** the album art.
- **Screens 2–3:** the title.
- **Screen 4:** the artist.
- **Screen 5:** a spinning record, with the album and year.

Setup: get an API token from dashboard.audd.io and paste it into the card on the PC.

How it keeps to the monthly budget (1,000 requests by default, adjustable):
- **Only on request:** press **Start listening**. It switches itself off after the time you choose,
  1 hour by default.
- **One request per track:** it sends a 10-second clip once music has been playing for 3 seconds.
  After a match, it waits for the quiet gap before the next track. If it doesn't hear a gap, it
  checks again around the track's expected end.
- **No match:** it tries again in 30 s. After 3 misses in a row it waits for the next track.
- **Not while Spotify is playing:** if the Spotify plugin says Spotify is playing, that's what the mic
  is hearing, so it doesn't try.
- **Monthly counter:** each request is counted before it's sent, and it stops at the limit. The count
  resets on the 1st of each month.

Only the 10-second clips are sent to AudD. Nothing is saved to disk.
