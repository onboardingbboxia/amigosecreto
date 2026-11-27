'use strict';
// Amigo Secreto — servidor sin dependencias externas (Node 22+, node:sqlite).
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const C = require('./content');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '127.0.0.1';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const PUBLIC_DIR = path.join(__dirname, 'public');
fs.mkdirSync(DATA_DIR, { recursive: true });

/* ---------------- Base de datos ---------------- */
const db = new DatabaseSync(path.join(DATA_DIR, 'amigo.db'));
db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS people(
  id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  is_admin INTEGER NOT NULL DEFAULT 0, pass_hash TEXT, registered_at INTEGER, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS sessions(
  token_hash TEXT PRIMARY KEY, person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE, expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS kv(k TEXT PRIMARY KEY, v TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS assignments(
  giver INTEGER PRIMARY KEY REFERENCES people(id) ON DELETE CASCADE,
  receiver INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE);
CREATE TABLE IF NOT EXISTS wishes(
  id INTEGER PRIMARY KEY, person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  title TEXT, url TEXT, note TEXT, at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS notes(person_id INTEGER PRIMARY KEY REFERENCES people(id) ON DELETE CASCADE, text TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS messages(
  id INTEGER PRIMARY KEY, thread TEXT NOT NULL, sender INTEGER REFERENCES people(id) ON DELETE CASCADE,
  side TEXT, text TEXT NOT NULL, at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS messages_thread ON messages(thread, id);
CREATE TABLE IF NOT EXISTS plays(
  person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE, kind TEXT NOT NULL, key TEXT NOT NULL,
  pts INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(person_id, kind, key));
CREATE TABLE IF NOT EXISTS trivia_progress(
  person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE, round INTEGER NOT NULL,
  qi INTEGER NOT NULL, served_at INTEGER NOT NULL, score INTEGER NOT NULL, PRIMARY KEY(person_id, round));
CREATE TABLE IF NOT EXISTS retos(id INTEGER PRIMARY KEY, title TEXT NOT NULL, descr TEXT, pts INTEGER NOT NULL, at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS reto_winners(
  reto_id INTEGER NOT NULL REFERENCES retos(id) ON DELETE CASCADE,
  person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE, PRIMARY KEY(reto_id, person_id));
`);

const one = (sql, ...a) => db.prepare(sql).get(...a);
const all = (sql, ...a) => db.prepare(sql).all(...a);
const run = (sql, ...a) => db.prepare(sql).run(...a);
function tx(fn) { db.exec('BEGIN'); try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; } }
const kvGet = (k, d) => { const r = one('SELECT v FROM kv WHERE k=?', k); return r ? JSON.parse(r.v) : d; };
const kvSet = (k, v) => run('INSERT INTO kv(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v', k, JSON.stringify(v));

/* ---------------- Contraseñas y sesiones ---------------- */
function hashPass(pass) {
  const salt = crypto.randomBytes(16).toString('hex');
  const h = crypto.scryptSync(pass, salt, 32, { N: 16384, r: 8, p: 1 }).toString('hex');
  return `scrypt$${salt}$${h}`;
}
function checkPass(pass, stored) {
  if (!stored) return false;
  const [, salt, h] = stored.split('$');
  const got = crypto.scryptSync(pass, salt, 32, { N: 16384, r: 8, p: 1 });
  const want = Buffer.from(h, 'hex');
  return want.length === got.length && crypto.timingSafeEqual(got, want);
}
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const COOKIE = 'amigo_sesion';
function newSession(personId, remember) {
  const token = crypto.randomBytes(32).toString('base64url');
  const ttl = remember ? 180 * 864e5 : 864e5;
  run('INSERT INTO sessions(token_hash, person_id, expires_at) VALUES(?,?,?)', sha(token), personId, Date.now() + ttl);
  return { token, maxAge: remember ? Math.floor(ttl / 1000) : null };
}
function cookieHeader(req, value, maxAge) {
  const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
  const age = maxAge == null ? '' : `; Max-Age=${maxAge}`;
  return `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax${secure}${age}`;
}
function readCookie(req) {
  const m = (req.headers.cookie || '').match(new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`));
  return m ? m[1] : null;
}
function currentUser(req) {
  const t = readCookie(req);
  if (!t) return null;
  const s = one('SELECT person_id, expires_at FROM sessions WHERE token_hash=?', sha(t));
  if (!s) return null;
  if (s.expires_at < Date.now()) { run('DELETE FROM sessions WHERE token_hash=?', sha(t)); return null; }
  const p = one('SELECT id, name, is_admin, pass_hash FROM people WHERE id=?', s.person_id);
  if (!p || !p.pass_hash) return null;
  return { id: p.id, name: p.name, isAdmin: !!p.is_admin };
}
setInterval(() => run('DELETE FROM sessions WHERE expires_at < ?', Date.now()), 36e5).unref();

/* Intentos fallidos: 5 errores bloquean 60 s por persona+IP */
const fails = new Map();
function lockedOut(key) { const f = fails.get(key); return f && f.until > Date.now() ? Math.ceil((f.until - Date.now()) / 1000) : 0; }
function noteFail(key) { const f = fails.get(key) || { n: 0, until: 0 }; f.n++; if (f.n >= 5) { f.n = 0; f.until = Date.now() + 60000; } fails.set(key, f); }

/* ---------------- Utilidades ---------------- */
const TZ = process.env.TZ || 'America/Lima';
function dayKey(d = new Date()) {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
  return p; // YYYY-MM-DD
}
const dayIndex = () => Math.floor(Date.parse(dayKey() + 'T00:00:00Z') / 864e5);
const clean = (v, max) => String(v ?? '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').trim().slice(0, max);
const okUrl = u => /^https?:\/\/\S+$/i.test(u);
function shuffle(a) { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = crypto.randomInt(i + 1); [a[i], a[j]] = [a[j], a[i]]; } return a; }
const registered = () => all('SELECT id, name, is_admin FROM people WHERE pass_hash IS NOT NULL ORDER BY name COLLATE NOCASE');
const eventCfg = () => kvGet('event', { title: '', date: '', place: '', budget: '', notes: '', exclusions: [], drawDone: false, revealed: false, drawAt: null, drawIds: [] });
const drawId = () => kvGet('draw_id', '0');
const giverOf = id => one('SELECT giver FROM assignments WHERE receiver=?', id)?.giver ?? null;
const receiverOf = id => one('SELECT receiver FROM assignments WHERE giver=?', id)?.receiver ?? null;

class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const bad = (msg, status = 400) => { throw new HttpError(status, msg); };

/* ---------------- Tiempo real (SSE) ---------------- */
const clients = new Set();
function push(personId, event, data) {
  for (const c of clients) if (personId == null || c.personId === personId) c.res.write(`event: ${event}\ndata: ${JSON.stringify(data || {})}\n\n`);
}
const pushAll = (event, data) => push(null, event, data);
setInterval(() => { for (const c of clients) c.res.write(': ping\n\n'); }, 25000).unref();

/* ---------------- Hilos de mensajes ---------------- */
// Nombres que ve el cliente: group | dm:<otroId> | anon-santa (le escribo a quien regalo) | anon-kid (me escribe mi amigo secreto)
function resolveThread(me, name) {
  if (name === 'group') return { key: 'group', anon: false };
  const dm = /^dm:(\d+)$/.exec(name || '');
  if (dm) {
    const other = Number(dm[1]);
    if (other === me.id || !one('SELECT 1 FROM people WHERE id=? AND pass_hash IS NOT NULL', other)) bad('Esa persona no está registrada.');
    const [a, b] = [me.id, other].sort((x, y) => x - y);
    return { key: `dm:${a}:${b}`, anon: false, notify: [[me.id, `dm:${other}`], [other, `dm:${me.id}`]] };
  }
  if (name === 'anon-santa') {
    const r = receiverOf(me.id); if (!r) bad('Aún no hay sorteo.');
    return { key: `anon:${me.id}:${drawId()}`, anon: true, side: 'santa', notify: [[me.id, 'anon-santa'], [r, 'anon-kid']] };
  }
  if (name === 'anon-kid') {
    const g = giverOf(me.id); if (!g) bad('Aún no hay sorteo.');
    return { key: `anon:${g}:${drawId()}`, anon: true, side: 'kid', notify: [[me.id, 'anon-kid'], [g, 'anon-santa']] };
  }
  bad('Conversación no válida.');
}

/* ---------------- Puntos ---------------- */
function ranking() {
  const people = registered();
  const pl = all('SELECT person_id, kind, SUM(pts) AS s FROM plays GROUP BY person_id, kind');
  const rw = all('SELECT w.person_id, SUM(r.pts) AS s FROM reto_winners w JOIN retos r ON r.id=w.reto_id GROUP BY w.person_id');
  return people.map(p => {
    const t = pl.find(x => x.person_id === p.id && x.kind === 'trivia')?.s || 0;
    const d = pl.find(x => x.person_id === p.id && x.kind === 'daily')?.s || 0;
    const r = rw.find(x => x.person_id === p.id)?.s || 0;
    return { id: p.id, trivia: t, daily: d, retos: r, total: t + d + r };
  }).sort((a, b) => b.total - a.total);
}
function questionPayload(round, qi, servedAt) {
  const q = C.TRIVIA[(round - 1) * C.ROUND_SIZE + qi];
  const remaining = Math.max(0, C.Q_SECONDS - Math.floor((Date.now() - servedAt) / 1000));
  return { round, qi, total: roundSize(round), q: q.q, o: q.o, remaining, seconds: C.Q_SECONDS };
}
const roundSize = r => Math.min(C.ROUND_SIZE, C.TRIVIA.length - (r - 1) * C.ROUND_SIZE);

/* ---------------- Estado ---------------- */
function state(me) {
  const ev = eventCfg();
  const people = registered();
  const recv = receiverOf(me.id);
  const plays = all('SELECT kind, key, pts FROM plays WHERE person_id=?', me.id);
  const today = dayKey();
  const dItem = C.DAILY[dayIndex() % C.DAILY.length];
  const dPlayed = plays.find(p => p.kind === 'daily' && p.key === today);
  const retos = all('SELECT id, title, descr, pts, at FROM retos ORDER BY at DESC').map(r => ({
    ...r, winners: all('SELECT person_id FROM reto_winners WHERE reto_id=?', r.id).map(x => x.person_id)
  }));
  const out = {
    me,
    event: { title: ev.title, date: ev.date, place: ev.place, budget: ev.budget, notes: ev.notes, drawDone: ev.drawDone, revealed: ev.revealed, drawAt: ev.drawAt },
    members: people.map(p => ({ id: p.id, name: p.name })),
    assignment: recv ? { receiver: recv } : null,
    hasGiver: !!giverOf(me.id),
    pairs: ev.revealed ? all('SELECT giver, receiver FROM assignments').map(r => [r.giver, r.receiver]) : null,
    ranking: ranking(),
    retos,
    trivia: Array.from({ length: C.ROUNDS }, (_, i) => {
      const p = plays.find(x => x.kind === 'trivia' && x.key === 'r' + (i + 1));
      const prog = one('SELECT qi FROM trivia_progress WHERE person_id=? AND round=?', me.id, i + 1);
      return { round: i + 1, played: !!p && (!prog || prog.qi >= roundSize(i + 1)), inProgress: !!prog && prog.qi < roundSize(i + 1), pts: p ? p.pts : null };
    }),
    daily: { key: today, e: dItem.e, q: dItem.q, o: dItem.o, pts: C.DAILY_PTS, played: !!dPlayed, result: dPlayed ? dPlayed.pts : null, answer: dPlayed ? dItem.a : null },
    triviaInfo: { rounds: C.ROUNDS, size: C.ROUND_SIZE, seconds: C.Q_SECONDS }
  };
  if (me.isAdmin) {
    out.admin = {
      exclusions: ev.exclusions || [],
      drawIds: ev.drawIds || [],
      roster: all('SELECT id, name, is_admin, pass_hash IS NOT NULL AS reg FROM people ORDER BY name COLLATE NOCASE').map(p => ({ id: p.id, name: p.name, isAdmin: !!p.is_admin, registered: !!p.reg }))
    };
  }
  return out;
}

/* ---------------- Rutas ---------------- */
const routes = [];
const route = (method, pattern, opts, fn) => routes.push({ method, re: new RegExp('^' + pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$'), auth: opts.auth, admin: opts.admin, fn });

// Público: lista para elegir nombre
route('GET', '/api/roster', {}, () => ({
  people: all('SELECT id, name, is_admin, pass_hash IS NOT NULL AS reg FROM people ORDER BY name COLLATE NOCASE').map(p => ({ id: p.id, name: p.name, registered: !!p.reg, isAdmin: !!p.is_admin })),
  title: eventCfg().title || ''
}));

route('POST', '/api/register', {}, ({ body, req, res, ip }) => {
  const id = Number(body.personId), pass = String(body.password || '');
  const p = one('SELECT * FROM people WHERE id=?', id);
  if (!p) bad('Elige tu nombre de la lista.');
  if (p.pass_hash) bad('Ese nombre ya tiene contraseña. Usa "Entrar".', 409);
  if (pass.length < 4 || pass.length > 128) bad('La contraseña debe tener entre 4 y 128 caracteres.');
  if (p.is_admin) {
    const key = 'admin|' + ip; const wait = lockedOut(key); if (wait) bad(`Demasiados intentos. Espera ${wait} s.`, 429);
    const stored = kvGet('admin_code_hash', null);
    if (!stored || !checkPass(String(body.adminCode || '').trim(), stored)) { noteFail(key); bad('El código de organizador no es correcto.', 403); }
  }
  run('UPDATE people SET pass_hash=?, registered_at=? WHERE id=? AND pass_hash IS NULL', hashPass(pass), Date.now(), id);
  const s = newSession(id, !!body.remember);
  res.setHeader('Set-Cookie', cookieHeader(req, s.token, s.maxAge));
  pushAll('state');
  return { ok: true };
});

route('POST', '/api/login', {}, ({ body, req, res, ip }) => {
  const id = Number(body.personId), pass = String(body.password || '');
  const key = id + '|' + ip; const wait = lockedOut(key);
  if (wait) bad(`Demasiados intentos. Espera ${wait} s.`, 429);
  const p = one('SELECT * FROM people WHERE id=?', id);
  if (!p || !p.pass_hash) bad('Ese nombre todavía no tiene contraseña. Créala primero.');
  if (!checkPass(pass, p.pass_hash)) { noteFail(key); bad('Contraseña incorrecta. Si la olvidaste, pide al organizador que la restablezca.', 401); }
  fails.delete(key);
  const s = newSession(id, !!body.remember);
  res.setHeader('Set-Cookie', cookieHeader(req, s.token, s.maxAge));
  return { ok: true };
});

route('POST', '/api/logout', {}, ({ req, res }) => {
  const t = readCookie(req); if (t) run('DELETE FROM sessions WHERE token_hash=?', sha(t));
  res.setHeader('Set-Cookie', cookieHeader(req, '', 0));
  return { ok: true };
});

route('POST', '/api/password', { auth: true }, ({ me, body, req, res }) => {
  const p = one('SELECT pass_hash FROM people WHERE id=?', me.id);
  if (!checkPass(String(body.current || ''), p.pass_hash)) bad('La contraseña actual no es correcta.', 401);
  const next = String(body.next || ''); if (next.length < 4 || next.length > 128) bad('La contraseña nueva debe tener entre 4 y 128 caracteres.');
  run('UPDATE people SET pass_hash=? WHERE id=?', hashPass(next), me.id);
  run('DELETE FROM sessions WHERE person_id=?', me.id); // cierra otras sesiones
  const s = newSession(me.id, !!body.remember);
  res.setHeader('Set-Cookie', cookieHeader(req, s.token, s.maxAge));
  return { ok: true };
});

route('GET', '/api/state', { auth: true }, ({ me }) => state(me));

// Lista de deseos
route('GET', '/api/wishes/mine', { auth: true }, ({ me }) => ({ items: all('SELECT id, title, url, note, at FROM wishes WHERE person_id=? ORDER BY at', me.id) }));
route('GET', '/api/wishes/receiver', { auth: true }, ({ me }) => {
  const r = receiverOf(me.id); if (!r) return { items: [] };
  return { items: all('SELECT id, title, url, note, at FROM wishes WHERE person_id=? ORDER BY at', r) };
});
route('POST', '/api/wishes', { auth: true }, ({ me, body }) => {
  const title = clean(body.title, 100), url = clean(body.url, 600), note = clean(body.note, 600);
  if (url && !okUrl(url)) bad('El enlace debe empezar con https://');
  if (!title && !url && !note) bad('Escribe al menos un título, un enlace o una nota.');
  if (one('SELECT COUNT(*) n FROM wishes WHERE person_id=?', me.id).n >= 40) bad('Tu lista ya tiene 40 cosas. Borra alguna para agregar más.');
  run('INSERT INTO wishes(person_id,title,url,note,at) VALUES(?,?,?,?,?)', me.id, title, url, note, Date.now());
  const g = giverOf(me.id); push(me.id, 'wishes'); if (g) push(g, 'wishes');
  return { ok: true };
});
route('DELETE', '/api/wishes/:id', { auth: true }, ({ me, params }) => {
  run('DELETE FROM wishes WHERE id=? AND person_id=?', Number(params.id), me.id);
  const g = giverOf(me.id); push(me.id, 'wishes'); if (g) push(g, 'wishes');
  return { ok: true };
});

// Apuntes privados
route('GET', '/api/notes', { auth: true }, ({ me }) => ({ text: one('SELECT text FROM notes WHERE person_id=?', me.id)?.text || '' }));
route('PUT', '/api/notes', { auth: true }, ({ me, body }) => {
  run('INSERT INTO notes(person_id,text) VALUES(?,?) ON CONFLICT(person_id) DO UPDATE SET text=excluded.text', me.id, clean(body.text, 4000));
  return { ok: true };
});

// Mensajes
route('GET', '/api/threads', { auth: true }, ({ me }) => {
  const last = {};
  const g = one("SELECT MAX(id) m FROM messages WHERE thread='group'"); last.group = g.m || 0;
  for (const r of all("SELECT thread, MAX(id) m FROM messages WHERE thread LIKE 'dm:%' AND (thread LIKE ? OR thread LIKE ?) GROUP BY thread", `dm:${me.id}:%`, `dm:%:${me.id}`)) {
    const [, a, b] = r.thread.split(':').map(Number); last['dm:' + (a === me.id ? b : a)] = r.m;
  }
  const d = drawId();
  if (receiverOf(me.id)) last['anon-santa'] = one('SELECT MAX(id) m FROM messages WHERE thread=?', `anon:${me.id}:${d}`).m || 0;
  const gv = giverOf(me.id); if (gv) last['anon-kid'] = one('SELECT MAX(id) m FROM messages WHERE thread=?', `anon:${gv}:${d}`).m || 0;
  return { last };
});
route('GET', '/api/messages', { auth: true }, ({ me, query }) => {
  const t = resolveThread(me, query.get('thread'));
  const rows = all('SELECT id, sender, side, text, at FROM messages WHERE thread=? ORDER BY id DESC LIMIT 300', t.key).reverse();
  return {
    messages: rows.map(m => t.anon ? { id: m.id, mine: m.side === t.side, text: m.text, at: m.at } : { id: m.id, sender: m.sender, mine: m.sender === me.id, text: m.text, at: m.at })
  };
});
const lastSend = new Map();
route('POST', '/api/messages', { auth: true }, ({ me, body }) => {
  const text = clean(body.text, 1000); if (!text) bad('El mensaje está vacío.');
  if (Date.now() - (lastSend.get(me.id) || 0) < 400) bad('Vas muy rápido. Espera un segundo.', 429);
  lastSend.set(me.id, Date.now());
  const t = resolveThread(me, body.thread);
  run('INSERT INTO messages(thread, sender, side, text, at) VALUES(?,?,?,?,?)', t.key, t.anon ? null : me.id, t.anon ? t.side : null, text, Date.now());
  if (t.key === 'group') pushAll('msg', { thread: 'group' });
  else for (const [pid, name] of t.notify) push(pid, 'msg', { thread: name });
  return { ok: true };
});

// Juegos
route('POST', '/api/daily', { auth: true }, ({ me, body }) => {
  const k = dayKey(), item = C.DAILY[dayIndex() % C.DAILY.length];
  if (one("SELECT 1 FROM plays WHERE person_id=? AND kind='daily' AND key=?", me.id, k)) bad('Ya jugaste el reto de hoy. Vuelve mañana.', 409);
  const pts = Number(body.choice) === item.a ? C.DAILY_PTS : 0;
  run("INSERT INTO plays(person_id,kind,key,pts) VALUES(?, 'daily', ?, ?)", me.id, k, pts);
  pushAll('state');
  return { correct: item.a, pts };
});
route('POST', '/api/trivia/start', { auth: true }, ({ me, body }) => {
  const round = Number(body.round);
  if (!(round >= 1 && round <= C.ROUNDS)) bad('Ronda no válida.');
  const size = roundSize(round);
  let prog = one('SELECT * FROM trivia_progress WHERE person_id=? AND round=?', me.id, round);
  const played = one("SELECT pts FROM plays WHERE person_id=? AND kind='trivia' AND key=?", me.id, 'r' + round);
  if (played && (!prog || prog.qi >= size)) bad('Ya jugaste esta ronda.', 409);
  if (!prog) {
    tx(() => {
      run("INSERT INTO plays(person_id,kind,key,pts) VALUES(?, 'trivia', ?, 0)", me.id, 'r' + round);
      run('INSERT INTO trivia_progress(person_id, round, qi, served_at, score) VALUES(?,?,0,?,0)', me.id, round, Date.now());
    });
    prog = one('SELECT * FROM trivia_progress WHERE person_id=? AND round=?', me.id, round);
    pushAll('state');
  }
  // Si se recargó la página y la pregunta ya venció, cuenta como fallada
  while (prog.qi < size && Date.now() - prog.served_at > (C.Q_SECONDS + 2) * 1000) {
    run('UPDATE trivia_progress SET qi=qi+1, served_at=? WHERE person_id=? AND round=?', Date.now(), me.id, round);
    prog = one('SELECT * FROM trivia_progress WHERE person_id=? AND round=?', me.id, round);
  }
  if (prog.qi >= size) return { done: true, score: prog.score };
  return { done: false, score: prog.score, question: questionPayload(round, prog.qi, prog.served_at) };
});
route('POST', '/api/trivia/answer', { auth: true }, ({ me, body }) => {
  const round = Number(body.round), qi = Number(body.qi), choice = Number(body.choice);
  const prog = one('SELECT * FROM trivia_progress WHERE person_id=? AND round=?', me.id, round);
  if (!prog) bad('Empieza la ronda primero.');
  if (prog.qi !== qi) bad('Esa pregunta ya se respondió.', 409);
  const q = C.TRIVIA[(round - 1) * C.ROUND_SIZE + qi];
  const elapsed = (Date.now() - prog.served_at) / 1000;
  const ok = choice === q.a && elapsed <= C.Q_SECONDS + 1.5;
  const gain = ok ? 10 + Math.round(5 * Math.max(0, C.Q_SECONDS - elapsed) / C.Q_SECONDS) : 0;
  const score = prog.score + gain, nextQi = qi + 1, now = Date.now();
  tx(() => {
    run('UPDATE trivia_progress SET qi=?, served_at=?, score=? WHERE person_id=? AND round=?', nextQi, now, score, me.id, round);
    run("UPDATE plays SET pts=? WHERE person_id=? AND kind='trivia' AND key=?", score, me.id, 'r' + round);
  });
  pushAll('state');
  const done = nextQi >= roundSize(round);
  return { correct: q.a, gain, score, done, next: done ? null : questionPayload(round, nextQi, now) };
});

// Organizador
route('PUT', '/api/admin/event', { auth: true, admin: true }, ({ body }) => {
  const ev = eventCfg();
  for (const [k, n] of [['title', 60], ['date', 40], ['place', 120], ['budget', 40], ['notes', 800]]) if (k in body) ev[k] = clean(body[k], n);
  kvSet('event', ev); pushAll('state'); return { ok: true };
});
route('PUT', '/api/admin/exclusions', { auth: true, admin: true }, ({ body }) => {
  const ids = new Set(all('SELECT id FROM people').map(p => p.id));
  const ex = (Array.isArray(body.exclusions) ? body.exclusions : []).map(p => [Number(p[0]), Number(p[1])]).filter(([a, b]) => a !== b && ids.has(a) && ids.has(b)).slice(0, 200);
  const ev = eventCfg(); ev.exclusions = ex; kvSet('event', ev); pushAll('state'); return { ok: true };
});
route('POST', '/api/admin/roster', { auth: true, admin: true }, ({ body }) => {
  const names = [...new Set(String(body.names || '').split(/[\n;]+/).map(s => clean(s, 40).replace(/\s+/g, ' ')).filter(Boolean))];
  let added = 0;
  for (const n of names) { try { run('INSERT INTO people(name, created_at) VALUES(?,?)', n, Date.now()); added++; } catch { /* repetido */ } }
  pushAll('state'); return { added };
});
route('DELETE', '/api/admin/roster/:id', { auth: true, admin: true }, ({ me, params }) => {
  const id = Number(params.id); if (id === me.id) bad('No puedes borrarte a ti mismo.');
  const p = one('SELECT pass_hash, is_admin FROM people WHERE id=?', id); if (!p) bad('No existe.', 404);
  if (p.is_admin) bad('No puedes borrar al organizador.');
  run('DELETE FROM people WHERE id=?', id); pushAll('state'); return { ok: true };
});
route('POST', '/api/admin/reset-password/:id', { auth: true, admin: true }, ({ me, params }) => {
  const id = Number(params.id); if (id === me.id) bad('Cambia tu propia contraseña desde "Mi cuenta".');
  run('UPDATE people SET pass_hash=NULL WHERE id=?', id); run('DELETE FROM sessions WHERE person_id=?', id);
  pushAll('state'); return { ok: true };
});
route('POST', '/api/admin/draw', { auth: true, admin: true }, () => {
  const people = registered().map(p => p.id), n = people.length;
  if (n < 3) bad(`Se necesitan al menos 3 personas registradas. Hay ${n}.`);
  const ev = eventCfg();
  const ex = new Set((ev.exclusions || []).flatMap(([a, b]) => [a + '|' + b, b + '|' + a]));
  const ok = (g, r) => g !== r && !ex.has(g + '|' + r);
  let map = null;
  for (let i = 0; i < 5000 && !map; i++) { const o = shuffle(people); if (o.every((g, j) => ok(g, o[(j + 1) % n]))) map = o.map((g, j) => [g, o[(j + 1) % n]]); }
  for (let i = 0; i < 5000 && !map; i++) { const r = shuffle(people); if (people.every((g, j) => ok(g, r[j]))) map = people.map((g, j) => [g, r[j]]); }
  if (!map) bad('No hay forma de sortear con esas exclusiones. Quita alguna e inténtalo de nuevo.');
  tx(() => {
    run('DELETE FROM assignments');
    for (const [g, r] of map) run('INSERT INTO assignments(giver, receiver) VALUES(?,?)', g, r);
    kvSet('draw_id', crypto.randomBytes(6).toString('hex'));
    Object.assign(ev, { drawDone: true, revealed: false, drawAt: Date.now(), drawIds: people });
    kvSet('event', ev);
  });
  pushAll('state'); return { ok: true };
});
route('POST', '/api/admin/reset-draw', { auth: true, admin: true }, () => {
  tx(() => { run('DELETE FROM assignments'); const ev = eventCfg(); Object.assign(ev, { drawDone: false, revealed: false, drawIds: [] }); kvSet('event', ev); });
  pushAll('state'); return { ok: true };
});
route('POST', '/api/admin/reveal', { auth: true, admin: true }, ({ body }) => {
  const ev = eventCfg(); if (!ev.drawDone) bad('Primero haz el sorteo.');
  ev.revealed = body.revealed !== false; kvSet('event', ev); pushAll('state'); return { ok: true };
});
route('POST', '/api/admin/retos', { auth: true, admin: true }, ({ body }) => {
  const title = clean(body.title, 80); if (!title) bad('Ponle nombre al reto.');
  const pts = Math.max(1, Math.min(500, Math.round(Number(body.pts) || 0)));
  run('INSERT INTO retos(title, descr, pts, at) VALUES(?,?,?,?)', title, clean(body.descr, 300), pts, Date.now());
  pushAll('state'); return { ok: true };
});
route('DELETE', '/api/admin/retos/:id', { auth: true, admin: true }, ({ params }) => { run('DELETE FROM retos WHERE id=?', Number(params.id)); pushAll('state'); return { ok: true }; });
route('POST', '/api/admin/retos/:id/toggle', { auth: true, admin: true }, ({ params, body }) => {
  const rid = Number(params.id), pid = Number(body.personId);
  if (one('SELECT 1 FROM reto_winners WHERE reto_id=? AND person_id=?', rid, pid)) run('DELETE FROM reto_winners WHERE reto_id=? AND person_id=?', rid, pid);
  else run('INSERT INTO reto_winners(reto_id, person_id) VALUES(?,?)', rid, pid);
  pushAll('state'); return { ok: true };
});

/* ---------------- Servidor HTTP ---------------- */
const STATIC = { '/': 'index.html', '/index.html': 'index.html' };
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > 64 * 1024) { reject(new HttpError(413, 'Demasiado grande.')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { if (!chunks.length) return resolve({}); try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(new HttpError(400, 'Datos no válidos.')); } });
    req.on('error', reject);
  });
}
function send(res, status, obj) {
  const b = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(b) });
  res.end(b);
}
const SEC_HEADERS = {
  'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin', 'X-Frame-Options': 'DENY',
  'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"
};

