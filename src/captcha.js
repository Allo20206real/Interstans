// Self-hosted image captcha. No third-party account needed.
// For a large public launch, swap `generate` for hCaptcha / Cloudflare Turnstile —
// the rest of the app only depends on createCaptcha() / verifyCaptcha().
const crypto = require('node:crypto');
const { CAPTCHA_TTL_MS } = require('./config');

const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no look-alikes (0/O, 1/I/L)

function rand(min, max) {
  return min + crypto.randomInt(0, 1_000_000) / 1_000_000 * (max - min);
}

function generate() {
  let text = '';
  for (let i = 0; i < 5; i++) text += ALPHABET[crypto.randomInt(ALPHABET.length)];

  const w = 200, h = 70;
  const parts = [`<rect width="${w}" height="${h}" fill="#f3f0ff"/>`];
  for (let i = 0; i < 6; i++) {
    parts.push(`<path d="M${rand(0, w)} ${rand(0, h)} Q${rand(0, w)} ${rand(0, h)} ${rand(0, w)} ${rand(0, h)}" stroke="hsl(${rand(0, 360)},60%,55%)" stroke-width="${rand(1, 2.5)}" fill="none"/>`);
  }
  [...text].forEach((ch, i) => {
    const x = 22 + i * 36 + rand(-4, 4), y = 47 + rand(-8, 8);
    parts.push(`<text x="${x}" y="${y}" font-family="monospace" font-size="${rand(30, 38)}" font-weight="bold" fill="hsl(${rand(230, 300)},55%,${rand(25, 40)}%)" transform="rotate(${rand(-28, 28)} ${x} ${y}) skewX(${rand(-12, 12)})">${ch}</text>`);
  });
  for (let i = 0; i < 40; i++) {
    parts.push(`<circle cx="${rand(0, w)}" cy="${rand(0, h)}" r="${rand(0.5, 1.8)}" fill="hsl(${rand(0, 360)},50%,50%)"/>`);
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${parts.join('')}</svg>`;
  return { text, svg };
}

function makeCaptchaService(db, generator = generate) {
  return {
    create() {
      const now = Date.now();
      db.prepare('DELETE FROM captchas WHERE expires_at < ?').run(now);
      const { text, svg } = generator();
      const id = crypto.randomUUID();
      db.prepare('INSERT INTO captchas (id, answer, expires_at) VALUES (?, ?, ?)')
        .run(id, text.toUpperCase(), now + CAPTCHA_TTL_MS);
      return { id, image: 'data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64') };
    },
    // Single use: a captcha is consumed on the first attempt, right or wrong.
    verify(id, answer) {
      if (typeof id !== 'string' || typeof answer !== 'string') return false;
      const row = db.prepare('DELETE FROM captchas WHERE id = ? RETURNING answer, expires_at').get(id);
      if (!row || row.expires_at < Date.now()) return false;
      const a = Buffer.from(row.answer), b = Buffer.from(answer.trim().toUpperCase());
      return a.length === b.length && crypto.timingSafeEqual(a, b);
    },
  };
}

module.exports = { makeCaptchaService, generate };
