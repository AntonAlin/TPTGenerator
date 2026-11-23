import { describe, expect, it, vi } from 'vitest';
import { listenForNexus, readHandoff } from './handoff.ts';

const msg = { type: 'nexus-holdings', version: 1, fileName: 'demo-fund-holdings-2026-10-30.csv', csv: 'Date,Portfolio,Name\n2026-10-30,Demo,Volvo B\n', meta: { portfolioName: 'Demo Fund', baseCurrency: 'SEK', valuationDate: '2026-10-30' } };

describe('reading a hand-off message', () => {
  it('takes a well-formed message', () => {
    expect(readHandoff(msg)).toEqual({ fileName: msg.fileName, csv: msg.csv, meta: msg.meta });
  });
  it.each([
    ['another type', { ...msg, type: 'other' }],
    ['another version', { ...msg, version: 2 }],
    ['no CSV', { ...msg, csv: '' }],
    ['CSV not text', { ...msg, csv: 42 }],
    ['nothing', null],
  ])('refuses %s', (_, m) => expect(readHandoff(m)).toBeUndefined());
  it('drops meta values that are not what they claim, and paths from the file name', () => {
    const h = readHandoff({ ...msg, fileName: '../../etc/passwd', meta: { portfolioName: 'X', baseCurrency: 'sek!', valuationDate: '30/10/2026' } })!;
    expect(h.fileName).toBe('..-..-etc-passwd.csv');
    expect(h.meta).toEqual({ portfolioName: 'X', baseCurrency: undefined, valuationDate: undefined });
  });
});

/** A stand-in for window: its opener, message listeners and location. */
function fakeWindow(hash: string, withOpener = true) {
  const listeners: ((e: MessageEvent) => void)[] = [];
  const opener = { postMessage: vi.fn() };
  const win = {
    location: { hash },
    opener: withOpener ? opener : null,
    addEventListener: (_: string, f: (e: MessageEvent) => void) => listeners.push(f),
    removeEventListener: (_: string, f: (e: MessageEvent) => void) => listeners.splice(listeners.indexOf(f), 1),
  };
  const send = (origin: string, data: unknown, source: unknown = opener) => [...listeners].forEach((f) => f({ origin, data, source } as unknown as MessageEvent));
  return { win: win as unknown as Window, opener, send, listeners };
}

describe('listening for Nexus', () => {
  it('says ready to Nexus only, takes the holdings once, then stops listening', () => {
    const { win, opener, send, listeners } = fakeWindow('#from-nexus');
    const got = vi.fn();
    listenForNexus(got, win);
    expect(opener.postMessage).toHaveBeenCalledWith({ type: 'tpt-ready', version: 1 }, 'https://nexus.alin.one');
    send('https://nexus.alin.one', msg);
    expect(got).toHaveBeenCalledTimes(1);
    expect(listeners).toHaveLength(0);
  });
  it('ignores other origins and other windows', () => {
    const { win, send } = fakeWindow('#from-nexus');
    const got = vi.fn();
    listenForNexus(got, win);
    send('https://evil.example', msg);
    send('https://nexus.alin.one.evil.example', msg);
    send('https://nexus.alin.one', msg, { some: 'other window' });
    expect(got).not.toHaveBeenCalled();
  });
  it('does nothing when not opened by Nexus for a hand-off', () => {
    const plain = fakeWindow('');
    listenForNexus(vi.fn(), plain.win);
    expect(plain.opener.postMessage).not.toHaveBeenCalled();
    expect(plain.listeners).toHaveLength(0);
    const noOpener = fakeWindow('#from-nexus', false);
    listenForNexus(vi.fn(), noOpener.win);
    expect(noOpener.listeners).toHaveLength(0);
  });
});
