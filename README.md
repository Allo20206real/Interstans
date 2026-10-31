# Interstants

A content creation platform for real people posting real videos.

## Features

- **For You**: a full-screen feed of short videos that you scroll up and down. It ranks videos by how new they are and how many likes they got this week, and never shows you your own videos.
- **Following**: a feed of videos from the people you follow. You can follow and unfollow people, and every profile shows its followers, following and total likes.
- **Short and long videos**: videos up to 3 minutes are posted as **shorts** (For You). Longer videos are posted as **long videos**, which you can browse and watch in a full player.
- **Only real videos**: there is no sample, filler or generated content. Every video was uploaded by a signed-up user. The server checks each upload's actual bytes (MP4, MOV or WebM), so a renamed file is turned away.
- **Tap to like, as much as you want**: tap the heart (or double-tap the video) as many times as you like. You can't like your own videos.
- **No bots**:
  - You must solve a captcha to sign up.
  - Taps are limited to human speed (up to 15 a second, with short bursts of up to 40).
  - Every 1,000 taps you're asked to solve a quick "are you human?" captcha.
  - Sign-ups, log-ins and uploads are rate limited.
- **Creator Program**: you can join once you have **20,000 likes this week** (the count resets Monday 00:00 UTC) **or** **200 followers**. Members get a Creator badge.

All of these numbers are in [`src/config.js`](src/config.js).

## Run it

Requires Node.js 22.13+ (it uses the built-in `node:sqlite`).

```bash
npm install
npm start          # http://localhost:3000
npm test
```

Data is stored in `data/interstants.db`, and uploaded videos go in `uploads/`. You can change these locations with `DATA_DIR` / `UPLOAD_DIR`, and the port with `PORT`. If you run it behind a reverse proxy, set `TRUST_PROXY=1` so the per-IP rate limits see each user's real IP address.

## Notes for production

- The captcha is built in and needs no third-party account. For a large public launch, swap it for hCaptcha or Cloudflare Turnstile in `src/captcha.js`. The rest of the app only calls `create()` and `verify()`.
- Rate limits and tap buckets are kept in memory, so they assume a single server process.
