import { describe, it, expect } from 'vitest';
import type { ConsoleEntry } from '@browpilot/shared';
import { ConsoleBuffer } from '../src/buffer.js';

function entry(tabId: number, text: string, timestamp: number, level = 'log'): ConsoleEntry {
  return { tabId, level, text, timestamp };
}

describe('ConsoleBuffer.push + query', () => {
  it('returns all entries in chronological order when query is empty', () => {
    const buf = new ConsoleBuffer();
    buf.push(entry(1, 'a', 10));
    buf.push(entry(2, 'b', 20));
    buf.push(entry(1, 'c', 30));
    expect(buf.query({}).map((e) => e.text)).toEqual(['a', 'b', 'c']);
  });

  it('filters by tabId', () => {
    const buf = new ConsoleBuffer();
    buf.push(entry(1, 'a', 10));
    buf.push(entry(2, 'b', 20));
    buf.push(entry(1, 'c', 30));
    expect(buf.query({ tabId: 1 }).map((e) => e.text)).toEqual(['a', 'c']);
  });

  it('filters by case-insensitive substring on text', () => {
    const buf = new ConsoleBuffer();
    buf.push(entry(1, 'TypeError: boom', 10));
    buf.push(entry(1, 'just a log', 20));
    expect(buf.query({ filter: 'error' }).map((e) => e.text)).toEqual(['TypeError: boom']);
  });

  it('filters by since (strictly greater timestamp)', () => {
    const buf = new ConsoleBuffer();
    buf.push(entry(1, 'old', 10));
    buf.push(entry(1, 'edge', 20));
    buf.push(entry(1, 'new', 30));
    expect(buf.query({ since: 20 }).map((e) => e.text)).toEqual(['new']);
  });

  it('combines tabId, filter, and since', () => {
    const buf = new ConsoleBuffer();
    buf.push(entry(1, 'Error one', 10));
    buf.push(entry(2, 'Error two', 30));
    buf.push(entry(1, 'Error three', 40));
    buf.push(entry(1, 'info four', 50));
    expect(buf.query({ tabId: 1, filter: 'error', since: 20 }).map((e) => e.text)).toEqual([
      'Error three',
    ]);
  });

  it('caps the per-tab ring, evicting the oldest', () => {
    const buf = new ConsoleBuffer(3);
    for (let i = 0; i < 5; i++) buf.push(entry(1, `m${i}`, i));
    expect(buf.query({ tabId: 1 }).map((e) => e.text)).toEqual(['m2', 'm3', 'm4']);
  });

  it('caps each tab independently', () => {
    const buf = new ConsoleBuffer(2);
    buf.push(entry(1, 'a1', 1));
    buf.push(entry(2, 'b1', 2));
    buf.push(entry(1, 'a2', 3));
    buf.push(entry(1, 'a3', 4));
    expect(buf.query({ tabId: 1 }).map((e) => e.text)).toEqual(['a2', 'a3']);
    expect(buf.query({ tabId: 2 }).map((e) => e.text)).toEqual(['b1']);
  });

  it('clearTab removes only that tab', () => {
    const buf = new ConsoleBuffer();
    buf.push(entry(1, 'a', 1));
    buf.push(entry(2, 'b', 2));
    buf.clearTab(1);
    expect(buf.query({}).map((e) => e.text)).toEqual(['b']);
  });
});
