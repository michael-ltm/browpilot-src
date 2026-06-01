import { describe, it, expect, beforeEach } from 'vitest';
import { installChromeMock } from './chromeMock.js';
import { getInstanceId, getLabel, LABEL_KEY } from '../src/background/config.js';

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
