'use strict';
/* MyJawn P1 smoke test: two scripted WebSocket clients.
 * Run with the server up:  node test/smoke.js   (PORT env respected) */
const WebSocket = require('ws');
const BASE = 'http://localhost:' + (process.env.PORT || 3030);
const suffix = Date.now().toString(36);
const U1 = 'smoke_a_' + suffix, U2 = 'smoke_b_' + suffix;
let failures = 0;
function check(name, ok, extra) {
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + name + (extra ? '  — ' + extra : ''));
  if (!ok) failures++;
}
async function api(pathName, body, token) {
  const r = await fetch(BASE + pathName, {
    method: body ? 'POST' : 'GET',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, data: await r.json() };
}
class Client {
  constructor(name) { this.name = name; this.msgs = []; this.waiters = []; }
  connect(token) {
    return new Promise((res, rej) => {
      this.ws = new WebSocket(BASE.replace('http', 'ws'));
      this.ws.on('open', () => { this.ws.send(JSON.stringify({ t: 'auth', token })); res(); });
      this.ws.on('error', rej);
      this.ws.on('message', raw => {
        const m = JSON.parse(raw);
        this.msgs.push(m);
        this.waiters = this.waiters.filter(w => !w(m));
      });
    });
  }
  send(o) { this.ws.send(JSON.stringify(o)); }
  waitFor(pred, desc, timeout = 4000) {
    const hit = this.msgs.find(pred);
    if (hit) return Promise.resolve(hit);
    return new Promise((res, rej) => {
      const to = setTimeout(() => rej(new Error('timeout waiting for ' + desc)), timeout);
      this.waiters.push(m => { if (pred(m)) { clearTimeout(to); res(m); return true; } return false; });
    });
  }
  close() { this.ws.close(); }
}

(async () => {
  // --- accounts ---
  const r1 = await api('/api/register', { username: U1, password: 'pw1234' });
  const r2 = await api('/api/register', { username: U2, password: 'pw1234' });
  check('register A + B', r1.status === 200 && r2.status === 200, 'start notes=' + r1.data.notes);
  const dup = await api('/api/register', { username: U1, password: 'pw1234' });
  check('duplicate username rejected', dup.status === 409);
  const bad = await api('/api/login', { username: U1, password: 'wrong' });
  check('wrong password rejected', bad.status === 401);
  const l1 = await api('/api/login', { username: U1, password: 'pw1234' });
  check('login A', l1.status === 200 && !!l1.data.token);
  const meA = await api('/api/me', null, l1.data.token);
  check('GET /api/me', meA.data.username === U1);
  check('default look is B1', meA.data.look === 'B1', 'look=' + meA.data.look);

  // --- presence in the lobby ---
  const A = new Client('A'), B = new Client('B');
  await A.connect(l1.data.token);
  const aState = await A.waitFor(m => m.t === 'roomState', 'A roomState');
  check('A joins lobby', aState.room === 'lobby');
  await B.connect(r2.data.token);
  await B.waitFor(m => m.t === 'roomState', 'B roomState');
  const joinSeen = await A.waitFor(m => m.t === 'playerJoin' && m.username === U2, 'A sees B join');
  check('A sees B join the lobby', !!joinSeen);
  const bState = B.msgs.find(m => m.t === 'roomState');
  check('B sees A in lobby players list', bState.players.some(p => p.username === U1),
    'players=' + bState.players.map(p => p.username).join(','));
  check('roomState carries player looks', bState.players.every(p => typeof p.look === 'string' && p.look.length > 0));

  // --- avatar look (figure-string base) ---
  A.send({ t: 'setLook', look: 'B2' });
  const lu = await B.waitFor(m => m.t === 'lookUpdate' && m.username === U1, 'B sees A look change');
  check('look change broadcasts to room', lu.look === 'B2');
  const meA2 = await api('/api/me', null, l1.data.token);
  check('look persists on the account', meA2.data.look === 'B2');
  A.send({ t: 'setLook', look: 'NOPE' });
  const lerr = await A.waitFor(m => m.t === 'error' && /Unknown look/.test(m.msg || ''), 'bad look rejected').catch(() => null);
  check('invalid look rejected server-side', !!lerr);

  // --- movement ---
  A.send({ t: 'move', x: 3, y: 3 });
  const mv = await B.waitFor(m => m.t === 'move' && m.username === U1, 'B sees A move');
  check('B receives A movement', mv.x === 3 && mv.y === 3 && Array.isArray(mv.path) && mv.path.length > 0,
    'path steps=' + (mv.path || []).length);
  A.send({ t: 'move', x: 0, y: 0 }); // lobby soda machine sits at 0,0 -> blocked
  const err = await A.waitFor(m => m.t === 'error' && /Cannot walk/.test(m.msg || ''), 'blocked move rejected');
  check('server rejects move into furniture', /Cannot walk/.test(err.msg || ''));

  // --- chat ---
  A.send({ t: 'chat', text: 'yo B, welcome to my jawn' });
  const ch = await B.waitFor(m => m.t === 'chat' && m.username === U1, 'B hears A chat');
  check('B receives A chat', ch.text === 'yo B, welcome to my jawn');

  // --- faucet (lobby has a soda machine) ---
  A.send({ t: 'faucet' });
  const fc = await A.waitFor(m => m.t === 'faucet' && m.claimed, 'A faucet claim');
  const youAfter = A.msgs.filter(m => m.t === 'you').pop();
  check('faucet pays +25 Notes', fc.claimed === 25 && youAfter.notes === 150 + 25, 'notes=' + youAfter.notes);
  A.send({ t: 'faucet' });
  const ferr = await A.waitFor(m => m.t === 'error' && /already claimed/.test(m.msg || ''), 'second faucet rejected', 4000).catch(() => null);
  check('second faucet claim within 24h rejected', !!ferr);

  // --- buy + place in own room ---
  A.send({ t: 'join', room: 'user:' + U1 });
  const own = await A.waitFor(m => m.t === 'roomState' && m.room === 'user:' + U1, 'A enters own jawn');
  check('A enters personal room', own.owner === U1);
  A.send({ t: 'buy', itemId: 'C2' }); // sofa, 60
  const you2 = await A.waitFor(m => m.t === 'you' && m.inventory.C2 === 1, 'A owns sofa');
  check('buy sofa deducts Notes + adds inventory', you2.notes === 175 - 60, 'notes=' + you2.notes);
  A.send({ t: 'buy', itemId: 'C6' }); // TV, 80 — affordable at 115, leaves 35
  const you3 = await A.waitFor(m => m.t === 'you' && m.inventory.C6 === 1, 'A owns TV');
  check('second purchase succeeds', you3.notes === 35, 'notes=' + you3.notes);
  A.send({ t: 'buy', itemId: 'C14' }); // bookshelf, 40 > 35 left
  const berr = await A.waitFor(m => m.t === 'error' && /Not enough/.test(m.msg || ''), 'overspend rejected').catch(() => null);
  check('insufficient funds rejected server-side', !!berr);
  A.send({ t: 'place', itemId: 'C2', x: 2, y: 2, rot: 0 });
  const fu = await A.waitFor(m => m.t === 'furniUpdate' && m.furniture.some(f => f.item === 'C2'), 'sofa placed');
  check('place furniture broadcasts update', !!fu);
  const placed = fu.furniture.find(f => f.item === 'C2');
  A.send({ t: 'move', x: 2, y: 2 });
  const cerr = await A.waitFor(m => m.t === 'error' && /Cannot walk/.test(m.msg || ''), 'own-room collision').catch(() => null);
  check('placed furniture blocks movement', !!cerr);
  A.send({ t: 'remove', instId: placed.inst });
  const fu2 = await A.waitFor(m => m.t === 'furniUpdate' && !m.furniture.some(f => f.item === 'C2'), 'sofa removed');
  check('remove furniture works', !!fu2);

  // --- B visits A's room ---
  B.send({ t: 'join', room: 'user:' + U1 });
  const visit = await B.waitFor(m => m.t === 'roomState' && m.room === 'user:' + U1, 'B visits A');
  check('B can visit A\'s jawn', visit.owner === U1);
  B.send({ t: 'place', itemId: 'C1', x: 1, y: 1, rot: 0 });
  const perr = await B.waitFor(m => m.t === 'error' && /only decorate/.test(m.msg || ''), 'visitor place rejected').catch(() => null);
  check('visitor cannot decorate someone else\'s room', !!perr);

  A.close(); B.close();
  console.log(failures === 0 ? '\nALL CHECKS PASSED' : '\n' + failures + ' CHECK(S) FAILED');
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error('SMOKE ERROR:', e.message); process.exit(1); });
