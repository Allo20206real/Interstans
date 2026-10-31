'use strict';
const $ = (sel, root = document) => root.querySelector(sel);
const view = $('#view');
let me = null;

// ---------- utilities ----------
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (n) => n >= 1e6 ? (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M' : n >= 1e4 ? (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'K' : n.toLocaleString();
const dur = (s) => { s = Math.round(s); const h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, x = String(s % 60).padStart(2, '0'); return h ? `${h}:${String(m).padStart(2, '0')}:${x}` : `${m}:${x}`; };
const ago = (t) => { const s = (Date.now() - t) / 1000; for (const [n, u] of [[86400 * 7, 'w'], [86400, 'd'], [3600, 'h'], [60, 'm']]) if (s >= n) return Math.floor(s / n) + u; return 'now'; };
const initial = (name) => esc((name || '?').trim()[0]?.toUpperCase() || '?');

async function api(path, opts = {}) {
  const init = { method: opts.method || 'GET', headers: {} };
  if (opts.body !== undefined) { init.headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(opts.body); }
  const res = await fetch(path, init);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { const err = new Error(data.error || 'Something went wrong.'); err.status = res.status; err.data = data; throw err; }
  return data;
}
function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.classList.remove('hidden');
  clearTimeout(toast.timer); toast.timer = setTimeout(() => t.classList.add('hidden'), 2500);
}
function needLogin() { toast('Log in to do that'); location.hash = '#/login'; }

async function refreshMe() {
  me = (await api('/api/me')).user;
  $('#account').innerHTML = me
    ? `<a class="btn small primary" href="#/upload">+ Post</a>
       <a href="#/creator" class="btn small">Creator</a>
       <a href="#/u/${esc(me.username)}" class="avatar" style="width:34px;height:34px;font-size:14px" title="@${esc(me.username)}">${initial(me.displayName)}</a>`
    : `<a class="btn small" href="#/login">Log in</a><a class="btn small primary" href="#/signup">Sign up</a>`;
}

// ---------- captcha ----------
async function loadCaptcha(container) {
  const c = await api('/api/captcha');
  container.innerHTML = `<div class="captcha"><img alt="Type the characters shown" src="${c.image}">
    <button type="button" class="btn small" title="New code">↻</button></div>
    <input type="text" name="captcha" placeholder="Type the characters above" autocomplete="off" autocapitalize="characters" required maxlength="8">`;
  container.dataset.id = c.id;
  $('button', container).onclick = () => loadCaptcha(container);
}
const captchaValue = (container) => ({ captchaId: container.dataset.id, captchaAnswer: $('input', container).value });

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
async function flushTaps(extra) {
  flushTimer = null;
  for (const [id, p] of [...pending]) {
    pending.delete(id);
    try {
      const r = await api(`/api/videos/${id}/taps`, { method: 'POST', body: { count: p.count, ...extra } });
      p.els.forEach((el) => { $('.count', el).textContent = fmt(r.likes); });
      if (r.granted < p.count) toast('Whoa, slow down — that was faster than a human can tap');
    } catch (err) {
      if (err.data?.needsCaptcha) {
        pending.set(id, p);
        if (!humanCheck) humanCheck = askHuman();
        const answer = await humanCheck; humanCheck = null;
        if (answer) return flushTaps(answer);
        pending.clear();
      } else toast(err.message);
    }
  }
}

// ---------- follow ----------
async function toggleFollow(author, btn) {
  if (!me) return needLogin();
  try {
    const r = await api(`/api/users/${author.id}/follow`, { method: author.isFollowing ? 'DELETE' : 'POST' });
    author.isFollowing = r.following;
    return r;
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
      <a href="#/u/${esc(a.username)}">@${esc(a.username)}</a>${a.creator ? '<span class="badge">Creator</span>' : ''}
      <span class="muted"> · ${ago(v.createdAt)}</span>
      <p class="title">${esc(v.title)}</p>${v.description ? `<p class="desc">${esc(v.description)}</p>` : ''}
    </div>
    <div class="rail">
      <a class="avatar" href="#/u/${esc(a.username)}">${initial(a.displayName)}
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
    if (await toggleFollow(v.author)) { document.querySelectorAll(`.slide`).forEach((s) => s.__v?.author.id === v.author.id && $('.follow-plus', s)?.remove()); toast(`Following @${v.author.username}`); }
  };
  el.__v = v;
}

