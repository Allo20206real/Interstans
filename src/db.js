const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');

function openDb(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY,
      username TEXT NOT NULL UNIQUE COLLATE NOCASE,
      display_name TEXT NOT NULL,
      bio TEXT NOT NULL DEFAULT '',
      password_hash TEXT NOT NULL,
      taps_since_captcha INTEGER NOT NULL DEFAULT 0,
      creator_since INTEGER,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS videos (
      id INTEGER PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      filename TEXT NOT NULL,
      mime TEXT NOT NULL,
      duration REAL NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('short', 'long')),
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS videos_user ON videos(user_id, created_at);
    CREATE INDEX IF NOT EXISTS videos_kind ON videos(kind, created_at);

    CREATE TABLE IF NOT EXISTS follows (
      follower_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      followee_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (follower_id, followee_id),
      CHECK (follower_id <> followee_id)
    );
    CREATE INDEX IF NOT EXISTS follows_followee ON follows(followee_id);

    -- Each row is a batch of taps (likes) from one user on one video.
    CREATE TABLE IF NOT EXISTS taps (
      id INTEGER PRIMARY KEY,
      video_id INTEGER NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      creator_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      count INTEGER NOT NULL CHECK (count > 0),
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS taps_video ON taps(video_id);
    CREATE INDEX IF NOT EXISTS taps_creator_time ON taps(creator_id, created_at);

    CREATE TABLE IF NOT EXISTS captchas (
      id TEXT PRIMARY KEY,
      answer TEXT NOT NULL,
      expires_at INTEGER NOT NULL
    );
  `);
  return db;
}

module.exports = { openDb };
