import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../server/db.js';
import { createApp } from '../server/server.js';

let server, base;
before(async () => {
  server = createApp(openDb(':memory:'));
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
const signup = async (name) => (await call('POST', '/api/register', { name, pin: '1234' })).token;

test('register, duplicate name, login, bad pin', async () => {
  assert.ok(await signup('Asha'));
  assert.equal((await call('POST', '/api/register', { name: 'asha', pin: '1234' })).status, 409);
  assert.equal((await call('POST', '/api/register', { name: 'Bo', pin: 'abc' })).status, 400);
  assert.equal((await call('POST', '/api/login', { name: 'Asha', pin: '0000' })).status, 401);
  assert.ok((await call('POST', '/api/login', { name: 'Asha', pin: '1234' })).token);
  assert.equal((await call('GET', '/api/me')).status, 401);
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
