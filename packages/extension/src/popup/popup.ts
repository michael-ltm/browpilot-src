import { type OnStatusParams } from '@claude-browser/shared';
import { STATUS_KEY } from '../background/transport';
import { LABEL_KEY, IDLE_DETACH_MIN_KEY, DEFAULT_IDLE_DETACH_MIN } from '../background/config';
import { getInstanceId, getLabel, resolveIdleDetachMin } from '../background/config';

export interface StatusView {
  color: string;
  label: string;
}

export function statusDisplay(status: OnStatusParams | undefined): StatusView {
  const state = status?.state ?? 'waiting';
  const base: Record<OnStatusParams['state'], StatusView> = {
    connected: { color: '#22c55e', label: 'Connected' },
    reconnecting: { color: '#f59e0b', label: 'Reconnecting…' },
    waiting: { color: '#9ca3af', label: 'Waiting for Claude Code…' },
    disconnected: { color: '#ef4444', label: 'Disconnected' },
  };
  const view = { ...base[state] };
  if (status?.detail) view.label = `${view.label} (${status.detail})`;
  return view;
}

/** Pure: persist a profile label (trimmed). */
export async function applyLabelInput(value: string): Promise<void> {
  await chrome.storage.local.set({ [LABEL_KEY]: value.trim() });
}

/** Pure: persist the idle auto-detach minutes; invalid/blank input falls back to the default. */
export async function applyIdleDetachInput(value: string): Promise<void> {
  const n = Number.parseInt(value.trim(), 10);
  const min = Number.isInteger(n) && n >= 0 ? n : DEFAULT_IDLE_DETACH_MIN;
  await chrome.storage.local.set({ [IDLE_DETACH_MIN_KEY]: min });
}

async function render(): Promise<void> {
  const versionEl = document.getElementById('version');
  if (versionEl) versionEl.textContent = `v${chrome.runtime.getManifest().version}`;

  const dot = document.getElementById('dot');
  const text = document.getElementById('label');
  if (dot && text) {
    const got = await chrome.storage.local.get(STATUS_KEY);
    const status = (got as Record<string, unknown>)[STATUS_KEY] as
      | import('@claude-browser/shared').OnStatusParams
      | undefined;
    const view = statusDisplay(status);
    dot.style.background = view.color;
    text.textContent = view.label;
  }

  const labelInput = document.getElementById('cb-label') as HTMLInputElement | null;
  if (labelInput) {
    // Prefill with the resolved name (custom > email > Profile<short>).
    labelInput.value = await getLabel(await getInstanceId());
    labelInput.addEventListener('change', () => {
      void applyLabelInput(labelInput.value);
    });
  }

  const idleInput = document.getElementById('cb-idle') as HTMLInputElement | null;
  if (idleInput) {
    idleInput.value = String(await resolveIdleDetachMin());
    idleInput.addEventListener('change', () => {
      void applyIdleDetachInput(idleInput.value);
    });
  }
}

if (typeof document !== 'undefined') {
  document.addEventListener('DOMContentLoaded', () => {
    void render();
  });
}
