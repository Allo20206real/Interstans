// Platform rules live here so they're easy to find and change.
module.exports = {
  // Creator Program: qualify with EITHER of these.
  CREATOR_WEEKLY_LIKES: 20000, // likes (taps) received since Monday 00:00 UTC
  CREATOR_FOLLOWERS: 200,

  // Videos up to this length are "shorts" (For You feed); longer ones are "long" videos.
  SHORT_MAX_SECONDS: 180,
  MAX_UPLOAD_BYTES: 1024 * 1024 * 1024, // 1 GB

  // Anti-bot: taps are unlimited, but at human speed, with a periodic captcha check.
  TAP_BUCKET_SIZE: 40, // max burst of taps
  TAP_REFILL_PER_SECOND: 15, // sustained taps/second a human finger can manage
  TAPS_BETWEEN_CAPTCHAS: 1000, // re-verify you're human after this many taps

  CAPTCHA_TTL_MS: 5 * 60 * 1000,
  SESSION_TTL_MS: 30 * 24 * 60 * 60 * 1000,
};
