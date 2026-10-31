-- Interstants database setup.
-- Paste this whole file into Supabase → SQL Editor → New query, then click Run.
-- It is safe to run again later (e.g. after an update): it only creates/replaces things.

-- ============================================================
-- Platform rules (change the numbers here)
-- ============================================================
create or replace function public.rules() returns jsonb language sql immutable as $$
  select jsonb_build_object(
    'creator_weekly_likes', 20000,   -- likes received since Monday 00:00 UTC
    'creator_followers',    200,
    'short_max_seconds',    180,     -- up to this = short (For You), longer = long video
    'tap_bucket_size',      40,      -- max burst of taps
    'tap_refill_per_sec',   15,      -- sustained human tapping speed
    'taps_between_captchas',1000     -- "are you human?" check after this many taps
  );
$$;

create schema if not exists private;
revoke all on schema private from anon, authenticated;

-- ============================================================
-- Tables
-- ============================================================
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  username text not null check (username ~ '^[A-Za-z0-9_.]{3,30}$'),
  display_name text not null check (char_length(display_name) between 1 and 50),
  bio text not null default '' check (char_length(bio) <= 300),
  creator_since timestamptz,
  created_at timestamptz not null default now()
);
create unique index if not exists profiles_username_lower on public.profiles (lower(username));

create table if not exists public.videos (
  id bigint generated always as identity primary key,
  user_id uuid not null references public.profiles(id) on delete cascade,
  title text not null check (char_length(title) between 1 and 120),
  description text not null default '' check (char_length(description) <= 2000),
  storage_path text not null unique,
  duration real not null check (duration > 0),
  kind text not null check (kind in ('short', 'long')),
  created_at timestamptz not null default now()
);
create index if not exists videos_user on public.videos (user_id, created_at desc);
create index if not exists videos_kind on public.videos (kind, created_at desc);

create table if not exists public.follows (
  follower_id uuid not null references public.profiles(id) on delete cascade,
  followee_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (follower_id, followee_id),
  check (follower_id <> followee_id)
);
create index if not exists follows_followee on public.follows (followee_id);

