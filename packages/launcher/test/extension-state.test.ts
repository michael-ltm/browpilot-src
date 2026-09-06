import { describe, it, expect } from 'vitest';
import { fakeEnv, prefsWithExtension } from './fake-env.js';
import { isRecordEnabled, readExtensionStatus } from '../src/extension-state.js';

const EXT = 'ocjnpcjkgdfgglcljkaaokfplcfpnmlj';
const PROFILE = '/home/ada/.config/google-chrome/Default';

function envWith(files: Record<string, string>) {
  return fakeEnv({ platform: 'linux', home: '/home/ada', files });
}

describe('isRecordEnabled', () => {
  it('treats a record with neither state nor disable_reasons as enabled', () => {
    // Chrome 151 writes exactly this for a freshly loaded unpacked extension.
    expect(isRecordEnabled({ location: 4, path: '/dist' })).toBe(true);
  });

  it('honours the legacy state int', () => {
    expect(isRecordEnabled({ state: 1 })).toBe(true);
    expect(isRecordEnabled({ state: 0 })).toBe(false);
  });

  it('honours modern disable_reasons in both list and bitmask form', () => {
    expect(isRecordEnabled({ disable_reasons: [] })).toBe(true);
    expect(isRecordEnabled({ disable_reasons: ['DISABLE_USER_ACTION'] })).toBe(false);
    expect(isRecordEnabled({ disable_reasons: 0 })).toBe(true);
    expect(isRecordEnabled({ disable_reasons: 1 })).toBe(false);
  });

  it('lets an explicit legacy state win over disable_reasons', () => {
    expect(isRecordEnabled({ state: 0, disable_reasons: [] })).toBe(false);
  });
});

describe('readExtensionStatus', () => {
  it('reports absent when no preference file mentions the id', () => {
    const env = envWith({ [`${PROFILE}/Preferences`]: JSON.stringify({ extensions: { settings: {} } }) });
    expect(readExtensionStatus(PROFILE, EXT, env)).toEqual({
      state: 'absent',
      source: null,
      location: null,
      path: null,
      disableReasons: [],
    });
  });

  it('reads an unpacked install out of plain Preferences', () => {
    const env = envWith({
      [`${PROFILE}/Preferences`]: prefsWithExtension(EXT, {
        location: 4,
        path: '/repo/extension-dist',
        disable_reasons: [],
      }),
    });
    expect(readExtensionStatus(PROFILE, EXT, env)).toEqual({
      state: 'enabled',
      source: 'Preferences',
      location: 4,
      path: '/repo/extension-dist',
      disableReasons: [],
    });
  });

  it('prefers Secure Preferences when both files carry the id', () => {
    const env = envWith({
      [`${PROFILE}/Secure Preferences`]: prefsWithExtension(EXT, { location: 1, state: 1 }),
      [`${PROFILE}/Preferences`]: prefsWithExtension(EXT, { location: 4, state: 0 }),
    });
    expect(readExtensionStatus(PROFILE, EXT, env)).toMatchObject({
      state: 'enabled',
      source: 'Secure Preferences',
      location: 1,
    });
  });

  it('reports disabled with the reasons the user sees on the extensions page', () => {
    const env = envWith({
      [`${PROFILE}/Preferences`]: prefsWithExtension(EXT, { disable_reasons: ['DISABLE_USER_ACTION'] }),
    });
    expect(readExtensionStatus(PROFILE, EXT, env)).toMatchObject({
      state: 'disabled',
      disableReasons: ['DISABLE_USER_ACTION'],
    });
  });

  it('survives an unreadable or malformed preferences file', () => {
    const env = envWith({ [`${PROFILE}/Preferences`]: '{not json' });
    expect(readExtensionStatus(PROFILE, EXT, env).state).toBe('absent');
    expect(readExtensionStatus('/nonexistent', EXT, env).state).toBe('absent');
  });
});
