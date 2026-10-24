import { describe, it, expect } from 'vitest';
import { joinPath, samePath } from '../src/pathutil.js';

describe('joinPath', () => {
  it('uses the target platform separator, not the host one', () => {
    expect(joinPath('win32', 'C:\\Users\\ada', 'AppData', 'Local')).toBe('C:\\Users\\ada\\AppData\\Local');
    expect(joinPath('darwin', '/Users/ada', 'Library', 'Application Support')).toBe(
      '/Users/ada/Library/Application Support',
    );
  });

  it('collapses duplicate separators between segments', () => {
    expect(joinPath('linux', '/home/ada/', '/.config/', 'chromium')).toBe('/home/ada/.config/chromium');
  });

  it('keeps a root segment intact', () => {
    expect(joinPath('linux', '/', 'opt')).toBe('/opt');
  });

  it('skips empty segments', () => {
    expect(joinPath('linux', '/home', '', 'ada')).toBe('/home/ada');
  });
});

describe('samePath', () => {
  it('is case-insensitive off Linux and separator-insensitive everywhere', () => {
    expect(samePath('win32', 'C:\\Users\\Ada\\Data', 'c:/users/ada/data')).toBe(true);
    expect(samePath('darwin', '/Users/Ada/X/', '/users/ada/x')).toBe(true);
    expect(samePath('linux', '/home/Ada', '/home/ada')).toBe(false);
    expect(samePath('linux', '/home/ada/', '/home/ada')).toBe(true);
  });
});