-- Each row is a batch of taps (likes) from one person on one video.
create table if not exists public.taps (
  id bigint generated always as identity primary key,
  video_id bigint not null references public.videos(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  creator_id uuid not null references public.profiles(id) on delete cascade,
  count int not null check (count > 0),
  created_at timestamptz not null default now()
);
create index if not exists taps_video on public.taps (video_id);
create index if not exists taps_creator_time on public.taps (creator_id, created_at);

-- Hidden from the app: captcha answers and anti-bot tap state.
create table if not exists private.captchas (
  id uuid primary key default gen_random_uuid(),
  answer text not null,
  expires_at timestamptz not null
);
create table if not exists private.tap_state (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  tokens real not null,
  updated_at timestamptz not null,
  taps_since_captcha int not null default 0
);

-- ============================================================
-- Row level security: everyone can read; writes are limited to your own stuff.
-- Likes, captchas, follows-of-yourself and creator status are only changed by
-- the functions below, never directly.
-- ============================================================
alter table public.profiles enable row level security;
alter table public.videos   enable row level security;
alter table public.follows  enable row level security;
alter table public.taps     enable row level security;

revoke all on public.profiles, public.videos, public.follows, public.taps from anon, authenticated;
grant select on public.profiles, public.videos, public.follows, public.taps to anon, authenticated;
grant update (display_name, bio) on public.profiles to authenticated;
grant insert (user_id, title, description, storage_path, duration) on public.videos to authenticated;
grant delete on public.videos to authenticated;
grant insert (follower_id, followee_id), delete on public.follows to authenticated;

drop policy if exists "read profiles" on public.profiles;
create policy "read profiles" on public.profiles for select using (true);
drop policy if exists "edit own profile" on public.profiles;
create policy "edit own profile" on public.profiles for update to authenticated
  using (id = auth.uid()) with check (id = auth.uid());

drop policy if exists "read videos" on public.videos;
create policy "read videos" on public.videos for select using (true);
drop policy if exists "post own videos" on public.videos;
create policy "post own videos" on public.videos for insert to authenticated
  with check (user_id = auth.uid()
              and storage_path like auth.uid()::text || '/%'
              -- every post must point at a file that was really uploaded
              and exists (select 1 from storage.objects o where o.bucket_id = 'videos' and o.name = storage_path));
drop policy if exists "delete own videos" on public.videos;
create policy "delete own videos" on public.videos for delete to authenticated using (user_id = auth.uid());

drop policy if exists "read follows" on public.follows;
create policy "read follows" on public.follows for select using (true);
drop policy if exists "follow as yourself" on public.follows;
create policy "follow as yourself" on public.follows for insert to authenticated with check (follower_id = auth.uid());
drop policy if exists "unfollow as yourself" on public.follows;
create policy "unfollow as yourself" on public.follows for delete to authenticated using (follower_id = auth.uid());

drop policy if exists "read taps" on public.taps;
create policy "read taps" on public.taps for select using (true);

-- A video's kind (short/long) is decided by the database from its duration.
create or replace function private.set_video_kind() returns trigger language plpgsql as $$
begin
  new.kind := case when new.duration <= (public.rules()->>'short_max_seconds')::real then 'short' else 'long' end;
  new.created_at := now();
  return new;
end $$;
drop trigger if exists set_video_kind on public.videos;
create trigger set_video_kind before insert on public.videos for each row execute function private.set_video_kind();
-- kind is filled in by the trigger, so give it a placeholder default
alter table public.videos alter column kind set default 'short';

-- ============================================================
-- Read-friendly views
-- ============================================================
create or replace view public.video_list with (security_invoker = true) as
select v.id, v.user_id, v.title, v.description, v.storage_path, v.duration, v.kind, v.created_at,
       p.username, p.display_name, p.creator_since is not null as creator,
       coalesce((select sum(t.count) from public.taps t where t.video_id = v.id), 0)::bigint as likes
from public.videos v join public.profiles p on p.id = v.user_id;

create or replace view public.profile_list with (security_invoker = true) as
select p.id, p.username, p.display_name, p.bio, p.creator_since is not null as creator, p.created_at,
       (select count(*) from public.follows f where f.followee_id = p.id) as followers,
       (select count(*) from public.follows f where f.follower_id = p.id) as following,
       coalesce((select sum(t.count) from public.taps t where t.creator_id = p.id), 0)::bigint as likes
from public.profiles p;

revoke all on public.video_list, public.profile_list from anon, authenticated;
grant select on public.video_list, public.profile_list to anon, authenticated;

-- ============================================================
-- Captcha (self-hosted, generated inside the database — no extra accounts)
-- ============================================================
create or replace function public.new_captcha() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  alphabet constant text := 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  txt text := '';
  svg text;
  ch text; x real; y real; i int;
  cid uuid;
begin
  delete from private.captchas where expires_at < now();
  if (select count(*) from private.captchas) > 50000 then
    raise exception 'Too many people signing up right now. Try again in a minute.';
  end if;
  for i in 1..5 loop
    txt := txt || substr(alphabet, 1 + floor(random() * length(alphabet))::int, 1);
  end loop;
  svg := '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="70" viewBox="0 0 200 70"><rect width="200" height="70" fill="#f3f0ff"/>';
  for i in 1..6 loop
    svg := svg || format('<path d="M%s %s Q%s %s %s %s" stroke="hsl(%s,60%%,55%%)" stroke-width="%s" fill="none"/>',
      round((random()*200)::numeric,1), round((random()*70)::numeric,1), round((random()*200)::numeric,1),
      round((random()*70)::numeric,1), round((random()*200)::numeric,1), round((random()*70)::numeric,1),
      floor(random()*360), round((1 + random()*1.5)::numeric,1));
  end loop;
  for i in 1..5 loop
    ch := substr(txt, i, 1);
    x := 22 + (i-1) * 36 + (random()*8 - 4);
    y := 47 + (random()*16 - 8);
    svg := svg || format('<text x="%s" y="%s" font-family="monospace" font-size="%s" font-weight="bold" fill="hsl(%s,55%%,%s%%)" transform="rotate(%s %s %s) skewX(%s)">%s</text>',
      round(x::numeric,1), round(y::numeric,1), 30 + floor(random()*8), 230 + floor(random()*70), 25 + floor(random()*15),
      round((random()*56 - 28)::numeric,1), round(x::numeric,1), round(y::numeric,1), round((random()*24 - 12)::numeric,1), ch);
  end loop;
  for i in 1..40 loop
    svg := svg || format('<circle cx="%s" cy="%s" r="%s" fill="hsl(%s,50%%,50%%)"/>',
      round((random()*200)::numeric,1), round((random()*70)::numeric,1), round((0.5 + random()*1.3)::numeric,1), floor(random()*360));
  end loop;
  svg := svg || '</svg>';
  insert into private.captchas (answer, expires_at) values (txt, now() + interval '5 minutes') returning id into cid;
  return jsonb_build_object('id', cid, 'image', 'data:image/svg+xml;base64,' || replace(encode(convert_to(svg, 'UTF8'), 'base64'), E'\n', ''));
end $$;

-- Single use: consumed on the first attempt, right or wrong.
create or replace function private.check_captcha(cid uuid, answer text) returns boolean
language plpgsql security definer set search_path = '' as $$
declare real_answer text;
begin
  if cid is null or answer is null then return false; end if;
  delete from private.captchas c where c.id = cid and c.expires_at > now() returning c.answer into real_answer;
  return real_answer is not null and real_answer = upper(trim(answer));
end $$;

-- ============================================================
-- Account: after signing up with email, you must pass the captcha to create
-- your profile. Without a profile you can't post, follow or like.
-- ============================================================
create or replace function public.create_profile(username text, display_name text, captcha_id uuid, captcha_answer text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare uid uuid := auth.uid();
begin
  if uid is null then raise exception 'Log in first.'; end if;
  if exists (select 1 from public.profiles where id = uid) then raise exception 'You already have a profile.'; end if;
  if not private.check_captcha(captcha_id, captcha_answer) then raise exception 'Captcha was wrong. Try the new one.'; end if;
  if username !~ '^[A-Za-z0-9_.]{3,30}$' then raise exception 'Username: 3–30 letters, numbers, _ or .'; end if;
  if exists (select 1 from public.profiles p where lower(p.username) = lower(create_profile.username)) then
    raise exception 'That username is taken.';
  end if;
  insert into public.profiles (id, username, display_name)
  values (uid, username, coalesce(nullif(trim(left(display_name, 50)), ''), username));
  return jsonb_build_object('ok', true);
end $$;

-- ============================================================
-- Taps (likes): tap as much as you want — at human speed, with a captcha
-- every N taps. You can't like your own videos.
-- ============================================================
create or replace function public.tap(video_id bigint, count int, captcha_id uuid default null, captcha_answer text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := auth.uid();
  r jsonb := public.rules();
  bucket real := (r->>'tap_bucket_size')::real;
  refill real := (r->>'tap_refill_per_sec')::real;
  per_captcha int := (r->>'taps_between_captchas')::int;
  creator uuid;
  st private.tap_state;
  granted int;
  total bigint;
begin
  if uid is null or not exists (select 1 from public.profiles where id = uid) then raise exception 'Log in first.'; end if;
  select v.user_id into creator from public.videos v where v.id = tap.video_id;
  if creator is null then raise exception 'Video not found.'; end if;
  if creator = uid then raise exception 'You can''t like your own video.'; end if;
  if count is null or count < 1 then raise exception 'Bad tap count.'; end if;

  insert into private.tap_state (user_id, tokens, updated_at) values (uid, bucket, now()) on conflict do nothing;
  select * into st from private.tap_state where user_id = uid for update;

  if captcha_id is not null then
    if not private.check_captcha(captcha_id, captcha_answer) then
      return jsonb_build_object('needs_captcha', true, 'error', 'Captcha was wrong.');
    end if;
    st.taps_since_captcha := 0;
  end if;
  if st.taps_since_captcha >= per_captcha then
    update private.tap_state set taps_since_captcha = st.taps_since_captcha where user_id = uid;
    return jsonb_build_object('needs_captcha', true, 'error', 'Quick check: are you human?');
  end if;

  st.tokens := least(bucket, st.tokens + extract(epoch from (clock_timestamp() - st.updated_at))::real * refill);
  granted := greatest(0, least(count, floor(st.tokens)::int, per_captcha - st.taps_since_captcha));
  update private.tap_state
     set tokens = st.tokens - granted, updated_at = clock_timestamp(), taps_since_captcha = st.taps_since_captcha + granted
   where user_id = uid;
  if granted > 0 then
    insert into public.taps (video_id, user_id, creator_id, count) values (tap.video_id, uid, creator, granted);
  end if;
  select coalesce(sum(t.count), 0) into total from public.taps t where t.video_id = tap.video_id;
  return jsonb_build_object('granted', granted, 'likes', total);
end $$;

-- ============================================================
-- For You feed: shorts only, never your own, newer + more liked this week first.
-- ============================================================
create or replace function public.for_you(seen bigint[] default '{}')
returns setof public.video_list language sql stable security invoker set search_path = '' as $$
  select vl.* from public.video_list vl
  where vl.kind = 'short'
    and vl.user_id is distinct from auth.uid()
    and not (vl.id = any(coalesce(seen, '{}')))
  order by
    (log(1 + coalesce((select sum(t.count) from public.taps t
                       where t.video_id = vl.id and t.created_at > now() - interval '7 days'), 0)) + 1)
    / power(extract(epoch from (now() - vl.created_at)) / 3600 + 2, 0.8)
    * (0.75 + random() * 0.5) desc
  limit 10;
$$;

-- ============================================================
-- Creator Program: 20,000 likes this week OR 200 followers.
-- ============================================================
create or replace function public.creator_status() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  uid uuid := auth.uid();
  r jsonb := public.rules();
  week_start timestamptz := date_trunc('week', now() at time zone 'utc') at time zone 'utc';
  likes bigint; followers bigint; since timestamptz;
begin
  if uid is null then raise exception 'Log in first.'; end if;
  select creator_since into since from public.profiles where id = uid;
  select coalesce(sum(count), 0) into likes from public.taps where creator_id = uid and created_at >= week_start;
  select count(*) into followers from public.follows where followee_id = uid;
  return jsonb_build_object(
    'member', since is not null, 'member_since', since,
    'eligible', likes >= (r->>'creator_weekly_likes')::bigint or followers >= (r->>'creator_followers')::bigint,
    'weekly_likes', likes, 'weekly_likes_goal', (r->>'creator_weekly_likes')::bigint,
    'followers', followers, 'followers_goal', (r->>'creator_followers')::bigint,
    'week_started_at', week_start);
end $$;

create or replace function public.join_creator_program() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare s jsonb := public.creator_status();
begin
  if (s->>'member')::boolean then return s; end if;
  if not (s->>'eligible')::boolean then raise exception 'Not eligible yet.'; end if;
  update public.profiles set creator_since = now() where id = auth.uid();
  return public.creator_status();
end $$;

revoke all on function public.new_captcha(), public.create_profile(text, text, uuid, text),
  public.tap(bigint, int, uuid, text), public.for_you(bigint[]), public.creator_status(),
  public.join_creator_program(), public.rules() from public, anon, authenticated;
revoke all on function private.check_captcha(uuid, text), private.set_video_kind() from public, anon, authenticated;
grant execute on function public.new_captcha(), public.for_you(bigint[]), public.rules() to anon, authenticated;
grant execute on function public.create_profile(text, text, uuid, text), public.tap(bigint, int, uuid, text),
  public.creator_status(), public.join_creator_program() to authenticated;

-- ============================================================
-- Video storage: public to watch; you can only upload into your own folder,
-- only real video types, and only after you've made a profile (passed the captcha).
-- ============================================================
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('videos', 'videos', true, 52428800, array['video/mp4', 'video/quicktime', 'video/webm'])
on conflict (id) do update set public = true, file_size_limit = 52428800,
  allowed_mime_types = array['video/mp4', 'video/quicktime', 'video/webm'];

drop policy if exists "upload own videos" on storage.objects;
create policy "upload own videos" on storage.objects for insert to authenticated
  with check (bucket_id = 'videos'
              and (storage.foldername(name))[1] = auth.uid()::text
              and exists (select 1 from public.profiles where id = auth.uid()));
drop policy if exists "see own video files" on storage.objects;
create policy "see own video files" on storage.objects for select to authenticated
  using (bucket_id = 'videos' and (storage.foldername(name))[1] = auth.uid()::text);
drop policy if exists "delete own videos" on storage.objects;
create policy "delete own videos" on storage.objects for delete to authenticated
  using (bucket_id = 'videos' and (storage.foldername(name))[1] = auth.uid()::text);
