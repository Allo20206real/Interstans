const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openDb } = require('../src/db');
const { createApp, weekStart } = require('../src/app');
const cfg = require('../src/config');

let server, base, clock = Date.UTC(2026, 9, 28, 12); // a Wednesday
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'interstants-'));

// Minimal MP4: ftyp + moov/mvhd (timescale 1000, given duration in ms).
function fakeMp4(ms) {
  const ftyp = Buffer.concat([Buffer.from([0, 0, 0, 16]), Buffer.from('ftypisom'), Buffer.alloc(4)]);
  const mvhd = Buffer.alloc(8 + 100);
  mvhd.writeUInt32BE(108, 0); mvhd.write('mvhd', 4, 'latin1');
  mvhd.writeUInt32BE(1000, 8 + 12); mvhd.writeUInt32BE(ms, 8 + 16);
  const moov = Buffer.concat([Buffer.alloc(4), Buffer.from('moov'), mvhd]);
  moov.writeUInt32BE(moov.length, 0);
  return Buffer.concat([ftyp, moov, Buffer.alloc(64)]);
}

before(async () => {
  const app = createApp({
    db: openDb(':memory:'),
    uploadDir: path.join(tmp, 'uploads'),
    captchaGenerator: () => ({ text: 'HUMAN', svg: '<svg/>' }),
    now: () => clock,
    signupsPerHourPerIp: 10_000,
  });
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

function client() {
  let cookie = '';
  const call = async (method, url, body, isForm) => {
    const headers = cookie ? { cookie } : {};
    if (body && !isForm) headers['content-type'] = 'application/json';
    const res = await fetch(base + url, { method, headers, body: isForm ? body : body && JSON.stringify(body) });
    const set = res.headers.get('set-cookie'); if (set) cookie = set.split(';')[0];
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  return {
    get: (u) => call('GET', u), post: (u, b) => call('POST', u, b), del: (u) => call('DELETE', u),
    form: (u, fd) => call('POST', u, fd, true),
    async signup(username) {
      const c = await call('GET', '/api/captcha');
      const r = await call('POST', '/api/signup', { username, password: 'password123', captchaId: c.body.id, captchaAnswer: 'human' });
      assert.equal(r.status, 201, JSON.stringify(r.body));
      return (await call('GET', '/api/me')).body.user;
    },
  };
}
async function upload(c, ms, title = 'clip') {
  const fd = new FormData();
  fd.append('title', title);
  fd.append('video', new Blob([fakeMp4(ms)]), 'x.mp4');
  return c.form('/api/videos', fd);
}

test('signup requires a correct captcha, and captchas are single use', async () => {
  const c = client();
  const cap = await c.get('/api/captcha');
  assert.match(cap.body.image, /^data:image\/svg\+xml/);
  let r = await c.post('/api/signup', { username: 'botty', password: 'password123', captchaId: cap.body.id, captchaAnswer: 'WRONG' });
  assert.equal(r.status, 400);
  r = await c.post('/api/signup', { username: 'botty', password: 'password123', captchaId: cap.body.id, captchaAnswer: 'HUMAN' });
  assert.equal(r.status, 400, 'reused captcha must fail');
  r = await c.post('/api/signup', { username: 'botty', password: 'password123' });
  assert.equal(r.status, 400, 'missing captcha must fail');
});

test('uploads: real video files only, classified short vs long by duration', async () => {
  const c = client(); await c.signup('maker');
  const short = await upload(c, 30_000, 'short one');
  assert.equal(short.status, 201); assert.equal(short.body.video.kind, 'short');
  const long = await upload(c, (cfg.SHORT_MAX_SECONDS + 60) * 1000, 'long one');
  assert.equal(long.status, 201); assert.equal(long.body.video.kind, 'long');

  const fd = new FormData(); fd.append('title', 'fake'); fd.append('video', new Blob(['not a video at all']), 'fake.mp4');
  const bad = await c.form('/api/videos', fd);
  assert.equal(bad.status, 400); assert.match(bad.body.error, /not a video/);

  const anon = await upload(client(), 1000);
  assert.equal(anon.status, 401);
});

test('For You only shows real uploads, never your own, and no long videos', async () => {
  const empty = await (client()).get('/api/feed/foryou');
  assert.ok(Array.isArray(empty.body.videos));
  const c = client(); const u = await c.signup('viewer1');
  const feed = await c.get('/api/feed/foryou');
  assert.ok(feed.body.videos.length >= 1);
  assert.ok(feed.body.videos.every((v) => v.kind === 'short' && v.author.id !== u.id));
  const long = await c.get('/api/feed/long');
  assert.ok(long.body.videos.every((v) => v.kind === 'long'));
});

test('follow / unfollow and following feed', async () => {
  const a = client(); const ua = await a.signup('alice');
  const b = client(); await b.signup('bob');
  await upload(a, 5000, 'alice short');
  assert.equal((await b.get('/api/users/alice')).body.user.followers, 0);
  const bob = (await b.get('/api/me')).body.user;
  assert.equal((await b.post(`/api/users/${bob.id}/follow`)).status, 400, 'cannot follow self');
  let r = await b.post(`/api/users/${ua.id}/follow`);
  assert.deepEqual(r.body, { following: true, followers: 1 });
  r = await b.post(`/api/users/${ua.id}/follow`);
  assert.equal(r.body.followers, 1, 'following twice is idempotent');
  const feed = await b.get('/api/feed/following');
  assert.ok(feed.body.videos.length && feed.body.videos.every((v) => v.author.username === 'alice'));
  r = await b.del(`/api/users/${ua.id}/follow`);
  assert.deepEqual(r.body, { following: false, followers: 0 });
});

test('taps: unlimited but human-speed, no self-likes, captcha every N taps', async () => {
  const creator = client(); await creator.signup('tapcreator');
  const vid = (await upload(creator, 5000)).body.video;
  assert.equal((await creator.post(`/api/videos/${vid.id}/taps`, { count: 1 })).status, 400, 'no self likes');

  const fan = client(); await fan.signup('fan');
  let r = await fan.post(`/api/videos/${vid.id}/taps`, { count: 1_000_000 });
  assert.equal(r.body.granted, cfg.TAP_BUCKET_SIZE, 'burst capped at human speed');
  r = await fan.post(`/api/videos/${vid.id}/taps`, { count: 5 });
  assert.equal(r.body.granted, 0, 'bucket empty until time passes');

  // Tap at human speed until the captcha kicks in.
  let total = cfg.TAP_BUCKET_SIZE;
  while (total < cfg.TAPS_BETWEEN_CAPTCHAS) {
    clock += 10_000;
    r = await fan.post(`/api/videos/${vid.id}/taps`, { count: 40 });
    total += r.body.granted;
  }
  clock += 10_000;
  r = await fan.post(`/api/videos/${vid.id}/taps`, { count: 1 });
  assert.equal(r.status, 428); assert.equal(r.body.needsCaptcha, true);
  const cap = await fan.get('/api/captcha');
  r = await fan.post(`/api/videos/${vid.id}/taps`, { count: 3, captchaId: cap.body.id, captchaAnswer: 'HUMAN' });
  assert.equal(r.status, 200); assert.equal(r.body.granted, 3);
  assert.equal(r.body.likes, cfg.TAPS_BETWEEN_CAPTCHAS + 3);
});

test('creator program: 200 followers OR 20,000 likes this week', async () => {
  const c = client(); const u = await c.signup('hopeful');
  let s = await c.get('/api/creator-program');
  assert.equal(s.body.eligible, false);
  assert.equal(s.body.weeklyLikesGoal, 20000); assert.equal(s.body.followersGoal, 200);
  assert.equal((await c.post('/api/creator-program/join')).status, 403);

  for (let i = 0; i < cfg.CREATOR_FOLLOWERS; i++) {
    if (i % 20 === 0) clock += 61_000; // stay under the per-IP captcha rate limit
    const f = client(); await f.signup(`follower${i}`);
    await f.post(`/api/users/${u.id}/follow`);
  }
  s = await c.post('/api/creator-program/join');
  assert.equal(s.status, 200); assert.equal(s.body.member, true);
  assert.equal((await c.get('/api/users/hopeful')).body.user.creator, true);
});

test('weekly likes reset on Monday 00:00 UTC', () => {
  assert.equal(weekStart(Date.UTC(2026, 9, 28, 12)), Date.UTC(2026, 9, 26)); // Wed -> Mon
  assert.equal(weekStart(Date.UTC(2026, 10, 1, 23)), Date.UTC(2026, 9, 26)); // Sun -> Mon
  assert.equal(weekStart(Date.UTC(2026, 9, 26, 0)), Date.UTC(2026, 9, 26)); // Mon
});
