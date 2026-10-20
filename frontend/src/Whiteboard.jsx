import React, { useCallback, useEffect, useRef, useState } from 'react';
import { getSocket, randomId } from './socket.js';
import Toolbar from './components/Toolbar.jsx';
import StickyNotes from './components/StickyNotes.jsx';

const BG = '#ffffff';
const CURSOR_TTL_MS = 5000;
const CURSOR_THROTTLE_MS = 33; // ~30 cursor updates/sec max
const MIN_POINT_DIST = 2; // px — drops jitter without visible loss

function posFromEvent(e, canvas) {
  const r = canvas.getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
}

/**
 * Whiteboard — owns the Socket.io connection, the canvas, and all
 * real-time state (strokes, cursors, notes, presence, latency).
 */
export default function Whiteboard({ roomId, name, onExit, onNewBoard, toast }) {
  const canvasRef = useRef(null);
  const ctxRef = useRef(null);
  const dprRef = useRef(1);

  const [tool, setTool] = useState('pen');
  const [color, setColor] = useState('#111111');
  const [width, setWidth] = useState(4);

  const [me, setMe] = useState(null);
  const [users, setUsers] = useState([]);
  const [notes, setNotes] = useState([]);
  const [cursors, setCursors] = useState({});
  const [latency, setLatency] = useState(null);
  const [connected, setConnected] = useState(false);

  // Mutable drawing state lives in refs — pointer handlers fire at 60Hz+
  // and must never go stale or re-render.
  const strokesRef = useRef([]); // completed strokes (local + remote)
  const activeRef = useRef(new Map()); // strokeId -> in-progress stroke
  const drawingRef = useRef(null); // my in-progress stroke
  const brushRef = useRef({ tool: 'pen', color: '#111111', width: 4 });
  const myIdRef = useRef(null);
  const usersRef = useRef([]);
  const lastCursorSent = useRef(0);

  brushRef.current = { tool, color, width };
  usersRef.current = users;

  /* ---------------- canvas paint helpers ---------------- */

  const redraw = useCallback(() => {
    const canvas = canvasRef.current;
    const ctx = ctxRef.current;
    if (!canvas || !ctx) return;
    const dpr = dprRef.current;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = BG;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    for (const s of strokesRef.current) paintStroke(ctx, s);
    for (const s of activeRef.current.values()) paintStroke(ctx, s);
  }, []);

  // Size the canvas to its box * devicePixelRatio so lines stay crisp.
  useEffect(() => {
    const canvas = canvasRef.current;
    const fit = () => {
      const dpr = window.devicePixelRatio || 1;
      dprRef.current = dpr;
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      ctxRef.current = canvas.getContext('2d');
      redraw();
    };
    fit();
    window.addEventListener('resize', fit);
    return () => window.removeEventListener('resize', fit);
  }, [redraw]);

  /* ---------------- socket lifecycle ---------------- */

  useEffect(() => {
    const s = getSocket();
    setConnected(s.connected);

    const onState = ({ you, users: u, strokes, notes: n }) => {
      myIdRef.current = you.userId;
      setMe(you);
      setUsers(u);
      strokesRef.current = Array.isArray(strokes) ? strokes : [];
      activeRef.current.clear();
      drawingRef.current = null;
      setNotes(Array.isArray(n) ? n : []);
      setCursors({});
      redraw();
    };
    const onUserJoin = (u) => setUsers((prev) => [...prev.filter((x) => x.userId !== u.userId), u]);
    const onUserLeave = ({ userId }) => {
      setUsers((prev) => prev.filter((x) => x.userId !== userId));
      setCursors((prev) => {
        const next = { ...prev };
        delete next[userId];
        return next;
      });
    };

    const onStrokeStart = (st) => {
      activeRef.current.set(st.id, { ...st, points: [...st.points] });
      paintTail(st, st.points.length);
    };
    const onStrokeMove = (st) => {
      let cur = activeRef.current.get(st.id);
      if (!cur) {
        // Start packet lost (e.g. reconnect) — recover gracefully.
        cur = { ...st, points: [] };
        activeRef.current.set(st.id, cur);
      }
      cur.points.push(...st.points);
      paintTail(cur, st.points.length);
    };
    const onStrokeEnd = (st) => {
      const cur = activeRef.current.get(st.id);
      activeRef.current.delete(st.id);
      if (cur) {
        cur.points.push(...st.points);
        strokesRef.current.push(cur);
        paintTail(cur, st.points.length);
      } else {
        strokesRef.current.push({ ...st });
        redraw();
      }
    };
    const onStrokeUndo = ({ id }) => {
      let changed = false;
      const i = strokesRef.current.findIndex((x) => x.id === id);
      if (i >= 0) { strokesRef.current.splice(i, 1); changed = true; }
      if (activeRef.current.delete(id)) changed = true;
      if (drawingRef.current && drawingRef.current.id === id) drawingRef.current = null;
      if (changed) redraw();
    };
    const onClear = () => {
      strokesRef.current = [];
      activeRef.current.clear();
      drawingRef.current = null;
      setNotes([]);
      redraw();
    };

    const onNoteAdd = (n) => setNotes((prev) => [...prev.filter((x) => x.id !== n.id), n]);
    const onNoteMove = ({ id, x, y }) =>
      setNotes((prev) => prev.map((n) => (n.id === id ? { ...n, x, y } : n)));
    const onNoteEdit = ({ id, text }) =>
      setNotes((prev) => prev.map((n) => (n.id === id ? { ...n, text } : n)));
    const onNoteDelete = ({ id }) => setNotes((prev) => prev.filter((n) => n.id !== id));

    const onCursor = ({ userId, x, y }) => {
      if (userId === myIdRef.current) return;
      setCursors((prev) => ({ ...prev, [userId]: { x, y, t: Date.now() } }));
    };

    const onConnect = () => setConnected(true);
    const onDisconnect = () => { setConnected(false); setLatency(null); };
    const onReconnect = () => {
      setConnected(true);
      s.emit('join-room', { roomId, name }); // re-sync full state
    };

    s.on('room:state', onState);
    s.on('user:join', onUserJoin);
    s.on('user:leave', onUserLeave);
    s.on('stroke:start', onStrokeStart);
    s.on('stroke:move', onStrokeMove);
    s.on('stroke:end', onStrokeEnd);
    s.on('stroke:undo', onStrokeUndo);
    s.on('canvas:clear', onClear);
    s.on('note:add', onNoteAdd);
    s.on('note:move', onNoteMove);
    s.on('note:edit', onNoteEdit);
    s.on('note:delete', onNoteDelete);
    s.on('cursor:move', onCursor);
    s.on('connect', onConnect);
    s.on('disconnect', onDisconnect);
    s.on('reconnect', onReconnect);

    if (!s.connected) s.connect();
    s.emit('join-room', { roomId, name });

    // Latency probe every 2s.
    const pingTimer = setInterval(() => {
      if (!s.connected) return;
      const t0 = Date.now();
      s.emit('ping');
      s.once('pong', () => setLatency(Date.now() - t0));
    }, 2000);

    // Drop cursors that stopped moving (tab closed without disconnect, etc).
    const pruneTimer = setInterval(() => {
      const now = Date.now();
      setCursors((prev) => {
        const next = {};
        let dropped = false;
        for (const [k, v] of Object.entries(prev)) {
          if (now - v.t < CURSOR_TTL_MS) next[k] = v;
          else dropped = true;
        }
        return dropped ? next : prev;
      });
    }, 2000);

    return () => {
      clearInterval(pingTimer);
      clearInterval(pruneTimer);
      s.emit('leave-room');
      s.off('room:state', onState);
      s.off('user:join', onUserJoin);
      s.off('user:leave', onUserLeave);
      s.off('stroke:start', onStrokeStart);
      s.off('stroke:move', onStrokeMove);
      s.off('stroke:end', onStrokeEnd);
      s.off('stroke:undo', onStrokeUndo);
      s.off('canvas:clear', onClear);
      s.off('note:add', onNoteAdd);
      s.off('note:move', onNoteMove);
      s.off('note:edit', onNoteEdit);
      s.off('note:delete', onNoteDelete);
      s.off('cursor:move', onCursor);
      s.off('connect', onConnect);
      s.off('disconnect', onDisconnect);
      s.off('reconnect', onReconnect);
    };
    // Mount-only: the board remounts (key={roomId}) when the room changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ---------------- local drawing ---------------- */

  const paintTail = (stroke, n) => {
    const ctx = ctxRef.current;
    if (!ctx || n <= 0) return;
    const pts = stroke.points;
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = stroke.tool === 'eraser' ? BG : stroke.color;
    ctx.fillStyle = ctx.strokeStyle;
    ctx.lineWidth = stroke.tool === 'eraser' ? stroke.width * 3 : stroke.width;
    if (pts.length === 1) {
      ctx.beginPath();
      ctx.arc(pts[0].x, pts[0].y, ctx.lineWidth / 2, 0, Math.PI * 2);
      ctx.fill();
    } else {
      const start = Math.max(1, pts.length - n);
      ctx.beginPath();
      ctx.moveTo(pts[start - 1].x, pts[start - 1].y);
      for (let i = start; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
      ctx.stroke();
    }
    ctx.restore();
  };

  const sendCursorThrottled = (e) => {
    const now = performance.now();
    if (now - lastCursorSent.current < CURSOR_THROTTLE_MS) return;
    lastCursorSent.current = now;
    const p = posFromEvent(e, canvasRef.current);
    getSocket().emit('cursor:move', { x: Math.round(p.x), y: Math.round(p.y) });
  };

  const onPointerDown = (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    const canvas = canvasRef.current;
    const p = posFromEvent(e, canvas);
    const brush = brushRef.current;

    if (brush.tool === 'note') {
      const note = {
        id: randomId('n-'),
        userId: myIdRef.current,
        x: Math.round(p.x - 90),
        y: Math.round(p.y - 24),
        text: '',
        color: '#fef08a',
      };
      setNotes((prev) => [...prev, note]);
      getSocket().emit('note:add', note);
      setTool('pen'); // back to pen after placing a note
      return;
    }

    const stroke = {
      id: randomId('s-'),
      userId: myIdRef.current,
      color: brush.color,
      width: brush.width,
      tool: brush.tool,
      points: [p],
    };
    drawingRef.current = stroke;
    activeRef.current.set(stroke.id, stroke);
    canvas.setPointerCapture(e.pointerId);
    paintTail(stroke, 1);
    getSocket().emit('stroke:start', stroke);
  };

  const onPointerMove = (e) => {
    sendCursorThrottled(e);
    const d = drawingRef.current;
    if (!d) return;
    const p = posFromEvent(e, canvasRef.current);
    const last = d.points[d.points.length - 1];
    if (Math.hypot(p.x - last.x, p.y - last.y) < MIN_POINT_DIST) return;
    d.points.push(p);
    paintTail(d, 1);
    getSocket().emit('stroke:move', {
      id: d.id, userId: d.userId, color: d.color,
      width: d.width, tool: d.tool, points: [p],
    });
  };

  const endStroke = () => {
    const d = drawingRef.current;
    if (!d) return;
    drawingRef.current = null;
    activeRef.current.delete(d.id);
    strokesRef.current.push(d);
    getSocket().emit('stroke:end', {
      id: d.id, userId: d.userId, color: d.color,
      width: d.width, tool: d.tool, points: [],
    });
  };

  /* ---------------- toolbar actions ---------------- */

  const handleUndo = () => getSocket().emit('stroke:undo'); // server broadcast is authoritative

  const handleClear = () => {
    if (window.confirm('Clear the entire board for everyone in this room?')) {
      getSocket().emit('canvas:clear');
    }
  };

  const handleExport = () => {
    canvasRef.current.toBlob((blob) => {
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `syncboard-${roomId}.png`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
      toast('Board exported as PNG');
    }, 'image/png');
  };

  const copyInvite = async () => {
    const link = `${window.location.origin}/r/${roomId}`;
    try {
      await navigator.clipboard.writeText(link);
    } catch {
      window.prompt('Copy your invite link:', link);
    }
    toast('Invite link copied — send it to anyone');
  };

  /* ---------------- notes (local wrappers) ---------------- */

  const noteMove = (id, x, y) => {
    setNotes((prev) => prev.map((n) => (n.id === id ? { ...n, x, y } : n)));
    getSocket().emit('note:move', { id, x, y });
  };
  const noteEdit = (id, text) => {
    setNotes((prev) => prev.map((n) => (n.id === id ? { ...n, text } : n)));
    getSocket().emit('note:edit', { id, text });
  };
  const noteDelete = (id) => {
    setNotes((prev) => prev.filter((n) => n.id !== id));
    getSocket().emit('note:delete', { id });
  };

  const userById = (id) => usersRef.current.find((u) => u.userId === id);
  const notesWithAuthors = notes.map((n) => ({
    ...n,
    authorName: (userById(n.userId) || {}).name || '',
  }));

  return (
    <div className="board">
      <div className="topbar">
        <div className="brand">SyncBoard<span className="dot">.</span></div>
        <span className="room-id" title="Room ID">/r/{roomId}</span>
        <button className="icon-btn" onClick={copyInvite} title="Copy invite link">🔗 Invite</button>
        <button className="icon-btn" onClick={onNewBoard} title="Start a fresh board">＋ New</button>
        <button className="icon-btn" onClick={onExit} title="Leave this board">⏻ Leave</button>
        <div className="spacer" />
        <div className="users" title="Online now">
          {users.map((u) => (
            <span key={u.userId} className="user-chip" title={u.name}>
              <span className="udot" style={{ background: u.color }} />
              <span>{u.name}{u.userId === (me && me.userId) ? ' (you)' : ''}</span>
            </span>
          ))}
        </div>
        <div className={`status${connected ? '' : ' wait'}`} title="Round-trip latency, probed every 2s">
          <span className="sdot" />
          {connected ? (latency === null ? '···' : `${latency} ms`) : 'reconnecting…'}
        </div>
      </div>

      <div className="stage" data-tool={tool} onPointerMove={sendCursorThrottled}>
        <canvas
          ref={canvasRef}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endStroke}
          onPointerCancel={endStroke}
          onPointerLeave={endStroke}
        />
        {/* Remote cursors as DOM — no canvas repaint churn at 30Hz. */}
        {Object.entries(cursors).map(([id, c]) => {
          const u = userById(id);
          if (!u) return null;
          return (
            <div
              key={id}
              className="remote-cursor"
              style={{ transform: `translate(${c.x}px, ${c.y}px)` }}
            >
              <svg width="16" height="16" viewBox="0 0 16 16">
                <path d="M2 1 L14 8 L8.5 9 L6.5 14 Z" fill={u.color} stroke="#fff" strokeWidth="1.2" />
              </svg>
              <span className="clabel" style={{ background: u.color }}>{u.name}</span>
            </div>
          );
        })}
        <StickyNotes
          notes={notesWithAuthors}
          onMove={noteMove}
          onEdit={noteEdit}
          onDelete={noteDelete}
        />
        <Toolbar
          tool={tool} setTool={setTool}
          color={color} setColor={setColor}
          width={width} setWidth={setWidth}
          onUndo={handleUndo}
          onClear={handleClear}
          onExport={handleExport}
        />
      </div>
    </div>
  );
}

/** Paint a whole stroke (used on full redraws). */
function paintStroke(ctx, stroke) {
  const pts = stroke.points;
  if (!pts || pts.length === 0) return;
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = stroke.tool === 'eraser' ? BG : stroke.color;
  ctx.fillStyle = ctx.strokeStyle;
  ctx.lineWidth = stroke.tool === 'eraser' ? stroke.width * 3 : stroke.width;
  if (pts.length === 1) {
    ctx.beginPath();
    ctx.arc(pts[0].x, pts[0].y, ctx.lineWidth / 2, 0, Math.PI * 2);
    ctx.fill();
  } else {
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.stroke();
  }
  ctx.restore();
}
