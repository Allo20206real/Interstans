const express = require('express');
const cookieParser = require('cookie-parser');
const multer = require('multer');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const cfg = require('./config');
const { makeCaptchaService } = require('./captcha');
const { probeVideo } = require('./videoProbe');

// ---------- helpers ----------
function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(pw, salt, 64);
  return `${salt.toString('hex')}:${hash.toString('hex')}`;
}
function checkPassword(pw, stored) {
  const [saltHex, hashHex] = stored.split(':');
  const hash = crypto.scryptSync(pw, Buffer.from(saltHex, 'hex'), 64);
  return crypto.timingSafeEqual(hash, Buffer.from(hashHex, 'hex'));
}
// Start of the current week: Monday 00:00 UTC.
function weekStart(now = Date.now()) {
  const d = new Date(now);
  const daysSinceMonday = (d.getUTCDay() + 6) % 7;
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - daysSinceMonday);
}
const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

function createApp({ db, uploadDir, captchaGenerator, now = () => Date.now(), signupsPerHourPerIp = 5 }) {
  fs.mkdirSync(uploadDir, { recursive: true });
  const captcha = makeCaptchaService(db, captchaGenerator);
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '32kb' }));
  app.use(cookieParser());

  // ---------- simple in-memory rate limiting ----------
  const hits = new Map();
  function rateLimit(key, max, windowMs) {
    const t = now();
    const arr = (hits.get(key) || []).filter((x) => x > t - windowMs);
    arr.push(t);
    hits.set(key, arr);
    return arr.length <= max;
  }
  const tapBuckets = new Map(); // userId -> { tokens, at }
  function takeTaps(userId, wanted) {
    const t = now();
    const b = tapBuckets.get(userId) || { tokens: cfg.TAP_BUCKET_SIZE, at: t };
    b.tokens = Math.min(cfg.TAP_BUCKET_SIZE, b.tokens + ((t - b.at) / 1000) * cfg.TAP_REFILL_PER_SECOND);
    b.at = t;
    const granted = Math.max(0, Math.min(wanted, Math.floor(b.tokens)));
    b.tokens -= granted;
    tapBuckets.set(userId, b);
    return granted;
  }

  // ---------- auth ----------
  function loadUser(req, _res, next) {
    const token = req.cookies.session;
    if (token) {
      const row = db.prepare(`SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
                              WHERE s.token = ? AND s.expires_at > ?`).get(token, now());
      if (row) req.user = row;
    }
    next();
  }
  function requireUser(req, res, next) {
    if (!req.user) return res.status(401).json({ error: 'Log in first.' });
    next();
  }
  function startSession(res, userId) {
    const token = crypto.randomBytes(32).toString('hex');
    db.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)')
      .run(token, userId, now() + cfg.SESSION_TTL_MS);
    res.cookie('session', token, { httpOnly: true, sameSite: 'lax', maxAge: cfg.SESSION_TTL_MS });
  }
  app.use(loadUser);

  // ---------- stats ----------
  const followerCount = (id) => db.prepare('SELECT COUNT(*) c FROM follows WHERE followee_id = ?').get(id).c;
  const followingCount = (id) => db.prepare('SELECT COUNT(*) c FROM follows WHERE follower_id = ?').get(id).c;
  const weeklyLikes = (id) =>
    db.prepare('SELECT COALESCE(SUM(count),0) c FROM taps WHERE creator_id = ? AND created_at >= ?').get(id, weekStart(now())).c;
  const totalLikes = (id) => db.prepare('SELECT COALESCE(SUM(count),0) c FROM taps WHERE creator_id = ?').get(id).c;
  const isFollowing = (a, b) => !!db.prepare('SELECT 1 FROM follows WHERE follower_id = ? AND followee_id = ?').get(a, b);

  function publicUser(u, viewer) {
    return {
      id: u.id,
      username: u.username,
      displayName: u.display_name,
      bio: u.bio,
      creator: !!u.creator_since,
      followers: followerCount(u.id),
      following: followingCount(u.id),
      likes: totalLikes(u.id),
      isFollowing: viewer ? isFollowing(viewer.id, u.id) : false,
      isMe: viewer ? viewer.id === u.id : false,
    };
  }
  const VIDEO_SELECT = `
    SELECT v.*, u.username, u.display_name, u.creator_since,
      (SELECT COALESCE(SUM(count),0) FROM taps t WHERE t.video_id = v.id) AS likes
    FROM videos v JOIN users u ON u.id = v.user_id`;
  function publicVideo(v, viewer) {
    return {
      id: v.id,
      title: v.title,
      description: v.description,
      kind: v.kind,
      duration: v.duration,
      url: `/media/${v.filename}`,
      likes: v.likes,
      createdAt: v.created_at,
      author: {
        id: v.user_id,
        username: v.username,
        displayName: v.display_name,
        creator: !!v.creator_since,
        isFollowing: viewer ? isFollowing(viewer.id, v.user_id) : false,
        isMe: viewer ? viewer.id === v.user_id : false,
      },
    };
  }

  // ---------- captcha ----------
  app.get('/api/captcha', (req, res) => {
    if (!rateLimit(`captcha:${req.ip}`, 30, 60_000)) return res.status(429).json({ error: 'Slow down.' });
    res.json(captcha.create());
  });

  // ---------- accounts ----------
  app.post('/api/signup', (req, res) => {
    if (!rateLimit(`signup:${req.ip}`, signupsPerHourPerIp, 60 * 60_000)) return res.status(429).json({ error: 'Too many sign-ups from this network. Try later.' });
    const { captchaId, captchaAnswer } = req.body || {};
    if (!captcha.verify(captchaId, captchaAnswer)) return res.status(400).json({ error: 'Captcha was wrong. Try the new one.', captcha: true });
    const username = str(req.body.username, 30);
    const displayName = str(req.body.displayName, 50) || username;
    const password = typeof req.body.password === 'string' ? req.body.password : '';
    if (!/^[a-zA-Z0-9_.]{3,30}$/.test(username)) return res.status(400).json({ error: 'Username: 3–30 letters, numbers, _ or .' });
    if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });
    if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) return res.status(409).json({ error: 'That username is taken.' });
    const { lastInsertRowid } = db.prepare(
      'INSERT INTO users (username, display_name, password_hash, created_at) VALUES (?, ?, ?, ?)'
    ).run(username, displayName, hashPassword(password), now());
    startSession(res, Number(lastInsertRowid));
    res.status(201).json({ ok: true });
  });

  app.post('/api/login', (req, res) => {
    if (!rateLimit(`login:${req.ip}`, 10, 15 * 60_000)) return res.status(429).json({ error: 'Too many attempts. Try again in a few minutes.' });
    const username = str(req.body?.username, 30);
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
    if (!user || !checkPassword(password, user.password_hash)) return res.status(401).json({ error: 'Wrong username or password.' });
    startSession(res, user.id);
    res.json({ ok: true });
  });

  app.post('/api/logout', (req, res) => {
    if (req.cookies.session) db.prepare('DELETE FROM sessions WHERE token = ?').run(req.cookies.session);
    res.clearCookie('session');
    res.json({ ok: true });
  });

  app.get('/api/me', (req, res) => {
    res.json({ user: req.user ? publicUser(req.user, req.user) : null });
  });

  app.patch('/api/me', requireUser, (req, res) => {
    const displayName = str(req.body?.displayName, 50) || req.user.display_name;
    const bio = req.body?.bio !== undefined ? str(req.body.bio, 300) : req.user.bio;
    db.prepare('UPDATE users SET display_name = ?, bio = ? WHERE id = ?').run(displayName, bio, req.user.id);
    res.json({ ok: true });
  });

  // ---------- profiles & follows ----------
  app.get('/api/users/:username', (req, res) => {
    const u = db.prepare('SELECT * FROM users WHERE username = ?').get(req.params.username);
    if (!u) return res.status(404).json({ error: 'No such user.' });
    const videos = db.prepare(`${VIDEO_SELECT} WHERE v.user_id = ? ORDER BY v.created_at DESC`).all(u.id);
    res.json({ user: publicUser(u, req.user), videos: videos.map((v) => publicVideo(v, req.user)) });
  });

  app.post('/api/users/:id/follow', requireUser, (req, res) => {
    const target = Number(req.params.id);
    if (target === req.user.id) return res.status(400).json({ error: "You can't follow yourself." });
    if (!db.prepare('SELECT 1 FROM users WHERE id = ?').get(target)) return res.status(404).json({ error: 'No such user.' });
    db.prepare('INSERT OR IGNORE INTO follows (follower_id, followee_id, created_at) VALUES (?, ?, ?)').run(req.user.id, target, now());
    res.json({ following: true, followers: followerCount(target) });
  });

  app.delete('/api/users/:id/follow', requireUser, (req, res) => {
    const target = Number(req.params.id);
    db.prepare('DELETE FROM follows WHERE follower_id = ? AND followee_id = ?').run(req.user.id, target);
    res.json({ following: false, followers: followerCount(target) });
  });

  // ---------- uploads ----------
  const upload = multer({
    storage: multer.diskStorage({
      destination: uploadDir,
      filename: (_req, _file, cb) => cb(null, crypto.randomBytes(16).toString('hex')),
    }),
    limits: { fileSize: cfg.MAX_UPLOAD_BYTES, files: 1 },
  });
  const EXT = { 'video/mp4': '.mp4', 'video/quicktime': '.mov', 'video/webm': '.webm' };

  app.post('/api/videos', requireUser, (req, res, next) => {
    if (!rateLimit(`upload:${req.user.id}`, 20, 60 * 60_000)) return res.status(429).json({ error: 'Upload limit reached. Try again later.' });
    upload.single('video')(req, res, (err) => {
      if (err) return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'Video is too large (max 1 GB).' : 'Upload failed.' });
      next();
    });
  }, (req, res) => {
    const reject = (msg) => {
      if (req.file) fs.rmSync(req.file.path, { force: true });
      res.status(400).json({ error: msg });
    };
    if (!req.file) return reject('Choose a video file.');
    const title = str(req.body.title, 120);
    if (!title) return reject('Give your video a title.');
    // Only real video files recorded/uploaded by the user — content is checked by its bytes.
    const probe = probeVideo(req.file.path);
    if (!probe) return reject('That file is not a video. Upload an MP4, MOV or WebM.');
    // Prefer the duration read from the file itself; fall back to what the browser measured.
    const clientDuration = Number(req.body.duration);
    const duration = probe.duration ?? (Number.isFinite(clientDuration) && clientDuration > 0 ? clientDuration : null);
    if (!duration) return reject("Couldn't read the video's length.");
    const kind = duration <= cfg.SHORT_MAX_SECONDS ? 'short' : 'long';
    const filename = req.file.filename + EXT[probe.mime];
    fs.renameSync(req.file.path, path.join(uploadDir, filename));
    const { lastInsertRowid } = db.prepare(
      `INSERT INTO videos (user_id, title, description, filename, mime, duration, kind, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(req.user.id, title, str(req.body.description, 2000), filename, probe.mime, duration, kind, now());
    const v = db.prepare(`${VIDEO_SELECT} WHERE v.id = ?`).get(lastInsertRowid);
    res.status(201).json({ video: publicVideo(v, req.user) });
  });

  app.delete('/api/videos/:id', requireUser, (req, res) => {
    const v = db.prepare('SELECT * FROM videos WHERE id = ? AND user_id = ?').get(Number(req.params.id), req.user.id);
    if (!v) return res.status(404).json({ error: 'Not found.' });
    db.prepare('DELETE FROM videos WHERE id = ?').run(v.id);
    fs.rmSync(path.join(uploadDir, v.filename), { force: true });
    res.json({ ok: true });
  });

  app.get('/api/videos/:id', (req, res) => {
    const v = db.prepare(`${VIDEO_SELECT} WHERE v.id = ?`).get(Number(req.params.id));
    if (!v) return res.status(404).json({ error: 'Not found.' });
    res.json({ video: publicVideo(v, req.user) });
  });

  // ---------- feeds (only videos real users uploaded — there is no seeded content) ----------
  app.get('/api/feed/foryou', (req, res) => {
    const exclude = (req.query.seen || '').split(',').map(Number).filter(Number.isInteger).slice(0, 500);
    const t = now();
    const recentSince = t - 7 * 24 * 3600_000;
    const rows = db.prepare(`
      SELECT v.*, u.username, u.display_name, u.creator_since,
        (SELECT COALESCE(SUM(count),0) FROM taps t WHERE t.video_id = v.id) AS likes,
        (SELECT COALESCE(SUM(count),0) FROM taps t WHERE t.video_id = v.id AND t.created_at >= ?) AS recent_likes
      FROM videos v JOIN users u ON u.id = v.user_id
      WHERE v.kind = 'short' ORDER BY v.created_at DESC LIMIT 1000`).all(recentSince);
    const seen = new Set(exclude);
    const scored = rows
      .filter((v) => !seen.has(v.id) && v.user_id !== req.user?.id)
      .map((v) => {
        const ageHours = (t - v.created_at) / 3600_000;
        const score = (Math.log10(v.recent_likes + 1) + 1) / Math.pow(ageHours + 2, 0.8) * (0.75 + Math.random() * 0.5);
        return { v, score };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, 10);
    res.json({ videos: scored.map(({ v }) => publicVideo(v, req.user)) });
  });

  app.get('/api/feed/following', requireUser, (req, res) => {
    const before = Number(req.query.before) || Number.MAX_SAFE_INTEGER;
    const rows = db.prepare(`${VIDEO_SELECT}
      WHERE v.user_id IN (SELECT followee_id FROM follows WHERE follower_id = ?) AND v.created_at < ?
      ORDER BY v.created_at DESC LIMIT 10`).all(req.user.id, before);
    res.json({ videos: rows.map((v) => publicVideo(v, req.user)) });
  });

  app.get('/api/feed/long', (req, res) => {
    const before = Number(req.query.before) || Number.MAX_SAFE_INTEGER;
    const rows = db.prepare(`${VIDEO_SELECT} WHERE v.kind = 'long' AND v.created_at < ?
      ORDER BY v.created_at DESC LIMIT 24`).all(before);
    res.json({ videos: rows.map((v) => publicVideo(v, req.user)) });
  });

  // ---------- taps (likes) ----------
  // Tap as many times as you like — at human speed, with a periodic "are you human?" check.
  app.post('/api/videos/:id/taps', requireUser, (req, res) => {
    const video = db.prepare('SELECT id, user_id FROM videos WHERE id = ?').get(Number(req.params.id));
    if (!video) return res.status(404).json({ error: 'Not found.' });
    if (video.user_id === req.user.id) return res.status(400).json({ error: "You can't like your own video." });

    const { captchaId, captchaAnswer } = req.body || {};
    let tapsSince = req.user.taps_since_captcha;
    if (captchaId) {
      if (!captcha.verify(captchaId, captchaAnswer)) return res.status(428).json({ error: 'Captcha was wrong.', needsCaptcha: true });
      tapsSince = 0;
      db.prepare('UPDATE users SET taps_since_captcha = 0 WHERE id = ?').run(req.user.id);
    }
    if (tapsSince >= cfg.TAPS_BETWEEN_CAPTCHAS) {
      return res.status(428).json({ error: 'Quick check: are you human?', needsCaptcha: true });
    }

    const wanted = Math.floor(Number(req.body?.count));
    if (!Number.isFinite(wanted) || wanted < 1) return res.status(400).json({ error: 'Bad tap count.' });
    const granted = takeTaps(req.user.id, Math.min(wanted, cfg.TAPS_BETWEEN_CAPTCHAS - tapsSince));
    if (granted > 0) {
      db.prepare('INSERT INTO taps (video_id, user_id, creator_id, count, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(video.id, req.user.id, video.user_id, granted, now());
      db.prepare('UPDATE users SET taps_since_captcha = taps_since_captcha + ? WHERE id = ?').run(granted, req.user.id);
    }
    const likes = db.prepare('SELECT COALESCE(SUM(count),0) c FROM taps WHERE video_id = ?').get(video.id).c;
    res.json({ granted, likes });
  });

  // ---------- creator program ----------
  function creatorStatus(user) {
    const likes = weeklyLikes(user.id);
    const followers = followerCount(user.id);
    return {
      member: !!user.creator_since,
      memberSince: user.creator_since,
      eligible: likes >= cfg.CREATOR_WEEKLY_LIKES || followers >= cfg.CREATOR_FOLLOWERS,
      weeklyLikes: likes,
      weeklyLikesGoal: cfg.CREATOR_WEEKLY_LIKES,
      followers,
      followersGoal: cfg.CREATOR_FOLLOWERS,
      weekStartedAt: weekStart(now()),
    };
  }
  app.get('/api/creator-program', requireUser, (req, res) => res.json(creatorStatus(req.user)));
  app.post('/api/creator-program/join', requireUser, (req, res) => {
    const status = creatorStatus(req.user);
    if (status.member) return res.json(status);
    if (!status.eligible) return res.status(403).json({ ...status, error: 'Not eligible yet.' });
    db.prepare('UPDATE users SET creator_since = ? WHERE id = ?').run(now(), req.user.id);
    res.json(creatorStatus(db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id)));
  });

  // ---------- static ----------
  app.use('/media', express.static(uploadDir, { maxAge: '7d', fallthrough: false }));
  app.use(express.static(path.join(__dirname, '..', 'public')));
  app.get(/^(?!\/api\/|\/media\/).*/, (_req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'index.html')));
  app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found.' }));
  return app;
}

module.exports = { createApp, weekStart };
