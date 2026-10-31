\set ON_ERROR_STOP 1
-- Helpers (run as the superuser)
create function pg_temp.as_user(uid uuid) returns void language plpgsql as $$
begin perform set_config('request.jwt.claim.sub', coalesce(uid::text, ''), false);
  if uid is null then execute 'set role anon'; else execute 'set role authenticated'; end if; end $$;
create function pg_temp.answer(cid uuid) returns text language sql as $$ select answer from private.captchas where id = cid $$;
create function pg_temp.expect_error(sql text, pattern text) returns void language plpgsql as $$
begin
  begin execute sql; exception when others then
    if sqlerrm !~* pattern then raise exception 'expected error ~ %, got: %', pattern, sqlerrm; end if;
    return;
  end;
  raise exception 'expected error ~ % but it succeeded: %', pattern, sql;
end $$;
grant execute on all functions in schema pg_temp to anon, authenticated;

insert into auth.users (id) select ('00000000-0000-0000-0000-' || lpad(i::text, 12, '0'))::uuid from generate_series(1, 210) i;
\set alice '''00000000-0000-0000-0000-000000000001'''
\set bob   '''00000000-0000-0000-0000-000000000002'''

-- 1. Profile creation needs a correct, single-use captcha
create temp table cap as select (public.new_captcha()->>'id')::uuid id; grant select on cap to authenticated, anon;
select pg_temp.as_user(:alice);
select pg_temp.expect_error($$ select public.create_profile('alice', 'Alice', (select id from cap), 'WRONG') $$, 'captcha');
reset role;
truncate cap; insert into cap select (public.new_captcha()->>'id')::uuid; alter table cap add column a text; update cap set a = pg_temp.answer(id);
select pg_temp.as_user(:alice);
select public.create_profile('alice', 'Alice', (select id from cap), lower((select a from cap)));
select pg_temp.expect_error($$ select public.create_profile('alice2', 'A', (select id from cap), (select a from cap)) $$, 'already|captcha');
reset role;
select pg_temp.as_user(:bob);
select pg_temp.expect_error($$ select public.create_profile('bob', 'Bob', (select id from cap), (select a from cap)) $$, 'captcha');
reset role;
truncate cap; insert into cap select (public.new_captcha()->>'id')::uuid, null; update cap set a = pg_temp.answer(id);
select pg_temp.as_user(:bob);
select pg_temp.expect_error($$ select public.create_profile('ALICE', 'x', (select id from cap), (select a from cap)) $$, 'taken');
reset role;
truncate cap; insert into cap select (public.new_captcha()->>'id')::uuid, null; update cap set a = pg_temp.answer(id);
select pg_temp.as_user(:bob);
select public.create_profile('bob', 'Bob', (select id from cap), (select a from cap));
select pg_temp.expect_error($$ insert into public.profiles (id, username, display_name) values (auth.uid(), 'x', 'x') $$, 'permission');
select pg_temp.expect_error($$ update public.profiles set creator_since = now() $$, 'permission');
update public.profiles set bio = 'hi' where id = :alice;  -- RLS: silently affects 0 rows
reset role;
select 'ok 1 captcha + profiles' where (select bio from public.profiles where username = 'alice') = '';

-- 2. Videos: own folder only, kind decided by the database
select pg_temp.as_user(:alice);
select pg_temp.expect_error($$ insert into public.videos (user_id, title, storage_path, duration) values (auth.uid(), 'no file', auth.uid() || '/a.mp4', 30) $$, 'row-level');
insert into storage.objects (bucket_id, name) values ('videos', :alice || '/a.mp4'), ('videos', :alice || '/b.mp4');
insert into public.videos (user_id, title, storage_path, duration) values (auth.uid(), 'short', auth.uid() || '/a.mp4', 30);
insert into public.videos (user_id, title, storage_path, duration) values (auth.uid(), 'long', auth.uid() || '/b.mp4', 600);
select pg_temp.expect_error($$ insert into public.videos (user_id, title, storage_path, duration) values (auth.uid(), 'x', 'someone-else/c.mp4', 5) $$, 'row-level');
select pg_temp.expect_error($$ insert into public.videos (user_id, title, storage_path, duration, kind) values (auth.uid(), 'x', auth.uid() || '/a.mp4', 999, 'short') $$, 'permission');
select pg_temp.expect_error($$ insert into storage.objects (bucket_id, name) values ('videos', '00000000-0000-0000-0000-000000000002/x.mp4') $$, 'row-level');
reset role;
select pg_temp.as_user('00000000-0000-0000-0000-000000000099');  -- signed up but never passed the captcha
select pg_temp.expect_error($$ insert into storage.objects (bucket_id, name) values ('videos', auth.uid() || '/x.mp4') $$, 'row-level');
select pg_temp.expect_error($$ insert into public.videos (user_id, title, storage_path, duration) values (auth.uid(), 'x', auth.uid() || '/x.mp4', 5) $$, 'foreign key|violates');
reset role;
select 'ok 2 videos' where (select string_agg(kind, ',' order by id) from public.videos) = 'short,long';

