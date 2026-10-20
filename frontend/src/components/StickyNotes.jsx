import React, { useEffect, useRef, useState } from 'react';

/**
 * Sticky notes rendered as DOM elements floating over the canvas — much
 * easier to edit text than painting text into canvas pixels. Position is in
 * board CSS pixels so it maps 1:1 onto the drawing surface.
 */
export default function StickyNotes({ notes, onMove, onEdit, onDelete }) {
  return (
    <>
      {notes.map((note) => (
        <Note
          key={note.id}
          note={note}
          onMove={onMove}
          onEdit={onEdit}
          onDelete={onDelete}
        />
      ))}
    </>
  );
}

function Note({ note, onMove, onEdit, onDelete }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(note.text);
  const drag = useRef(null);

  // Keep the draft in sync when a remote edit arrives while not editing.
  useEffect(() => {
    if (!editing) setDraft(note.text);
  }, [note.text, editing]);

  const onHeadDown = (e) => {
    if (e.target.closest('.ndel')) return;
    drag.current = {
      dx: e.clientX - note.x,
      dy: e.clientY - note.y,
      el: e.currentTarget.parentElement,
    };
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const onHeadMove = (e) => {
    if (!drag.current) return;
    const x = e.clientX - drag.current.dx;
    const y = e.clientY - drag.current.dy;
    drag.current.el.style.left = `${x}px`;
    drag.current.el.style.top = `${y}px`;
    drag.current.x = x;
    drag.current.y = y;
  };

  const onHeadUp = () => {
    if (drag.current && drag.current.x !== undefined) {
      onMove(note.id, Math.round(drag.current.x), Math.round(drag.current.y));
    }
    drag.current = null;
  };

  const commit = () => {
    setEditing(false);
    if (draft !== note.text) onEdit(note.id, draft);
  };

  return (
    <div
      className="note"
      style={{ left: note.x, top: note.y, background: note.color || '#fef08a' }}
    >
      <div
        className="nhead"
        onPointerDown={onHeadDown}
        onPointerMove={onHeadMove}
        onPointerUp={onHeadUp}
      >
        <span>drag me</span>
        <button className="ndel" title="Delete note" onClick={() => onDelete(note.id)}>✕</button>
      </div>
      {editing ? (
        <textarea
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); commit(); }
            if (e.key === 'Escape') { setDraft(note.text); setEditing(false); }
          }}
          placeholder="Type a note…"
        />
      ) : (
        <div className="nbody" onDoubleClick={() => setEditing(true)} title="Double-click to edit">
          {note.text || <i style={{ opacity: 0.5 }}>double-click to edit</i>}
        </div>
      )}
      <div className="nfoot">{note.authorName || ''}</div>
    </div>
  );
}