const server = http.createServer(async (req, res) => {
  for (const [k, v] of Object.entries(SEC_HEADERS)) res.setHeader(k, v);
  const url = new URL(req.url, 'http://x');
  const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  try {
    if (req.method === 'GET' && STATIC[url.pathname]) {
      const f = path.join(PUBLIC_DIR, STATIC[url.pathname]);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
      return fs.createReadStream(f).pipe(res);
    }
    if (url.pathname === '/api/events' && req.method === 'GET') {
      const me = currentUser(req); if (!me) return send(res, 401, { error: 'Inicia sesión.' });
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      res.write('retry: 4000\n\n');
      const c = { res, personId: me.id }; clients.add(c);
      req.on('close', () => clients.delete(c));
      return;
    }
    if (!url.pathname.startsWith('/api/')) return send(res, 404, { error: 'No encontrado.' });
    if (req.method !== 'GET' && req.headers['x-amigo'] !== '1') return send(res, 403, { error: 'Solicitud no permitida.' });
    let match = null, params = null;
    for (const r of routes) { if (r.method !== req.method) continue; const m = r.re.exec(url.pathname); if (m) { match = r; params = m.groups || {}; break; } }
    if (!match) return send(res, 404, { error: 'No encontrado.' });
    const me = currentUser(req);
    if (match.auth && !me) return send(res, 401, { error: 'Tu sesión terminó. Vuelve a entrar.' });
    if (match.admin && !me.isAdmin) return send(res, 403, { error: 'Solo el organizador puede hacer esto.' });
    const body = req.method === 'GET' ? {} : await readBody(req);
    const out = await match.fn({ req, res, me, body, params, query: url.searchParams, ip });
    send(res, 200, out);
  } catch (e) {
    if (e instanceof HttpError) return send(res, e.status, { error: e.message });
    console.error(e);
    send(res, 500, { error: 'Algo falló en el servidor. Inténtalo de nuevo.' });
  }
});

