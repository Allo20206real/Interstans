'use strict';
const $ = (sel, root = document) => root.querySelector(sel);
const view = $('#view');
const CFG = window.INTERSTANTS_CONFIG || {};
const SHORT_MAX_SECONDS = 180;
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024; // Supabase free plan per-file limit
let sb = null;
let me = null;       // my profile (from profile_list) or null
let session = null;  // Supabase auth session or null
let routeId = 0;     // bumps on every navigation so slow, outdated pages don't draw over new ones

// ---------- utilities ----------
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (n) => { n = Number(n) || 0; return n >= 1e6 ? (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M' : n >= 1e4 ? (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'K' : n.toLocaleString(); };
const dur = (s) => { s = Math.round(s); const h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, x = String(s % 60).padStart(2, '0'); return h ? `${h}:${String(m).padStart(2, '0')}:${x}` : `${m}:${x}`; };
const ago = (t) => { const s = (Date.now() - new Date(t)) / 1000; for (const [n, u] of [[86400 * 7, 'w'], [86400, 'd'], [3600, 'h'], [60, 'm']]) if (s >= n) return Math.floor(s / n) + u; return 'now'; };
const initial = (name) => esc((name || '?').trim()[0]?.toUpperCase() || '?');
const videoUrl = (path) => sb.storage.from('videos').getPublicUrl(path).data.publicUrl;

// Throws a readable Error if Supabase returned one.
function ok({ data, error }) {
  if (error) {
    const msg = error.message || 'Something went wrong.';
    throw new Error(/JWT|token/i.test(msg) ? 'Your login expired. Log in again.' : msg);
  }
  return data;
}
function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.classList.remove('hidden');
  clearTimeout(toast.timer); toast.timer = setTimeout(() => t.classList.add('hidden'), 2800);
}
function needLogin() { toast('Log in to do that'); location.hash = '#/login'; }

async function refreshMe() {
  session = (await sb.auth.getSession()).data.session;
  me = null;
  if (session) me = ok(await sb.from('profile_list').select('*').eq('id', session.user.id).maybeSingle());
  $('#account').innerHTML = me
    ? `<a class="btn small primary" href="#/upload">+ Post</a>
       <a href="#/creator" class="btn small">Creator</a>
       <a href="#/u/${encodeURIComponent(me.username)}" class="avatar" style="width:34px;height:34px;font-size:14px" title="@${esc(me.username)}">${initial(me.display_name)}</a>`
    : session
      ? `<a class="btn small primary" href="#/finish">Finish sign-up</a>`
      : `<a class="btn small" href="#/login">Log in</a><a class="btn small primary" href="#/signup">Sign up</a>`;
}

// Turn video_list rows into the shape the UI uses, including "am I following them?".
async function hydrate(rows) {
  let following = new Set();
  const ids = [...new Set(rows.map((r) => r.user_id))];
  if (me && ids.length) {
    const f = ok(await sb.from('follows').select('followee_id').eq('follower_id', me.id).in('followee_id', ids));
    following = new Set(f.map((x) => x.followee_id));
  }
  return rows.map((r) => ({
    id: r.id, title: r.title, description: r.description, kind: r.kind, duration: r.duration,
    url: videoUrl(r.storage_path), path: r.storage_path, likes: Number(r.likes), createdAt: r.created_at,
    author: { id: r.user_id, username: r.username, displayName: r.display_name, creator: r.creator,
      isFollowing: following.has(r.user_id), isMe: me?.id === r.user_id },
  }));
}

// ---------- captcha ----------
async function loadCaptcha(container) {
  const c = ok(await sb.rpc('new_captcha'));
  container.innerHTML = `<div class="captcha"><img alt="Type the characters shown" src="${c.image}">
    <button type="button" class="btn small" title="New code">↻</button></div>
    <input type="text" name="captcha" placeholder="Type the characters above" autocomplete="off" autocapitalize="characters" required maxlength="8">`;
  container.dataset.id = c.id;
  $('button', container).onclick = () => loadCaptcha(container);
}
const captchaValue = (container) => ({ captcha_id: container.dataset.id, captcha_answer: $('input', container).value });

function askHuman() {
  return new Promise((resolve) => {
    const modal = $('#modal');
    modal.innerHTML = `<form class="card"><h1>Are you human?</h1>
      <p class="muted">You've been tapping a lot! Type the code to keep going. This keeps bots off Interstants.</p>
      <div id="hc"></div><p class="error"></p>
      <div class="row"><button class="btn primary">Continue</button><button type="button" class="btn" id="hcCancel">Cancel</button></div></form>`;
    modal.classList.remove('hidden');
    const box = $('#hc', modal);
    loadCaptcha(box).then(() => $('input', box).focus());
    const close = (v) => { modal.classList.add('hidden'); modal.innerHTML = ''; resolve(v); };
    $('#hcCancel', modal).onclick = () => close(null);
    $('form', modal).onsubmit = (e) => { e.preventDefault(); close(captchaValue(box)); };
  });
}

// ---------- taps (likes): tap as much as you want ----------
const pending = new Map(); // videoId -> { count, els: Set }
let flushTimer = null, humanCheck = null;
function tap(video, btn, stage) {
  if (!me) return needLogin();
  if (video.author.isMe) return toast("You can't like your own video");
  const p = pending.get(video.id) || { count: 0, els: new Set() };
  p.count++; p.els.add(btn); pending.set(video.id, p);
  video.likes++;
  $('.count', btn).textContent = fmt(video.likes);
  if (stage) {
    const h = document.createElement('div'); h.className = 'float-heart'; h.textContent = '❤️';
    h.style.right = 22 + Math.random() * 20 + 'px'; h.style.bottom = 120 + 'px';
    stage.appendChild(h); setTimeout(() => h.remove(), 900);
  }
  if (!flushTimer) flushTimer = setTimeout(flushTaps, 600);
}
async function flushTaps(extra = {}) {
  flushTimer = null;
  for (const [id, p] of [...pending]) {
    pending.delete(id);
    try {
      const r = ok(await sb.rpc('tap', { video_id: id, count: p.count, ...extra }));
      extra = {};
      if (r.needs_captcha) {
        pending.set(id, p);
        if (!humanCheck) humanCheck = askHuman();
        const answer = await humanCheck; humanCheck = null;
        if (answer) return flushTaps(answer);
        pending.clear(); return;
      }
      p.els.forEach((el) => { $('.count', el).textContent = fmt(r.likes); });
      if (r.granted < p.count) toast('Whoa, slow down — that was faster than a human can tap');
    } catch (err) { toast(err.message); }
  }
}

// ---------- follow ----------
async function toggleFollow(author) {
  if (!me) return needLogin();
  try {
    if (author.isFollowing) ok(await sb.from('follows').delete().eq('follower_id', me.id).eq('followee_id', author.id));
    else ok(await sb.from('follows').upsert({ follower_id: me.id, followee_id: author.id }, { ignoreDuplicates: true }));
    author.isFollowing = !author.isFollowing;
    const p = ok(await sb.from('profile_list').select('followers').eq('id', author.id).single());
    return { following: author.isFollowing, followers: p.followers };
  } catch (err) { toast(err.message); }
}

// ---------- vertical feed ----------
let muted = true;
function slideHTML(v) {
  const a = v.author;
  return `<section class="slide" data-id="${v.id}"><div class="stage">
    <video src="${esc(v.url)}" loop playsinline preload="metadata" ${muted ? 'muted' : ''}></video>
    <button class="sound">${muted ? '🔇' : '🔊'}</button>
    <div class="caption">
      <a href="#/u/${encodeURIComponent(a.username)}">@${esc(a.username)}</a>${a.creator ? '<span class="badge">Creator</span>' : ''}
      <span class="muted"> · ${ago(v.createdAt)}</span>
      <p class="title">${esc(v.title)}</p>${v.description ? `<p class="desc">${esc(v.description)}</p>` : ''}
    </div>
    <div class="rail">
      <a class="avatar" href="#/u/${encodeURIComponent(a.username)}">${initial(a.displayName)}
        ${a.isMe || a.isFollowing ? '' : '<button class="follow-plus" title="Follow">+</button>'}</a>
      <button class="tap" title="Tap to like — tap as much as you want"><span class="heart">❤️</span><span class="count">${fmt(v.likes)}</span></button>
    </div></div></section>`;
}
function wireSlide(el, v) {
  const stage = $('.stage', el), vid = $('video', el), btn = $('.tap', el);
  btn.onclick = () => tap(v, btn, stage);
  vid.onclick = () => (vid.paused ? vid.play() : vid.pause());
  vid.ondblclick = () => tap(v, btn, stage);
  $('.sound', el).onclick = () => {
    muted = !muted;
    document.querySelectorAll('.feed video').forEach((x) => (x.muted = muted));
    document.querySelectorAll('.sound').forEach((x) => (x.textContent = muted ? '🔇' : '🔊'));
  };
  const plus = $('.follow-plus', el);
  if (plus) plus.onclick = async (e) => {
    e.preventDefault(); e.stopPropagation();
    if (await toggleFollow(v.author)) {
      document.querySelectorAll('.slide').forEach((s) => { if (s.__v?.author.id === v.author.id) { s.__v.author.isFollowing = true; $('.follow-plus', s)?.remove(); } });
      toast(`Following @${v.author.username}`);
    }
  };
  el.__v = v;
}

async function fetchFeed(kind, seen, cursor) {
  if (kind === 'foryou') return hydrate(ok(await sb.rpc('for_you', { seen: seen.slice(-400) })));
  const ids = ok(await sb.from('follows').select('followee_id').eq('follower_id', me.id)).map((f) => f.followee_id);
  if (!ids.length) return [];
  let q = sb.from('video_list').select('*').in('user_id', ids).order('created_at', { ascending: false }).limit(10);
  if (cursor) q = q.lt('created_at', cursor);
  return hydrate(ok(await q));
}

async function renderFeed(kind) {
  if (kind === 'following' && !me) {
    view.innerHTML = `<div class="empty"><div class="card"><h1>Following</h1><p class="muted">Log in to see videos from people you follow.</p>
      <a class="btn primary" href="#/login">Log in</a></div></div>`;
    return;
  }
  const r = routeId;
  view.innerHTML = '<div class="feed" id="feed"></div>';
  const feed = $('#feed');
  const seen = []; let cursor = null, loading = false, done = false;

  const observer = new IntersectionObserver((entries) => {
    for (const e of entries) {
      const vid = $('video', e.target);
      if (!vid) continue;
      if (e.isIntersecting && e.intersectionRatio > 0.6) { vid.muted = muted; vid.play().catch(() => {}); }
      else vid.pause();
    }
    const visible = entries.find((e) => e.isIntersecting);
    if (visible && feed.lastElementChild === visible.target) loadMore();
  }, { root: feed, threshold: [0, 0.6] });

  async function loadMore() {
    if (loading || done) return; loading = true;
    try {
      const videos = await fetchFeed(kind, seen, cursor);
      if (!videos.length) done = true;
      for (const v of videos) {
        seen.push(v.id); cursor = v.createdAt;
        feed.insertAdjacentHTML('beforeend', slideHTML(v));
        const el = feed.lastElementChild; wireSlide(el, v); observer.observe(el);
      }
      if (r !== routeId) return;
      if (!feed.children.length) {
        view.innerHTML = kind === 'foryou'
          ? `<div class="empty"><div class="card"><h1>Nothing here yet</h1><p class="muted">Every video on Interstants is posted by a real person — no fake or filler content. Be the first to post a short!</p><a class="btn primary" href="#/upload">Post a video</a></div></div>`
          : `<div class="empty"><div class="card"><h1>No videos yet</h1><p class="muted">Follow people from the For You page and their videos will show up here.</p><a class="btn primary" href="#/">Go to For You</a></div></div>`;
      } else if (done) {
        feed.insertAdjacentHTML('beforeend', `<section class="slide"><div class="card" style="text-align:center"><h2>You're all caught up</h2><p class="muted">That's everything posted so far.</p><button class="btn primary" onclick="location.reload()">Start over</button></div></section>`);
      }
    } catch (err) { toast(err.message); }
    loading = false;
  }
  await loadMore();
}

// ---------- long videos ----------
function tileHTML(v, { owner = false } = {}) {
  return `<a class="tile" href="#/v/${v.id}">
    <video src="${esc(v.url)}#t=0.5" preload="metadata" muted playsinline></video>
    <span class="dur">${dur(v.duration)}</span>
    ${owner ? `<button class="btn small del" data-del="${v.id}">Delete</button>` : ''}
    <div class="meta"><b>${esc(v.title)}</b><span class="muted">@${esc(v.author.username)} · ${fmt(v.likes)} ❤️ · ${ago(v.createdAt)}</span></div></a>`;
}
async function renderLong() {
  view.innerHTML = `<div class="page"><h1>Long videos</h1><div class="grid" id="grid"></div><p class="muted" id="more"></p></div>`;
  const grid = $('#grid'), more = $('#more'); let cursor = null;
  async function load() {
    let q = sb.from('video_list').select('*').eq('kind', 'long').order('created_at', { ascending: false }).limit(24);
    if (cursor) q = q.lt('created_at', cursor);
    const videos = await hydrate(ok(await q));
    videos.forEach((v) => { grid.insertAdjacentHTML('beforeend', tileHTML(v)); cursor = v.createdAt; });
    if (!grid.children.length) more.innerHTML = 'No long videos yet — every video here is posted by a real person. <a href="#/upload" style="color:var(--accent)">Post one</a>.';
    else if (videos.length === 24) { more.innerHTML = '<button class="btn">Load more</button>'; $('button', more).onclick = load; }
    else more.textContent = '';
  }
  await load();
}
async function renderPlayer(id) {
  const r = routeId;
  const row = ok(await sb.from('video_list').select('*').eq('id', Number(id)).maybeSingle());
  if (!row) throw Object.assign(new Error('That video was deleted or never existed.'), { status: 404 });
  const [v] = await hydrate([row]);
  if (r !== routeId) return;
  const a = v.author;
  view.innerHTML = `<div class="page player">
    <video src="${esc(v.url)}" controls autoplay playsinline></video>
    <h1 style="margin-top:16px">${esc(v.title)}</h1>
    <div class="row">
      <a class="avatar" href="#/u/${encodeURIComponent(a.username)}">${initial(a.displayName)}</a>
      <div><a href="#/u/${encodeURIComponent(a.username)}"><b>${esc(a.displayName)}</b>${a.creator ? '<span class="badge">Creator</span>' : ''}</a><div class="muted">@${esc(a.username)} · ${ago(v.createdAt)} · ${dur(v.duration)}</div></div>
      ${a.isMe ? '' : `<button class="btn ${a.isFollowing ? '' : 'primary'}" id="follow">${a.isFollowing ? 'Following' : 'Follow'}</button>`}
      <span class="spacer"></span>
      <button class="tap btn" id="tap"><span class="heart" style="font-size:22px">❤️</span><span class="count">${fmt(v.likes)}</span></button>
    </div>
    ${v.description ? `<p class="card" style="white-space:pre-wrap;margin-top:16px">${esc(v.description)}</p>` : ''}</div>`;
  $('#tap').onclick = () => tap(v, $('#tap'));
  const f = $('#follow');
  if (f) f.onclick = async () => { if (await toggleFollow(a)) { f.textContent = a.isFollowing ? 'Following' : 'Follow'; f.classList.toggle('primary', !a.isFollowing); } };
}

// ---------- profile ----------
async function renderProfile(username) {
  const r = routeId;
  const u = ok(await sb.from('profile_list').select('*').eq('username', username).maybeSingle());
  if (!u) throw Object.assign(new Error('No such user.'), { status: 404 });
  const isMe = me?.id === u.id;
  const isFollowing = me && !isMe
    ? !!ok(await sb.from('follows').select('follower_id').eq('follower_id', me.id).eq('followee_id', u.id).maybeSingle())
    : false;
  const videos = await hydrate(ok(await sb.from('video_list').select('*').eq('user_id', u.id).order('created_at', { ascending: false })));
  if (r !== routeId) return;
  const shorts = videos.filter((v) => v.kind === 'short'), longs = videos.filter((v) => v.kind === 'long');
  view.innerHTML = `<div class="page">
    <div class="profile-head">
      <div class="avatar big">${initial(u.display_name)}</div>
      <div style="flex:1;min-width:220px">
        <h1 style="margin:0">${esc(u.display_name)} ${u.creator ? '<span class="badge">Creator</span>' : ''}</h1>
        <div class="muted">@${esc(u.username)}</div>
        <div class="stats"><div><b id="fc">${fmt(u.followers)}</b><span class="muted">Followers</span></div>
          <div><b>${fmt(u.following)}</b><span class="muted">Following</span></div>
          <div><b>${fmt(u.likes)}</b><span class="muted">Likes</span></div></div>
        ${u.bio ? `<p style="white-space:pre-wrap">${esc(u.bio)}</p>` : ''}
      </div>
      <div class="row">${isMe
        ? `<button class="btn" id="edit">Edit profile</button><a class="btn" href="#/creator">Creator Program</a><button class="btn" id="logout">Log out</button>`
        : `<button class="btn ${isFollowing ? '' : 'primary'}" id="follow">${isFollowing ? 'Following' : 'Follow'}</button>`}</div>
    </div>
    <div id="editbox"></div>
    <h2>Shorts <span class="muted">${shorts.length}</span></h2>
    <div class="grid shorts">${shorts.map((v) => tileHTML(v, { owner: isMe })).join('') || '<p class="muted">No shorts yet.</p>'}</div>
    <h2>Long videos <span class="muted">${longs.length}</span></h2>
    <div class="grid">${longs.map((v) => tileHTML(v, { owner: isMe })).join('') || '<p class="muted">No long videos yet.</p>'}</div></div>`;

  const f = $('#follow');
  if (f) {
    const author = { id: u.id, isFollowing };
    f.onclick = async () => {
      const r = await toggleFollow(author); if (!r) return;
      f.textContent = r.following ? 'Following' : 'Follow'; f.classList.toggle('primary', !r.following); $('#fc').textContent = fmt(r.followers);
    };
  }
  if (isMe) {
    $('#logout').onclick = logout;
    $('#edit').onclick = () => {
      $('#editbox').innerHTML = `<form class="card" style="margin-top:16px"><label>Display name</label><input type="text" name="displayName" maxlength="50" required value="${esc(u.display_name)}">
        <label>Bio</label><textarea name="bio" maxlength="300">${esc(u.bio)}</textarea><p class="error"></p><div class="row"><button class="btn primary">Save</button></div></form>`;
      $('#editbox form').onsubmit = async (e) => {
        e.preventDefault(); const fd = new FormData(e.target);
        try {
          ok(await sb.from('profiles').update({ display_name: fd.get('displayName').trim(), bio: fd.get('bio').trim() }).eq('id', me.id));
          await refreshMe(); renderProfile(username);
        } catch (err) { $('#editbox .error').textContent = err.message; }
      };
    };
    view.querySelectorAll('[data-del]').forEach((b) => b.onclick = async (e) => {
      e.preventDefault(); e.stopPropagation();
      if (!confirm('Delete this video? This cannot be undone.')) return;
      const v = videos.find((x) => x.id === Number(b.dataset.del));
      try {
        ok(await sb.from('videos').delete().eq('id', v.id));
        await sb.storage.from('videos').remove([v.path]);
        renderProfile(username);
      } catch (err) { toast(err.message); }
    });
  }
}
async function logout() { await sb.auth.signOut(); await refreshMe(); location.hash = '#/'; }

// ---------- auth pages ----------
const PENDING_KEY = 'interstants.pendingProfile';
function renderAuth(mode) {
  const signup = mode === 'signup';
  view.innerHTML = `<div class="page narrow"><form class="card">
    <h1>${signup ? 'Join Interstants' : 'Welcome back'}</h1>
    ${signup ? '<p class="muted">Interstants is for real people only. No bots, no fake accounts.</p>' : ''}
    <label>Email</label><input type="email" name="email" autocomplete="email" required>
    <label>Password</label><input type="password" name="password" autocomplete="${signup ? 'new-password' : 'current-password'}" required minlength="${signup ? 8 : 1}">
    ${signup ? `<label>Username</label><input type="text" name="username" required minlength="3" maxlength="30" pattern="[A-Za-z0-9_.]{3,30}" title="3–30 letters, numbers, _ or .">
      <label>Display name</label><input type="text" name="displayName" maxlength="50">
      <label>Prove you're human</label><div id="cap"></div>` : ''}
    <p class="error" id="err"></p>
    <button class="btn primary" style="width:100%">${signup ? 'Create account' : 'Log in'}</button>
    <p class="muted" style="text-align:center">${signup ? 'Have an account? <a href="#/login" style="color:var(--accent)">Log in</a>' : 'New here? <a href="#/signup" style="color:var(--accent)">Sign up</a>'}</p>
  </form></div>`;
  const cap = $('#cap');
  if (cap) loadCaptcha(cap).catch((e) => ($('#err').textContent = e.message));
  $('form', view).onsubmit = async (e) => {
    e.preventDefault();
    const btn = $('button.primary', e.target); btn.disabled = true;
    const fd = new FormData(e.target);
    const email = fd.get('email').trim(), password = fd.get('password');
    try {
      if (!signup) {
        ok(await sb.auth.signInWithPassword({ email, password }));
        await refreshMe(); location.hash = me ? '#/' : '#/finish';
        return;
      }
      const profile = { username: fd.get('username').trim(), display_name: fd.get('displayName').trim() };
      if (me?.username) throw new Error('You are already logged in.');
      const res = ok(await sb.auth.signUp({ email, password }));
      if (!res.session) {
        // Email confirmation is on: finish the profile after they confirm and log in.
        localStorage.setItem(PENDING_KEY, JSON.stringify(profile));
        view.innerHTML = `<div class="page narrow"><div class="card"><h1>Check your email</h1><p>We sent a link to <b>${esc(email)}</b>. Click it, then come back and log in to finish setting up your account.</p><a class="btn primary" href="#/login">Log in</a></div></div>`;
        return;
      }
      try {
        ok(await sb.rpc('create_profile', { ...profile, ...captchaValue(cap) }));
      } catch (err) {
        localStorage.setItem(PENDING_KEY, JSON.stringify(profile));
        await refreshMe(); toast(err.message); location.hash = '#/finish'; return;
      }
      localStorage.removeItem(PENDING_KEY);
      await refreshMe(); location.hash = '#/';
    } catch (err) {
      $('#err').textContent = /already registered/i.test(err.message) ? 'That email already has an account. Log in instead.' : err.message;
      if (cap) loadCaptcha(cap);
    } finally { btn.disabled = false; }
  };
}

// Logged in, but no profile yet (captcha not passed or email just confirmed).
function renderFinish() {
  if (!session) return (location.hash = '#/login');
  if (me) return (location.hash = '#/');
  const saved = JSON.parse(localStorage.getItem(PENDING_KEY) || '{}');
  view.innerHTML = `<div class="page narrow"><form class="card">
    <h1>Finish signing up</h1><p class="muted">Pick your username and prove you're human.</p>
    <label>Username</label><input type="text" name="username" required minlength="3" maxlength="30" pattern="[A-Za-z0-9_.]{3,30}" value="${esc(saved.username || '')}">
    <label>Display name</label><input type="text" name="displayName" maxlength="50" value="${esc(saved.display_name || '')}">
    <label>Prove you're human</label><div id="cap"></div>
    <p class="error" id="err"></p>
    <button class="btn primary" style="width:100%">Finish</button>
    <p class="muted" style="text-align:center"><a href="#" id="out" style="color:var(--accent)">Log out</a></p></form></div>`;
  const cap = $('#cap'); loadCaptcha(cap);
  $('#out').onclick = (e) => { e.preventDefault(); logout(); };
  $('form', view).onsubmit = async (e) => {
    e.preventDefault(); const fd = new FormData(e.target);
    try {
      ok(await sb.rpc('create_profile', { username: fd.get('username').trim(), display_name: fd.get('displayName').trim(), ...captchaValue(cap) }));
      localStorage.removeItem(PENDING_KEY);
      await refreshMe(); location.hash = '#/';
    } catch (err) { $('#err').textContent = err.message; loadCaptcha(cap); }
  };
}

// ---------- upload ----------
async function sniffVideo(file) {
  const head = new Uint8Array(await file.slice(0, 12).arrayBuffer());
  const ascii = String.fromCharCode(...head.slice(4, 12));
  if (ascii.startsWith('ftyp')) return ascii.slice(4) === 'qt  ' ? 'video/quicktime' : 'video/mp4';
  if (head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3) return 'video/webm';
  return null;
}
function renderUpload() {
  if (!me) return needLogin();
  view.innerHTML = `<div class="page narrow" style="max-width:560px"><form class="card">
    <h1>Post a video</h1>
    <p class="muted">Upload a video you made. Up to 3 minutes posts as a <b>short</b> (For You feed); longer posts as a <b>long video</b>.</p>
    <div class="drop" id="drop"><b>Choose a video</b><div class="muted">MP4, MOV or WebM · up to 50 MB</div>
      <input type="file" accept="video/mp4,video/quicktime,video/webm" hidden></div>
    <label>Title</label><input type="text" name="title" maxlength="120" required>
    <label>Description</label><textarea name="description" maxlength="2000"></textarea>
    <div class="bar hidden" id="bar"><div></div></div>
    <p class="error" id="err"></p>
    <button class="btn primary" id="go" disabled style="width:100%">Post</button></form></div>`;
  const drop = $('#drop'), input = $('input[type=file]', drop), err = $('#err');
  let file = null, mime = null, duration = null;
  drop.onclick = (e) => { if (e.target.tagName !== 'VIDEO') input.click(); };
  input.onchange = async () => {
    file = input.files[0]; duration = null; $('#go').disabled = true; err.textContent = '';
    if (!file) return;
    mime = await sniffVideo(file);
    if (!mime) { err.textContent = 'That file is not a video. Choose an MP4, MOV or WebM.'; return; }
    if (file.size > MAX_UPLOAD_BYTES) { err.textContent = `That video is ${(file.size / 1048576).toFixed(0)} MB. The limit is 50 MB — try a shorter clip or lower quality.`; return; }
    const url = URL.createObjectURL(file);
    drop.classList.add('has');
    drop.innerHTML = `<b>${esc(file.name)}</b><div class="muted" id="kind">Reading video…</div><video src="${url}" controls muted playsinline></video>`;
    drop.appendChild(input);
    const v = $('video', drop);
    v.onloadedmetadata = () => {
      if (!Number.isFinite(v.duration) || v.duration <= 0) { $('#kind').textContent = "Couldn't read this video's length."; return; }
      duration = v.duration;
      $('#kind').textContent = `${dur(duration)} · will post as a ${duration <= SHORT_MAX_SECONDS ? 'short' : 'long video'}`;
      $('#go').disabled = false;
    };
    v.onerror = () => { $('#kind').textContent = "Your browser can't play this file, so it can't be posted. Try an MP4."; };
  };
  $('form', view).onsubmit = async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    $('#go').disabled = true; $('#bar').classList.remove('hidden'); err.textContent = '';
    const ext = { 'video/mp4': 'mp4', 'video/quicktime': 'mov', 'video/webm': 'webm' }[mime];
    const path = `${me.id}/${crypto.randomUUID()}.${ext}`;
    try {
      // Upload with XHR so we can show progress.
      const { data: { session: s } } = await sb.auth.getSession();
      await new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('POST', `${CFG.supabaseUrl.replace(/\/$/, '')}/storage/v1/object/videos/${path}`);
        xhr.setRequestHeader('Authorization', `Bearer ${s.access_token}`);
        xhr.setRequestHeader('apikey', CFG.supabaseAnonKey);
        xhr.setRequestHeader('Content-Type', mime);
        xhr.setRequestHeader('x-upsert', 'false');
        xhr.upload.onprogress = (ev) => { $('#bar div').style.width = (ev.loaded / ev.total * 100) + '%'; };
        xhr.onload = () => {
          if (xhr.status < 300) return resolve();
          let msg = 'Upload failed.';
          try { msg = JSON.parse(xhr.responseText).message || msg; } catch {}
          if (/exceeded|too large|maximum/i.test(msg)) msg = 'Video is too large (max 50 MB).';
          if (/quota|storage limit/i.test(msg)) msg = 'Interstants is out of storage space right now. Try again later.';
          reject(new Error(msg));
        };
        xhr.onerror = () => reject(new Error('Network error. Check your connection.'));
        xhr.send(file);
      });
      const row = ok(await sb.from('videos').insert({
        user_id: me.id, title: fd.get('title').trim(), description: fd.get('description').trim(), storage_path: path, duration,
      }).select('id, kind').single());
      toast('Posted!');
      location.hash = row.kind === 'long' ? `#/v/${row.id}` : `#/u/${encodeURIComponent(me.username)}`;
    } catch (ex) {
      await sb.storage.from('videos').remove([path]).catch(() => {});
      err.textContent = ex.message; $('#go').disabled = false; $('#bar').classList.add('hidden');
    }
  };
}

