'use strict';
/*
 * MyJawn P1 server — accounts, rooms, chat, furniture, Notes economy.
 * HTTP (static + REST auth) and WebSocket (game protocol) on one port.
 * Persistence: built-in node:sqlite (data.sqlite in this folder).
 * Passwords: crypto.scrypt with per-user salt. Only dependency: ws.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const { DatabaseSync } = require('node:sqlite');

const PORT = process.env.PORT || 3030;
const ROOT = __dirname;
const PUBLIC = path.join(ROOT, 'public');
const ASSETS = path.join(ROOT, 'assets');

const GRID_W = 12, GRID_H = 10;
const START_NOTES = 150;
const FAUCET_AMOUNT = 25;
const FAUCET_MS = 24 * 60 * 60 * 1000;

const CATALOGUE = JSON.parse(fs.readFileSync(path.join(ROOT, 'catalogue.json'), 'utf8'));
const ITEM = Object.fromEntries(CATALOGUE.map(i => [i.id, i]));

/* ---------------- persistence ---------------- */
const db = new DatabaseSync(path.join(ROOT, 'data.sqlite'));
db.exec(`
CREATE TABLE IF NOT EXISTS users(
  username TEXT PRIMARY KEY,
  pass TEXT NOT NULL,            -- salt:hexhash
  notes INTEGER NOT NULL DEFAULT ${START_NOTES},
  inventory TEXT NOT NULL DEFAULT '{}',   -- {itemId: count} (owned, incl. placed)
  last_faucet INTEGER NOT NULL DEFAULT 0,
  created INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions(
  token TEXT PRIMARY KEY, username TEXT NOT NULL, created INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS rooms(
  id TEXT PRIMARY KEY, owner TEXT NOT NULL,
  floor TEXT NOT NULL DEFAULT 'wood', wall TEXT NOT NULL DEFAULT 'cream',
  furniture TEXT NOT NULL DEFAULT '[]'    -- [{inst,item,x,y,rot}]
);
`);
// Migration: avatar look (figure-string base id, ALIGNMENT-RESEARCH §4 — look is
// stored as data, e.g. 'B1'; wearables extend this string later, never re-render).
try { db.exec(`ALTER TABLE users ADD COLUMN look TEXT NOT NULL DEFAULT 'B1'`); } catch (e) { /* column already exists */ }
const VALID_LOOKS = ['B1', 'B2'];
// Seed the lobby with a soda machine so the faucet is reachable from day one.
db.prepare(`INSERT OR IGNORE INTO rooms(id,owner,furniture) VALUES('lobby','system',?)`)
  .run(JSON.stringify([{ inst: 'lobby-soda', item: 'C8', x: 0, y: 0, rot: 0 }]));

const q = {
  user: db.prepare('SELECT * FROM users WHERE username=?'),
  addUser: db.prepare('INSERT INTO users(username,pass,created) VALUES(?,?,?)'),
  setNotes: db.prepare('UPDATE users SET notes=? WHERE username=?'),
  setInv: db.prepare('UPDATE users SET inventory=? WHERE username=?'),
  setFaucet: db.prepare('UPDATE users SET last_faucet=? WHERE username=?'),
  setLook: db.prepare('UPDATE users SET look=? WHERE username=?'),
  addSession: db.prepare('INSERT INTO sessions(token,username,created) VALUES(?,?,?)'),
  session: db.prepare('SELECT username FROM sessions WHERE token=?'),
  room: db.prepare('SELECT * FROM rooms WHERE id=?'),
  addRoom: db.prepare('INSERT OR IGNORE INTO rooms(id,owner) VALUES(?,?)'),
  setRoom: db.prepare('UPDATE rooms SET floor=?, wall=?, furniture=? WHERE id=?'),
};

function getRoom(id) {
  let r = q.room.get(id);
  if (!r && id.startsWith('user:')) {
    const owner = id.slice(5);
    if (q.user.get(owner)) { q.addRoom.run(id, owner); r = q.room.get(id); }
  }
  if (!r) return null;
  return { id: r.id, owner: r.owner, floor: r.floor, wall: r.wall, furniture: JSON.parse(r.furniture) };
}
function saveRoom(room) { q.setRoom.run(room.floor, room.wall, JSON.stringify(room.furniture), room.id); }
function getUser(name) { const u = q.user.get(name); if (u) { u.inventory = JSON.parse(u.inventory); if (!VALID_LOOKS.includes(u.look)) u.look = 'B1'; } return u; }

