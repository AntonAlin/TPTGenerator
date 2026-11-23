/**
 * Receiving a portfolio from Nexus Portfolio Lab, inside the browser.
 *
 * Nexus opens this app at #from-nexus in a new tab. This tab tells its opener it is ready, and the
 * opener posts the holdings as CSV text (postMessage between the two tabs). Nothing goes over the
 * network: the page's Content-Security-Policy still forbids every request, and postMessage is not one.
 *
 * Only a message from Nexus's own origin, sent by the very window that opened this tab, is read; any
 * other message is ignored. The protocol (same in options-lab js/handoff.js):
 *   this tab → opener: { type: 'tpt-ready', version: 1 }
 *   opener → this tab: { type: 'nexus-holdings', version: 1, fileName, csv, meta: { portfolioName?, baseCurrency?, valuationDate? } }
 */
export const NEXUS_ORIGINS = ['https://nexus.alin.one'];
export const HANDOFF_HASH = '#from-nexus';
const MAX_CSV_CHARS = 50_000_000;

export interface NexusHandoff {
  fileName: string;
  csv: string;
  meta: { portfolioName?: string; baseCurrency?: string; valuationDate?: string };
}

const text = (v: unknown, max = 200) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined);

/** Parse a message into a hand-off, or undefined if it is not a well-formed one. */
export function readHandoff(data: unknown): NexusHandoff | undefined {
  const d = data as Record<string, unknown> | null;
  if (!d || d.type !== 'nexus-holdings' || d.version !== 1 || typeof d.csv !== 'string' || !d.csv.trim() || d.csv.length > MAX_CSV_CHARS) return undefined;
  const meta = (d.meta && typeof d.meta === 'object' ? d.meta : {}) as Record<string, unknown>;
  const ccy = text(meta.baseCurrency, 3);
  const date = text(meta.valuationDate, 10);
  // A file name for display only: no path, a csv extension.
  const name = (text(d.fileName) ?? 'nexus-holdings.csv').replace(/[\\/:*?"<>|]+/g, '-');
  return {
    fileName: /\.csv$/i.test(name) ? name : `${name}.csv`,
    csv: d.csv,
    meta: {
      portfolioName: text(meta.portfolioName),
      baseCurrency: ccy && /^[A-Z]{3}$/.test(ccy) ? ccy : undefined,
      valuationDate: date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : undefined,
    },
  };
}

/**
 * When opened by Nexus at #from-nexus: say ready, wait for the holdings, hand them over once. Returns
 * a function that stops listening.
 */
export function listenForNexus(onReceive: (h: NexusHandoff) => void, win: Window = window, origins: string[] = NEXUS_ORIGINS): () => void {
  const opener = win.opener as Window | null;
  if (win.location.hash !== HANDOFF_HASH || !opener) return () => {};
  const on = (e: MessageEvent) => {
    if (!origins.includes(e.origin) || e.source !== opener) return;
    const h = readHandoff(e.data);
    if (!h) return;
    win.removeEventListener('message', on);
    onReceive(h);
  };
  win.addEventListener('message', on);
  // Addressed to Nexus's origin only: an opener from anywhere else never receives it.
  for (const o of origins) opener.postMessage({ type: 'tpt-ready', version: 1 }, o);
  return () => win.removeEventListener('message', on);
}
