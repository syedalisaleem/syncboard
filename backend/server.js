/**
 * SyncBoard backend — real-time collaborative whiteboard.
 *
 * Express + Socket.io. Broadcasts scale horizontally through the optional
 * Redis adapter; per-room history (strokes, notes, presence) lives in
 * process memory — see README "Scaling" for the trade-off.
 *
 * Protocol (all payloads are plain JSON):
 *   client -> server : join-room { roomId, name } / leave-room {}
 *   server -> client : room:state { you, users, strokes, notes }
 *   server -> room   : user:join { userId, name, color } / user:leave { userId }
 *   client -> server : stroke:start | stroke:move | stroke:end { id, userId, color, width, tool, points }
 *   client -> server : stroke:undo { userId }            -> room: stroke:undo { id }
 *   client -> server : canvas:clear {}                   -> room: canvas:clear {}
 *   client -> server : note:add | note:move | note:edit | note:delete
 *   client -> server : cursor:move { userId, x, y }      -> room (no history)
 *   client -> server : ping {}                          -> client: pong { t }
 */
require('dotenv').config();

const express = require('express');
const http = require('http');
const cors = require('cors');
const { Server } = require('socket.io');

const PORT = Number(process.env.PORT) || 4000;
const MAX_STROKES = 5000; // per-room stroke history cap; oldest strokes are dropped
const MAX_POINTS = 4000; // per-stroke point cap (abuse guard)
const MAX_TEXT = 2000; // per-note text cap
const REDIS_CONNECT_TIMEOUT_MS = 5000;

const USER_COLORS = [
  '#ef4444', '#f97316', '#eab308', '#22c55e',
  '#14b8a6', '#3b82f6', '#8b5cf6', '#ec4899',
];

/* ------------------------------------------------------------------ */
/* In-memory room state                                                */
/* ------------------------------------------------------------------ */
// rooms: roomId -> { users: Map<socketId, user>, strokes: [stroke], notes: Map<id, note> }
// user  = { userId, name, color }
// stroke= { id, userId, color, width, tool: 'pen'|'eraser', points: [{x,y}] }
// note  = { id, userId, x, y, text, color }
const rooms = new Map();

function getRoom(roomId) {
  let room = rooms.get(roomId);
  if (!room) {
    room = { users: new Map(), strokes: [], notes: new Map() };
    rooms.set(roomId, room);
  }
  return room;
}

function assignColor(room) {
  return USER_COLORS[room.users.size % USER_COLORS.length];
}

function cleanStr(v, max) {
  return String(v ?? '').slice(0, max);
}

function cleanPoint(p) {
  if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) return null;
  return { x: p.x, y: p.y };
}

/** Validate/normalize an incoming stroke payload. Returns null if unusable. */
function sanitizeStroke(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = cleanStr(raw.id, 64);
  if (!id) return null;
  const points = [];
  if (Array.isArray(raw.points)) {
    for (const p of raw.points) {
      const cp = cleanPoint(p);
      if (cp) points.push(cp);
      if (points.length >= MAX_POINTS) break;
    }
  }
  return {
    id,
    userId: cleanStr(raw.userId, 64),
    color: cleanStr(raw.color, 16) || '#111111',
    width: Math.min(60, Math.max(1, Number(raw.width) || 3)),
    tool: raw.tool === 'eraser' ? 'eraser' : 'pen',
    points,
  };
}

function sanitizeNote(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = cleanStr(raw.id, 64);
  if (!id) return null;
  return {
    id,
    userId: cleanStr(raw.userId, 64),
    x: Number.isFinite(raw.x) ? raw.x : 0,
    y: Number.isFinite(raw.y) ? raw.y : 0,
    text: cleanStr(raw.text, MAX_TEXT),
    color: cleanStr(raw.color, 16) || '#fef08a',
  };
}

