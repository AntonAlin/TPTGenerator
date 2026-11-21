/**
 * "How it works": what the app does and how it decides, for people who have to trust its output.
 * Facts such as field counts and model accuracy are read from the code and data, and the worked
 * example is computed live by the real pipeline (see howItWorksExample.ts), so the page cannot
 * describe a system that no longer exists.
 */
import { useMemo } from 'preact/hooks';
import { spec } from '../spec/index.ts';
import { LOW_CONFIDENCE, model } from '../detect/classify.ts';
import { CANONICAL_INFO } from '../detect/canonical.ts';
import synonyms from '../detect/synonyms.json';
import type { AmountRole } from '../derive/amounts.ts';
import { runExample } from './howItWorksExample.ts';
import { NEXUS_URL, REPO_URL } from './links.ts';

const pct = (x: number, digits = 1) => `${(x * 100).toFixed(digits)}%`;
const num = (v: unknown) => (typeof v === 'number' ? v.toLocaleString('en-US', { maximumFractionDigits: 3 }) : v instanceof Date ? v.toISOString().slice(0, 10) : String(v ?? ''));

const metrics = model.metrics as { validationAccuracy: number; validationHighConfidenceAccuracy: number; validationHighConfidenceShare: number; trainColumns: number; validationColumns: number };
const synonymCount = Object.entries(synonyms as Record<string, unknown>)
  .filter(([k, v]) => !k.startsWith('$') && v && typeof v === 'object')
  .reduce((n, [, v]) => n + Object.values(v as Record<string, string[]>).reduce((m, list) => m + list.length, 0), 0);
const fieldCount = model.classes.filter((c) => c !== 'ignore').length;

const ROLE_LABEL: Record<AmountRole, string> = {
  quantity: 'Quantity → field 18',
  nominal: 'Nominal / notional → field 19',
  mv_local: 'Market value, local',
  mv_port: 'Market value, portfolio ccy',
  other: 'Not a market value: dropped',
};
const KIND_LABEL: Record<string, string> = { units: 'shares or fund units', bond: 'bond', cash: 'cash', listed: 'listed derivative', otc: 'OTC derivative', unknown: 'unknown' };
const SKIP_LABEL: Record<string, string> = {
  'above-header': 'title above the table',
  'section-heading': 'section heading',
  total: 'total row (kept for checks)',
  'computed-total': 'subtotal (kept for checks)',
  blank: 'blank',
  note: 'note',
  'repeated-header': 'repeated header',
};

const SECTIONS = [
  ['how-sources', 'Where values come from'],
  ['how-table', 'Finding the table'],
  ['how-matching', 'Matching columns'],
  ['how-amounts', 'Units, nominal or value?'],
  ['how-derive', 'Deriving the rest'],
  ['how-export', 'Validation and export'],
  ['how-tested', 'How it is tested'],
  ['how-privacy', 'Privacy'],
  ['how-limits', 'Limits'],
  ['how-nexus', 'Nexus Portfolio Lab'],
] as const;

