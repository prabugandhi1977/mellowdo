const $app = document.getElementById('app');
const REASONS = { overwhelm: 'Overwhelmed', boredom: 'Bored', fear: 'Afraid to get it wrong', unclear: "Don't know where to start", tired: 'Tired' };
const MOODS = ['😞', '😕', '😐', '🙂', '😄'];
const CHECKINS = ['Still with it? Just keep going gently.', 'Halfway there. Breathe, then carry on.', 'You showed up. That is the hard part.'];

let token = localStorage.getItem('md_token');
let me = null;
let tab = 'today';
let timer = null; // { end, minutes, taskId }
let tick = null;
let openGroup = null;

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function api(method, path, body) {
  const res = await fetch('/api' + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && token) { signOut(); throw new Error('Please sign in'); }
  if (!res.ok) throw new Error(data.error || 'Something went wrong');
  return data;
}

function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => el.classList.remove('show'), 3500);
  if ('Notification' in window && Notification.permission === 'granted' && document.hidden) new Notification('MellowDo', { body: msg });
}
const guard = (fn) => async (...a) => { try { await fn(...a); } catch (e) { toast(e.message); } };

function signOut() {
  localStorage.removeItem('md_token');
  token = null; me = null;
  render();
}

// ---------- views ----------
function authView() {
  $app.innerHTML = `
    <h1>MellowDo</h1>
    <p class="muted">Start small. No guilt. Pick a name and a short PIN to begin.</p>
    <form class="card" id="auth">
      <label>Name <input name="name" autocomplete="username" required minlength="2" maxlength="30"></label>
      <label>PIN (4-8 digits) <input name="pin" type="password" inputmode="numeric" autocomplete="current-password" pattern="\\d{4,8}" required></label>
      <p class="err" id="err"></p>
      <div class="row"><button type="submit" data-mode="register">Create account</button><button type="submit" class="ghost" data-mode="login">Sign in</button></div>
    </form>`;
  document.getElementById('auth').addEventListener('submit', async (e) => {
    e.preventDefault();
    const mode = e.submitter?.dataset.mode || 'login';
    const f = new FormData(e.target);
    try {
      const r = await api('POST', '/' + mode, { name: f.get('name'), pin: f.get('pin') });
      token = r.token; localStorage.setItem('md_token', token);
      await boot();
    } catch (err) { document.getElementById('err').textContent = err.message; }
  });
}

async function todayView() {
  const { tasks } = await api('GET', '/tasks');
  const open = tasks.filter((t) => !t.done), done = tasks.filter((t) => t.done);
  const card = (t) => `
    <div class="card"><div class="row"><b>${esc(t.title)}</b>
      <button class="ghost small" data-del="${t.id}" aria-label="Delete ${esc(t.title)}">Remove</button></div>
      ${t.steps.map((s) => `<label class="step ${s.done ? 'done' : ''}">
        <input type="checkbox" data-step="${s.id}" ${s.done ? 'checked' : ''}>
        <span>${esc(s.text)} <span class="muted">(${s.minutes} min)</span></span></label>`).join('')}
      ${t.done ? '<p>🌱 All done. Well done!</p>' : `<button class="small" data-focus="${t.id}">Focus on this</button>`}
    </div>`;
  $app.innerHTML = `
    <h1>Hi ${esc(me.name)} 👋</h1>
    <p class="muted">What have you been putting off? We'll shrink it to a tiny first step.</p>
    <form class="card" id="newTask">
      <input name="title" placeholder="e.g. Call the bank" maxlength="120" required>
      <select name="reason" aria-label="Why is it hard?">
        <option value="">What makes it hard? (optional)</option>
        ${Object.entries(REASONS).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}
      </select>
      <button type="submit">Make it tiny</button>
    </form>
    ${open.map(card).join('') || '<p class="muted">Nothing here yet. Add the one thing you keep avoiding.</p>'}
    ${done.length ? `<h2>Finished</h2>${done.map(card).join('')}` : ''}`;
  document.getElementById('newTask').addEventListener('submit', guard(async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    await api('POST', '/tasks', { title: f.get('title'), reason: f.get('reason') });
    toast('Here is your tiny first step. Just do that one.');
    render();
  }));
  $app.querySelectorAll('[data-step]').forEach((el) => el.addEventListener('change', guard(async () => {
    const r = await api('PATCH', `/steps/${el.dataset.step}`, { done: el.checked });
    if (r.task.done) toast('Task complete. You did it! 🎉');
    render();
  })));
  $app.querySelectorAll('[data-del]').forEach((el) => el.addEventListener('click', guard(async () => {
    await api('DELETE', `/tasks/${el.dataset.del}`); render();
  })));
  $app.querySelectorAll('[data-focus]').forEach((el) => el.addEventListener('click', () => {
    focusTask = Number(el.dataset.focus); tab = 'focus'; render();
  }));
}

