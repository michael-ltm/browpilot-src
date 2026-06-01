import { describe, expect, it } from 'vitest';
import { statusDisplay, applyLabelInput } from '../src/popup/popup';
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
  it('treats missing status as disconnected', () => {
    expect(statusDisplay(undefined)).toEqual({ color: '#ef4444', label: 'Disconnected' });
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