/* ---------------- auth helpers ---------------- */
function hashPass(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  return salt + ':' + crypto.scryptSync(pw, salt, 64).toString('hex');
}
function checkPass(pw, stored) {
  const [salt, hash] = stored.split(':');
  const got = crypto.scryptSync(pw, salt, 64);
  return crypto.timingSafeEqual(got, Buffer.from(hash, 'hex'));
}
const USER_RE = /^[A-Za-z0-9_]{3,16}$/;

/* ---------------- HTTP ---------------- */
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml' };
function sendFile(res, file) {
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
}
function bodyJson(req) {
  return new Promise(resolve => {
    let b = ''; req.on('data', c => { b += c; if (b.length > 1e5) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch { resolve({}); } });
  });
}
function json(res, code, obj) { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); }

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;

  if (p === '/api/register' && req.method === 'POST') {
    const { username, password } = await bodyJson(req);
    if (!USER_RE.test(username || '')) return json(res, 400, { error: 'Username: 3-16 chars, letters/numbers/underscore.' });
    if (!password || password.length < 4) return json(res, 400, { error: 'Password: at least 4 characters.' });
    if (q.user.get(username)) return json(res, 409, { error: 'Username taken.' });
    q.addUser.run(username, hashPass(password), Date.now());
    q.addRoom.run('user:' + username, username);
    const token = crypto.randomBytes(24).toString('hex');
    q.addSession.run(token, username, Date.now());
    return json(res, 200, { token, username, notes: START_NOTES, look: 'B1' });
  }
  if (p === '/api/login' && req.method === 'POST') {
    const { username, password } = await bodyJson(req);
    const u = q.user.get(username || '');
    if (!u || !checkPass(password || '', u.pass)) return json(res, 401, { error: 'Bad username or password.' });
    const token = crypto.randomBytes(24).toString('hex');
    q.addSession.run(token, username, Date.now());
    return json(res, 200, { token, username, notes: u.notes, look: VALID_LOOKS.includes(u.look) ? u.look : 'B1' });
  }
  if (p === '/api/me' && req.method === 'GET') {
    const token = (req.headers.authorization || '').replace('Bearer ', '');
    const s = q.session.get(token);
    if (!s) return json(res, 401, { error: 'No session.' });
    const u = getUser(s.username);
    return json(res, 200, { username: u.username, notes: u.notes, inventory: u.inventory, look: u.look });
  }
  if (p === '/api/catalogue') return json(res, 200, CATALOGUE);

  if (p === '/' ) return sendFile(res, path.join(PUBLIC, 'index.html'));
  if (p.startsWith('/assets/')) return sendFile(res, path.join(ASSETS, path.basename(p)));
  return sendFile(res, path.join(PUBLIC, path.basename(p)));
});

/* ---------------- game state ---------------- */
const clients = new Map(); // ws -> {username, roomId, x, y}
const roomsLive = new Map(); // roomId -> Set<ws>

function footprint(item, rot) { return rot % 2 === 0 ? [item.w, item.d] : [item.d, item.w]; }
function blockedCells(room, ignoreInst) {
  const blocked = new Set();
  for (const f of room.furniture) {
    if (f.inst === ignoreInst) continue;
    const item = ITEM[f.item]; if (!item || item.walkable) continue;
    const [w, d] = footprint(item, f.rot);
    for (let dx = 0; dx < w; dx++) for (let dy = 0; dy < d; dy++) blocked.add((f.x + dx) + ',' + (f.y + dy));
  }
  return blocked;
}
function findPath(room, sx, sy, tx, ty) {
  if (tx < 0 || ty < 0 || tx >= GRID_W || ty >= GRID_H) return null;
  const blocked = blockedCells(room);
  if (blocked.has(tx + ',' + ty)) return null;
  const key = (x, y) => x + ',' + y;
  const prev = new Map([[key(sx, sy), null]]);
  const queue = [[sx, sy]];
  while (queue.length) {
    const [x, y] = queue.shift();
    if (x === tx && y === ty) {
      const path = []; let k = key(x, y);
      while (k) { const [px, py] = k.split(',').map(Number); path.unshift({ x: px, y: py }); k = prev.get(k); }
      return path.slice(1);
    }
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, ny = y + dy, k = key(nx, ny);
      if (nx < 0 || ny < 0 || nx >= GRID_W || ny >= GRID_H || blocked.has(k) || prev.has(k)) continue;
      prev.set(k, key(x, y)); queue.push([nx, ny]);
    }
  }
  return null;
}
function roomHasFaucet(room) { return room.furniture.some(f => ITEM[f.item] && ITEM[f.item].faucet); }
function faucetStatus(user, room) {
  const readyAt = (user.last_faucet || 0) + FAUCET_MS;
  return { present: roomHasFaucet(room), ready: Date.now() >= readyAt, readyAt };
}
function send(ws, obj) { if (ws.readyState === 1) ws.send(JSON.stringify(obj)); }
function broadcast(roomId, obj, except) {
  const set = roomsLive.get(roomId); if (!set) return;
  for (const ws of set) if (ws !== except) send(ws, obj);
}
function playersIn(roomId) {
  const out = [];
  const set = roomsLive.get(roomId); if (!set) return out;
  for (const ws of set) { const c = clients.get(ws); const u = getUser(c.username); out.push({ username: c.username, x: c.x, y: c.y, look: u ? u.look : 'B1' }); }
  return out;
}
function youPayload(user) { return { t: 'you', username: user.username, notes: user.notes, inventory: user.inventory, look: user.look }; }

