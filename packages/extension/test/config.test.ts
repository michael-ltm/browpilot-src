import { describe, it, expect, beforeEach } from 'vitest';
import { installChromeMock } from './chromeMock.js';
import {
  getInstanceId,
  getLabel,
  getProfileEmailName,
  resolveIdleDetachMin,
  IDLE_DETACH_MIN_KEY,
  DEFAULT_IDLE_DETACH_MIN,
  LABEL_KEY,
  INSTANCE_ID_KEY,
  migrateLegacyStorage,
} from '../src/background/config.js';

describe('extension profile identity', () => {
  beforeEach(() => installChromeMock());

  it('generates an instanceId once and returns it stably', async () => {
    const id1 = await getInstanceId();
    const id2 = await getInstanceId();
    expect(id1).toBe(id2);
    expect(id1.length).toBeGreaterThan(8);
  });

  it('defaults the label to "Profile <first4 of id>" and honors a stored label', async () => {
    const id = await getInstanceId();
    expect(await getLabel(id)).toBe(`Profile ${id.slice(0, 4)}`);
    await chrome.storage.local.set({ [LABEL_KEY]: 'Work' });
    expect(await getLabel(id)).toBe('Work');
  });
});

describe('profile name resolution', () => {
  it('getProfileEmailName returns the email local-part when signed in', async () => {
    const m = installChromeMock();
    m.identityEmail = 'user@example.com';
    expect(await getProfileEmailName()).toBe('franco');
  });

  it('getProfileEmailName returns null when signed out', async () => {
    installChromeMock(); // identityEmail = ''
    expect(await getProfileEmailName()).toBeNull();
  });

  it('getLabel prefers a custom label over the email', async () => {
    const m = installChromeMock();
    m.identityEmail = 'user@example.com';
    await chrome.storage.local.set({ browpilotLabel: 'Work' });
    expect(await getLabel('abcd1234')).toBe('Work');
  });

  it('getLabel falls back to the email local-part when no custom label', async () => {
    const m = installChromeMock();
    m.identityEmail = 'user@example.com';
    expect(await getLabel('abcd1234')).toBe('franco');
  });

  it('getLabel falls back to Profile <shortId> when no custom and signed out', async () => {
    installChromeMock();
    expect(await getLabel('abcd1234')).toBe('Profile abcd');
  });
});

describe('idle auto-detach setting', () => {
  beforeEach(() => installChromeMock());

  it('defaults to 30 minutes when unset', async () => {
    expect(DEFAULT_IDLE_DETACH_MIN).toBe(30);
    expect(await resolveIdleDetachMin()).toBe(30);
  });

  it('honors a stored positive integer', async () => {
    await chrome.storage.local.set({ [IDLE_DETACH_MIN_KEY]: 5 });
    expect(await resolveIdleDetachMin()).toBe(5);
  });

  it('honors 0 (disabled) as a valid stored value', async () => {
    await chrome.storage.local.set({ [IDLE_DETACH_MIN_KEY]: 0 });
    expect(await resolveIdleDetachMin()).toBe(0);
  });

  it('falls back to the default for a negative, fractional, or non-number value', async () => {
    await chrome.storage.local.set({ [IDLE_DETACH_MIN_KEY]: -3 });
    expect(await resolveIdleDetachMin()).toBe(30);
    await chrome.storage.local.set({ [IDLE_DETACH_MIN_KEY]: 1.5 });
    expect(await resolveIdleDetachMin()).toBe(30);
    await chrome.storage.local.set({ [IDLE_DETACH_MIN_KEY]: 'oops' });
    expect(await resolveIdleDetachMin()).toBe(30);
  });
});

describe('migrateLegacyStorage', () => {
  it('moves claude-browser keys to Browpilot keys so the instance id survives the rename', async () => {
    const mock = installChromeMock();
    mock.storage.claudeBrowserInstanceId = 'legacy-id';
    mock.storage.claudeBrowserLabel = 'Work';
    await migrateLegacyStorage();
    expect(mock.storage[INSTANCE_ID_KEY]).toBe('legacy-id');
    expect(mock.storage[LABEL_KEY]).toBe('Work');
    expect(mock.storage).not.toHaveProperty('claudeBrowserInstanceId');
    expect(await getInstanceId()).toBe('legacy-id');
    expect(mock.alarms.cleared).toEqual(expect.arrayContaining(['claude-browser-reconnect', 'claude-browser-keepalive']));
  });

  it('keeps a value already stored under the new key', async () => {
    const mock = installChromeMock();
    mock.storage[LABEL_KEY] = 'New';
    mock.storage.claudeBrowserLabel = 'Old';
    await migrateLegacyStorage();
    expect(mock.storage[LABEL_KEY]).toBe('New');
    expect(mock.storage).not.toHaveProperty('claudeBrowserLabel');
  });
});
