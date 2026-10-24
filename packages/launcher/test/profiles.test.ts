import { describe, it, expect } from 'vitest';
import { fakeEnv, localState } from './fake-env.js';
import { lastUsedProfile, readProfiles } from '../src/profiles.js';

const UDD = '/home/ada/.config/google-chrome';

describe('readProfiles', () => {
  it('uses the display names from Local State and puts Default first', () => {
    const env = fakeEnv({
      platform: 'linux',
      home: '/home/ada',
      files: {
        [`${UDD}/Local State`]: localState({ 'Profile 1': 'Work', Default: 'Personal' }),
        [`${UDD}/Default/Preferences`]: '{}',
        [`${UDD}/Profile 1/Preferences`]: '{}',
      },
    });
    expect(readProfiles(UDD, env)).toEqual([
      { dir: 'Default', name: 'Personal', path: `${UDD}/Default` },
      { dir: 'Profile 1', name: 'Work', path: `${UDD}/Profile 1` },
    ]);
  });

  it('follows profiles_order for the non-default profiles', () => {
    const env = fakeEnv({
      platform: 'linux',
      home: '/home/ada',
      files: {
        [`${UDD}/Local State`]: localState(
          { Default: 'Personal', 'Profile 2': 'Two', 'Profile 1': 'One' },
          { profiles_order: ['Default', 'Profile 2', 'Profile 1'] },
        ),
        [`${UDD}/Default/Preferences`]: '{}',
        [`${UDD}/Profile 1/Preferences`]: '{}',
        [`${UDD}/Profile 2/Preferences`]: '{}',
      },
    });
    expect(readProfiles(UDD, env).map((p) => p.dir)).toEqual(['Default', 'Profile 2', 'Profile 1']);
  });

  it('drops info_cache entries whose directory is gone', () => {
    const env = fakeEnv({
      platform: 'linux',
      home: '/home/ada',
      files: {
        [`${UDD}/Local State`]: localState({ Default: 'Personal', 'Profile 9': 'Deleted' }),
        [`${UDD}/Default/Preferences`]: '{}',
      },
    });
    expect(readProfiles(UDD, env).map((p) => p.dir)).toEqual(['Default']);
  });

  it('falls back to scanning the directory when Local State is unusable', () => {
    const env = fakeEnv({
      platform: 'linux',
      home: '/home/ada',
      files: {
        [`${UDD}/Local State`]: 'not json',
        [`${UDD}/Default/Preferences`]: '{}',
        [`${UDD}/Profile 3/Preferences`]: '{}',
        [`${UDD}/Crash Reports/x`]: '',
      },
    });
    expect(readProfiles(UDD, env).map((p) => p.dir)).toEqual(['Default', 'Profile 3']);
  });

  it('returns nothing for a user data dir that does not exist', () => {
    const env = fakeEnv({ platform: 'linux', home: '/home/ada' });
    expect(readProfiles(UDD, env)).toEqual([]);
  });
});

describe('lastUsedProfile', () => {
  it('reports the profile Chromium would reopen, or null', () => {
    const env = fakeEnv({
      platform: 'linux',
      home: '/home/ada',
      files: { [`${UDD}/Local State`]: localState({ Default: 'Personal' }, { last_used: 'Profile 1' }) },
    });
    expect(lastUsedProfile(UDD, env)).toBe('Profile 1');
    expect(lastUsedProfile('/gone', env)).toBeNull();
  });
});