let focusTask = null;
async function focusView() {
  const stats = await api('GET', '/focus/stats');
  const left = timer ? Math.max(0, timer.end - Date.now()) : 0;
  $app.innerHTML = `
    <h1>Focus</h1>
    <p class="muted">Short sessions, gentle nudges. Stopping early is okay, because showing up counts.</p>
    <div class="stats">
      <div class="card"><b>${stats.today_minutes}</b>min today</div>
      <div class="card"><b>${stats.streak}</b>day streak</div>
      <div class="card"><b>${stats.total_sessions}</b>sessions</div>
    </div>
    <div class="timer" id="clock" role="timer">${fmt(timer ? left : 0)}</div>
    ${timer ? '<div class="row"><button class="ghost" id="stop">Stop for now</button></div>'
      : `<div class="chips" role="group" aria-label="Session length">${[5, 10, 15, 25].map((m) =>
        `<button class="chip" data-min="${m}" aria-pressed="false">${m} min</button>`).join('')}</div>
         <p><button id="start" disabled>Start</button></p>`}`;
  if (timer) {
    document.getElementById('stop').addEventListener('click', guard(() => endTimer(false)));
    return runClock();
  }
  let mins = null;
  const start = document.getElementById('start');
  $app.querySelectorAll('[data-min]').forEach((b) => b.addEventListener('click', () => {
    mins = Number(b.dataset.min); start.disabled = false;
    $app.querySelectorAll('[data-min]').forEach((o) => o.setAttribute('aria-pressed', String(o === b)));
  }));
  start.addEventListener('click', () => {
    if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission();
    timer = { end: Date.now() + mins * 60000, minutes: mins, taskId: focusTask, shown: 0 };
    localStorage.setItem('md_timer', JSON.stringify(timer));
    render();
  });
}