-- 3. For You: shorts only, never your own; anon can browse
select pg_temp.as_user(:bob);
select 'ok 3a bob sees alice short' where (select count(*) from public.for_you()) = 1 and (select kind from public.for_you()) = 'short';
select pg_temp.as_user(:alice);
select 'ok 3b alice does not see her own' where (select count(*) from public.for_you()) = 0;
select pg_temp.as_user(null);
select 'ok 3c anon browses' where (select count(*) from public.for_you()) = 1 and (select count(*) from public.video_list) = 2;
select pg_temp.expect_error($$ insert into public.follows (follower_id, followee_id) values ('00000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000001') $$, 'permission');
reset role;

-- 4. Follows
select pg_temp.as_user(:bob);
insert into public.follows (follower_id, followee_id) values (auth.uid(), :alice);
select pg_temp.expect_error($$ insert into public.follows (follower_id, followee_id) values ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000002') $$, 'row-level');
select pg_temp.expect_error($$ insert into public.follows (follower_id, followee_id) values (auth.uid(), auth.uid()) $$, 'check');
select 'ok 4 follows' where (select followers from public.profile_list where username = 'alice') = 1;
reset role;

select id as vid from public.videos where title = 'short' \gset
select set_config('t.vid', :'vid', false);
-- 5. Taps: no self-likes, human speed, captcha every 1000; direct inserts blocked
select pg_temp.as_user(:alice);
select pg_temp.expect_error($$ select public.tap(current_setting('t.vid')::bigint, 1) $$, 'own video');
select pg_temp.as_user(:bob);
select pg_temp.expect_error($$ insert into public.taps (video_id, user_id, creator_id, count) values (current_setting('t.vid')::bigint, auth.uid(), '00000000-0000-0000-0000-000000000001', 99999) $$, 'permission');
select 'ok 5a burst capped at 40' where (public.tap(:vid, 1000000)->>'granted')::int = 40;
select 'ok 5b empty bucket' where (public.tap(:vid, 5)->>'granted')::int = 0;
reset role;
update private.tap_state set taps_since_captcha = 1000;
select pg_temp.as_user(:bob);
select 'ok 5c captcha required' where (public.tap(:vid, 1)->>'needs_captcha')::boolean;
reset role;
truncate cap; insert into cap select (public.new_captcha()->>'id')::uuid, null; update cap set a = pg_temp.answer(id);
update private.tap_state set updated_at = now() - interval '10 seconds';
select pg_temp.as_user(:bob);
select 'ok 5d captcha passes, tapping resumes' where (public.tap(:vid, 3, (select id from cap), (select a from cap))->>'granted')::int = 3;
reset role;
select 'ok 5e likes counted' where (select likes from public.video_list where id = :vid) = 43;

-- 6. Creator program
select pg_temp.as_user(:alice);
select 'ok 6a not eligible' where not (public.creator_status()->>'eligible')::boolean
  and (public.creator_status()->>'weekly_likes')::int = 43 and (public.creator_status()->>'followers_goal')::int = 200;
select pg_temp.expect_error($$ select public.join_creator_program() $$, 'not eligible');
reset role;
insert into public.profiles (id, username, display_name) select id, 'f' || right(id::text, 4), 'f' from auth.users where id::text > '00000000-0000-0000-0000-000000000002' and id::text <= '00000000-0000-0000-0000-000000000201';
insert into public.follows (follower_id, followee_id) select id, :alice from public.profiles where username like 'f%';
select pg_temp.as_user(:alice);
select 'ok 6b joined with 200 followers' where (public.join_creator_program()->>'member')::boolean;
reset role;
select pg_temp.as_user(:bob);
select pg_temp.expect_error($$ select public.join_creator_program() $$, 'not eligible');
reset role;
insert into public.videos (user_id, title, storage_path, duration) values (:bob, 'b', :bob || '/b.mp4', 10);
insert into public.taps (video_id, user_id, creator_id, count, created_at) select id, :alice::uuid, :bob::uuid, c, t from public.videos, (values (19999, now()), (50000, now() - interval '8 days')) x(c, t) where title = 'b';
select pg_temp.as_user(:bob);
select 'ok 6c 19,999 this week is not enough' where not (public.creator_status()->>'eligible')::boolean;
reset role;
insert into public.taps (video_id, user_id, creator_id, count) select id, :alice::uuid, :bob::uuid, 1 from public.videos where title = 'b';
select pg_temp.as_user(:bob);
select 'ok 6d joined with 20,000 likes this week' where (public.join_creator_program()->>'member')::boolean;
reset role;

-- 7. anon can't touch private data or write
select pg_temp.as_user(null);
select pg_temp.expect_error($$ select * from private.captchas $$, 'permission');
select pg_temp.expect_error($$ truncate public.taps $$, 'permission');
select pg_temp.expect_error($$ select public.tap(1, 1) $$, 'permission');
reset role;
select pg_temp.as_user(:bob);
select pg_temp.expect_error($$ truncate public.videos $$, 'permission');
delete from public.videos where user_id <> auth.uid();
reset role;
select 'ok 7 no tampering' where (select count(*) from public.videos) = 3;
