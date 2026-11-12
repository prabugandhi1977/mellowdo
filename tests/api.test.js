import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../server/db.js';
import { createApp } from '../server/server.js';

let server, base, db;
const outbox = [];
const mailer = { live: true, async send(m) { outbox.push(m); } };
before(async () => {
  db = openDb(':memory:');
  server = createApp(db, { mailer, secret: 'test-secret' });
  await new Promise((r) => server.listen(0, r));
  base = `http://localhost:${server.address().port}`;
});
after(() => server.close());

async function call(method, path, body, token) {
  const res = await fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, ...(await res.json()) };
}
const lastCode = (email) => outbox.filter((m) => m.to === email).at(-1).text.match(/\b(\d{6})\b/)[1];
const emailFor = (name) => `${name.toLowerCase()}@example.com`;
async function signup(name) {
  const email = emailFor(name);
  assert.equal((await call('POST', '/api/auth/request', { email })).status, 200);
  const r = await call('POST', '/api/auth/verify', { email, code: lastCode(email), name });
  assert.ok(r.token, JSON.stringify(r));
  return r.token;
}

test('email sign-in: new account, returning user, case-insensitive email', async () => {
  const email = 'Asha@Example.com';
  const req = await call('POST', '/api/auth/request', { email });
  assert.equal(req.status, 200);
  assert.equal(req.dev_code, undefined); // live mailer never leaks the code
  const code = lastCode('asha@example.com');
  assert.equal((await call('POST', '/api/auth/verify', { email, code })).needs_name, true);
  const first = await call('POST', '/api/auth/verify', { email, code, name: 'Asha' });
  assert.ok(first.token);
  assert.equal((await call('GET', '/api/me', null, first.token)).user.name, 'Asha');
  // code is single-use
  assert.equal((await call('POST', '/api/auth/verify', { email, code, name: 'Asha' })).status, 401);
  // returning user signs in without a name, keeping the same account
  db.prepare('UPDATE login_codes SET created_at = created_at - 120000').run();
  await call('POST', '/api/auth/request', { email: 'asha@example.com' });
  const again = await call('POST', '/api/auth/verify', { email: 'asha@example.com', code: lastCode('asha@example.com') });
  assert.equal(again.user.id, first.user.id);
});

test('email sign-in rejects bad email, wrong code, expired code, and locks after 5 wrong tries', async () => {
  assert.equal((await call('POST', '/api/auth/request', { email: 'nope' })).status, 400);
  const email = 'lock@example.com';
  await call('POST', '/api/auth/request', { email });
  const good = lastCode(email);
  const wrong = good === '000000' ? '111111' : '000000';
  for (let i = 0; i < 5; i++) assert.equal((await call('POST', '/api/auth/verify', { email, code: wrong, name: 'Lock' })).status, 401);
  // even the right code is refused once attempts are used up
  assert.equal((await call('POST', '/api/auth/verify', { email, code: good, name: 'Lock' })).status, 401);
  assert.equal((await call('POST', '/api/auth/verify', { email: 'ghost@example.com', code: '123456' })).status, 401);
  db.prepare("UPDATE login_codes SET expires_at = 0 WHERE email = 'lock@example.com'").run();
  assert.equal((await call('POST', '/api/auth/verify', { email, code: good, name: 'Lock' })).status, 401);
});

test('email sign-in throttles code requests and does not burn quota on mail failure', async () => {
  const email = 'rate@example.com';
  assert.equal((await call('POST', '/api/auth/request', { email })).status, 200);
  assert.equal((await call('POST', '/api/auth/request', { email })).status, 429); // 1-minute cooldown
  for (let i = 0; i < 4; i++) {
    db.prepare('UPDATE login_codes SET created_at = created_at - 61000 WHERE email = ?').run(email);
    assert.equal((await call('POST', '/api/auth/request', { email })).status, 200);
  }
  db.prepare('UPDATE login_codes SET created_at = created_at - 61000 WHERE email = ?').run(email);
  const r = await call('POST', '/api/auth/request', { email });
  assert.equal(r.status, 429);
  assert.match(r.error, /Too many/);
  // failed send: user sees an error and may retry immediately
  const orig = mailer.send;
  mailer.send = async () => { throw new Error('provider down'); };
  const f = await call('POST', '/api/auth/request', { email: 'down@example.com' });
  mailer.send = orig;
  assert.equal(f.status, 502);
  assert.equal((await call('POST', '/api/auth/request', { email: 'down@example.com' })).status, 200);
});

