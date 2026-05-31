import { type OnStatusParams } from '@claude-browser/shared';
import { STATUS_KEY } from '../background/transport';

export interface StatusView {
  color: string;
  label: string;
}

export function statusDisplay(status: OnStatusParams | undefined): StatusView {
  const state = status?.state ?? 'disconnected';
  const base: Record<OnStatusParams['state'], StatusView> = {
    connected: { color: '#22c55e', label: 'Connected' },
    reconnecting: { color: '#f59e0b', label: 'Reconnecting…' },
    disconnected: { color: '#ef4444', label: 'Disconnected' },
  };
  const view = { ...base[state] };
  if (status?.detail) view.label = `${view.label} (${status.detail})`;
  return view;
}

async function render(): Promise<void> {
  const dot = document.getElementById('dot');
  const text = document.getElementById('label');
  if (!dot || !text) return;
  const got = await chrome.storage.local.get(STATUS_KEY);
  const status = (got as Record<string, unknown>)[STATUS_KEY] as OnStatusParams | undefined;
  const view = statusDisplay(status);
  dot.style.background = view.color;
  text.textContent = view.label;
}

if (typeof document !== 'undefined') {
  document.addEventListener('DOMContentLoaded', () => {
    void render();
  });
}