function joinRoom(ws, roomId) {
  const c = clients.get(ws);
  const room = getRoom(roomId);
  if (!room) return send(ws, { t: 'error', msg: 'Room not found (user may not exist).' });
  if (c.roomId) {
    const old = roomsLive.get(c.roomId); if (old) old.delete(ws);
    broadcast(c.roomId, { t: 'playerLeave', username: c.username });
  }
  // Spawn on the first free cell near the door (bottom-middle).
  const blocked = blockedCells(room);
  let sx = Math.floor(GRID_W / 2), sy = GRID_H - 1;
  outer: for (let r = 0; r < GRID_W; r++)
    for (let x = 0; x < GRID_W; x++) for (let y = 0; y < GRID_H; y++)
      if (!blocked.has(x + ',' + y)) { sx = x; sy = y; break outer; }
  c.roomId = roomId; c.x = sx; c.y = sy;
  if (!roomsLive.has(roomId)) roomsLive.set(roomId, new Set());
  roomsLive.get(roomId).add(ws);
  const user = getUser(c.username);
  send(ws, {
    t: 'roomState', room: roomId, owner: room.owner, floor: room.floor, wall: room.wall,
    gridW: GRID_W, gridH: GRID_H, furniture: room.furniture,
    players: playersIn(roomId), faucet: faucetStatus(user, room),
  });
  send(ws, youPayload(user));
  broadcast(roomId, { t: 'playerJoin', username: c.username, x: sx, y: sy, look: user.look }, ws);
}

