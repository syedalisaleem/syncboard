/**
 * SyncBoard smoke test — spins up two Socket.io clients against a running
 * backend and verifies the real-time protocol end to end.
 *
 * Usage:
 *   node smoke-test.js                 # targets http://localhost:4000
 *   SMOKE_URL=http://localhost:4000 node smoke-test.js
 *
 * Exit code 0 = all checks passed, 1 = at least one failed.
 */
const { io } = require('socket.io-client');

const BASE = process.env.SMOKE_URL || 'http://localhost:4000';
const TIMEOUT_MS = 5000;

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

function once(socket, event) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(event, handler);
      reject(new Error(`timed out waiting for "${event}"`));
    }, TIMEOUT_MS);
    const handler = (data) => {
      clearTimeout(timer);
      resolve(data);
    };
    socket.once(event, handler);
  });
}

function collect(socket, event, count) {
  return new Promise((resolve, reject) => {
    const got = [];
    const timer = setTimeout(() => {
      socket.off(event, handler);
      reject(new Error(`timed out waiting for ${count}x "${event}" (got ${got.length})`));
    }, TIMEOUT_MS);
    const handler = (data) => {
      got.push(data);
      if (got.length === count) {
        clearTimeout(timer);
        socket.off(event, handler);
        resolve(got);
      }
    };
    socket.on(event, handler);
  });
}

async function main() {
  const ROOM = `smoke-${Date.now().toString(36)}`;
  const a = io(BASE, { reconnection: false });
  const b = io(BASE, { reconnection: false });

  try {
    await Promise.all([once(a, 'connect'), once(b, 'connect')]);
    check('both clients connect', true);

    // B joins first and arms listeners before A appears.
    b.emit('join-room', { roomId: ROOM, name: 'Bob' });
    const bState = await once(b, 'room:state');

    const bSeesJoin = once(b, 'user:join');
    const aStateP = once(a, 'room:state');
    a.emit('join-room', { roomId: ROOM, name: 'Alice' });

    // 1. Presence: B must see A's join.
    try {
      const joined = await bSeesJoin;
      check('presence: B sees A join', joined && joined.name === 'Alice', JSON.stringify(joined));
    } catch (e) {
      check('presence: B sees A join', false, e.message);
    }

    // 2. Late-joiner state: A must receive full state including Bob.
    try {
      const aState = await aStateP;
      const names = (aState.users || []).map((u) => u.name);
      check(
        'late-joiner state: A receives users incl. Bob',
        names.includes('Bob') && names.includes('Alice'),
        `users=[${names.join(', ')}]`
      );
      check('late-joiner state: A learns its own identity', !!aState.you && aState.you.name === 'Alice');
    } catch (e) {
      check('late-joiner state', false, e.message);
    }

    const aliceId = a.id;

    // 3. Stroke relay: A draws, B must receive start/move/end in order.
    try {
      const order = [];
      const orderP = new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('stroke order timeout')), TIMEOUT_MS);
        const mk = (ev) => (d) => {
          order.push(ev);
          if (order.length === 3) {
            clearTimeout(timer);
            resolve(order);
          }
        };
        b.once('stroke:start', mk('stroke:start'));
        b.once('stroke:move', mk('stroke:move'));
        b.once('stroke:end', mk('stroke:end'));
      });
      const strokeId = `s-${Date.now()}`;
      a.emit('stroke:start', { id: strokeId, userId: aliceId, color: '#3b82f6', width: 4, tool: 'pen', points: [{ x: 10, y: 10 }] });
      a.emit('stroke:move', { id: strokeId, userId: aliceId, color: '#3b82f6', width: 4, tool: 'pen', points: [{ x: 20, y: 20 }] });
      a.emit('stroke:end', { id: strokeId, userId: aliceId, color: '#3b82f6', width: 4, tool: 'pen', points: [{ x: 30, y: 30 }] });
      const seen = await orderP;
      const inOrder =
        seen[0] === 'stroke:start' && seen[1] === 'stroke:move' && seen[2] === 'stroke:end';
      check('stroke relay: B receives start/move/end in order', inOrder, seen.join(' -> '));
    } catch (e) {
      check('stroke relay: B receives start/move/end in order', false, e.message);
    }

    // 4. Cursor relay.
    try {
      const curP = once(b, 'cursor:move');
      a.emit('cursor:move', { x: 123, y: 456 });
      const cur = await curP;
      check(
        'cursor relay: B receives A cursor',
        cur && cur.userId === aliceId && cur.x === 123 && cur.y === 456,
        JSON.stringify(cur)
      );
    } catch (e) {
      check('cursor relay: B receives A cursor', false, e.message);
    }

    // 5. Sticky note add.
    try {
      const noteP = once(b, 'note:add');
      a.emit('note:add', { id: 'n1', userId: aliceId, x: 50, y: 60, text: 'hello board', color: '#fef08a' });
      const note = await noteP;
      check(
        'note relay: B receives note:add',
        note && note.id === 'n1' && note.text === 'hello board',
        JSON.stringify(note)
      );
    } catch (e) {
      check('note relay: B receives note:add', false, e.message);
    }

    // 6. Latency probe.
    try {
      const t0 = Date.now();
      const pongP = once(a, 'pong');
      a.emit('ping');
      const pong = await pongP;
      const rtt = Date.now() - t0;
      check(
        'ping/pong: server answers with timestamp',
        pong && Number.isFinite(pong.t) && rtt < TIMEOUT_MS,
        `rtt=${rtt}ms serverT=${pong && pong.t}`
      );
    } catch (e) {
      check('ping/pong: server answers with timestamp', false, e.message);
    }

    // 7. Presence leave: A disconnects, B must see the leave.
    try {
      const leaveP = once(b, 'user:leave');
      a.disconnect();
      const left = await leaveP;
      check('presence: B sees A leave', left && left.userId === aliceId, JSON.stringify(left));
    } catch (e) {
      check('presence: B sees A leave', false, e.message);
    }

    void bState;
  } finally {
    a.disconnect();
    b.disconnect();
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => {
  console.error('smoke test crashed:', err);
  process.exit(1);
});