const fmt = (ms) => { const s = Math.ceil(ms / 1000); return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`; };

function runClock() {
  clearInterval(tick);
  tick = setInterval(guard(async () => {
    if (!timer) return clearInterval(tick);
    const left = timer.end - Date.now();
    const total = timer.minutes * 60000;
    // Gentle check-ins at 1/3 and 2/3 of the session.
    const stage = left <= 0 ? 3 : left < total / 3 ? 2 : left < (total * 2) / 3 ? 1 : 0;
    if (stage > timer.shown && stage < 3) { timer.shown = stage; localStorage.setItem('md_timer', JSON.stringify(timer)); toast(CHECKINS[stage - 1]); }
    const clock = document.getElementById('clock');
    if (clock) clock.textContent = fmt(Math.max(0, left));
    if (left <= 0) await endTimer(true);
  }), 500);
}

async function endTimer(completed) {
  clearInterval(tick);
  const t = timer; timer = null; localStorage.removeItem('md_timer');
  const elapsed = Math.max(1, Math.round((t.minutes * 60000 - Math.max(0, t.end - Date.now())) / 60000));
  await api('POST', '/focus', { minutes: completed ? t.minutes : Math.min(elapsed, t.minutes), completed, task_id: t.taskId });
  toast(completed ? 'Session complete. Take a breather 🌿' : 'No problem. You showed up, and that counts.');
  render();
}

async function checkinView() {
  const d = await api('GET', '/checkins');
  let mood = null, reason = null;
  $app.innerHTML = `
    <h1>Daily check-in</h1>
    <p class="muted">${d.checked_in_today ? 'You checked in today. You can update it.' : 'How are you feeling, and what got in the way today?'}</p>
    <form class="card" id="ci">
      <div class="chips" role="group" aria-label="Mood">${MOODS.map((m, i) => `<button type="button" class="chip mood" data-mood="${i + 1}" aria-label="Mood ${i + 1} of 5" aria-pressed="false">${m}</button>`).join('')}</div>
      <p class="muted">What made starting hard?</p>
      <div class="chips" role="group" aria-label="Reason">${Object.entries(REASONS).map(([k, v]) => `<button type="button" class="chip" data-reason="${k}" aria-pressed="false">${v}</button>`).join('')}</div>
      <textarea name="note" rows="2" maxlength="300" placeholder="Anything else? (optional)"></textarea>
      <button type="submit">Save</button>
    </form>
    <h2>Your patterns (30 days)</h2>
    ${d.top_reason ? `<div class="card">Most common blocker: <b>${esc(REASONS[d.top_reason.reason])}</b> (${d.top_reason.count} days). Average mood ${d.avg_mood}/5.</div>`
      : '<p class="muted">Check in a few days and patterns will show up here.</p>'}
    ${d.recent.slice(0, 7).map((c) => `<div class="card row"><span>${esc(c.day)}</span><span>${MOODS[c.mood - 1]} ${c.reason ? esc(REASONS[c.reason]) : ''}</span></div>`).join('')}`;
  const pick = (attr, set) => $app.querySelectorAll(`[data-${attr}]`).forEach((b) => b.addEventListener('click', () => {
    set(b.dataset[attr]);
    $app.querySelectorAll(`[data-${attr}]`).forEach((o) => o.setAttribute('aria-pressed', String(o === b)));
  }));
  pick('mood', (v) => { mood = Number(v); });
  pick('reason', (v) => { reason = v; });
  document.getElementById('ci').addEventListener('submit', guard(async (e) => {
    e.preventDefault();
    if (!mood) return toast('Pick a mood first');
    await api('POST', '/checkins', { mood, reason, note: new FormData(e.target).get('note') });
    toast('Saved. Thanks for being honest with yourself 💚');
    render();
  }));
}

async function communityView() {
  if (openGroup) return groupView();
  const { groups } = await api('GET', '/groups');
  $app.innerHTML = `
    <h1>Community</h1>
    <p class="muted">Share one small commitment a day. Cheer each other on. No shaming here.</p>
    ${groups.map((g) => `<button class="card" style="width:100%;text-align:left;color:inherit;background:var(--card)" data-open="${g.id}"><b>${esc(g.name)}</b><br><span class="muted">${g.members} members · code ${esc(g.code)}</span></button>`).join('')}
    <form class="card" id="newGroup"><b>Start a group</b><input name="name" placeholder="Group name" maxlength="40" required><button type="submit">Create</button></form>
    <form class="card" id="join"><b>Join with a code</b><input name="code" placeholder="e.g. A1B2C3" maxlength="10" required><button type="submit">Join</button></form>`;
  $app.querySelectorAll('[data-open]').forEach((b) => b.addEventListener('click', () => { openGroup = b.dataset.open; render(); }));
  document.getElementById('newGroup').addEventListener('submit', guard(async (e) => {
    e.preventDefault();
    openGroup = (await api('POST', '/groups', { name: new FormData(e.target).get('name') })).group.id; render();
  }));
  document.getElementById('join').addEventListener('submit', guard(async (e) => {
    e.preventDefault();
    openGroup = (await api('POST', '/groups/join', { code: new FormData(e.target).get('code') })).group.id; render();
  }));
}

async function groupView() {
  const g = await api('GET', `/groups/${openGroup}`);
  $app.innerHTML = `
    <button class="ghost small" id="back">← Groups</button>
    <h1>${esc(g.group.name)}</h1>
    <p class="muted">Invite code <b>${esc(g.group.code)}</b> · ${g.members.length} members · group streak ${g.group_streak} day${g.group_streak === 1 ? '' : 's'}</p>
    <form class="card" id="commit"><input name="text" placeholder="Today I will… (something small)" maxlength="140" required><button type="submit">Share</button></form>
    ${g.commitments.map((c) => `<div class="card"><b>${esc(c.name)}</b> ${c.done ? '✅' : ''}<br>${esc(c.text)}
      <div class="row" style="margin-top:8px"><span class="muted">💚 ${c.cheers}</span>
      ${c.mine ? (c.done ? '' : `<button class="small" data-done="${c.id}">Mark done</button>`)
        : `<button class="ghost small" data-cheer="${c.id}" ${c.cheered ? 'disabled' : ''}>${c.cheered ? 'Cheered' : 'Cheer'}</button>`}</div></div>`).join('')
      || '<p class="muted">No commitments yet today. Be the first!</p>'}`;
  document.getElementById('back').addEventListener('click', () => { openGroup = null; render(); });
  document.getElementById('commit').addEventListener('submit', guard(async (e) => {
    e.preventDefault();
    await api('POST', `/groups/${openGroup}/commit`, { text: new FormData(e.target).get('text') }); render();
  }));
  $app.querySelectorAll('[data-cheer]').forEach((b) => b.addEventListener('click', guard(async () => { await api('POST', `/commitments/${b.dataset.cheer}/cheer`); render(); })));
  $app.querySelectorAll('[data-done]').forEach((b) => b.addEventListener('click', guard(async () => { await api('POST', `/commitments/${b.dataset.done}/done`); toast('Nice work! 🌱'); render(); })));
}

// ---------- shell ----------
const TABS = [['today', '🌱 Today'], ['focus', '⏱ Focus'], ['checkin', '💭 Check-in'], ['community', '👥 Community']];

async function render() {
  if (!me) return authView();
  clearInterval(tick);
  try {
    await { today: todayView, focus: focusView, checkin: checkinView, community: communityView }[tab]();
  } catch (e) { if (me) toast(e.message); return; }
  const nav = document.createElement('nav');
  nav.setAttribute('aria-label', 'Main');
  nav.innerHTML = TABS.map(([k, label]) => `<button data-tab="${k}" ${k === tab ? 'aria-current="page"' : ''}>${label}</button>`).join('')
    + '<button data-tab="out">Sign out</button>';
  nav.addEventListener('click', (e) => {
    const k = e.target.closest('[data-tab]')?.dataset.tab;
    if (k === 'out') return signOut();
    if (k) { tab = k; openGroup = null; render(); }
  });
  $app.appendChild(nav);
}

async function boot() {
  if (token) {
    try { me = (await api('GET', '/me')).user; } catch { me = null; }
  }
  try {
    const saved = JSON.parse(localStorage.getItem('md_timer') || 'null');
    if (saved && me) { timer = saved; tab = 'focus'; }
  } catch { /* ignore corrupt timer */ }
  render();
}

if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
boot();