/* ---------------- Comandos de instalación ---------------- */
function seedIfEmpty() {
  if (one('SELECT COUNT(*) n FROM people').n > 0) return;
  const f = path.join(__dirname, 'seed.json');
  if (!fs.existsSync(f)) return;
  const seed = JSON.parse(fs.readFileSync(f, 'utf8'));
  tx(() => {
    for (const n of seed.names || []) run('INSERT OR IGNORE INTO people(name, created_at) VALUES(?,?)', clean(n, 40), Date.now());
    if (seed.admin) run('UPDATE people SET is_admin=1 WHERE name=?', seed.admin);
    if (seed.title) { const ev = eventCfg(); ev.title = seed.title; kvSet('event', ev); }
  });
  console.log(`Lista inicial cargada: ${(seed.names || []).length} personas.`);
}
const cmd = process.argv[2];
if (cmd === '--admin-code') {
  seedIfEmpty();
  const code = Array.from({ length: 3 }, () => crypto.randomBytes(2).toString('hex').toUpperCase()).join('-');
  kvSet('admin_code_hash', hashPass(code));
  console.log(code);
  process.exit(0);
} else if (cmd === '--reset-admin') {
  run('UPDATE people SET pass_hash=NULL WHERE is_admin=1'); run('DELETE FROM sessions WHERE person_id IN (SELECT id FROM people WHERE is_admin=1)');
  console.log('Contraseña del organizador borrada. Crea una nueva con el código de organizador.');
  process.exit(0);
} else {
  seedIfEmpty();
  server.listen(PORT, HOST, () => console.log(`Amigo Secreto escuchando en http://${HOST}:${PORT}`));
}
