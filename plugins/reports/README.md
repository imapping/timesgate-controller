# Listening reports

Shows what you've been listening to, from the **listening log**: every record identified by the
Vinyl plugin, and every song played on Spotify for at least 30 seconds.

In the card:
- **Period and source:** the last 7 days, 30 days, 12 months or all time, and everything, the
  turntable or Spotify.
- **Headline figures:** plays, listening time, artists and different songs.
- **Top artists, songs and albums**, with song titles linking to Spotify.
- **Plays by day** (or by month for the longer periods) and **when you listen** (by hour of the
  day). Hover over or tap a bar for its figure.
- **Latest plays**, each with a star (favourite) and a **Note** button.
- **Favourites:** the songs you've starred, with their plays in the period. Favourites also show a ★ in Top songs.
- **Your notes:** every play you've marked (Skips, Crackles, Poor quality, Needs cleaning, Wrong song) or commented on, with its
  album and position on the record, and a count of each mark. Handy as a list of records that need cleaning or replacing.

On the Times Gate:
- **Screen 1:** plays and listening time for the period.
- **Screen 2:** top artists.
- **Screen 3:** top songs.
- **Screen 4:** plays over time.
- **Screen 5:** the latest play.

The period and source you choose in the card are what the screens show. When kept updated, it
checks for new plays every minute and re-sends only the screens that changed.

Notes:
- Listening time adds up each song's length. Songs without a known length count as the average.
- Album names come from the recognition service, which sometimes names a compilation rather than
  the record on the turntable.
- It only reads the log (`tg.listening.query`). The only thing it changes is the note on a play, when you save one.