test('sessions: logout invalidates the token, old sessions expire', async () => {
  const t = await signup('Zed');
  assert.equal((await call('GET', '/api/me', null, t)).status, 200);
  await call('POST', '/api/logout', null, t);
  assert.equal((await call('GET', '/api/me', null, t)).status, 401);
  const t2 = await signup('Zed2');
  db.prepare("UPDATE sessions SET created_at = datetime('now', '-31 days') WHERE token = ?").run(t2);
  assert.equal((await call('GET', '/api/me', null, t2)).status, 401);
});

test('task breakdown starts tiny and completes when all steps are done', async () => {
  const t = await signup('Ravi');
  const { task } = await call('POST', '/api/tasks', { title: 'File taxes', reason: 'fear' }, t);
  assert.ok(task.steps.length >= 4);
  assert.ok(task.steps[0].minutes <= 2);
  assert.match(task.steps[0].text, /rough draft/);
  let last;
  for (const s of task.steps) last = await call('PATCH', `/api/steps/${s.id}`, { done: true }, t);
  assert.equal(last.task.done, true);
});

test('users cannot touch each other\'s tasks', async () => {
  const a = await signup('Mina');
  const b = await signup('Karan');
  const { task } = await call('POST', '/api/tasks', { title: 'Write essay' }, a);
  assert.equal((await call('PATCH', `/api/steps/${task.steps[0].id}`, { done: true }, b)).status, 404);
  assert.equal((await call('DELETE', `/api/tasks/${task.id}`, null, b)).status, 404);
});

test('focus: abandoned sessions keep the streak but add no focus minutes', async () => {
  const t = await signup('Lena');
  await call('POST', '/api/focus', { minutes: 15, completed: false }, t);
  let s = await call('POST', '/api/focus', { minutes: 10, completed: true }, t);
  assert.equal(s.today_minutes, 10);
  assert.equal(s.streak, 1);
  assert.equal((await call('POST', '/api/focus', { minutes: 0 }, t)).status, 400);
});

test('check-in replaces today\'s entry and surfaces top reason', async () => {
  const t = await signup('Omar');
  await call('POST', '/api/checkins', { mood: 2, reason: 'boredom' }, t);
  await call('POST', '/api/checkins', { mood: 4, reason: 'overwhelm', note: 'better' }, t);
  const r = await call('GET', '/api/checkins', null, t);
  assert.equal(r.recent.length, 1);
  assert.equal(r.top_reason.reason, 'overwhelm');
  assert.equal(r.checked_in_today, true);
  assert.equal((await call('POST', '/api/checkins', { mood: 9 }, t)).status, 400);
});

test('community: create, join, commit, cheer, done, access control', async () => {
  const a = await signup('Priya');
  const b = await signup('Sam');
  const c = await signup('Outsider');
  const { group } = await call('POST', '/api/groups', { name: 'Study Gang' }, a);
  assert.equal((await call('GET', `/api/groups/${group.id}`, null, c)).status, 404);
  assert.equal((await call('POST', '/api/groups/join', { code: group.code.toLowerCase() }, b)).status, 200);
  await call('POST', `/api/groups/${group.id}/commit`, { text: 'Read 5 pages' }, a);
  let g = await call('GET', `/api/groups/${group.id}`, null, b);
  assert.equal(g.members.length, 2);
  assert.equal(g.group_streak, 1);
  const cid = g.commitments[0].id;
  assert.equal((await call('POST', `/api/commitments/${cid}/cheer`, null, a)).status, 400);
  assert.equal((await call('POST', `/api/commitments/${cid}/cheer`, null, b)).status, 200);
  assert.equal((await call('POST', `/api/commitments/${cid}/done`, null, b)).status, 403);
  assert.equal((await call('POST', `/api/commitments/${cid}/done`, null, a)).status, 200);
  g = await call('GET', `/api/groups/${group.id}`, null, a);
  assert.equal(g.commitments[0].cheers, 1);
  assert.equal(g.commitments[0].done, true);
  assert.equal((await call('POST', `/api/commitments/${cid}/cheer`, null, c)).status, 404);
});

test('health check is public', async () => {
  const r = await call('GET', '/api/health');
  assert.equal(r.status, 200);
  assert.equal(r.ok, true);
});
