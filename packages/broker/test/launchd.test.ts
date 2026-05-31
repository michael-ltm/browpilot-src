import { describe, it, expect } from 'vitest';
import { renderLaunchdPlist, LAUNCHD_LABEL } from '../src/launchd.js';

describe('renderLaunchdPlist', () => {
  const plist = renderLaunchdPlist({
    nodePath: '/usr/local/bin/node',
    scriptPath: '/Users/x/.claude-browser/broker/dist/index.js',
  });

  it('exposes the fixed label', () => {
    expect(LAUNCHD_LABEL).toBe('com.claude-browser.broker');
  });

  it('declares the label key', () => {
    expect(plist).toContain('<key>Label</key>');
    expect(plist).toContain('<string>com.claude-browser.broker</string>');
  });

  it('sets KeepAlive and RunAtLoad to true', () => {
    expect(plist).toMatch(/<key>KeepAlive<\/key>\s*<true\/>/);
    expect(plist).toMatch(/<key>RunAtLoad<\/key>\s*<true\/>/);
  });

  it('lists node then the script in ProgramArguments', () => {
    const idxNode = plist.indexOf('/usr/local/bin/node');
    const idxScript = plist.indexOf('/Users/x/.claude-browser/broker/dist/index.js');
    expect(idxNode).toBeGreaterThan(-1);
    expect(idxScript).toBeGreaterThan(idxNode);
  });

  it('is valid XML beginning with the plist DOCTYPE', () => {
    expect(plist.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    expect(plist).toContain('<!DOCTYPE plist PUBLIC');
  });

  it('honors a custom label', () => {
    const p = renderLaunchdPlist({ nodePath: 'node', scriptPath: 's.js', label: 'com.x.y' });
    expect(p).toContain('<string>com.x.y</string>');
  });
});
