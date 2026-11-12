import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { breakdown, REASONS } from './breakdown.js';

const today = () => new Date().toISOString().slice(0, 10);
const dayOffset = (n) => new Date(Date.now() - n * 864e5).toISOString().slice(0, 10);

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const bad = (m) => new HttpError(400, m);

function hashPin(pin, salt) {
  return scryptSync(pin, salt, 32).toString('hex');
}

// Consecutive days (ending today or yesterday) that appear in `days`.
export function streak(days) {
  const set = new Set(days);
  let n = 0;
  let d = set.has(today()) ? 0 : 1;
  while (set.has(dayOffset(d))) { n++; d++; }
  return n;
}

export function createApi(db) {
  const q = (sql) => db.prepare(sql);

  const routes = [];
  const route = (method, pattern, auth, fn) => {
    const keys = [];
    const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => (keys.push(k), '([^/]+)')) + '$');
    routes.push({ method, re, keys, auth, fn });
  };

  const ownTask = (user, id) => {
    const t = q('SELECT * FROM tasks WHERE id = ? AND user_id = ?').get(id, user.id);
    if (!t) throw new HttpError(404, 'Task not found');
    return t;
  };
  const memberOf = (user, gid) => {
    const g = q(`SELECT g.* FROM groups g JOIN members m ON m.group_id = g.id
                 WHERE g.id = ? AND m.user_id = ?`).get(gid, user.id);
    if (!g) throw new HttpError(404, 'Group not found');
    return g;
  };
  const newSession = (userId) => {
    const token = randomBytes(24).toString('hex');
    q('INSERT INTO sessions (token, user_id) VALUES (?, ?)').run(token, userId);
    return token;
  };
  const taskWithSteps = (t) => ({
    ...t, done: !!t.done,
    steps: q('SELECT id, position, text, minutes, done FROM steps WHERE task_id = ? ORDER BY position')
      .all(t.id).map((s) => ({ ...s, done: !!s.done })),
  });

  // ---- auth ----
  route('POST', '/api/register', false, ({ body }) => {
    const name = String(body.name || '').trim();
    const pin = String(body.pin || '');
    if (name.length < 2 || name.length > 30) throw bad('Name must be 2-30 characters');
    if (!/^\d{4,8}$/.test(pin)) throw bad('PIN must be 4-8 digits');
    if (q('SELECT 1 FROM users WHERE name = ?').get(name)) throw new HttpError(409, 'That name is taken');
    const salt = randomBytes(16).toString('hex');
    const { lastInsertRowid } = q('INSERT INTO users (name, pin_hash, salt) VALUES (?, ?, ?)')
      .run(name, hashPin(pin, salt), salt);
    return { token: newSession(lastInsertRowid), user: { id: Number(lastInsertRowid), name } };
  });

  route('POST', '/api/login', false, ({ body }) => {
    const u = q('SELECT * FROM users WHERE name = ?').get(String(body.name || '').trim());
    const ok = u && timingSafeEqual(Buffer.from(hashPin(String(body.pin || ''), u.salt)), Buffer.from(u.pin_hash));
    if (!ok) throw new HttpError(401, 'Wrong name or PIN');
    return { token: newSession(u.id), user: { id: u.id, name: u.name } };
  });

  route('GET', '/api/me', true, ({ user }) => ({ user: { id: user.id, name: user.name }, reasons: REASONS }));

  // ---- tasks ----
  route('POST', '/api/tasks', true, ({ user, body }) => {
    const title = String(body.title || '').trim();
    if (!title || title.length > 120) throw bad('Describe the task in up to 120 characters');
    const reason = REASONS.includes(body.reason) ? body.reason : null;
    const { lastInsertRowid: id } = q('INSERT INTO tasks (user_id, title) VALUES (?, ?)').run(user.id, title);
    breakdown(title, reason).forEach((s, i) =>
      q('INSERT INTO steps (task_id, position, text, minutes) VALUES (?, ?, ?, ?)').run(id, i, s.text, s.minutes));
    return { task: taskWithSteps(ownTask(user, id)) };
  });

  route('GET', '/api/tasks', true, ({ user }) => ({
    tasks: q('SELECT * FROM tasks WHERE user_id = ? ORDER BY done, id DESC').all(user.id).map(taskWithSteps),
  }));

  route('PATCH', '/api/steps/:id', true, ({ user, params, body }) => {
    const s = q(`SELECT s.*, t.user_id FROM steps s JOIN tasks t ON t.id = s.task_id WHERE s.id = ?`).get(params.id);
    if (!s || s.user_id !== user.id) throw new HttpError(404, 'Step not found');
    q('UPDATE steps SET done = ? WHERE id = ?').run(body.done ? 1 : 0, s.id);
    const left = q('SELECT COUNT(*) c FROM steps WHERE task_id = ? AND done = 0').get(s.task_id).c;
    q('UPDATE tasks SET done = ? WHERE id = ?').run(left === 0 ? 1 : 0, s.task_id);
    return { task: taskWithSteps(ownTask(user, s.task_id)) };
  });

  route('DELETE', '/api/tasks/:id', true, ({ user, params }) => {
    q('DELETE FROM tasks WHERE id = ?').run(ownTask(user, params.id).id);
    return { ok: true };
  });

  // ---- focus sessions ----
  route('POST', '/api/focus', true, ({ user, body }) => {
    const minutes = Number(body.minutes);
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > 120) throw bad('Minutes must be 1-120');
    // Ending early still counts as showing up: only completed sessions add to focus time.
    q('INSERT INTO focus_sessions (user_id, task_id, minutes, completed, day) VALUES (?, ?, ?, ?, ?)')
      .run(user.id, body.task_id ? Number(body.task_id) : null, minutes, body.completed ? 1 : 0, today());
    return focusStats(user);
  });

  const focusStats = (user) => {
    const rows = q('SELECT day, minutes, completed FROM focus_sessions WHERE user_id = ?').all(user.id);
    const shownUp = rows.map((r) => r.day);
    return {
      today_minutes: rows.filter((r) => r.day === today() && r.completed).reduce((a, r) => a + r.minutes, 0),
      total_sessions: rows.filter((r) => r.completed).length,
      streak: streak(shownUp),
    };
  };
  route('GET', '/api/focus/stats', true, ({ user }) => focusStats(user));

  // ---- check-ins ----
  route('POST', '/api/checkins', true, ({ user, body }) => {
    const mood = Number(body.mood);
    if (!Number.isInteger(mood) || mood < 1 || mood > 5) throw bad('Mood must be 1-5');
    const reason = REASONS.includes(body.reason) ? body.reason : null;
    const note = String(body.note || '').slice(0, 300);
    q('DELETE FROM checkins WHERE user_id = ? AND day = ?').run(user.id, today());
    q('INSERT INTO checkins (user_id, mood, reason, note, day) VALUES (?, ?, ?, ?, ?)')
      .run(user.id, mood, reason, note, today());
    return { ok: true };
  });

  route('GET', '/api/checkins', true, ({ user }) => {
    const recent = q('SELECT day, mood, reason, note FROM checkins WHERE user_id = ? AND day >= ? ORDER BY day DESC')
      .all(user.id, dayOffset(29));
    const counts = {};
    recent.forEach((c) => { if (c.reason) counts[c.reason] = (counts[c.reason] || 0) + 1; });
    const top = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
    return {
      recent,
      top_reason: top ? { reason: top[0], count: top[1] } : null,
      avg_mood: recent.length ? +(recent.reduce((a, c) => a + c.mood, 0) / recent.length).toFixed(1) : null,
      checked_in_today: recent.some((c) => c.day === today()),
    };
  });

  // ---- community ----
  const makeCode = () => randomBytes(3).toString('hex').toUpperCase();

  route('POST', '/api/groups', true, ({ user, body }) => {
    const name = String(body.name || '').trim();
    if (name.length < 2 || name.length > 40) throw bad('Group name must be 2-40 characters');
    const { lastInsertRowid: id } = q('INSERT INTO groups (name, code, owner_id) VALUES (?, ?, ?)')
      .run(name, makeCode(), user.id);
    q('INSERT INTO members (group_id, user_id) VALUES (?, ?)').run(id, user.id);
    return { group: q('SELECT id, name, code FROM groups WHERE id = ?').get(id) };
  });

  route('POST', '/api/groups/join', true, ({ user, body }) => {
    const g = q('SELECT id, name, code FROM groups WHERE code = ?').get(String(body.code || '').trim().toUpperCase());
    if (!g) throw new HttpError(404, 'No group with that code');
    q('INSERT OR IGNORE INTO members (group_id, user_id) VALUES (?, ?)').run(g.id, user.id);
    return { group: g };
  });

  route('GET', '/api/groups', true, ({ user }) => ({
    groups: q(`SELECT g.id, g.name, g.code,
                 (SELECT COUNT(*) FROM members WHERE group_id = g.id) AS members
               FROM groups g JOIN members m ON m.group_id = g.id WHERE m.user_id = ? ORDER BY g.id DESC`).all(user.id),
  }));

  route('GET', '/api/groups/:id', true, ({ user, params }) => {
    const g = memberOf(user, params.id);
    const commitments = q(`SELECT c.id, c.text, c.done, c.user_id, u.name,
                             (SELECT COUNT(*) FROM cheers WHERE commitment_id = c.id) AS cheers,
                             EXISTS(SELECT 1 FROM cheers WHERE commitment_id = c.id AND user_id = ?) AS cheered
                           FROM commitments c JOIN users u ON u.id = c.user_id
                           WHERE c.group_id = ? AND c.day = ? ORDER BY c.id DESC`)
      .all(user.id, g.id, today()).map((c) => ({ ...c, done: !!c.done, cheered: !!c.cheered, mine: c.user_id === user.id }));
    // Group streak: days on which at least one member showed up with a commitment.
    const days = q('SELECT DISTINCT day FROM commitments WHERE group_id = ?').all(g.id).map((r) => r.day);
    return {
      group: { id: g.id, name: g.name, code: g.code },
      members: q(`SELECT u.name FROM members m JOIN users u ON u.id = m.user_id WHERE m.group_id = ?`).all(g.id).map((r) => r.name),
      commitments,
      group_streak: streak(days),
    };
  });

  route('POST', '/api/groups/:id/commit', true, ({ user, params, body }) => {
    const g = memberOf(user, params.id);
    const text = String(body.text || '').trim();
    if (!text || text.length > 140) throw bad('Share one small commitment (up to 140 characters)');
    q('INSERT INTO commitments (group_id, user_id, text, day) VALUES (?, ?, ?, ?)').run(g.id, user.id, text, today());
    return { ok: true };
  });

  const commitmentFor = (user, id) => {
    const c = q('SELECT * FROM commitments WHERE id = ?').get(id);
    if (!c) throw new HttpError(404, 'Commitment not found');
    memberOf(user, c.group_id);
    return c;
  };
  route('POST', '/api/commitments/:id/cheer', true, ({ user, params }) => {
    const c = commitmentFor(user, params.id);
    if (c.user_id === user.id) throw bad('Cheer on someone else!');
    q('INSERT OR IGNORE INTO cheers (commitment_id, user_id) VALUES (?, ?)').run(c.id, user.id);
    return { ok: true };
  });
  route('POST', '/api/commitments/:id/done', true, ({ user, params }) => {
    const c = commitmentFor(user, params.id);
    if (c.user_id !== user.id) throw new HttpError(403, 'Only the owner can mark this done');
    q('UPDATE commitments SET done = 1 WHERE id = ?').run(c.id);
    return { ok: true };
  });

  // ---- dispatcher ----
  return async function handle(method, path, headers, body) {
    for (const r of routes) {
      const m = r.method === method && r.re.exec(path);
      if (!m) continue;
      try {
        let user = null;
        if (r.auth) {
          const token = (headers.authorization || '').replace(/^Bearer /, '');
          user = q(`SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?`).get(token);
          if (!user) throw new HttpError(401, 'Please sign in');
        }
        const params = Object.fromEntries(r.keys.map((k, i) => [k, m[i + 1]]));
        return { status: 200, json: r.fn({ user, params, body }) };
      } catch (e) {
        if (e instanceof HttpError) return { status: e.status, json: { error: e.message } };
        console.error(e);
        return { status: 500, json: { error: 'Something went wrong' } };
      }
    }
    return { status: 404, json: { error: 'Not found' } };
  };
}
