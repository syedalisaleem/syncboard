import React, { useCallback, useEffect, useState } from 'react';
import Whiteboard from './Whiteboard.jsx';
import { randomId } from './socket.js';

const NAME_KEY = 'syncboard:name';

function roomIdFromUrl() {
  const m = window.location.pathname.match(/^\/r\/([\w-]+)/);
  if (m) return m[1];
  const h = window.location.hash.match(/#\/r\/([\w-]+)/);
  return h ? h[1] : null;
}

function goToRoom(roomId) {
  window.history.pushState({}, '', roomId ? `/r/${roomId}` : '/');
  window.dispatchEvent(new PopStateEvent('popstate'));
}

export default function App() {
  const [roomId, setRoomId] = useState(() => roomIdFromUrl());
  const [name, setName] = useState(() => localStorage.getItem(NAME_KEY) || '');
  const [toast, setToast] = useState('');

  useEffect(() => {
    const onPop = () => setRoomId(roomIdFromUrl());
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const showToast = useCallback((msg) => {
    setToast(msg);
    setTimeout(() => setToast(''), 2600);
  }, []);

  const join = useCallback((displayName) => {
    const clean = displayName.trim().slice(0, 40) || 'Anonymous';
    localStorage.setItem(NAME_KEY, clean);
    setName(clean);
  }, []);

  const newBoard = useCallback(() => goToRoom(randomId('board-')), []);
  const exitBoard = useCallback(() => goToRoom(null), []);

  return (
    <>
      {!roomId && <Lobby onNew={newBoard} onJoinCode={(code) => goToRoom(code.trim())} />}
      {roomId && !name && (
        <JoinModal roomId={roomId} initialName="" onJoin={join} onBack={exitBoard} />
      )}
      {roomId && name && (
        <Whiteboard
          key={roomId}
          roomId={roomId}
          name={name}
          onExit={exitBoard}
          onNewBoard={newBoard}
          toast={showToast}
        />
      )}
      {toast && <div className="toast">{toast}</div>}
    </>
  );
}

function Lobby({ onNew, onJoinCode }) {
  const [code, setCode] = useState('');
  return (
    <div className="lobby">
      <div className="card">
        <h1>SyncBoard<span className="dot">.</span></h1>
        <p>A real-time collaborative whiteboard. Draw together, drop sticky notes, see every cursor live.</p>
        <button className="btn block" onClick={onNew}>＋ Start a new board</button>
        <div className="divider">or join with a room code</div>
        <div className="field">
          <input
            placeholder="e.g. board-x7k2q9"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && code.trim()) onJoinCode(code); }}
          />
        </div>
        <button className="btn secondary block" disabled={!code.trim()} onClick={() => onJoinCode(code)}>
          Join board
        </button>
      </div>
    </div>
  );
}

function JoinModal({ roomId, onJoin, onBack }) {
  const [draft, setDraft] = useState('');
  const submit = () => onJoin(draft);
  return (
    <div className="modal-overlay">
      <div className="card">
        <h1>Join board</h1>
        <div className="room-chip">/r/{roomId}</div>
        <p>Pick a display name — everyone in the room will see it next to your cursor.</p>
        <div className="field">
          <label htmlFor="sb-name">Display name</label>
          <input
            id="sb-name"
            autoFocus
            placeholder="e.g. Ali"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') submit(); }}
          />
        </div>
        <button className="btn block" onClick={submit}>Join board →</button>
        <div style={{ marginTop: 12 }}>
          <button className="btn secondary block" onClick={onBack}>← Back</button>
        </div>
      </div>
    </div>
  );
}
