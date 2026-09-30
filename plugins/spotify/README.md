# Spotify

Shows what's playing on your Spotify account:
- **Screen 1:** the album art.
- **Screens 2–3:** the song title.
- **Screen 4:** the artist.
- **Screen 5:** play/pause and the album.

When kept updated, it checks every 5 seconds and redraws when the song changes.

Setup, once, on the PC:
1. Create an app at developer.spotify.com/dashboard. Tick Web API and set the Redirect URI
   `http://127.0.0.1:8080/api/spotify/callback`.
2. Paste the app's Client ID into the card and click Connect.

The login (read-only playback scope, PKCE, no secret) is kept in `data/spotify.json`.