/* ------------------------------------------------------------------ */
/* HTTP + Socket.io setup                                              */
/* ------------------------------------------------------------------ */
const app = express();
app.use(cors());
app.get('/health', (_req, res) => {
  res.json({ ok: true, rooms: rooms.size, redis: adapterMode });
});

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  // Slightly larger payload ceiling for chunky strokes; still bounded.
  maxHttpBufferSize: 1e6,
});

let adapterMode = 'memory';

/**
 * Attach the Redis pub/sub adapter when REDIS_URL is set and reachable.
 * Otherwise fall back to the in-memory adapter so a single instance works
 * with zero extra infrastructure.
 */
async function setupAdapter() {
  const url = process.env.REDIS_URL;
  if (!url) {
    console.warn(
      '[syncboard] REDIS_URL is not set — using the in-memory Socket.io adapter. ' +
        'This is fine for a single server instance.'
    );
    return;
  }
  let pubClient, subClient;
  try {
    const { createAdapter } = require('@socket.io/redis-adapter');
    const { createClient } = require('redis');
    pubClient = createClient({ url });
    subClient = pubClient.duplicate();
    // node-redis surfaces connection failures as 'error' events whose only
    // useful field is `code` (e.g. ECONNREFUSED) — log once, not per retry.
    let redisErrLogged = false;
    const logRedisError = (which) => (e) => {
      if (!redisErrLogged) {
        redisErrLogged = true;
        console.warn(`[syncboard] redis ${which}:`, e.code || e.message || 'connection failed');
      }
    };
    pubClient.on('error', logRedisError('pub'));
    subClient.on('error', logRedisError('sub'));
    await Promise.race([
      Promise.all([pubClient.connect(), subClient.connect()]),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('connect timeout')), REDIS_CONNECT_TIMEOUT_MS)
      ),
    ]);
    io.adapter(createAdapter(pubClient, subClient));
    adapterMode = 'redis';
    console.log('[syncboard] Redis adapter connected — broadcasts are shared across instances.');
  } catch (err) {
    // Detach the clients so their background reconnect loops die quietly.
    // (Not awaited: quit/disconnect may never settle on a dead connection.)
    for (const c of [pubClient, subClient]) {
      try {
        c?.removeAllListeners('error');
        c?.disconnect();
      } catch { /* noop */ }
    }
    console.warn(
      `[syncboard] Redis unreachable (${err.message || 'connection failed'}) — falling back to the in-memory adapter.`
    );
  }
}

