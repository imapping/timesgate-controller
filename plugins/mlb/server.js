// Baseball (MLB): your team's games from MLB's public stats feed (statsapi.mlb.com, no key needed).
//  - During a game it checks every 30 seconds: score, inning, count, outs, runners, batter and pitcher.
//  - Before a game it checks every couple of minutes; otherwise every 20 minutes.
//  - When your team scores it can beep and light the edge rainbow; a win does too.
// Settings in data/mlb.json: { team, beep, rainbow, autoShow }.
// MLB's data is for personal, non-commercial use (see the copyright line in its replies).
const { mbParts, MB_SPEED } = require('./public/render.js');

const API = 'https://statsapi.mlb.com/api/v1';
const LIVE_MS = 30 * 1000, SOON_MS = 2 * 60 * 1000, IDLE_MS = 20 * 60 * 1000;
const DODGERS = 119;

module.exports = tg => {
  const s = tg.settings;
  s.team ??= DODGERS; s.beep ??= true; s.rainbow ??= true; s.autoShow ??= false;
  let view = null, error = '', checkedAt = 0, nextAt = 0, checking = null, teams = null;
  let seen = null;   // { pk, runs, done }: our team's runs in the current game, to notice new ones

  const get = async path => {
    const r = await fetch(API + path, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
    if (!r.ok) throw new Error('MLB stats feed: HTTP ' + r.status);
    return r.json();
  };
  const ymd = d => d.toISOString().slice(0, 10);

  async function listTeams() {
    if (!teams) {
      const d = await get('/teams?sportId=1');
      teams = d.teams.map(t => ({ id: t.id, name: t.name, abbr: t.abbreviation })).sort((a, b) => a.name.localeCompare(b.name));
    }
    return teams;
  }

  const phaseOf = g => {
    const st = g.status.abstractGameState;   // Preview, Live, Final
    return st === 'Live' && !/Warmup|Delayed Start/.test(g.status.detailedState) ? 'live' : st === 'Final' ? 'final' : 'pre';
  };

  // Our team's games from yesterday to a week ahead: the live one, or the latest result and the next one.
  async function check() {
    if (checking) return checking;
    checking = (async () => {
      try {
        const now = new Date();
        const d = await get(`/schedule?sportId=1&teamId=${s.team}&startDate=${ymd(new Date(now - 36 * 3600e3))}&endDate=${ymd(new Date(+now + 8 * 864e5))}&hydrate=team,linescore,seriesStatus`);
        const games = (d.dates || []).flatMap(x => x.games);
        const live = games.find(g => phaseOf(g) === 'live');
        const last = games.filter(g => phaseOf(g) === 'final').pop();
        const next = games.find(g => phaseOf(g) === 'pre' && g.status.detailedState !== 'Postponed');
        const g = live || (last && (!next || now - new Date(last.gameDate) < 20 * 3600e3) ? last : next) || last;
        const was = view?.phase;
        view = g ? await describe(g, live ? 'live' : phaseOf(g)) : { phase: 'none', team: s.team };
        if (next && g !== next) view.next = { start: next.gameDate, opp: next.teams.home.team.id === s.team ? next.teams.away.team : next.teams.home.team, home: next.teams.home.team.id === s.team };
        if (next && g !== next) view.next.opp = { abbr: view.next.opp.abbreviation, name: view.next.opp.teamName || view.next.opp.name };
        error = '';
        scored(g, was);
        // How soon to look again.
        const soon = next && new Date(next.gameDate) - now < 30 * 60e3;
        nextAt = Date.now() + (live ? LIVE_MS : soon ? SOON_MS : IDLE_MS);
      } catch (e) { error = e.message; tg.log('Check failed:', e.message); nextAt = Date.now() + SOON_MS; }
      checkedAt = Date.now();
      tg.update();
    })().finally(() => { checking = null; });
    return checking;
  }

  async function describe(g, phase) {
    let ls = g.linescore || {};
    if (phase === 'live') ls = await get(`/game/${g.gamePk}/linescore`).catch(() => ls);
    const team = t => ({
      id: t.team.id, abbr: t.team.abbreviation || '?', name: t.team.teamName || t.team.name,
      score: t.score ?? null, record: t.leagueRecord && g.gameType === 'R' ? `${t.leagueRecord.wins}-${t.leagueRecord.losses}` : '',
    });
    const away = team(g.teams.away), home = team(g.teams.home);
    for (const [k, t] of [['away', away], ['home', home]]) {
      const x = ls.teams?.[k];
      if (x) { t.score = x.runs ?? t.score; t.hits = x.hits ?? 0; t.errors = x.errors ?? 0; }
    }
    const o = ls.offense || {};
    return {
      phase, pk: g.gamePk, team: s.team, start: g.gameDate, status: g.status.detailedState,
      away, home,
      inning: ls.currentInning ? { n: ls.currentInning, ordinal: ls.currentInningOrdinal, half: ls.inningHalf, state: ls.inningState } : null,
      scheduled: ls.scheduledInnings || 9,
      count: { b: ls.balls ?? 0, s: ls.strikes ?? 0, o: ls.outs ?? 0 },
      bases: [!!o.first, !!o.second, !!o.third],
      batter: o.batter?.fullName || null, pitcher: ls.defense?.pitcher?.fullName || null,
      series: { desc: g.seriesDescription || '', game: g.seriesGameNumber || null, of: g.gamesInSeries || null,
        status: g.seriesStatus?.result || g.seriesStatus?.summary || '', type: g.gameType },
      venue: g.venue?.name || '',
    };
  }

  // Our team scored (or won): beep and the rainbow edge.
  function scored(g, was) {
    if (!g || !view || view.phase === 'none') { seen = null; return; }
    const ours = view.home.id === s.team ? view.home : view.away, theirs = ours === view.home ? view.away : view.home;
    const runs = ours.score ?? 0;
    if (seen && seen.pk === view.pk && view.phase !== 'pre') {
      if (runs > seen.runs) celebrate(`${ours.name} scored (${ours.abbr} ${runs}, ${theirs.abbr} ${theirs.score ?? 0})`);
      else if (view.phase === 'final' && !seen.done && runs > (theirs.score ?? 0)) celebrate(`${ours.name} won, ${runs}–${theirs.score}`);
    }
    if (view.phase === 'live' && was !== 'live' && seen?.pk !== view.pk && s.autoShow && !tg.isLive()) tg.setLive(true);
    seen = { pk: view.pk, runs, done: view.phase === 'final' };
  }
  function celebrate(what) {
    tg.log(what);
    if (s.beep) tg.device.beep({ on: 90, off: 70, total: 800 });
    if (s.rainbow) tg.device.edgeRainbow(45 * 1000);
  }

  tg.after(2000, check);
  tg.every(LIVE_MS / 2, () => { if (Date.now() >= nextAt) check(); });

  const state = () => ({ team: s.team, beep: s.beep, rainbow: s.rainbow, autoShow: s.autoShow, error, checkedAt, view });
  return {
    render: () => {
      if (!view) throw Object.assign(new Error(error || 'Still loading from MLB…'), { status: 503 });
      return { speed: MB_SPEED, parts: mbParts(view, Date.now()) };
    },
    state,
    routes: {
      'GET /view': () => view || {},
      'GET /teams': async () => ({ teams: await listTeams() }),
      'POST /check': async () => { await check(); return state(); },
      'POST /options': async ({ body }) => {
        const b = body || {};
        if (Number.isInteger(b.team) && (await listTeams()).some(t => t.id === b.team) && b.team !== s.team) { s.team = b.team; seen = null; view = null; }
        for (const k of ['beep', 'rainbow', 'autoShow']) if (typeof b[k] === 'boolean') s[k] = b[k];
        tg.save();
        await check();
        return state();
      },
    },
    actions: {
      check: { label: 'check the score now', run: () => check() },
      test: { label: 'test the "we scored" celebration', run: () => celebrate('Test: your team scored') },
    },
  };
};