export function HowItWorks() {
  const ex = useMemo(runExample, []);
  const headerRow = ex.table.headerRows.at(-1)!;
  const skippedAt = new Map(ex.table.skipped.map((s) => [s.row, s]));
  const width = ex.table.headers.length;
  const jump = (id: string) => document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });

  return (
    <article class="stack how">
      <section class="card">
        <h2>How it works</h2>
        <p class="lead">
          TPT Generator turns a portfolio holdings file into a Solvency II Tripartite Template ({spec.meta.version}, {spec.fields.length} fields). It works with
          whatever column names, languages and number formats the file has, and everything happens in this browser tab.
        </p>
        <p>
          The template is the easy part. The hard part is working out what a custodian report means: which row is the header, which column holds the ISIN, and
          whether <code>5 000 000</code> in a holdings column is five million shares, a bond's nominal, a forward's notional or a market value. This page explains
          how the app decides, using a small example that the real engine processes as you read.
        </p>
        <ol class="flow" aria-label="Processing steps">
          <li><strong>Read</strong>xlsx, xls or csv, any number format</li>
          <li><strong>Find the table</strong>header, titles, sections, totals</li>
          <li><strong>Match columns</strong>header words, values, a trained model</li>
          <li><strong>Read amounts</strong>units, nominal, notional or value, cell by cell</li>
          <li><strong>Derive</strong>asset class, CIC, bond maths, FX, weights</li>
          <li><strong>Add fund data</strong>a form built from the template</li>
          <li><strong>Validate and export</strong>TPT, sources, quality report</li>
        </ol>
        <nav class="toc" aria-label="On this page">
          {SECTIONS.map(([id, label]) => (
            <button key={id} type="button" onClick={() => jump(id)}>
              {label}
            </button>
          ))}
        </nav>
      </section>

      <section class="card" id="how-sources">
        <h3>Every cell says where it came from</h3>
        <p>Each of the {spec.fields.length} TPT fields, for every holding, is one of four things. The app shows which in every step and in the export's Source sheet.</p>
        <ul class="sources">
          <li><span class="src src-file">F</span><span><strong>From the file.</strong> Copied from a column of your file, after the amount check described below.</span></li>
          <li><span class="src src-user">U</span><span><strong>Entered by you.</strong> Fund-level data from the fund form: identifiers, NAV, dates, the management company.</span></li>
          <li><span class="src src-derived">D</span><span><strong>Derived.</strong> Calculated from what the file contains, always with the method and a confidence (high, medium or low).</span></li>
          <li><span class="src src-missing">–</span><span><strong>Missing.</strong> Left blank and listed in the quality report with the reason.</span></li>
        </ul>
        <p>
          The app never fills a regulatory field with a plausible-looking guess. There is no market or reference data behind it, so a NACE code, credit quality step or
          issuer group comes from your file or stays blank. The SCR contribution fields are always blank.
        </p>
      </section>

      <section class="card" id="how-table">
        <h3><span class="step-num">1</span>Reading the file and finding the table</h3>
        <p>
          Holdings reports are written for people. Numbers come as <code>1 234 567,89</code>, <code>1.234.567,89</code> or <code>1,234,567.89</code>, negatives as{' '}
          <code>(1 234)</code>, percentages with or without the sign, and dates in a dozen formats or as Excel serial numbers. Each column's decimal style is
          detected from its values. A value that could go either way, like <code>94,125</code>, is read with the style of the rest of the file.
        </p>
        <p>
          The header row is the row that looks most like column labels: mostly text, unique labels, spanning the table, with rows of numbers below it. A two-row
          header such as "Market value" over "Local | SEK" is merged. Everything else that is not a holding is skipped and shown with the reason: titles above the
          table, blank rows, notes, repeated headers, section headings such as "Equities" or "Obligationer" (kept as a hint for the asset class), and totals and
          subtotals in English, Swedish, German or French, or found because a row equals the sum of the rows above it. Totals are not thrown away: they are used to
          check the market values, as explained further down.
        </p>
        <div class="example">
          <div class="example-label">Example: a Swedish custodian report, as the app reads it</div>
          <div class="table-wrap unbounded">
            <table class="grid compact sheet">
              <tbody>
                {ex.sheet.map((row, r) => {
                  const skip = skippedAt.get(r);
                  const cls = r === headerRow ? 'header-row' : skip ? 'skipped' : '';
                  return (
                    <tr key={r} class={cls}>
                      <td class="rownum">{r + 1}</td>
                      {Array.from({ length: width }, (_, c) => (
                        <td key={c} class={typeof row[c] === 'number' ? 'num' : ''}>
                          {num(row[c])}
                        </td>
                      ))}
                      <td class="why">{r === headerRow ? <span class="tag tag-header">header</span> : skip ? <span class="tag">{SKIP_LABEL[skip.reason] ?? skip.reason}</span> : null}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p class="small muted">
            Example data: names and identifiers are real, prices and amounts are made up. Look at the forward on row {ex.sheet.findIndex((r) => String(r[0]).startsWith('FX FWD')) + 1}: the custodian printed its notional in
            both value columns. The section on amounts below shows how the app finds that out.
          </p>
        </div>
      </section>

      <section class="card" id="how-matching">
        <h3><span class="step-num">2</span>Matching columns</h3>
        <p>
          Each column is matched to one of {fieldCount} kinds of input (ISIN, security name, quantity, nominal, market value, price, currency, coupon, maturity, weight
          and so on), or ignored. Three kinds of evidence go into it:
        </p>
        <ul>
          <li>
            <strong>The header.</strong> Fuzzy matching against {synonymCount.toLocaleString('en-US')} known header variants in English, Swedish, German and French,
            ignoring case, accents and punctuation, and tolerating typos and extra words ("Marknadsvärde SEK" still matches "marknadsvärde").
          </li>
          <li>
            <strong>The values.</strong> ISIN and LEI check digits, ISO currency and country codes, CIC codes, ratings, dates, percentages, a weight column that sums
            to 100%, text versus numbers.
          </li>
          <li>
            <strong>The columns together.</strong> A market value column equals quantity × price; a price column multiplies with another column to give a third; a
            weight column is each value's share of another column's total; a mixed holding column multiplies with the price as units in some rows and as a nominal
            ÷ 100 in others.
          </li>
        </ul>
        <p>
          These {model.featureNames.length} measurements go into a classifier (multinomial logistic regression) trained on {metrics.trainColumns.toLocaleString('en-US')}{' '}
          columns from synthetic messy files with held-out header spellings, typos and generic names such as "Column 7". On held-out data it gets{' '}
          {pct(metrics.validationAccuracy)} of columns right, and {pct(metrics.validationHighConfidenceAccuracy)} of those it is at least{' '}
          {pct(LOW_CONFIDENCE, 0)} sure about ({pct(metrics.validationHighConfidenceShare, 0)} of columns). The model is a table of weights evaluated in this page;
          nothing is sent anywhere.
        </p>
        <p>
          Each kind of input goes to at most one column: the most confident (column, field) pairs are assigned first. Mappings under {pct(LOW_CONFIDENCE, 0)} are
          highlighted for review, every mapping lists its evidence, and a confirmed mapping can be saved as a source profile, so the next file with the same columns
          is mapped automatically.
        </p>
        <div class="example">
          <div class="example-label">Example: the columns of the report above</div>
          <div class="table-wrap unbounded">
            <table class="grid compact">
              <thead>
                <tr>
                  <th>Column</th>
                  <th>Matched to</th>
                  <th>Confidence</th>
                  <th>Evidence</th>
                </tr>
              </thead>
              <tbody>
                {ex.predictions.map((p) => (
                  <tr key={p.index}>
                    <td>{p.header}</td>
                    <td>{CANONICAL_INFO[p.field].label}</td>
                    <td>
                      <span class="conf">
                        <span class="bar">
                          <span style={{ width: pct(p.confidence, 0) }} />
                        </span>
                        {pct(p.confidence, 0)}
                      </span>
                    </td>
                    <td class="wrap-cell">{p.reasons.slice(0, 3).join(' · ')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      <section class="card" id="how-amounts">
        <h3><span class="step-num">3</span>Units, nominal, notional or value?</h3>
        <p>
          Many reports put different things in one column: shares for equities, nominal for bonds, the balance for cash, the notional for forwards and swaps, the
          number of contracts for futures. Some print a forward's notional in the market value columns. The TPT needs each in its own field, so the app decides
          cell by cell, using arithmetic first:
        </p>
        <ul>
          <li><strong>Shares:</strong> quantity × price = market value.</li>
          <li><strong>Bonds:</strong> nominal × price ÷ 100 (plus accrued interest, if the value includes it) = market value.</li>
          <li><strong>Currencies:</strong> local value × FX rate = portfolio-currency value, with one consistent rate per currency.</li>
          <li><strong>Cash:</strong> the balance equals the market value.</li>
          <li><strong>Weights:</strong> market value ÷ NAV = the weight column, when there is one.</li>
          <li><strong>Plausibility:</strong> a derivative "market value" above 25% of the fund is not believed.</li>
        </ul>
        <p>
          Every possible reading of a row's amount cells is scored by which of these hold, plus what is typical for the row's type (an equity holds shares, a bond a
          nominal, cash a balance). Reading a cell differently from its column's mapping costs points, so the mapping stands unless the arithmetic says otherwise. The
          scores become probabilities: the best reading is used, and its confidence and the runner-up are shown in the Amounts tab of the export step.
        </p>
        <p>
          Then the whole column is checked against the report's own total row. If the market values only add up once a derivative's figure is read as something
          else, that figure was a notional. The remainder may be the derivative's real value, which the total includes but the row doesn't show, so a small gap is
          allowed. Among the re-readings that fit, the one that changes the fewest cells wins.
        </p>
        <div class="example">
          <div class="example-label">Example: how each row of the report was read</div>
          <div class="table-wrap unbounded">
            <table class="grid compact">
              <thead>
                <tr>
                  <th>Holding</th>
                  <th>Treated as</th>
                  <th>Reading</th>
                  <th>Decided by</th>
                  <th>Confidence</th>
                </tr>
              </thead>
              <tbody>
                {ex.amounts.holdings.map((h, i) => {
                  const it = ex.amounts.interpretations[i];
                  if (!it) return null;
                  return (
                    <tr key={i}>
                      <td>{h.file.security_name}</td>
                      <td>{KIND_LABEL[it.kind] ?? it.kind}</td>
                      <td class="wrap-cell">
                        {it.cells.map((c) => (
                          <div key={c.cell.col} class={c.role === 'other' ? 'dropped' : ''}>
                            <span class="muted">{c.cell.header}</span> {num(c.cell.value)}: {ROLE_LABEL[c.role]}
                          </div>
                        ))}
                      </td>
                      <td class="wrap-cell">{it.evidence[0]}</td>
                      <td class={it.confidence === 'low' ? 'conf-low' : ''}>
                        {it.confidence} ({pct(it.probability, 0)})
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {ex.amounts.notes.map((n) => (
            <p key={n} class="small">
              {n}
            </p>
          ))}
          <p class="small muted">
            On its own row, nothing gives the forward away: local value × FX = SEK value holds for 5,000,000 as well. Only the total row shows that the column adds up
            without it, so the 5,000,000 goes to field 19 as the notional and the market value fields stay empty rather than wrong.
          </p>
        </div>
      </section>

      <section class="card" id="how-derive">
        <h3><span class="step-num">4</span>Deriving what the file doesn't say</h3>
        <p>
          Where a field can be calculated from the file, it is, and marked as derived with its method. Each value is resolved in a fixed order: the file first, then
          a derivation, then blank.
        </p>
        <div class="two-col">
          <div>
            <h4>Derived, with a confidence</h4>
            <ul>
              <li>Asset class, from the asset type column, section headings, name keywords (ETF, FRN, covered, future, forward…), coupon and maturity, price level and identifier.</li>
              <li>CIC code: listing country (from a country column or the ISIN prefix, marked as estimated), category and sub-category. Derivative sub-categories follow the underlying (an FX forward is E2, an index future A1).</li>
              <li>Coupon and maturity parsed from names like <code>SWEDEN 0.75% 12/11/2029</code>; an ambiguous day/month order gets low confidence.</li>
              <li>Accrued interest, yield to maturity and duration for plain fixed-rate bonds, with the day count you choose.</li>
              <li>FX rates implied by local and portfolio values, the portfolio currency, NAV as the sum of holdings when you don't enter one, weights.</li>
              <li>Issuer country from the ISIN prefix, if you allow it (marked as estimated: the prefix is not always the issuer's country).</li>
              <li>Whether market values are clean or dirty, from nominal × price ÷ 100 against the file value.</li>
            </ul>
          </div>
          <div>
            <h4>Never guessed: from the file, or left blank</h4>
            <ul>
              <li>NACE codes, credit quality steps and ratings.</li>
              <li>Issuer and group names and identifiers.</li>
              <li>Securitisation type, state guarantee, redemption type and call dates.</li>
            </ul>
            <h4>Not computed at all</h4>
            <ul>
              <li>SCR contributions (fields 97 to 105b): always blank.</li>
              <li>Look-through, underlying-asset fields of derivatives, collateral, counterparty sector and eligibility assessments.</li>
            </ul>
          </div>
        </div>
      </section>

      <section class="card" id="how-export">
        <h3><span class="step-num">5</span>Fund data, validation and export</h3>
        <p>
          The fund form is generated from the official template, so its fields, option lists and rules change with the template version. You can work at
          fund or share-class level; source and fund profiles remember your mappings and fund details for next time.
        </p>
        <p>
          Before export every value is validated against the template: data types, closed lists, ISIN, LEI and CIC check rules, weights against 100%, NAV against the
          sum of holdings, duplicate identifiers, maturities before the valuation date. The TPT comes out as xlsx or csv in the template's exact column order, with an
          optional Source sheet giving every cell's origin and method, and a quality report listing completeness per field, missing mandatory fields, every estimated
          value and every field left blank on purpose.
        </p>
      </section>

      <section class="card" id="how-tested">
        <h3>How it is tested</h3>
        <ul>
          <li>Unit tests for every parser, check-digit rule, derivation and validation, with bond maths checked against an independent implementation.</li>
          <li>
            Random portfolios: a generator writes messy holdings files with an answer key, in four languages, xlsx or csv in local number formats, with titles,
            sections, subtotals, a mixed holding column and, sometimes, a forward whose notional is printed as its value. Every holding's fields are compared with
            the answer key on every test run.
          </li>
          <li>Sample files in the styles of custodians and fund administrators in several languages, run end to end and validated against the template.</li>
          <li>A browser test drives the built app through the whole workflow and checks that it makes no network requests.</li>
        </ul>
      </section>

      <section class="card" id="how-privacy">
        <h3>Privacy</h3>
        <p>
          Your file never leaves this tab. There is no server behind the app, no analytics and no tracking. The page's Content-Security-Policy forbids it from making
          network requests at all, so it could not send your data even by mistake. Saved source and fund profiles stay in this browser's storage. The affiliate
          banner's image is served from this site: nothing is requested from the advertiser unless you click it.{' '}
          <a href={REPO_URL} target="_blank" rel="noopener noreferrer">
            The source code is public
          </a>
          , so all of this can be checked.
        </p>
      </section>

      <section class="card" id="how-limits">
        <h3>Limits</h3>
        <ul>
          <li>It produces a TPT from what is in your file and what you enter. It is not a substitute for reference data or for your own review.</li>
          <li>Derived values are estimates. They are always marked, listed with their method, and worth checking, especially CIC sub-categories and countries.</li>
          <li>Column matching is statistical: review the mapping, especially highlighted columns.</li>
          <li>Bond analytics assume bullet bonds. Yields and durations are not computed for floating-rate, perpetual, callable, inflation-linked or similar bonds.</li>
          <li>Not legal, regulatory or investment advice. You remain responsible for the data you report.</li>
        </ul>
      </section>

      <section class="card nexus" id="how-nexus">
        <h3>Next: analyse the portfolio in Nexus Portfolio Lab</h3>
        <p>
          This app converts a holdings file into a TPT. <strong>Nexus Portfolio Lab</strong>, from the same developer, is free portfolio analytics for fund managers:
          what the portfolio is exposed to, how much risk it carries, and whether it stays within its limits. Like this app it runs in your browser with no
          accounts, and reads the same kind of holdings file (CSV or Excel). Your holdings stay in your browser and your own files or API; they are not sent to a
          server.
        </p>
        <p>What you can do there:</p>
        <ul>
          <li><strong>Exposure:</strong> market value against economic exposure including derivatives, by asset class, sector, region, country, issuer and currency before and after hedges.</li>
          <li><strong>Risk:</strong> parametric, historical and EWMA value at risk and expected shortfall, risk contributions by factor and by position, option Greeks.</li>
          <li><strong>Fixed income:</strong> yield, duration, convexity, DV01 and CS01, maturity and rating profiles.</li>
          <li><strong>Stress tests:</strong> 11 scenarios, among them 2008, the euro crisis, Covid and the 2022 rate shock, plus your own, with options fully repriced.</li>
          <li><strong>Liquidity:</strong> days to liquidate and a liquidity stress test along ESMA's guidelines, with redemption shocks and a coverage ratio.</li>
          <li><strong>Compliance:</strong> UCITS limits such as 5/10/40, issuer and counterparty limits, the fund's own investment rules, global exposure by commitment or VaR, a breach history and a control log.</li>
          <li><strong>Performance:</strong> risk and return against a benchmark, Brinson attribution, changes between two dates, and pre-trade checks of a trade before you make it.</li>
          <li>
            <strong>Reporting:</strong> a PDF report, draft PRIIPs KIDs and the FinDatEx EPT file. Nexus also reads TPT files you receive from other managers; the
            TPT for your own investors is made here.
          </li>
        </ul>
        <p class="small muted">
          One difference: Nexus downloads its chart and spreadsheet libraries and the ECB's exchange rates when it opens. Your holdings are not part of those
          requests.
        </p>
        <p>
          <a class="button-link" href={NEXUS_URL} target="_blank" rel="noopener noreferrer">
            Open Nexus Portfolio Lab ↗
          </a>
        </p>
      </section>
    </article>
  );
}
