import { describe, expect, it } from 'vitest';
import { statusDisplay, applyLabelInput, applyIdleDetachInput } from '../src/popup/popup';
import { IDLE_DETACH_MIN_KEY } from '../src/background/config';
import { installChromeMock } from './chromeMock';

describe('statusDisplay', () => {
  it('maps connected to a green dot', () => {
    expect(statusDisplay({ state: 'connected' })).toEqual({ color: '#22c55e', label: 'Connected' });
  });
  it('maps reconnecting to amber', () => {
    expect(statusDisplay({ state: 'reconnecting' })).toEqual({ color: '#f59e0b', label: 'Reconnecting…' });
  });
  it('maps disconnected to red', () => {
    expect(statusDisplay({ state: 'disconnected' })).toEqual({ color: '#ef4444', label: 'Disconnected' });
  });
  it('maps waiting to a calm grey', () => {
    expect(statusDisplay({ state: 'waiting' })).toEqual({ color: '#9ca3af', label: 'Waiting for an AI client…' });
  });
  it('treats missing status as waiting (not yet connected, not an error)', () => {
    expect(statusDisplay(undefined)).toEqual({ color: '#9ca3af', label: 'Waiting for an AI client…' });
  });
  it('appends detail to the label when present', () => {
    expect(statusDisplay({ state: 'reconnecting', detail: 'broker down' })).toEqual({
      color: '#f59e0b',
      label: 'Reconnecting… (broker down)',
    });
  });
});

describe('applyLabelInput', () => {
  it('writes the trimmed label to storage under LABEL_KEY', async () => {
    installChromeMock();
    await applyLabelInput('  Personal  ');
    const got = await chrome.storage.local.get('claudeBrowserLabel');
    expect(got.claudeBrowserLabel).toBe('Personal');
  });
});

describe('applyIdleDetachInput', () => {
  it('writes a non-negative integer to storage', async () => {
    installChromeMock();
    await applyIdleDetachInput('  5 ');
    const got = await chrome.storage.local.get(IDLE_DETACH_MIN_KEY);
    expect(got[IDLE_DETACH_MIN_KEY]).toBe(5);
  });

  it('writes 0 to mean disabled', async () => {
    installChromeMock();
    await applyIdleDetachInput('0');
    const got = await chrome.storage.local.get(IDLE_DETACH_MIN_KEY);
    expect(got[IDLE_DETACH_MIN_KEY]).toBe(0);
  });

  it('falls back to the 30-minute default for blank or non-numeric input', async () => {
    installChromeMock();
    await applyIdleDetachInput('abc');
    expect((await chrome.storage.local.get(IDLE_DETACH_MIN_KEY))[IDLE_DETACH_MIN_KEY]).toBe(30);
    await applyIdleDetachInput('');
    expect((await chrome.storage.local.get(IDLE_DETACH_MIN_KEY))[IDLE_DETACH_MIN_KEY]).toBe(30);
    await applyIdleDetachInput('-4');
    expect((await chrome.storage.local.get(IDLE_DETACH_MIN_KEY))[IDLE_DETACH_MIN_KEY]).toBe(30);
  });
});
