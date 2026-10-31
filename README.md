# Interstants

A content creation platform for real people posting real videos.

**Live site:** https://allo20206real.github.io/Interstans/ (once it's set up, see below)

## Features

- **For You**: a full-screen feed of short videos you scroll up and down. It shows newer videos and ones with more likes this week first, and never shows you your own.
- **Following**: follow people and see their videos in their own feed. Every profile shows followers, following and total likes.
- **Short and long videos**: videos up to 3 minutes are posted as **shorts**. Longer ones go in **Long videos**, which have a full player.
- **Only real videos**: there is no sample or filler content. Every post must point to a video file that was actually uploaded. The site checks the file really is a video (MP4, MOV or WebM), and storage only accepts video types.
- **Tap to like, as much as you want**: tap the heart, or double-tap the video. You can't like your own videos.
- **No bots**:
  - You must solve a captcha to finish signing up. Without a profile, an account can't post, follow or like.
  - Taps are capped at human speed (15 a second, bursts of up to 40).
  - Every 1,000 taps you're asked to solve another captcha.
  - All of these rules are enforced by the database, so they can't be skipped by tampering with the website.
- **Creator Program**: join with **20,000 likes this week** (resets Monday 00:00 UTC) **or** **200 followers**. Members get a Creator badge.

You can change the numbers in `public.rules()` at the top of [`supabase/schema.sql`](supabase/schema.sql).

## How it's hosted (free)

- **GitHub Pages** hosts the website (the `site/` folder).
- **Supabase (free plan)** stores accounts, videos, followers and likes.

Free plan limits to know about:

- About **1 GB of video storage** in total, and at most **50 MB per video**.
- If nobody visits for about a week, Supabase **pauses** the project. Nothing is deleted. Open your Supabase dashboard and click **Restore** to bring it back.

## Setup (one time)

1. **Create the database.** In your Supabase project, open **SQL Editor → New query**, paste the whole contents of [`supabase/schema.sql`](supabase/schema.sql), and click **Run**.
2. **Turn off email confirmation (recommended).** Go to **Authentication → Sign In / Providers → Email** and turn off **Confirm email**. The free plan's built-in email only sends a few emails per hour, so new users could get stuck waiting for one. If you leave it on, also set **Authentication → URL Configuration → Site URL** to the live site address above.
3. **Connect the site.** Copy your **Project URL** and **anon / publishable key** from **Project Settings → API**, or from the **Connect** button, into [`site/config.js`](site/config.js). That key is meant to be public.
4. **Turn on GitHub Pages.** In this repo, open **Settings → Pages**, then under **Source** choose **GitHub Actions**. Every push to `main` that changes `site/` redeploys the site.

If you change `supabase/schema.sql` later, paste it into the SQL Editor and run it again. It's safe to re-run and keeps all your data.

## Testing

`supabase/tests/run.sh "<psql connection args>"` runs the database rules against an empty local Postgres database that imitates Supabase. It covers the captcha, profiles, upload permissions, the feeds, follows, tap limits, the Creator Program and tamper-proofing.