async function renderFeed(kind) {
  if (kind === 'following' && !me) {
    view.innerHTML = `<div class="empty"><div class="card"><h1>Following</h1><p class="muted">Log in to see videos from people you follow.</p>
      <a class="btn primary" href="#/login">Log in</a></div></div>`;
    return;
  }
  view.innerHTML = '<div class="feed" id="feed"></div>';
  const feed = $('#feed');
  const seen = []; let cursor = null, loading = false, done = false;

  const observer = new IntersectionObserver((entries) => {
    for (const e of entries) {
      const vid = $('video', e.target);
      if (e.isIntersecting && e.intersectionRatio > 0.6) { vid.muted = muted; vid.play().catch(() => {}); }
      else vid.pause();
    }
    const visible = entries.find((e) => e.isIntersecting);
    if (visible && feed.lastElementChild === visible.target) loadMore();
  }, { root: feed, threshold: [0, 0.6] });

  async function loadMore() {
    if (loading || done) return; loading = true;
    try {
      const url = kind === 'foryou' ? `/api/feed/foryou?seen=${seen.slice(-400).join(',')}` : `/api/feed/following${cursor ? `?before=${cursor}` : ''}`;
      const { videos } = await api(url);
      if (!videos.length) done = true;
      for (const v of videos) {
        seen.push(v.id); cursor = v.createdAt;
        feed.insertAdjacentHTML('beforeend', slideHTML(v));
        const el = feed.lastElementChild; wireSlide(el, v); observer.observe(el);
      }
      if (!feed.children.length) {
        view.innerHTML = kind === 'foryou'
          ? `<div class="empty"><div class="card"><h1>Nothing here yet</h1><p class="muted">Every video on Interstants is posted by a real person — no fake or filler content. Be the first to post a short!</p><a class="btn primary" href="#/upload">Post a video</a></div></div>`
          : `<div class="empty"><div class="card"><h1>No videos yet</h1><p class="muted">Follow people from the For You page and their videos will show up here.</p><a class="btn primary" href="#/">Go to For You</a></div></div>`;
      } else if (done && kind === 'foryou') {
        feed.insertAdjacentHTML('beforeend', `<section class="slide"><div class="card" style="text-align:center"><h2>You're all caught up</h2><p class="muted">That's every short posted so far.</p><button class="btn primary" onclick="location.reload()">Start over</button></div></section>`);
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
  const grid = $('#grid'); let cursor = null;
  async function load() {
    const { videos } = await api(`/api/feed/long${cursor ? `?before=${cursor}` : ''}`);
    videos.forEach((v) => { grid.insertAdjacentHTML('beforeend', tileHTML(v)); cursor = v.createdAt; });
    if (!grid.children.length) $('#more').innerHTML = 'No long videos yet — every video here is posted by a real person. <a href="#/upload" style="color:var(--accent)">Post one</a>.';
    else if (videos.length === 24) { $('#more').innerHTML = '<button class="btn">Load more</button>'; $('#more button').onclick = load; }
    else $('#more').textContent = '';
  }
  await load();
}
async function renderPlayer(id) {
  const { video: v } = await api(`/api/videos/${id}`);
  const a = v.author;
  view.innerHTML = `<div class="page player">
    <video src="${esc(v.url)}" controls autoplay playsinline></video>
    <h1 style="margin-top:16px">${esc(v.title)}</h1>
    <div class="row">
      <a class="avatar" href="#/u/${esc(a.username)}">${initial(a.displayName)}</a>
      <div><a href="#/u/${esc(a.username)}"><b>${esc(a.displayName)}</b>${a.creator ? '<span class="badge">Creator</span>' : ''}</a><div class="muted">@${esc(a.username)} · ${ago(v.createdAt)} · ${dur(v.duration)}</div></div>
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
  const { user: u, videos } = await api(`/api/users/${encodeURIComponent(username)}`);
  const shorts = videos.filter((v) => v.kind === 'short'), longs = videos.filter((v) => v.kind === 'long');
  view.innerHTML = `<div class="page">
    <div class="profile-head">
      <div class="avatar big">${initial(u.displayName)}</div>
      <div style="flex:1;min-width:220px">
        <h1 style="margin:0">${esc(u.displayName)} ${u.creator ? '<span class="badge">Creator</span>' : ''}</h1>
        <div class="muted">@${esc(u.username)}</div>
        <div class="stats"><div><b id="fc">${fmt(u.followers)}</b><span class="muted">Followers</span></div>
          <div><b>${fmt(u.following)}</b><span class="muted">Following</span></div>
          <div><b>${fmt(u.likes)}</b><span class="muted">Likes</span></div></div>
        ${u.bio ? `<p style="white-space:pre-wrap">${esc(u.bio)}</p>` : ''}
      </div>
      <div class="row">${u.isMe
        ? `<button class="btn" id="edit">Edit profile</button><a class="btn" href="#/creator">Creator Program</a><button class="btn" id="logout">Log out</button>`
        : `<button class="btn ${u.isFollowing ? '' : 'primary'}" id="follow">${u.isFollowing ? 'Following' : 'Follow'}</button>`}</div>
    </div>
    <div id="editbox"></div>
    <h2>Shorts <span class="muted">${shorts.length}</span></h2>
    <div class="grid shorts">${shorts.map((v) => tileHTML(v, { owner: u.isMe })).join('') || '<p class="muted">No shorts yet.</p>'}</div>
    <h2>Long videos <span class="muted">${longs.length}</span></h2>
    <div class="grid">${longs.map((v) => tileHTML(v, { owner: u.isMe })).join('') || '<p class="muted">No long videos yet.</p>'}</div></div>`;

  const f = $('#follow');
  if (f) f.onclick = async () => {
    const r = await toggleFollow(u); if (!r) return;
    f.textContent = r.following ? 'Following' : 'Follow'; f.classList.toggle('primary', !r.following); $('#fc').textContent = fmt(r.followers);
  };
  if (u.isMe) {
    $('#logout').onclick = async () => { await api('/api/logout', { method: 'POST' }); await refreshMe(); location.hash = '#/'; };
    $('#edit').onclick = () => {
      $('#editbox').innerHTML = `<form class="card" style="margin-top:16px"><label>Display name</label><input type="text" name="displayName" maxlength="50" value="${esc(u.displayName)}">
        <label>Bio</label><textarea name="bio" maxlength="300">${esc(u.bio)}</textarea><div class="row" style="margin-top:12px"><button class="btn primary">Save</button></div></form>`;
      $('#editbox form').onsubmit = async (e) => {
        e.preventDefault(); const fd = new FormData(e.target);
        await api('/api/me', { method: 'PATCH', body: { displayName: fd.get('displayName'), bio: fd.get('bio') } });
        await refreshMe(); renderProfile(username);
      };
    };
    view.querySelectorAll('[data-del]').forEach((b) => b.onclick = async (e) => {
      e.preventDefault(); e.stopPropagation();
      if (!confirm('Delete this video? This cannot be undone.')) return;
      await api(`/api/videos/${b.dataset.del}`, { method: 'DELETE' }); renderProfile(username);
    });
  }
}

// ---------- auth pages ----------
function renderAuth(mode) {
  const signup = mode === 'signup';
  view.innerHTML = `<div class="page narrow"><form class="card">
    <h1>${signup ? 'Join Interstants' : 'Welcome back'}</h1>
    ${signup ? '<p class="muted">Interstants is for real people only. No bots, no fake accounts.</p>' : ''}
    <label>Username</label><input type="text" name="username" autocomplete="username" required maxlength="30">
    ${signup ? '<label>Display name</label><input type="text" name="displayName" maxlength="50">' : ''}
    <label>Password</label><input type="password" name="password" autocomplete="${signup ? 'new-password' : 'current-password'}" required minlength="${signup ? 8 : 1}">
    ${signup ? '<label>Prove you\'re human</label><div id="cap"></div>' : ''}
    <p class="error" id="err"></p>
    <button class="btn primary" style="width:100%">${signup ? 'Create account' : 'Log in'}</button>
    <p class="muted" style="text-align:center">${signup ? 'Have an account? <a href="#/login" style="color:var(--accent)">Log in</a>' : 'New here? <a href="#/signup" style="color:var(--accent)">Sign up</a>'}</p>
  </form></div>`;
  const cap = $('#cap');
  if (cap) loadCaptcha(cap);
  $('form', view).onsubmit = async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const body = { username: fd.get('username'), password: fd.get('password') };
    if (signup) Object.assign(body, { displayName: fd.get('displayName') }, captchaValue(cap));
    try {
      await api(signup ? '/api/signup' : '/api/login', { method: 'POST', body });
      await refreshMe(); location.hash = '#/';
    } catch (err) { $('#err').textContent = err.message; if (cap) loadCaptcha(cap); }
  };
}

// ---------- upload ----------
function renderUpload() {
  if (!me) return needLogin();
  view.innerHTML = `<div class="page narrow" style="max-width:560px"><form class="card">
    <h1>Post a video</h1>
    <p class="muted">Upload a video you made. Up to 3 minutes posts as a <b>short</b> (For You feed); longer posts as a <b>long video</b>.</p>
    <div class="drop" id="drop"><b>Choose a video</b><div class="muted">MP4, MOV or WebM · up to 1 GB</div>
      <input type="file" accept="video/mp4,video/quicktime,video/webm" hidden></div>
    <label>Title</label><input type="text" name="title" maxlength="120" required>
    <label>Description</label><textarea name="description" maxlength="2000"></textarea>
    <div class="bar hidden" id="bar"><div></div></div>
    <p class="error" id="err"></p>
    <button class="btn primary" id="go" disabled style="width:100%">Post</button></form></div>`;
  const drop = $('#drop'), input = $('input[type=file]', drop);
  let file = null, duration = null;
  drop.onclick = (e) => { if (e.target.tagName !== 'VIDEO') input.click(); };
  input.onchange = () => {
    file = input.files[0]; if (!file) return;
    const url = URL.createObjectURL(file);
    drop.classList.add('has');
    drop.innerHTML = `<b>${esc(file.name)}</b><div class="muted" id="kind">Reading video…</div><video src="${url}" controls muted playsinline></video>`;
    drop.appendChild(input);
    const v = $('video', drop);
    v.onloadedmetadata = () => {
      duration = v.duration;
      $('#kind').textContent = `${dur(duration)} · will post as a ${duration <= 180 ? 'short' : 'long video'}`;
      $('#go').disabled = false;
    };
    v.onerror = () => { $('#kind').textContent = "Your browser can't preview this file, but you can still try posting it."; $('#go').disabled = false; };
  };
  $('form', view).onsubmit = (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    fd.append('video', file);
    if (duration) fd.append('duration', duration);
    const xhr = new XMLHttpRequest();
    $('#go').disabled = true; $('#bar').classList.remove('hidden');
    xhr.upload.onprogress = (ev) => { $('#bar div').style.width = (ev.loaded / ev.total * 100) + '%'; };
    xhr.onload = () => {
      const data = JSON.parse(xhr.responseText || '{}');
      if (xhr.status === 201) { toast('Posted!'); location.hash = data.video.kind === 'long' ? `#/v/${data.video.id}` : `#/u/${me.username}`; }
      else { $('#err').textContent = data.error || 'Upload failed.'; $('#go').disabled = false; $('#bar').classList.add('hidden'); }
    };
    xhr.onerror = () => { $('#err').textContent = 'Network error.'; $('#go').disabled = false; };
    xhr.open('POST', '/api/videos'); xhr.send(fd);
  };
}

// ---------- creator program ----------
async function renderCreator() {
  if (!me) return needLogin();
  const s = await api('/api/creator-program');
  const pct = (a, b) => Math.min(100, (a / b) * 100).toFixed(1);
  view.innerHTML = `<div class="page narrow" style="max-width:560px"><div class="card">
    <h1>Creator Program ${s.member ? '<span class="badge">Member</span>' : ''}</h1>
    ${s.member
      ? `<p>You're in! You joined on ${new Date(s.memberSince).toLocaleDateString()}. Your videos show the Creator badge.</p>`
      : `<p class="muted">Reach <b>either</b> goal to join.</p>`}
    <div class="goal"><div class="row"><b>Likes this week</b><span class="spacer"></span><span>${fmt(s.weeklyLikes)} / ${fmt(s.weeklyLikesGoal)}</span></div>
      <div class="progress"><div style="width:${pct(s.weeklyLikes, s.weeklyLikesGoal)}%"></div></div>
      <span class="muted" style="font-size:13px">Week started ${new Date(s.weekStartedAt).toLocaleString()} · resets every Monday</span></div>
    <div class="or">OR</div>
    <div class="goal"><div class="row"><b>Followers</b><span class="spacer"></span><span>${fmt(s.followers)} / ${fmt(s.followersGoal)}</span></div>
      <div class="progress"><div style="width:${pct(s.followers, s.followersGoal)}%"></div></div></div>
    ${s.member ? '' : `<button class="btn pink" id="join" style="width:100%" ${s.eligible ? '' : 'disabled'}>${s.eligible ? 'Join the Creator Program' : 'Keep going — you\'re not there yet'}</button>`}
    <p class="error" id="err"></p></div></div>`;
  const j = $('#join');
  if (j) j.onclick = async () => {
    try { await api('/api/creator-program/join', { method: 'POST' }); toast('Welcome to the Creator Program!'); await refreshMe(); renderCreator(); }
    catch (err) { $('#err').textContent = err.message; }
  };
}

// ---------- router ----------
async function route() {
  if (pending.size) flushTaps();
  const hash = location.hash.replace(/^#/, '') || '/';
  const [, a, b] = hash.split('/');
  const tab = { '': 'foryou', following: 'following', long: 'long', v: 'long', upload: 'upload', me: 'me' }[a];
  document.querySelectorAll('[data-tab]').forEach((el) => el.classList.toggle('active', el.dataset.tab === tab));
  try {
    if (!a) return await renderFeed('foryou');
    if (a === 'following') return await renderFeed('following');
    if (a === 'long') return await renderLong();
    if (a === 'v') return await renderPlayer(b);
    if (a === 'u') return await renderProfile(decodeURIComponent(b));
    if (a === 'me') return me ? (location.hash = `#/u/${me.username}`) : needLogin();
    if (a === 'upload') return renderUpload();
    if (a === 'creator') return await renderCreator();
    if (a === 'login' || a === 'signup') return renderAuth(a);
    view.innerHTML = '<div class="page"><h1>Page not found</h1></div>';
  } catch (err) {
    view.innerHTML = `<div class="page"><h1>${err.status === 404 ? 'Not found' : 'Error'}</h1><p class="muted">${esc(err.message)}</p></div>`;
  }
}
window.addEventListener('hashchange', route);
window.addEventListener('pagehide', () => pending.size && flushTaps());
refreshMe().then(route);