/* ------------------------------------------------------------------ */
/* Socket.io event handlers                                            */
/* ------------------------------------------------------------------ */
io.on('connection', (socket) => {
  let membership = null; // { roomId, userId }

  const inRoom = () => membership && rooms.get(membership.roomId);

  function leaveCurrentRoom() {
    if (!membership) return;
    const { roomId, userId } = membership;
    const room = rooms.get(roomId);
    if (room) {
      room.users.delete(socket.id);
      socket.to(roomId).emit('user:leave', { userId });
      if (room.users.size === 0) rooms.delete(roomId); // free memory
    }
    socket.leave(roomId);
    membership = null;
  }

  socket.on('join-room', ({ roomId, name } = {}) => {
    leaveCurrentRoom();
    const id = cleanStr(roomId, 64) || 'lobby';
    const room = getRoom(id);
    const user = {
      userId: socket.id,
      name: cleanStr(name, 40) || 'Anonymous',
      color: assignColor(room),
    };
    room.users.set(socket.id, user);
    socket.join(id);
    membership = { roomId: id, userId: user.userId };

    // Full state for the late joiner: presence, stroke history, notes.
    socket.emit('room:state', {
      you: user,
      users: [...room.users.values()],
      strokes: room.strokes,
      notes: [...room.notes.values()],
    });
    socket.to(id).emit('user:join', user);
  });

  // --- Drawing relay -------------------------------------------------
  // Strokes are appended to per-room history on start (capped), extended on
  // move/end, and relayed to everyone else in the room.
  const relayStroke = (event, raw) => {
    const room = inRoom();
    if (!room) return;
    const stroke = sanitizeStroke(raw);
    if (!stroke) return;
    stroke.userId = membership.userId; // authoritative: the socket owns its strokes

    if (event === 'stroke:start') {
      room.strokes.push(stroke);
      if (room.strokes.length > MAX_STROKES) {
        room.strokes.splice(0, room.strokes.length - MAX_STROKES);
      }
    } else {
      const stored = room.strokes.find((s) => s.id === stroke.id);
      if (stored && stored.userId === membership.userId) {
        stored.points.push(...stroke.points);
      }
    }
    socket.to(membership.roomId).emit(event, stroke);
  };

  socket.on('stroke:start', (s) => relayStroke('stroke:start', s));
  socket.on('stroke:move', (s) => relayStroke('stroke:move', s));
  socket.on('stroke:end', (s) => relayStroke('stroke:end', s));

  socket.on('stroke:undo', () => {
    const room = inRoom();
    if (!room) return;
    for (let i = room.strokes.length - 1; i >= 0; i--) {
      if (room.strokes[i].userId === membership.userId) {
        const [removed] = room.strokes.splice(i, 1);
        io.to(membership.roomId).emit('stroke:undo', { id: removed.id });
        return;
      }
    }
  });

  socket.on('canvas:clear', () => {
    const room = inRoom();
    if (!room) return;
    room.strokes.length = 0;
    room.notes.clear();
    io.to(membership.roomId).emit('canvas:clear');
  });

  // --- Sticky notes ("live comments") --------------------------------
  socket.on('note:add', (raw) => {
    const room = inRoom();
    if (!room) return;
    const note = sanitizeNote(raw);
    if (!note) return;
    note.userId = membership.userId;
    room.notes.set(note.id, note);
    socket.to(membership.roomId).emit('note:add', note);
  });

  socket.on('note:move', ({ id, x, y } = {}) => {
    const room = inRoom();
    if (!room) return;
    const note = room.notes.get(cleanStr(id, 64));
    if (!note) return;
    if (Number.isFinite(x)) note.x = x;
    if (Number.isFinite(y)) note.y = y;
    socket.to(membership.roomId).emit('note:move', { id: note.id, x: note.x, y: note.y });
  });

  socket.on('note:edit', ({ id, text } = {}) => {
    const room = inRoom();
    if (!room) return;
    const note = room.notes.get(cleanStr(id, 64));
    if (!note) return;
    note.text = cleanStr(text, MAX_TEXT);
    socket.to(membership.roomId).emit('note:edit', { id: note.id, text: note.text });
  });

  socket.on('note:delete', ({ id } = {}) => {
    const room = inRoom();
    if (!room) return;
    const key = cleanStr(id, 64);
    if (room.notes.delete(key)) {
      socket.to(membership.roomId).emit('note:delete', { id: key });
    }
  });

  // --- Live cursors (relayed only, never stored) ----------------------
  socket.on('cursor:move', ({ x, y } = {}) => {
    if (!membership || !Number.isFinite(x) || !Number.isFinite(y)) return;
    socket.to(membership.roomId).emit('cursor:move', { userId: membership.userId, x, y });
  });

  // --- Latency probe ---------------------------------------------------
  // Supports both styles: emit('ping', ackFn) and the 'pong' event.
  socket.on('ping', (ack) => {
    const payload = { t: Date.now() };
    if (typeof ack === 'function') ack(payload);
    else socket.emit('pong', payload);
  });

  socket.on('leave-room', () => {
    leaveCurrentRoom();
  });

  socket.on('disconnect', () => {
    leaveCurrentRoom();
  });
});

/* ------------------------------------------------------------------ */
async function main() {
  await setupAdapter();
  server.listen(PORT, () => {
    console.log(`[syncboard] listening on http://localhost:${PORT} (adapter: ${adapterMode})`);
  });
}

main().catch((err) => {
  console.error('[syncboard] fatal:', err);
  process.exit(1);
});
