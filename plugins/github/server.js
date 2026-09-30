// GitHub repository stats: stars, visitors and clones (last 14 days), forks/watchers/issues/PRs,
// the last commit and top referrer, and your contribution graph. Checks every 10 minutes, even
// when not on the screens, so it can celebrate new stars, forks, issues and pull requests (beep,
// rainbow edge, and confetti on screen 1 if GitHub is showing).
// Settings in data/github.json: { token, repos, beep, rainbow, events, seen, recent }.
// The token is set from this PC only and never sent to the page. Without a token, it shows the
// public numbers (no visitors, clones or contribution graph).
const { renderGithub, GH_SPEED } = require('./public/render.js');

const API = 'https://api.github.com';
const CHECK_MS = 10 * 60 * 1000;     // GitHub allows 60 requests an hour without a token, 5,000 with
const ROTATE_MS = 60 * 1000;         // with several repositories, each gets a minute on the screens
const PARTY_MS = 10 * 60 * 1000;     // how long the celebration stays on screen 1
const REPO_RE = /^[\w.-]+\/[\w.-]+$/;

module.exports = tg => {
  const s = tg.settings;
  s.token ??= ''; s.repos ??= []; s.beep ??= true; s.rainbow ??= true;
  s.events ??= { stars: true, forks: true, issues: true };
  s.seen ??= {};      // repo → last counts, and the star count at the start of today
  s.recent ??= [];    // the last few things celebrated, for the card
  const data = {};    // repo → latest stats
  let contrib = null, error = '', checkedAt = 0, rate = null, current = 0, party = null, partyTimer = null, checking = null;

  async function gh(path, opts = {}) {
    const headers = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'timesgate-controller' };
    if (s.token) headers.Authorization = 'Bearer ' + s.token;
    if (opts.body) headers['Content-Type'] = 'application/json';
    const r = await fetch(API + path, { ...opts, headers, signal: AbortSignal.timeout(15000) });
    const left = r.headers.get('x-ratelimit-remaining');
    if (left != null && path !== '/graphql') rate = { left: Number(left), limit: Number(r.headers.get('x-ratelimit-limit')), reset: Number(r.headers.get('x-ratelimit-reset')) * 1000 };
    if (!r.ok) {
      const msg = (await r.json().catch(() => ({}))).message || r.statusText;
      throw Object.assign(new Error(r.status === 404 ? 'Repository not found (or the token can\'t see it)' : `GitHub: ${msg}`), { code: r.status, status: r.status === 404 ? 404 : 502 });
    }
    return r.json();
  }
  const soft = p => p.catch(e => ({ error: e.message, code: e.code }));

  // Views/clones: GitHub gives daily counts for the last 14 days; fill in any missing days with 0.
  function traffic(t, list) {
    if (!t || t.error) return t ? { error: t.error } : null;
    const byDay = Object.fromEntries((t[list] || []).map(d => [d.timestamp.slice(0, 10), d.count]));
    const days = [];
    for (let i = 13; i >= 0; i--) days.push(byDay[new Date(Date.now() - i * 864e5).toISOString().slice(0, 10)] || 0);
    return { total: t.count, uniques: t.uniques, days };
  }

  async function fetchRepo(name) {
    const info = await gh(`/repos/${name}`);
    const [commits, pulls, views, clones, refs] = await Promise.all([
      soft(gh(`/repos/${name}/commits?per_page=1`)),
      soft(gh(`/repos/${name}/pulls?state=open&per_page=100`)),
      s.token ? soft(gh(`/repos/${name}/traffic/views`)) : null,
      s.token ? soft(gh(`/repos/${name}/traffic/clones`)) : null,
      s.token ? soft(gh(`/repos/${name}/traffic/popular/referrers`)) : null,
    ]);
    const prs = Array.isArray(pulls) ? pulls.length : 0, c = Array.isArray(commits) && commits[0];
    const top = Array.isArray(refs) && refs[0];
    return {
      name: info.full_name, owner: info.owner.login, repo: info.name, url: info.html_url,
      stars: info.stargazers_count, forks: info.forks_count, watchers: info.subscribers_count,
      prs, issues: Math.max(0, info.open_issues_count - prs),   // GitHub counts PRs as issues
      commit: c ? { msg: c.commit.message.split('\n')[0], at: c.commit.author.date } : null,
      views: traffic(views, 'views'), clones: traffic(clones, 'clones'),
      referrer: top ? { name: top.referrer, count: top.count } : null,
      traffic: !s.token ? 'no token' : views && views.code === 403 ? 'no access' : views && views.error ? 'error' : 'ok',
    };
  }

  async function fetchContrib() {
    const query = '{ viewer { login contributionsCollection { contributionCalendar { totalContributions weeks { contributionDays { contributionCount } } } } } }';
    const r = await gh('/graphql', { method: 'POST', body: JSON.stringify({ query }) });
    if (r.errors) throw new Error(r.errors[0].message);
    const cal = r.data.viewer.contributionsCollection.contributionCalendar;
    return { login: r.data.viewer.login, total: cal.totalContributions, weeks: cal.weeks.slice(-16).map(w => w.contributionDays.map(d => d.contributionCount)) };
  }

  // Compare with the last counts; returns what's new. The first check of a repository only records.
  function whatsNew(d) {
    const today = new Date().toDateString(), counts = { stars: d.stars, forks: d.forks, issues: d.issues, prs: d.prs };
    const old = s.seen[d.name];
    if (!old) { s.seen[d.name] = { ...counts, day: today, dayStars: d.stars }; d.today = 0; tg.save(); return []; }
    if (old.day !== today) { old.day = today; old.dayStars = old.stars; }
    const news = [];
    if (s.events.stars && d.stars > old.stars) news.push({ kind: 'star', n: d.stars - old.stars });
    if (s.events.forks && d.forks > old.forks) news.push({ kind: 'fork', n: d.forks - old.forks });
    if (s.events.issues && d.prs > old.prs) news.push({ kind: 'pr', n: d.prs - old.prs });
    if (s.events.issues && d.issues > old.issues) news.push({ kind: 'issue', n: d.issues - old.issues });
    Object.assign(old, counts);
    d.today = d.stars - old.dayStars;
    tg.save();
    return news;
  }

  // Who did it (best effort, one request).
  async function who(name, ev) {
    try {
      if (ev.kind === 'star') { const d = data[name] || {}; const l = await gh(`/repos/${name}/stargazers?per_page=1&page=${d.stars}`); return l[0]?.login; }
      if (ev.kind === 'fork') return (await gh(`/repos/${name}/forks?sort=newest&per_page=1`))[0]?.owner?.login;
      if (ev.kind === 'pr') return (await gh(`/repos/${name}/pulls?state=open&sort=created&direction=desc&per_page=1`))[0]?.user?.login;
      if (ev.kind === 'issue') return (await gh(`/repos/${name}/issues?state=open&sort=created&per_page=10`)).find(i => !i.pull_request)?.user?.login;
    } catch {}
    return null;
  }

  function celebrate(name, ev) {
    party = { repo: name, kind: ev.kind, n: ev.n || 1, who: ev.who || null, at: Date.now() };
    s.recent = [{ ...party }, ...s.recent].slice(0, 8); tg.save();
    if (s.beep) tg.device.beep({ on: 90, off: 70, total: 800 });
    if (s.rainbow) tg.device.edgeRainbow(60 * 1000);
    const i = s.repos.indexOf(name); if (i >= 0) current = i;
    if (partyTimer) tg.clear(partyTimer);
    partyTimer = tg.after(PARTY_MS, () => { party = null; partyTimer = null; tg.update(); });
    tg.log(`New ${ev.kind} on ${name}${ev.who ? ' from ' + ev.who : ''}`);
    tg.update();
  }

  function check() {
    if (checking) return checking;
    checking = (async () => {
      let first = null;
      try {
        for (const name of s.repos) {
          const d = await fetchRepo(name);
          data[name] = d;
          const news = whatsNew(d);
          if (news.length && !first) { first = { name, ev: news[0] }; first.ev.who = await who(name, news[0]); }
        }
        for (const k of Object.keys(data)) if (!s.repos.includes(k)) delete data[k];
        contrib = s.token ? await fetchContrib().catch(e => ({ error: e.message })) : null;
        error = '';
      } catch (e) { error = e.message; tg.log('Check failed:', e.message); }
      checkedAt = Date.now();
      if (first) celebrate(first.name, first.ev); else tg.update();
    })().finally(() => { checking = null; });  // (not inside: with nothing to fetch, that runs before `checking` is set)
    return checking;
  }

  const view = name => {
    name = name || s.repos[current % s.repos.length];
    const d = data[name];
    if (!s.repos.length) throw Object.assign(new Error('Add a repository in the GitHub card first.'), { status: 400 });
    if (!d) throw Object.assign(new Error(error || 'Still loading from GitHub…'), { status: 503 });
    return { repo: d, contrib, party: party && party.repo === name ? party : null, now: Date.now() };
  };

  function state() {
    return {
      hasToken: !!s.token, repos: s.repos, current: s.repos[current % (s.repos.length || 1)] || null,
      beep: s.beep, rainbow: s.rainbow, events: s.events, error, checkedAt, rate, recent: s.recent,
      login: contrib && !contrib.error ? contrib.login : null, contribError: contrib?.error || null,
      stats: s.repos.map(n => data[n]).filter(Boolean).map(d => ({
        name: d.name, url: d.url, stars: d.stars, today: d.today, forks: d.forks, watchers: d.watchers, issues: d.issues, prs: d.prs,
        views: d.views && !d.views.error ? d.views.total : null, uniques: d.views && !d.views.error ? d.views.uniques : null,
        clones: d.clones && !d.clones.error ? d.clones.total : null, traffic: d.traffic,
      })),
    };
  }

  const repoName = v => {
    const m = /^(?:https?:\/\/github\.com\/)?([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/.exec(String(v || '').trim());
    if (!m || !REPO_RE.test(m[1])) throw Object.assign(new Error('Use owner/name, e.g. imapping/timesgate-controller, or the GitHub link.'), { status: 400 });
    return m[1];
  };
  const localOnly = ctx => { if (!ctx.local) throw Object.assign(new Error('Change the GitHub token on the PC itself.'), { status: 403 }); };

  tg.after(3000, check);
  tg.every(CHECK_MS, check);
  tg.every(ROTATE_MS, () => {
    if (s.repos.length > 1 && !party && tg.isLive()) { current = (current + 1) % s.repos.length; tg.update(); }
  });

  return {
    render: () => {
      const v = view();
      return { speed: GH_SPEED, parts: renderGithub(v).map((sc, i) => ({ key: sc.key, jobs: [{ screen: i, frames: sc.frames }] })) };
    },
    state,
    routes: {
      'GET /view': ({ query }) => view(query.get('repo')),
      'POST /check': async () => { await check(); return state(); },
      'POST /repos': async ({ body }) => {
        if (body.add) {
          const name = repoName(body.add);
          const info = await gh(`/repos/${name}`);   // check it exists, and use GitHub's spelling
          if (!s.repos.some(r => r.toLowerCase() === info.full_name.toLowerCase())) s.repos.push(info.full_name);
          current = s.repos.indexOf(info.full_name);
        }
        if (body.remove) { s.repos = s.repos.filter(r => r !== body.remove); delete s.seen[body.remove]; current = 0; }
        tg.save();
        await check();
        return state();
      },
      'POST /options': async ctx => {
        const b = ctx.body || {};
        if (typeof b.token === 'string') {
          localOnly(ctx);
          s.token = b.token.trim(); contrib = null;
          tg.save(); await check();
          if (error && s.token) { const e = error; s.token = ''; tg.save(); await check(); throw Object.assign(new Error('That token didn\'t work: ' + e), { status: 400 }); }
        }
        if (typeof b.beep === 'boolean') s.beep = b.beep;
        if (typeof b.rainbow === 'boolean') s.rainbow = b.rainbow;
        if (b.events) for (const k of ['stars', 'forks', 'issues']) if (typeof b.events[k] === 'boolean') s.events[k] = b.events[k];
        tg.save();
        return state();
      },
    },
    actions: {
      test: { label: 'test the celebration', run: () => celebrate(s.repos[current % (s.repos.length || 1)] || 'your/repo', { kind: 'star', n: 1, who: 'octocat' }) },
      next: { label: 'next repository', run: () => { if (s.repos.length > 1) { current = (current + 1) % s.repos.length; tg.update(); } } },
    },
  };
};