const wss = new WebSocketServer({ server });
wss.on('connection', ws => {
  let authed = false;
  ws.on('message', raw => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (!authed) {
      if (m.t !== 'auth') return ws.close();
      const s = q.session.get(m.token || '');
      if (!s) { send(ws, { t: 'error', msg: 'Bad session token.' }); return ws.close(); }
      authed = true;
      clients.set(ws, { username: s.username, roomId: null, x: 0, y: 0 });
      joinRoom(ws, 'lobby');
      return;
    }
    const c = clients.get(ws);
    const user = getUser(c.username);
    const room = c.roomId ? getRoom(c.roomId) : null;

    switch (m.t) {
      case 'join': joinRoom(ws, String(m.room || 'lobby')); break;

      case 'setLook': {
        if (!VALID_LOOKS.includes(m.look)) return send(ws, { t: 'error', msg: 'Unknown look.' });
        q.setLook.run(m.look, c.username);
        const fresh = getUser(c.username);
        send(ws, youPayload(fresh));
        broadcast(c.roomId, { t: 'lookUpdate', username: c.username, look: m.look });
        break;
      }

      case 'move': {
        if (!room) break;
        const path = findPath(room, c.x, c.y, m.x | 0, m.y | 0);
        if (!path) return send(ws, { t: 'error', msg: 'Cannot walk there.' });
        if (path.length) { c.x = m.x | 0; c.y = m.y | 0; }
        broadcast(c.roomId, { t: 'move', username: c.username, path, x: c.x, y: c.y });
        break;
      }

      case 'chat': {
        const text = String(m.text || '').trim().slice(0, 200);
        if (!text || !room) break;
        broadcast(c.roomId, { t: 'chat', username: c.username, text });
        break;
      }

      case 'buy': {
        const item = ITEM[m.itemId];
        if (!item) return send(ws, { t: 'error', msg: 'Unknown item.' });
        if (user.notes < item.price) return send(ws, { t: 'error', msg: 'Not enough Notes.' });
        user.notes -= item.price;
        user.inventory[item.id] = (user.inventory[item.id] || 0) + 1;
        q.setNotes.run(user.notes, user.username);
        q.setInv.run(JSON.stringify(user.inventory), user.username);
        send(ws, youPayload(user));
        send(ws, { t: 'bought', itemId: item.id });
        break;
      }

      case 'place': {
        if (!room || room.owner !== c.username) return send(ws, { t: 'error', msg: 'You can only decorate your own Jawn.' });
        const item = ITEM[m.itemId];
        if (!item) break;
        const owned = user.inventory[item.id] || 0;
        const placed = room.furniture.filter(f => f.item === item.id).length;
        if (placed >= owned) return send(ws, { t: 'error', msg: 'None left in inventory.' });
        const rot = m.rot ? 1 : 0, x = m.x | 0, y = m.y | 0;
        const [w, d] = footprint(item, rot);
        if (x < 0 || y < 0 || x + w > GRID_W || y + d > GRID_H) return send(ws, { t: 'error', msg: 'Does not fit there.' });
        const blocked = blockedCells(room);
        for (let dx = 0; dx < w; dx++) for (let dy = 0; dy < d; dy++)
          if (blocked.has((x + dx) + ',' + (y + dy))) return send(ws, { t: 'error', msg: 'Space occupied.' });
        const inst = 'f' + Date.now().toString(36) + Math.floor(Math.random() * 1e4);
        room.furniture.push({ inst, item: item.id, x, y, rot });
        saveRoom(room);
        broadcast(c.roomId, { t: 'furniUpdate', furniture: room.furniture });
        send(ws, { t: 'faucet', ...faucetStatus(user, room) });
        break;
      }

      case 'moveFurni': {
        if (!room || room.owner !== c.username) return send(ws, { t: 'error', msg: 'You can only decorate your own Jawn.' });
        const f = room.furniture.find(f => f.inst === m.instId);
        if (!f) break;
        const item = ITEM[f.item];
        const rot = m.rot ? 1 : 0, x = m.x | 0, y = m.y | 0;
        const [w, d] = footprint(item, rot);
        if (x < 0 || y < 0 || x + w > GRID_W || y + d > GRID_H) return send(ws, { t: 'error', msg: 'Does not fit there.' });
        const blocked = blockedCells(room, f.inst);
        for (let dx = 0; dx < w; dx++) for (let dy = 0; dy < d; dy++)
          if (blocked.has((x + dx) + ',' + (y + dy))) return send(ws, { t: 'error', msg: 'Space occupied.' });
        f.x = x; f.y = y; f.rot = rot;
        saveRoom(room);
        broadcast(c.roomId, { t: 'furniUpdate', furniture: room.furniture });
        break;
      }

      case 'remove': {
        if (!room || room.owner !== c.username) return send(ws, { t: 'error', msg: 'You can only decorate your own Jawn.' });
        const before = room.furniture.length;
        room.furniture = room.furniture.filter(f => f.inst !== m.instId);
        if (room.furniture.length !== before) {
          saveRoom(room);
          broadcast(c.roomId, { t: 'furniUpdate', furniture: room.furniture });
          send(ws, { t: 'faucet', ...faucetStatus(user, room) });
        }
        break;
      }

      case 'setStyle': {
        if (!room || room.owner !== c.username) break;
        if (['wood', 'carpet', 'checker'].includes(m.floor)) room.floor = m.floor;
        if (['cream', 'sky', 'plum', 'mint'].includes(m.wall)) room.wall = m.wall;
        saveRoom(room);
        broadcast(c.roomId, { t: 'furniUpdate', furniture: room.furniture, floor: room.floor, wall: room.wall });
        break;
      }

      case 'faucet': {
        if (!room) break;
        const st = faucetStatus(user, room);
        if (!st.present) return send(ws, { t: 'error', msg: 'No soda machine in this room.' });
        if (!st.ready) return send(ws, { t: 'error', msg: 'Faucet already claimed — come back in 24h.' });
        user.notes += FAUCET_AMOUNT;
        q.setNotes.run(user.notes, user.username);
        q.setFaucet.run(Date.now(), user.username);
        send(ws, youPayload(user));
        send(ws, { t: 'faucet', ...faucetStatus(user, room), claimed: FAUCET_AMOUNT });
        break;
      }
    }
  });
  ws.on('close', () => {
    const c = clients.get(ws);
    if (c && c.roomId) {
      const set = roomsLive.get(c.roomId); if (set) set.delete(ws);
      broadcast(c.roomId, { t: 'playerLeave', username: c.username });
    }
    clients.delete(ws);
  });
});

server.listen(PORT, () => console.log(`MyJawn P1 listening on http://localhost:${PORT}`));
