# Vinyl

Identifies the record playing near the microphone, using AudD (audd.io), ACRCloud (acrcloud.com) or both,
and shows it:
- **Screen 1:** the album art.
- **Screens 2–3:** the title.
- **Screen 4:** the artist.
- **Screen 5:** a spinning record, with the album and year.

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
  **access secret** into the card. ACRCloud has a free trial. In the project, switch on Spotify under its third-party ID settings so matches come with Spotify links.
- **AudD, then ACRCloud if no match:** asks AudD first, and only asks ACRCloud when AudD finds
  nothing. Each service has its own monthly limit in the card.

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
