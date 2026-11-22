/**
 * Browser end-to-end test of the production build (run: `npm run e2e`).
 *
 * Drives the real app in headless Chromium through the whole workflow and checks:
 *  - upload → skipped rows → column mapping → source profile → fund form → export,
 *  - mixed amount columns re-read cell by cell (Amounts tab),
 *  - reconciliation against the file's totals, sub-totals, weights and FX (Reconciliation tab),
 *  - asset types: a file's own type text given a class, remembered (Asset types tab),
 *  - learning from corrections: a column mapped by hand maps the same way in the next file,
 *  - the "How it works" page and its live example,
 *  - downloaded TPT / quality report files are valid and have the spec layout,
 *  - IndexedDB persistence (the source profile survives a page reload),
 *  - the affiliate banner is labelled, its image is self-hosted, its link sends no referrer,
 *  - no page or console errors, no request to any other origin,
 *  - the Content-Security-Policy blocks network requests from the page.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { preview } from 'vite';
import { chromium, type Page } from 'playwright';
import * as XLSX from 'xlsx';
import spec from '../src/spec/tpt_spec.json' with { type: 'json' };

const root = resolve(import.meta.dirname, '..');
const samples = join(root, 'samples');
const downloads = mkdtempSync(join(tmpdir(), 'tpt-e2e-'));
const headers = spec.fields.map((f) => f.header);
const colOf = (id: string) => spec.fields.findIndex((f) => f.id === id);

const server = await preview({ root, preview: { port: 0, strictPort: false }, logLevel: 'silent' });
const url = server.resolvedUrls?.local[0];
if (!url) throw new Error('vite preview did not start');
const origin = new URL(url).origin;

const browser = await chromium.launch();
const context = await browser.newContext({ acceptDownloads: true, viewport: { width: 1400, height: 900 } });
const page = await context.newPage();
const errors: string[] = [];
const foreign: string[] = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => m.type() === 'error' && !m.text().includes('Content Security Policy') && errors.push(m.text()));
page.on('request', (r) => !r.url().startsWith(origin) && !r.url().startsWith('blob:') && !r.url().startsWith('data:') && foreign.push(r.url()));

async function step(name: string, fn: () => Promise<void>) {
  const t = Date.now();
  await fn();
  console.log(`  ✓ ${name} (${Date.now() - t} ms)`);
}

async function upload(p: Page, file: string) {
  await p.click('text=1. Upload holdings');
  await p.setInputFiles('input[type=file]', join(samples, file));
  await p.waitForSelector('text=holdings rows');
}

async function download(p: Page, label: string) {
  const [d] = await Promise.all([p.waitForEvent('download'), p.click(`text=${label}`)]);
  const path = join(downloads, d.suggestedFilename());
  await d.saveAs(path);
  return { name: d.suggestedFilename(), bytes: readFileSync(path) };
}

try {
  console.log(`Browser e2e against ${url}`);
  await page.goto(url);

  await step('header: logo, version 1.0, self-hosted icons', async () => {
    await page.goto(url);
    await page.waitForSelector('.brand-logo');
    assert.equal(await page.textContent('.version'), 'Version 1.0');
    const icons = await page.$$eval('link[rel~="icon"], link[rel="apple-touch-icon"]', (ls) => ls.map((l) => (l as HTMLLinkElement).href));
    assert.equal(icons.length, 2);
    for (const href of icons) {
      assert.ok(href.startsWith(origin), `icon not self-hosted: ${href}`);
      assert.equal((await page.request.get(href)).status(), 200);
    }
    assert.ok(await page.evaluate(() => (document.querySelector('.brand-logo') as HTMLImageElement).naturalWidth > 0), 'logo did not load');
  });

  await step('the published build has no source maps', async () => {
    const files = readdirSync(join(root, 'dist'), { recursive: true }).map(String);
    assert.deepEqual(files.filter((f) => f.endsWith('.map')), []);
    const js = files.filter((f) => f.endsWith('.js')).map((f) => readFileSync(join(root, 'dist', f), 'utf8'));
    assert.ok(js.length && js.every((s) => !s.includes('sourceMappingURL')));
  });

  await step('CSP blocks network requests from the page', async () => {
    const csp = await page.getAttribute('meta[http-equiv="Content-Security-Policy"]', 'content');
    assert.match(csp ?? '', /connect-src 'none'/);
    const outcome = await page.evaluate(() => fetch('https://example.com/').then(() => 'sent', () => 'blocked'));
    assert.equal(outcome, 'blocked');
  });

  await step('affiliate banner: labelled, self-hosted image, link without referrer', async () => {
    const link = page.locator('aside.promo a.promo-link');
    assert.equal(await link.getAttribute('href'), 'https://go.nordvpn.net/aff_c?offer_id=15&aff_id=160913&url_id=902');
    assert.equal(await link.getAttribute('target'), '_blank');
    assert.match((await link.getAttribute('rel')) ?? '', /\bsponsored\b.*\bnoreferrer\b/);
    assert.ok(await page.isVisible('text=Advertisement · affiliate link'));
    const img = link.locator('img');
    await img.scrollIntoViewIfNeeded();
    await page.waitForFunction(() => (document.querySelector('aside.promo img') as HTMLImageElement | null)?.complete === true);
    assert.ok(await img.evaluate((el: HTMLImageElement) => el.naturalWidth === 700 && el.currentSrc.startsWith(location.origin)));
  });

  await step('upload Swedish custodian file: header, skipped rows, preview', async () => {
    await upload(page, 'se_custodian_holdings.xlsx');
    await page.waitForSelector('text=two-row header: rows 5 + 6');
    assert.ok(await page.isVisible('text=Totals and subtotals: 3'));
    assert.ok(await page.isVisible('text=Section headings: 3'));
  });

  await step('column mapping and saving a source profile', async () => {
    await page.click('text=Continue to column mapping');
    await page.waitForSelector('table.mapping');
    assert.equal(await page.inputValue('select[aria-label="Mapping for Marknadsvärde SEK"]'), 'market_value_portfolio');
    assert.equal(await page.inputValue('select[aria-label="Mapping for Kommentar"]'), 'ignore');
    await page.click('text=Save as source profile');
    await page.waitForSelector('text=Saved source profile');
    await page.click('text=Confirm mapping');
  });

  await step('fund form with suggestions', async () => {
    await page.waitForSelector('text=Fund and share class data');
    await page.click('text=Use 2026-09-30');
    await page.click('text=Use SEK');
    await page.fill('label:has-text("1 · Portfolio identifying data") input', 'SE0000108656');
    await page.fill('label:has-text("3 · Portfolio name") input', 'Exempelfonden');
    await page.fill('label:has-text("5 · Net asset valuation") input', '50241000');
  });

  await step('export: TPT xlsx, csv and quality report', async () => {
    await page.click('text=Continue to export');
    await page.waitForSelector('text=Mandatory cells filled');
    assert.ok(await page.isVisible('text=0 errors'));
    const x = await download(page, 'Download TPT (.xlsx)');
    assert.match(x.name, /^20260930_TPTV8_SE0000108656_\d{8}_Exempelfonden\.xlsx$/);
    const wb = XLSX.read(x.bytes);
    assert.deepEqual(wb.SheetNames, ['TPT', 'Source', 'Source notes']);
    const rows = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets.TPT, { header: 1, defval: null });
    assert.deepEqual(rows[0], headers);
    assert.equal(rows.length, 8);
    // "Antal" holds the nominal for bonds: read as nominal (field 19), not quantity (field 18).
    const sgb = rows.find((r) => r[colOf('17')] === 'SWEDEN 0.75% 12/11/2029')!;
    assert.equal(sgb[colOf('19')], 10_000_000);
    assert.equal(sgb[colOf('18')], null);
    assert.equal(rows[1][colOf('1000')], spec.meta.versionFieldValue);
    const csv = await download(page, 'Download TPT (.csv)');
    assert.equal(csv.bytes.toString('utf8').replace(/^﻿/, '').split('\r\n')[0], headers.join(','));
    const q = await download(page, 'Download quality report (.xlsx)');
    assert.deepEqual(XLSX.read(q.bytes).SheetNames, ['Summary', 'Field completeness', 'Missing mandatory', 'Estimated values', 'Validation', 'Not derivable', 'Amount interpretation', 'Reconciliation']);
  });

  await step('reconciliation: totals, sub-totals, weights and FX agree with the file', async () => {
    await page.click('button[role=tab]:has-text("Reconciliation")');
    await page.waitForSelector("text=add up to the file's subtotal");
    assert.ok(await page.isVisible("text=add up to the file's total"));
    assert.ok(await page.isVisible('text=all agree'));
  });

  await step('after a reload: the source profile is remembered (IndexedDB)', async () => {
    await page.reload();
    await upload(page, 'se_custodian_holdings.xlsx');
    await page.click('text=Continue to column mapping');
    await page.waitForSelector('text=Mapping loaded from source profile');
  });

  await step('mixed amounts: forward notional shown as market value is re-read (Amounts tab)', async () => {
    await upload(page, 'en_custodian_mixed_amounts.xlsx');
    await page.click('text=Continue to column mapping');
    await page.click('text=Confirm mapping');
    await page.click('text=Use EUR');
    await page.click('text=4. Export & quality report');
    await page.click('button[role=tab]:has-text("Amounts")');
    // The forward repeats its holding figure in both value columns; the total row agrees.
    await page.waitForSelector('text=the market values add up to the reported total');
    await page.waitForSelector('td:has-text("FX FWD EUR/USD 15-DEC-2026")');
    assert.ok(await page.isVisible('text=repeats the notional'));
  });

  await step('"How it works" page: linkable, live example computed by the engine', async () => {
    await page.click('header a:has-text("How it works")');
    await page.waitForSelector('h2:has-text("How it works")');
    assert.equal(new URL(page.url()).hash, '#how-it-works');
    // The example tables are computed by the real pipeline when the page opens.
    await page.waitForSelector('td:has-text("Amount (mixed")');
    assert.ok(await page.isVisible('text=but for 12,400'));
    assert.ok(await page.isVisible('td:has-text("total row (kept for checks)")'));
    // Nexus Portfolio Lab: linked in the footer and explained on this page.
    const nexus = page.locator('footer a:has-text("Nexus Portfolio Lab")');
    assert.equal(await nexus.getAttribute('href'), 'https://nexus.alin.one/');
    assert.equal(await nexus.getAttribute('target'), '_blank');
    assert.match((await nexus.getAttribute('rel')) ?? '', /noreferrer/);
    await page.click('text=1. Upload holdings');
    await page.click('footer a:has-text("What you can do there")');
    await page.waitForSelector('#how-nexus');
    assert.ok(await page.locator('#how-nexus h3').isVisible());
    assert.ok(await page.locator('#how-nexus').evaluate((el) => { const r = el.getBoundingClientRect(); return r.top < innerHeight && r.bottom > 0; }));
    assert.equal(await page.getAttribute('#how-nexus a:has-text("Open Nexus Portfolio Lab")', 'href'), 'https://nexus.alin.one/');
    // The source is not public: no link to the repository anywhere in the app.
    assert.equal(await page.locator('a[href*="github.com"]').count(), 0);
    // Opening the address directly shows the page; leaving it clears the address.
    await page.goto(`${url}#how-it-works`);
    await page.waitForSelector('h2:has-text("How it works")');
    await page.click('text=1. Upload holdings');
    assert.equal(new URL(page.url()).hash, '');
  });

  await step('a file with two funds on six dates: pick the fund and date to convert', async () => {
    await upload(page, 'nexus_holdings_demo.csv');
    await page.waitForSelector('text=This file holds 2 portfolios on 6 dates');
    assert.equal(await page.inputValue('select[aria-label="Portfolio to convert"]'), 'Demo: Nordic Balanced Fund');
    assert.equal(await page.inputValue('select[aria-label="Date to convert"]'), '2026-10-30');
    assert.ok(await page.isVisible('text=55 holdings rows (of 406 in the file)'));
    await page.selectOption('select[aria-label="Portfolio to convert"]', 'Demo: Nordic Equity Fund');
    await page.selectOption('select[aria-label="Date to convert"]', '2026-07-31');
    await page.waitForSelector('text=13 holdings rows (of 406 in the file)');
    await page.click('text=Continue to column mapping');
    await page.waitForSelector('table.mapping');
    assert.equal(await page.inputValue('select[aria-label="Mapping for Date"]'), 'ignore');
    assert.equal(await page.inputValue('select[aria-label="Mapping for Quantity"]'), 'quantity');
    await page.click('text=Confirm mapping');
    await page.waitForSelector('text=Use “Demo: Nordic Equity Fund” as 3 · Portfolio name');
    await page.click('text=Use 2026-07-31');
    await page.click('text=Use “Demo: Nordic Equity Fund” as 3 · Portfolio name');
    assert.equal(await page.inputValue('label:has-text("3 · Portfolio name") input'), 'Demo: Nordic Equity Fund');
  });

  await step('legacy .xls multi-asset file with derivatives exports without errors', async () => {
    await upload(page, 'en_multi_asset.xls');
    await page.click('text=Continue to column mapping');
    await page.click('text=Confirm mapping');
    await page.click('text=4. Export & quality report');
    await page.waitForSelector('text=Mandatory cells filled');
    assert.ok(await page.isVisible('text=0 errors'));
  });

  await step('asset types: give a type text a class, remembered for the next file', async () => {
    await page.click('button[role=tab]:has-text("Asset types")');
    const sel = page.locator('select[aria-label^="Class for asset type"]').first();
    await sel.waitFor();
    const label = (await sel.getAttribute('aria-label'))!;
    await sel.selectOption('other');
    await page.waitForSelector('text=set by you');
    await page.reload();
    await upload(page, 'en_multi_asset.xls');
    await page.click('text=Continue to column mapping');
    await page.click('text=Confirm mapping');
    await page.click('text=4. Export & quality report');
    await page.click('button[role=tab]:has-text("Asset types")');
    assert.equal(await page.inputValue(`select[aria-label="${label}"]`), 'other');
    await page.selectOption(`select[aria-label="${label}"]`, '');
    await page.waitForSelector('text=set by you', { state: 'detached' });
  });

  await step('learning: a column mapped by hand maps the same way in the next file', async () => {
    await upload(page, 'en_multi_asset.xls');
    await page.click('text=Continue to column mapping');
    await page.waitForSelector('table.mapping');
    await page.selectOption('select[aria-label="Mapping for Rating"]', 'ignore');
    await page.click('text=Confirm mapping');
    await page.waitForSelector('text=Fund and share class data');
    await upload(page, 'en_multi_asset.xls');
    await page.click('text=Continue to column mapping');
    await page.waitForSelector('text=mapped the way you mapped the same header before');
    assert.equal(await page.inputValue('select[aria-label="Mapping for Rating"]'), 'ignore');
    // Forget it again from the profiles panel.
    await page.click('summary:has-text("learned headers")');
    await page.click('tr:has(code:text-is("rating")) button:has-text("Forget")');
    await page.waitForSelector('tr:has(code:text-is("rating"))', { state: 'detached' });
  });

  assert.deepEqual(errors, [], `page errors: ${errors.join('\n')}`);
  assert.deepEqual(foreign, [], `requests to other origins: ${foreign.join('\n')}`);
  console.log('  ✓ no page errors, no requests to other origins');
  console.log('Browser e2e passed.');
} finally {
  await browser.close();
  await server.close();
  rmSync(downloads, { recursive: true, force: true });
}
