# SyncBoard

A real-time collaborative whiteboard. Multiple users draw on the same canvas,
drop sticky notes, and see each other's live cursors — all with sub-100ms
latency on a local network.

**Stack:** React + Vite + Canvas 2D (frontend) · Node.js + Express + Socket.io
(backend) · optional Redis pub/sub for horizontal scaling.

## Architecture

```
┌──────────────┐   WebSocket (Socket.io)   ┌─────────────────────────┐
│  React SPA   │◄────────────────────────►│  Node.js + Express      │
│  Canvas 2D   │   stroke:start/move/end   │  per-room state:        │
│  DOM cursors │   cursor:move (throttled) │   users / strokes /     │
│  DOM notes   │   note:add/move/edit/del  │   notes (in-memory)     │
└──────────────┘   ping/pong (latency)     └────────────┬────────────┘
                                                      │ optional
                                                      ▼
                                             ┌──────────────────┐
                                             │  Redis pub/sub   │
                                             │  (multi-instance │
                                             │   broadcast)     │
                                             └──────────────────┘
```

**Event flow:** clients emit intent events (`stroke:start`, `note:add`, …).
The server validates/normalizes each payload, mutates per-room state, and
rebroadcasts to everyone else in the room. Drawing is *optimistic* — the local
stroke paints instantly; remote strokes stream in point-by-point as they are
drawn. Full state (`room:state`) is pushed to late joiners so a newcomer sees
the whole board immediately.

### Where Redis fits (and the fallback)

`@socket.io/redis-adapter` lets several backend instances share Socket.io
room traffic through Redis pub/sub: a stroke emitted on instance A is
published to Redis and fanned out to sockets on instance B.

Redis is **optional**. On boot the server tries `REDIS_URL` (5s timeout):

- **Set + reachable** → Redis adapter, multi-instance broadcasts work.
- **Unset or unreachable** → console warning, falls back to the in-memory
  adapter. Everything works on a single instance with zero infrastructure.

Known trade-off (documented honestly): per-room *history* (stroke list,
notes, presence map) lives in process memory. The Redis adapter shares
*broadcasts*, not that state — so with multiple instances, a late joiner
only gets the history held by the instance it lands on. For true multi-
instance history, back the room store with Redis/DB (the adapter already
gives you the broadcast half).

## Run locally

```bash
# Terminal 1 — backend (http://localhost:4000)
cd backend
npm install
cp .env.example .env   # optional
npm start              # or: npm run dev  (auto-reload)

# Terminal 2 — frontend (http://localhost:5173)
cd frontend
npm install
npm run dev            # or: npm run build  (production bundle in dist/)
```

Open `http://localhost:5173`, pick a name, and share the `/r/<roomId>` URL —
anyone with the link joins the same room. To point the dev frontend at a
remote backend: `VITE_BACKEND_URL=http://host:4000 npm run dev`.

**Smoke test** (needs the backend running):

```bash
cd backend
node smoke-test.js     # or: npm run smoke
```

It connects two clients to one room and asserts: presence join/leave,
late-joiner state, ordered `stroke:start/move/end` relay, cursor relay,
note relay, and ping/pong. Exits 0 on all-pass.

## Deploy

Build the frontend (`npm run build`) and serve `frontend/dist/` as static
files; run the backend with `node server.js` behind it (same origin avoids
CORS entirely — Socket.io is served from `/socket.io`). Set `PORT` and
`REDIS_URL` via environment.

**Scaling note:** one instance needs nothing but the process itself. If you
scale to multiple instances, you must either enable the Redis adapter
(`REDIS_URL`) *or* use sticky sessions — without one of the two, a client's
polling/WebSocket frames can land on different servers and the room
broadcasts break. Even with the adapter, remember per-room history is
in-memory (see above); sticky sessions paper over that too, since a room's
users then share one instance's memory.

## Latency design notes

- **Throttled cursors:** clients emit `cursor:move` at most every 33ms
  (~30/s); the server relays without storing. Cursors render as DOM elements,
  not canvas repaints, so 30Hz updates cost no redraw churn.
- **Incremental strokes:** `stroke:move` carries only *new* points; receivers
  paint just the new tail segment instead of re-rendering the stroke.
