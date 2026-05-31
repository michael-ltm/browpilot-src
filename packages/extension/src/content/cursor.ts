/**
 * Animated agent cursor overlay. Injected into the page via chrome.scripting.
 * Positioned with transform translate3d for GPU-accelerated, layout-free moves.
 * Exposes window.__claudeBrowserCursor.moveTo(x, y) so the relay can drive it.
 */
declare global {
  interface Window {
    __claudeBrowserCursor?: { moveTo(x: number, y: number): void; destroy(): void };
  }
}

const CURSOR_ID = 'claude-browser-cursor';

function ensureCursor(): HTMLElement {
  const existing = document.getElementById(CURSOR_ID);
  if (existing) return existing;
  const el = document.createElement('div');
  el.id = CURSOR_ID;
  el.style.cssText = [
    'position:fixed',
    'top:0',
    'left:0',
    'width:18px',
    'height:18px',
    'margin:-9px 0 0 -9px',
    'border-radius:50%',
    'background:rgba(99,102,241,0.85)',
    'box-shadow:0 0 0 3px rgba(99,102,241,0.30)',
    'pointer-events:none',
    'z-index:2147483647',
    'transition:transform 120ms ease-out',
    'will-change:transform',
    'transform:translate3d(-100px,-100px,0)',
  ].join(';');
  document.documentElement.appendChild(el);
  return el;
}

function moveTo(x: number, y: number): void {
  const el = ensureCursor();
  el.style.transform = `translate3d(${x}px, ${y}px, 0)`;
}

function destroy(): void {
  document.getElementById(CURSOR_ID)?.remove();
  delete window.__claudeBrowserCursor;
}

window.__claudeBrowserCursor = { moveTo, destroy };
ensureCursor();

export {};
