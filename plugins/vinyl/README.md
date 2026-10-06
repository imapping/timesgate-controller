# Vinyl

Identifies the record playing near the microphone, using AudD (audd.io), ACRCloud (acrcloud.com) or both,
and shows it:
- **Screen 1:** the album art.
- **Screens 2–3:** the title.
- **Screen 4:** the artist.
- **Screen 5:** a spinning record, with the album and year (and the side and track, with Discogs).

Matches missing a Spotify link or cover are looked up on Spotify (through the Spotify plugin, if it's
connected), then in Apple's iTunes Search for the cover. Titles that arrive all in lowercase get
capital letters.

## Setup

Choose the **Service** in the card, then add its keys from the computer running the controller (or
one it trusts). The keys stay on the controller and are never sent to the page.
- **AudD:** get an API token from dashboard.audd.io. Simple and cheap ($5 per 1,000 requests).
- **ACRCloud:** often better with records heard through speakers in a room. In the ACRCloud console,
  create an **Audio & Video Recognition** project (audio source **Recorded Audio**, bucket
  **ACRCloud Music**). Copy its **host** (like `identify-eu-west-1.acrcloud.com`), **access key** and
  **access secret** into the card. ACRCloud has a free trial. In the project, switch on Spotify under its third-party ID settings so matches come with Spotify links. If the project also has **cover song (humming) identification**, those looser matches are used
  when there's no fingerprint match and ACRCloud is at least 70% sure; less sure guesses are shown in
  the card's "Last clip sent" line but not used.
- **AudD, then ACRCloud if no match:** asks AudD first, and only asks ACRCloud when AudD finds
  nothing. Each service has its own monthly limit in the card.

## Its own recognition

