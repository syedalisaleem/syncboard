import React from 'react';

export const SWATCHES = [
  '#111111', '#ef4444', '#f97316', '#eab308',
  '#22c55e', '#14b8a6', '#3b82f6', '#8b5cf6', '#ec4899',
];

/**
 * Floating toolbar: tool select, color swatches (+ custom), width slider,
 * undo, clear-all, export PNG.
 */
export default function Toolbar({
  tool, setTool,
  color, setColor,
  width, setWidth,
  onUndo, onClear, onExport,
}) {
  const isCustom = !SWATCHES.includes(color);

  return (
    <div className="toolbar" role="toolbar" aria-label="Drawing tools">
      <button
        className={`tool-btn${tool === 'pen' ? ' active' : ''}`}
        title="Pen"
        onClick={() => setTool('pen')}
      >✏️</button>
      <button
        className={`tool-btn${tool === 'eraser' ? ' active' : ''}`}
        title="Eraser"
        onClick={() => setTool('eraser')}
      >🧽</button>
      <button
        className={`tool-btn${tool === 'note' ? ' active' : ''}`}
        title="Sticky note (click the board)"
        onClick={() => setTool('note')}
      >📝</button>

      <div className="tb-sep" />

      <div className="swatches">
        {SWATCHES.map((c) => (
          <button
            key={c}
            className={`swatch${color === c ? ' active' : ''}`}
            style={{ background: c }}
            title={c}
            onClick={() => setColor(c)}
            aria-label={`color ${c}`}
          />
        ))}
        <label
          className={`swatch custom${isCustom ? ' active' : ''}`}
          title="Custom color"
          style={isCustom ? { background: color } : undefined}
        >
          <input
            type="color"
            value={color}
            onChange={(e) => setColor(e.target.value)}
          />
        </label>
      </div>

      <div className="tb-sep" />

      <label className="width-ctl" title="Stroke width">
        <span
          className="width-dot"
          style={{ width: Math.max(3, width), height: Math.max(3, width) }}
        />
        <input
          type="range"
          min="1"
          max="24"
          value={width}
          onChange={(e) => setWidth(Number(e.target.value))}
        />
      </label>

      <div className="tb-sep" />

      <button className="tool-btn" title="Undo my last stroke" onClick={onUndo}>↩️</button>
      <button className="tool-btn danger" title="Clear board for everyone" onClick={onClear}>🗑️</button>
      <button className="tool-btn" title="Export board as PNG" onClick={onExport}>📥</button>
    </div>
  );
}