// ---------- creator program ----------
async function renderCreator() {
  if (!me) return needLogin();
  const r = routeId;
  const s = ok(await sb.rpc('creator_status'));
  if (r !== routeId) return;
  const pct = (a, b) => Math.min(100, (a / b) * 100).toFixed(1);
  view.innerHTML = `<div class="page narrow" style="max-width:560px"><div class="card">
    <h1>Creator Program ${s.member ? '<span class="badge">Member</span>' : ''}</h1>
    ${s.member
      ? `<p>You're in! You joined on ${new Date(s.member_since).toLocaleDateString()}. Your videos show the Creator badge.</p>`
      : `<p class="muted">Reach <b>either</b> goal to join.</p>`}
    <div class="goal"><div class="row"><b>Likes this week</b><span class="spacer"></span><span>${fmt(s.weekly_likes)} / ${fmt(s.weekly_likes_goal)}</span></div>
      <div class="progress"><div style="width:${pct(s.weekly_likes, s.weekly_likes_goal)}%"></div></div>
      <span class="muted" style="font-size:13px">Week started ${new Date(s.week_started_at).toLocaleString()} · resets every Monday</span></div>
    <div class="or">OR</div>
    <div class="goal"><div class="row"><b>Followers</b><span class="spacer"></span><span>${fmt(s.followers)} / ${fmt(s.followers_goal)}</span></div>
      <div class="progress"><div style="width:${pct(s.followers, s.followers_goal)}%"></div></div></div>
    ${s.member ? '' : `<button class="btn pink" id="join" style="width:100%" ${s.eligible ? '' : 'disabled'}>${s.eligible ? 'Join the Creator Program' : "Keep going — you're not there yet"}</button>`}
    <p class="error" id="err"></p></div></div>`;
  const j = $('#join');
  if (j) j.onclick = async () => {
    try { ok(await sb.rpc('join_creator_program')); toast('Welcome to the Creator Program!'); await refreshMe(); renderCreator(); }
    catch (err) { $('#err').textContent = err.message; }
  };
}

// ---------- router ----------
async function route() {
  const id = ++routeId;
  if (pending.size) flushTaps();
  const hash = location.hash.replace(/^#/, '') || '/';
  const [, a, b] = hash.split('/');
  const tab = { '': 'foryou', following: 'following', long: 'long', v: 'long', upload: 'upload', me: 'me' }[a];
  document.querySelectorAll('[data-tab]').forEach((el) => el.classList.toggle('active', el.dataset.tab === tab));
  if (session && !me && !['finish', 'login', 'signup'].includes(a)) return (location.hash = '#/finish');
  try {
    if (!a) return await renderFeed('foryou');
    if (a === 'following') return await renderFeed('following');
    if (a === 'long') return await renderLong();
    if (a === 'v') return await renderPlayer(b);
    if (a === 'u') return await renderProfile(decodeURIComponent(b));
    if (a === 'me') return me ? (location.hash = `#/u/${encodeURIComponent(me.username)}`) : needLogin();
    if (a === 'upload') return renderUpload();
    if (a === 'creator') return await renderCreator();
    if (a === 'login' || a === 'signup') return renderAuth(a);
    if (a === 'finish') return renderFinish();
    view.innerHTML = '<div class="page"><h1>Page not found</h1></div>';
  } catch (err) {
    if (id !== routeId) return;
    view.innerHTML = `<div class="page"><h1>${err.status === 404 ? 'Not found' : 'Error'}</h1><p class="muted">${esc(err.message)}</p></div>`;
  }
}

function renderNotConfigured() {
  view.innerHTML = `<div class="page narrow"><div class="card"><h1>Almost there</h1>
    <p>Interstants isn't connected to its database yet. Add your Supabase project URL and anon key to <code>site/config.js</code>.</p>
    <p class="muted">See the README for the step-by-step setup.</p></div></div>`;
}

(async function start() {
  if (!CFG.supabaseUrl || !CFG.supabaseAnonKey || !window.supabase) return renderNotConfigured();
  sb = window.supabase.createClient(CFG.supabaseUrl, CFG.supabaseAnonKey);
  try { await refreshMe(); } catch (err) { toast(err.message); }
  sb.auth.onAuthStateChange((event) => { if (event === 'SIGNED_OUT' || event === 'TOKEN_REFRESHED') refreshMe().catch(() => {}); });
  window.addEventListener('hashchange', route);
  window.addEventListener('pagehide', () => pending.size && flushTaps());
  route();
})();