- **Optimistic local drawing:** your own pen paints instantly at 60fps —
  network round-trips never gate the brush.
- **Minimal payloads:** points are `{x, y}` only; per-stroke point arrays are
  capped server-side (abuse guard), room history is capped at 5000 strokes.
- **Live readout:** the client pings every 2s and shows round-trip ms in the
  top bar, so latency is observable, not theoretical.

## Protocol summary

| Direction | Event | Payload |
|---|---|---|
| C→S | `join-room` / `leave-room` | `{ roomId, name }` |
| S→C | `room:state` | `{ you, users, strokes, notes }` |
| S→room | `user:join` / `user:leave` | `{ userId, name, color }` |
| C→S→room | `stroke:start` / `stroke:move` / `stroke:end` | `{ id, userId, color, width, tool, points }` |
| C→S→room | `stroke:undo` | `{ userId }` → `{ id }` |
| C→S→room | `canvas:clear` | `{}` |
| C→S→room | `note:add` / `note:move` / `note:edit` / `note:delete` | note fields |
| C→S→room | `cursor:move` | `{ userId, x, y }` (relayed only) |
| C↔S | `ping` → `pong` | `{ t: serverTimestamp }` |

## Project layout

```
syncboard/
├── backend/
│   ├── server.js        # Express + Socket.io, rooms, Redis adapter w/ fallback
│   ├── smoke-test.js    # end-to-end protocol test (two clients, 9 assertions)
│   ├── package.json     # start / dev / smoke scripts
│   └── .env.example
├── frontend/
│   ├── src/
│   │   ├── App.jsx              # routing (/r/:roomId), lobby, join modal
│   │   ├── Whiteboard.jsx       # canvas + socket lifecycle + top bar
│   │   ├── socket.js            # shared Socket.io client
│   │   ├── components/
│   │   │   ├── Toolbar.jsx      # pen/eraser/note, colors, width, undo/clear/export
│   │   │   └── StickyNotes.jsx  # draggable, editable, real-time notes
│   │   └── styles.css
│   ├── index.html
│   ├── vite.config.js
│   └── package.json     # dev / build / preview scripts
└── README.md
```

---

## CI & container image

| What | Where |
| --- | --- |
| Build + protocol test | [`.github/workflows/ci.yml`](.github/workflows/ci.yml) — installs backend and frontend, builds the SPA, boots the backend and runs the two-client Socket.io smoke test |
| Backend image | `ghcr.io/syedalisaleem/syncboard:latest` (published on every push to `main`) |

```bash
docker run --rm -p 4000:4000 ghcr.io/syedalisaleem/syncboard:latest
# optional Redis for multi-instance fan-out:
#   -e REDIS_URL=redis://host:6379
```

No GitHub Pages deploy: every feature is a live Socket.io room, so a Pages-hosted
whiteboard could never sync. Render runs both halves instead.

## Deploy on Render

[`render.yaml`](render.yaml) is a [Render Blueprint](https://render.com/docs/blueprint-spec)
that creates two free services from this repo without changing a single source file:

| Service | What it is |
| --- | --- |
| `syncboard-backend` | The Express + Socket.io server, built from [`Dockerfile`](Dockerfile), health-checked at `/health` |
| `syncboard-frontend` | The React SPA, deployed as a static site |

The static site is built with `VITE_BACKEND_URL` pointed at the backend's public hostname —
the variable [`frontend/src/socket.js`](frontend/src/socket.js) already reads — so the client
connects cross-origin, and the backend already permits it (`cors: { origin: '*' }` on both
Express and Socket.io).

**To deploy:** Render Dashboard → **New** → **Blueprint** → select this repository → **Apply**.
Render creates both services and passes the backend's URL to the frontend build for you.

Worth knowing:

- Free web services spin down after ~15 minutes idle. The first visit afterwards takes
  30–60 seconds to wake the backend.
- Rooms are held in process memory, so the Blueprint runs a single instance — which is what
  the app assumes by default. Attach a Render Key Value instance via `REDIS_URL` to fan out
  across more than one.
- `/*` rewrites to `/index.html` so a shared `/r/<roomId>` link resolves on a cold load.
  Render skips the rewrite when a real file exists at the path, so `/assets/*` is unaffected.