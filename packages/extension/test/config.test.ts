import { describe, it, expect, beforeEach } from 'vitest';
import { installChromeMock } from './chromeMock.js';
import { getInstanceId, getLabel, getProfileEmailName, LABEL_KEY } from '../src/background/config.js';

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
    await chrome.storage.local.set({ claudeBrowserLabel: 'Work' });
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