Vinyl learns the records you play, so a record only needs a recognition service the first time.
- While a track plays, its sound is fingerprinted (the strongest pitches and the timing between
  them). When the track ends, the fingerprint is saved under the name the service gave it (with the
  album, position and cover from Discogs, if that's set up).
- Each time it identifies, it checks its own fingerprints first. A track it knows is recognised on
  the controller in a fraction of a second, with no request sent. The history marks these "own".
- Anything it doesn't know goes to the service as before, and is learned for next time.
- If only part of a track was heard the first time (listening started halfway), a later, longer
  play replaces it.

In the card's settings, **Own recognition** shows how many tracks are learned and how often they
were recognised here, and **Show learned tracks** lists them with a **Forget** button each (for a
track learned under the wrong name; it's learned again the next time it plays). Untick the box to
switch learning and own recognition off.

Notes:
- Fingerprints are kept in `data/vinyl-prints.db` (SQLite), about 1.5 MB for an LP. It needs
  better-sqlite3, like the listening log.
- A track is only learned if it had a clear gap after it and one name. Tracks that run into each
  other without a gap aren't learned, and keep using the service.
- Fingerprints are of your deck at its own speed, so the turntable speed correction isn't needed
  for them. If you change the **Turntable speed** setting later (after adjusting the deck), clips
  are converted to the old speed before matching, so what's learned still works.
- It recognises your own records as your equipment plays them. It won't recognise the same song
  from the radio, a different pressing or a streaming service.
- Spoken-word tracks and other fast-changing sound: each clip is tried at four slightly different alignments,
  because speech falls differently into the analysis frames on every play. Once a learned track is recognised,
  its length is known, so pauses in it aren't taken for the gap before the next track, and it's accepted on less
  evidence while it should still be playing. When a clip isn't recognised here, the card's "Last clip" line says
  how close the nearest learned track came.
- With learned tracks, listening works even with no service set up or the monthly limit used up:
  known tracks are recognised, others are "not recognised".

## Choosing the record yourself (no service needed)

With your Discogs collection set up, you can tell Vinyl what you're about to play instead of having
it recognised. Open **Choose the record yourself** in the card, find the record, and click its side.
Then press Start listening and lower the needle.
- Each time a track starts after a gap, it's named as the next track on that side, straight away,
  with the album, cover and position. No clip is sent anywhere.
- Discogs' track lengths are used to tell a quiet passage from the end of a track, and to move on
  when tracks run together without a gap.
- The card lists the side's tracks with what's playing and what's next. If it gets out of step (the
  needle went down mid-side, a track was skipped), click **This is playing** on the right track.
- Tracks named this way are learned like any others, so next time the record is recognised by
  itself, with nothing chosen.
- When the side finishes, choose the next one. With no service set up and nothing learned,
  listening stops there.
- Tracks already learned are still recognised from their sound first, and the chosen side follows
  along from the recognised track.

This works with no AudD or ACRCloud account at all: Discogs and a turntable are enough. The list
of records in your collection can be seen by anyone who can open the controller's page.

## Your Discogs collection

If your records are listed on [Discogs](https://www.discogs.com), each identified song is matched to
the record you own. Recognition services often name a compilation or a reissue; with Discogs you get
your record's album, year and cover, and where the song is on it ("Side B · track 3"). The album in
the card's history links to the record on Discogs, and the listening log gets the corrected album.

In the card's settings, under **Your collection**, enter your Discogs username and a personal access
token (Discogs → Settings → Developers → **Generate new token**), from the computer running the
controller or one it trusts. The token stays on the controller and is only sent to api.discogs.com.

- The list of records and each record's track list (with track lengths) are saved in `data/vinyl-discogs.json`. Track
  lists load one a second (Discogs allows 60 requests a minute), so a big collection takes a few
  minutes the first time. Songs are matched as soon as their record's track list is loaded.
- The collection is checked for new records once a day, or with **Refresh**.
- When a song is on several of your records, it picks the one the last song came from (you're
  probably still playing it), then an album over a compilation.
- A song that isn't in your collection keeps the recognition service's album and cover.
- The year is the year of your pressing, as Discogs lists it.
- **Remove** deletes the username, the token and the saved copy.

## Turntable speed

Fingerprint matching fails if a turntable runs even 2% fast or slow, though nobody hears that
(some decks, like the Sony PS-LX310BT, often run at about 34.1 instead of 33⅓). Measure yours at 33
with a turntable speed app (a phone lying on the platter) and enter the reading in the card's
**Turntable speed at 33** box: clips are then slowed or sped up to the right speed before they're
sent. Better still, adjust the deck itself if it has a speed adjuster, and leave the box at 33.33.

How it keeps to the monthly budgets (AudD 1,000 and ACRCloud 300 requests by default, adjustable):
- **Only on request:** press **Start listening**. It switches itself off after the time you choose,
  1 hour by default.
- **One request per track:** it sends a 12-second clip (the most AudD's standard service uses; 10 seconds can be chosen in the card) to the chosen service once music has been playing for 3 seconds. Clips are cleaned up first (bass rumble and hum cut, voices lifted), which helps with big speakers.
  After a match, it waits for the quiet gap before the next track. If it doesn't hear a gap, it
  checks again around the track's expected end.
- **No match:** it tries again in 30 s. After 3 misses in a row it waits for the next track.
- **Not while Spotify is playing:** if the Spotify plugin says Spotify is playing, that's what the mic
  is hearing, so it doesn't try.
- **Monthly counters:** each request is counted before it's sent, per service, and a service stops at
  its limit. The counts reset on the 1st of each month.
- **Service errors:** if a service refuses (a wrong key, a used-up trial), it's left out until you
  switch listening on again, and the card shows why.

Only the clips are sent to the services. Nothing is saved to disk: the last clip is kept in memory so you can listen to what was sent and each service's answer (the card's "listen" link, from a trusted computer).

## Favourites and notes on tracks

The star next to a song in the history makes it a favourite; the Listening reports card lists your favourites.

Each song in the card's history has a **Note** button: mark it as Skips, Crackles, Poor quality, Needs cleaning, Wrong song, Wrong album or Wrong Discogs entry, and
add a comment. Notes are saved with the play in the listening log, and the Listening reports card lists them.

## Stylus hours

Styluses wear out (the Audio-Technica AT-LP120XUSB's manual says to replace it every 300 hours), so Vinyl keeps
an approximate count of how long the needle has been on a record. Settings → **Stylus** shows the hours played
since the stylus was fitted, as a bar that turns amber at 90% and red past the limit, with a warning line at the top
of the card. **New stylus fitted** starts again from 0, and the limit can be changed.

- It counts from the turntable input's level, averaged over about a second: music, the quiet between tracks
  and the run-out groove count; a lifted arm doesn't.
- It keeps counting with Vinyl switched off, by listening to the input in the background, but **only for an input
  marked as a direct connection** (so never a room microphone), and only for its level.

## Input and live listening

The card has its own copy of the Microphone card's controls: which input to use, a 10-second test,
**Listen live** with a volume slider, and the direct-connection setting. Both copies show and change
the same thing. The volume and quality are remembered in each browser.
