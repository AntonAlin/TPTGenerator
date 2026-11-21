# TPT Generator

A free, static web app that turns a portfolio holdings file (xlsx, xls or csv) with unknown, inconsistent
column names into a FinDatEx **Solvency II Tripartite Template (TPT)**. It is for fund managers and
custodians, works at fund or share-class level, and does not do look-through.

There is no market data, reference data vendor or API behind it. Every TPT cell is one of the following, and
the app always shows which:

- **taken from the input file**,
- **taken from your own security master** (data you entered earlier),
- **derived** from data in the file, with the method and a confidence level, or
- **left blank and flagged**.

Live app: <https://tptgenerator.alin.one> (GitHub Pages).

## Privacy and data handling

- **Everything runs in your browser tab.** There is no backend, no analytics and no telemetry.
- **Network requests are blocked.** The production build has a Content-Security-Policy with
  `connect-src 'none'`: the browser refuses any request from the app, so portfolio data cannot be sent
  anywhere even by mistake. The browser end-to-end test checks this.
- **Uploaded files stay in memory** and are gone when you close the tab.
- **What you choose to save** (source profiles, fund profiles, the security master) is stored in your
  browser's IndexedDB on your computer only. Clearing site data deletes it, so export it regularly. Each
  store has JSON export and import, which is also how you move it to another computer or share it with
  colleagues.

## How it works

| Step | What happens |
| --- | --- |
| 1. Upload | Reads xlsx/xls/csv. Finds the header row (also two-row merged headers) and skips titles, blank rows, section headings, totals/subtotals, repeated headers and notes. Shows every skipped row with the reason. |
| 2. Map columns | Classifies each column (ISIN, name, quantity, market value, weight, …) from its header and its values. Shows a confidence and the evidence, and highlights low-confidence mappings. A confirmed mapping can be saved as a *source profile* and is reused for files from the same source. |
| 3. Fund / share class | Fund-level TPT fields (form generated from the template), share classes, valuation date, portfolio currency, FX rates, conventions. Reusable *fund profiles*. |
| 4. Security master | Every holding with every value and where it came from. You fill in or correct instrument and issuer data (LEI, NACE, CIC, rating, …). Saved for future files. |
| 5. Export | TPT as xlsx (optional *Source* sheet showing the origin of every cell) or csv, plus a completeness and data quality report. |

## Quick start

Requires Node 20+ (22 recommended).

```bash
npm install
npm run dev          # http://localhost:5173
```

| Command | Purpose |
| --- | --- |
| `npm test` | Unit, pipeline and sample end-to-end tests (Vitest) |
| `npm run e2e` | Builds, then drives the production build in headless Chromium (Playwright) |
| `npm run build` | Checks the spec JSON is up to date, type-checks, builds `dist/` |
| `npm run preview` | Serves `dist/` |
| `npm run spec:build` | Regenerates `src/spec/tpt_spec.json` from the template in `/spec` |
| `npm run samples` | Regenerates the synthetic files in `/samples` |

SheetJS is installed from the official SheetJS CDN tarball (`https://cdn.sheetjs.com/`), not from the
outdated npm registry package, so `npm install` needs access to `cdn.sheetjs.com`.

`npm run e2e` needs a Chromium for Playwright 1.63 (`npx playwright install chromium` once).

## Deploy to GitHub Pages

1. In the repository, open **Settings → Pages → Build and deployment → Source** and choose **GitHub Actions**.
   For a custom domain, enter it on the same page. `public/CNAME` is also shipped in the build.
2. Push to `main`. `.github/workflows/deploy.yml` checks the spec, runs all tests including the browser
   end-to-end test, builds, and deploys `dist/`. Pull requests are built and tested but not deployed.

The Vite `base` is relative (`./`), so the site works under any repository name or domain.

**Troubleshooting a blank page.** If the live site shows a blank page and serves files such as `/README.md`
or `/src/main.tsx`, Pages is publishing the raw repository ("Deploy from a branch") instead of the
built app. Set **Source** to **GitHub Actions** and deploy a *new* commit: Pages identifies deployments by
commit, so re-deploying a commit that was already published from a branch keeps the old files.

## Project layout

```
spec/                 Official FinDatEx template + annex, CIC and NACE sources, spec config/overrides
scripts/              build-spec.ts, extract-features.ts, make-samples.ts, e2e-browser.ts, reference data builders
training/             Synthetic data generator and model training (Python + numpy)
samples/              Synthetic messy holdings files used by the tests
src/spec/             Spec parser, generated tpt_spec.json, field validation
src/ingest/           File reading, table detection, number/date parsing, ISIN/LEI/CUSIP/SEDOL validation
src/detect/           Canonical fields, synonym dictionary, features, model.json, classifier
src/derive/           Name parsing, asset class, CIC, fixed income, valuation/FX, field resolution
src/master/           Security master (attributes, IndexedDB-backed store)
src/portfolio/        Fund/share-class data and fund profiles
src/profiles/         Source profiles and the key-value store (IndexedDB / memory)
src/export/           TPT builder, quality report, xlsx/csv writers
src/data/             Bundled reference data: ISO 3166/4217, CIC table, NACE, EEA/OECD lists
src/ui/               Preact UI
tests/                Pipeline end-to-end tests over every sample
```

## The TPT specification

All field definitions come from the official FinDatEx template in `/spec`. None are typed in by hand.

| File | Purpose |
| --- | --- |
| `spec/TPT_V8_post_consultation_261008V2.xlsx` | Official FinDatEx TPT V8.0 template: the source of truth. |
| `spec/TPT_V8_Technical_Annex.pdf` | FinDatEx technical annex (V7 → V8 changes). |
| `spec/tpt_v8.overrides.json` | The few facts not in the Excel file (exact value of field 1000, list of fields that must stay empty), each citing the annex. |
| `spec/spec.config.json` | The active template, sheet and overrides file. |
| `scripts/build-spec.ts` | Parses the template into `src/spec/tpt_spec.json`. |
| `src/spec/tpt_spec.json` | **Generated; do not edit.** The app reads only this file, through `src/spec/index.ts`. |

Per field, the JSON holds:

- id, header, name, section and export order;
- definition, codification and comment, verbatim;
- requirement level (M/C/O/I/N/A);
- applicability per CIC category, plus the NW 675, SST and IORP columns;
- whether the field changed since the previous version, and whether it must stay empty;
- a data type and any closed list read from the codification text.

The template has no data-type column. The parser applies fixed, named rules (`dataTypeRule`) and reports what it cannot
classify instead of guessing. The parser finds columns by header text (`NUM_DATA`, `CODIFICATION`,
`(CIC x)`, …), not by column letters.

Everything else in the app follows the spec, so a new version brings its changes automatically:

- the export columns and headers;
- the fund form;
- the option lists;
- validation;
- applicability per CIC category.

### Updating the TPT version

1. Put the new official template `.xlsx` (and its technical annex, if any) in `/spec`.
2. Point `spec/spec.config.json` at the new file and sheet name.
3. Create or update the overrides file from the annex, citing sources, or remove it if nothing is needed.
4. Run `npm run spec:build` and review every warning it prints.
5. Run `npm test` and `npm run e2e`, then commit the template and the regenerated JSON.

CI runs `npm run spec:check` and fails if the committed JSON does not match the template.

## Column detection

Each input column is mapped to one of 21 canonical fields (`src/detect/canonical.ts`). The classifier
combines three kinds of signal:

1. **Header signals.** Fuzzy matching against `src/detect/synonyms.json` (English, Swedish, German, French).
   Matching ignores case, accents and punctuation. **Edit this file to add header variants.** Changes take
   effect without retraining. The `ignore` list covers headers that are usually not needed (comments,
   sector, cost, P/L, …).
2. **Value signals** (`src/detect/features.ts`):
   - ISIN check digit (Luhn) and LEI check digits (ISO 17442);
   - ISO 4217, ISO 3166 and CIC codes, ratings, dates (many formats);
   - decimal comma/point, percentages, columns summing to ~100% or ~1, row numbers, text vs numbers;
   - cross-column checks: value = quantity × price, weight = value ÷ total.
3. **Model.** Multinomial logistic regression over 62 features. Weights are in `src/detect/model.json` and
   inference is a few lines of TypeScript: no ML runtime in the browser.

Each field except `ignore` goes to at most one column. Mappings below 60% confidence are highlighted, and
every mapping lists its evidence.

**Source profiles.** A confirmed mapping is saved under a fingerprint of the normalised headers. The next
file with the same headers, in any order, is mapped automatically.

### Retraining the column model

```bash
python3 -m venv training/.venv
training/.venv/bin/pip install -r training/requirements.txt
training/retrain.sh            # TABLES=4000 SEED=7 by default
npm test
```

1. `training/generate.py` creates synthetic messy tables. It varies:
   - headers: dictionary and held-out variants, four languages, typos, generic "Column 7" names;
   - number and date formats;
   - noise columns and asset mixes.
2. `scripts/extract-features.ts` computes features with **the same TypeScript code the browser uses**, so
   training and inference cannot drift apart.
3. `training/train.py` trains with numpy only and writes `src/detect/model.json` with validation metrics.

Current model (67 features, 22 classes including mixed amounts):

- 97.4% validation accuracy;
- 99.6% on the 92% of columns predicted with ≥ 60% confidence.

Most remaining confusion is between "mixed amount" and "quantity". Both go through the same cell-by-cell
interpretation, so it only changes how strongly the column mapping is trusted.

If you change the feature list you must retrain: the app refuses a model trained on a different feature set.

## Mixed amount columns

Holdings files often put different things in one column: shares for equities, nominal for bonds, the balance
for cash, the notional for FX forwards and swaps, contracts for futures. Some reports even show a forward's
notional in the market value columns. `src/derive/amounts.ts` decides, **cell by cell**, what each amount is
and moves it into the right field (quantity, nominal/notional, market value local or portfolio, or
"not used" for a duplicated figure).

1. **Row type** from the asset class:
   - units (equities, funds);
   - bonds;
   - cash;
   - listed derivatives (contracts);
   - OTC derivatives (notional).
2. **Arithmetic.** Every possible reading of the row's amount cells is scored by which identities hold:
   - quantity × price = value;
   - nominal × price ÷ 100 (+ accrued) = value;
   - local value × FX = portfolio value;
   - cash amount = value;
   - value ÷ NAV = weight (also for a value implied by a nominal or quantity reading);
   - a derivative "market value" above 25% of NAV is implausible.

   Reading a cell differently from its column mapping costs points, so the mapping holds unless the arithmetic
   clearly says otherwise. Scores become probabilities (softmax).
3. **NAV.** If you haven't entered one, NAV is estimated in two passes from rows whose value and weight are both known.
4. **Column totals.** When the file has a total row, uncertain cells are re-read if that is the only way a column's market
   values add up to the reported total. A forward's notional repeated in other value columns is dropped too.
5. **ML.** The column classifier has a class for mixed amount columns ("Holding", "Antal/Nominellt",
   "Nominal / Market value", …). It learns it from headers and from row-level features: how often the column
   multiplies with the price as units, how often as a nominal ÷ 100, how often it equals another column, and whether it mixes those behaviours.

Every re-read value keeps its source "file", with the column, the identity that decided it, the
confidence and the runner-up reading. These show in the export step (**Amounts** tab), the quality report
(**Amount interpretation** sheet) and the Source sheet. Uncertain readings are listed as warnings.

Also, a column whose numbers can't show their decimal style on their own (e.g. only `94,125`) is read with the
decimal style of the rest of the file.

## Derivations

Every value carries its source (file, master, user, derived, missing). Derived values also carry the method
and a confidence (high / medium / low). Per attribute (`src/derive/resolve.ts`):

**input file → your security master → derivation → blank**

A master value marked "override file" also beats the file.

| Module | What it does |
| --- | --- |
| `parseName.ts` | Coupon (`0.75%`, `4 1/8`, `3,5%`), maturity (`12/11/2029`, `15-NOV-32`, `02/15/31`, ISO, `PERP` → `9999-12-31`) and instrument hints from security names. Ambiguous day/month order gets low confidence and the note shows the other reading. A year alone ("FRN 2027") never becomes a date. |
| `assetClass.ts` | Asset class from the asset-type column, section headings, name keywords (ETF, fund, FRN, covered, government, futures, forwards, …), coupon/maturity, price level and ISIN prefix. Each class maps to a CIC category and sub-category. For derivatives, the sub-category comes from the underlying (e.g. FX forward → E2, index future → A1). |
| `cicDerive.ts` | CIC = listing location + category + sub-category. The location comes from the file's country column, else the ISIN prefix (both marked estimated), else XL. XT for cash, deposits and OTC derivatives; XL for non-ETF funds. Unsure sub-categories show alternatives. Also maps CIC → fields 13 and 131. |
| `fixedIncome.ts` | Coupon schedule; accrued interest (ACT/ACT ICMA, 30E/360, ACT/360, ACT/365F); yield to maturity (Newton with bisection fallback); Macaulay and modified duration. Verified against an independent implementation. |
| `valuation.ts` | Implied FX per currency (portfolio ÷ local value), portfolio-currency guess, FX table. Detects whether market values are clean or dirty (nominal × price ÷ 100 vs the file value). |
| `resolve.ts` | Applies the resolution order to every attribute. Also derives NAV (entered, else the sum of holdings, flagged), weights, cash ratio (field 9) and portfolio duration (field 10). |

Assumptions you can change in step 3:

- whether file market values include accrued interest (auto-detected per bond);
- the day count;
- the coupon frequency per currency (used only inside calculations; field 38 is filled only from your master);
- whether to estimate the issuer country from the ISIN prefix.

**Never derived:** credit quality step, NACE, issuer group, securitisation type, state guarantee, redemption
type, call dates, rating agency. These are left blank unless you enter them.

## Security master, source profiles and fund profiles

- **Security master** (`src/master/`):
  - instrument records keyed by ISIN (else identifier, else name);
  - issuer records keyed by LEI (else issuer name), so an issuer's LEI, group, country and NACE are entered
    once and apply to all its holdings;
  - "apply to all holdings of this issuer" for instrument-level values;
  - option lists come from the spec, and NACE is a searchable picklist.
- **Source profiles** remember column mappings per source.
- **Fund profiles** remember identification, management company and conventions. NAV, dates and FX rates
  change every period, so they are not saved.

## Export and quality report

`src/export/buildTpt.ts` builds one TPT per fund or per share class:

- exact column order and headers of the active spec, column names on the first line only;
- file names follow the template convention (`20260930_TPTV8_SE0000108656_20261005_Free-text`).

Formats and fixed rules:

- **xlsx:** sheet `TPT`, plus an optional `Source` sheet with each cell's origin (`file`, `master`, `user`,
  `derived (confidence) #n`) and a `Source notes` sheet with the full method for every `#n`.
- **csv:** comma or semicolon, decimal point, no thousands separators, ISO dates, UTF-8 with BOM.
- **Share classes:** holdings are shared across classes. Amounts in portfolio currency (24, 25, 28) are
  converted to each class currency. Weights are relative to the total fund NAV.
- **Field 1000** gets the exact version value. Fields FinDatEx no longer maintains are always empty.
- **Exposure (27, 28, 30)** for non-derivatives equals the market valuation including accrued interest, per
  the field definitions. FX forwards, FRAs and CDS use the notional.
- **SCR contribution fields (97–105b)** are always blank, and field 11 is `N`.

The quality report (`src/export/quality.ts`) is shown in step 5 and downloadable as xlsx. It contains:

- **Completeness per field:** % filled over the rows where the field applies (per the template's CIC
  columns), split by source (file / master / user / derived / missing).
- **Missing mandatory fields**, per holding. Portfolio fields are listed once.
- **Estimated values:** every derived value with its method and confidence.
- **Validation:**
  - every value against its spec data type and closed list (CIC, ISO codes, NACE, dates);
  - invalid ISINs, LEIs and CICs;
  - weights not summing to 100%, NAV vs sum of holdings;
  - duplicate identifiers, maturities before the valuation date.
- **Fields left blank on purpose**, with the reason.

## Reference data

| File | Content and source |
| --- | --- |
| `src/data/iso3166.json`, `iso4217.json` | ISO 3166-1 countries (249) and ISO 4217 currencies (178), generated by `scripts/build_reference_data.py` from pycountry (Debian iso-codes). The non-ISO currency codes the TPT allows (CNH, …) come from the spec. |
| `src/data/cic_table.json` | CIC table per Commission Implementing Regulation (EU) 2023/894, Annex VI: 16 categories, 115 sub-categories, XL/XT. Supplied by the project owner; not verified against the Official Journal. Tests cross-check it with the TPT spec. |
| `src/data/nace.json` | NACE Rev. 2 (21 sections, 88 divisions, 272 groups, 615 classes) in TPT field 148 format (`K6419`), built by `scripts/build_nace.py` from `spec/nace/NACE_Rev2_Sept2019.pdf`. Section U, missing from that PDF, is added as a marked supplement. Used for picking and validation only, never guessed. |
| `src/data/regions.json` | EEA and OECD members as of November 2026, for the economic-zone fields 13, 53, 74 and 87. |

## Testing

- **Unit tests** (`src/**/*.test.ts`) cover every parser, validator and derivation:
  - spec parsing, CSV/xlsx reading, number and date parsing;
  - ISIN/LEI/CUSIP/SEDOL checks, table detection, header matching and the classifier;
  - name parsing, asset class and CIC, fixed-income maths (against reference values), valuation, resolution;
  - security master, profiles, portfolio fields, field validation, export and the quality report.
- **Pipeline end-to-end tests** (`tests/e2e.test.ts`, `tests/samples.test.ts`) run every file in `/samples`
  through the whole pipeline. They read the written TPT back and check:
  - the spec headers;
  - that every value passes validation;
  - weights summing to 100%;
  - the Source sheet;
  - sample-specific results such as share-class conversion, master values and derivative exposure.
- **Browser end-to-end test** (`npm run e2e`, `scripts/e2e-browser.ts`) drives the production build in
  Chromium. It checks:
  - the workflow end to end;
  - the downloaded files;
  - persistence across a reload;
  - no page errors;
  - no requests to other origins;
  - that the Content-Security-Policy blocks network calls.

### Samples

Synthetic files generated by `npm run samples`. The data is fictional apart from a few public equity ISINs.

| File | What it exercises |
| --- | --- |
| `se_custodian_holdings.xlsx` | Swedish headers, title rows, merged two-row header, section headings, subtotals, total, notes column, footer, second sheet |
| `se_fund_admin_semicolon.csv` | Swedish, semicolon CSV, Windows-1252, decimal comma, `%` weights, unlabelled total row |
| `en_bond_portfolio.csv` | English, comma CSV, quoted thousands, text dates, blank row, total, no portfolio-currency column |
| `en_custodian_mixed_amounts.xlsx` | Mixed "Holding" column (shares, nominals, fund units, forward notional, futures contracts, cash), forward notional shown in both market value columns, total row that only adds up without it |
| `sv_nominellt_eller_varde.csv` | "Nominellt/Marknadsvärde": nominal for bonds, market value for the rest, decided by the weight column; prices with three decimal commas (`94,125`) |
| `en_multi_asset.xls` | Legacy xls, English, FX forward, index future, ETF, covered bond, CIC and LEI columns, fraction weights, subtotals, two cash currencies |
| `de_depot_statement.xlsx` | German headers, header on row 3, repeated header after a page break, accrued interest, `Summe` row |
| `fr_portefeuille.csv` | French headers, UTF-8 BOM, narrow no-break space thousands, comment column, money market fund, total |
| `generic_headers.xlsx` | Meaningless headers (`Col1`…): detection from values, user corrections |

## Limitations

The app produces a TPT from what is in the file and what you enter. It is not a substitute for reference
data or for your own review. In particular:

- **No market or reference data.** Issuer and group LEIs, management company data, NACE codes, credit
  quality steps, ratings and similar fields come only from the file or from your security master. Expect
  them to be missing on first use; the quality report lists them.
- **Estimated values are estimates.** They are always flagged and listed with their method in the report,
  and you should review them:
  - listing country in the CIC (from a country column or the ISIN prefix);
  - issuer country from the ISIN prefix;
  - asset class and CIC sub-category;
  - coupon and maturity parsed from names;
  - clean/dirty detection;
  - NAV as the sum of holdings when none is entered.
- **Bond analytics are simplified.** Yield and duration assume bullet redemption at 100, the chosen day count,
  and the coupon frequency from your master or a per-currency assumption. They are not computed for
  floating-rate notes, perpetuals, callable, sinking, inflation-linked or PIK bonds.
- **Not computed:**
  - look-through;
  - SCR contributions (fields 97–105b);
  - derivative exposure and greeks, except the notional for FX forwards, FRAs and CDS;
  - underlying-asset fields of derivatives (67–89);
  - collateral and counterparty-sector fields;
  - eligibility assessments (LTEI, legislative programmes, infrastructure, type 1 private equity).
- **Column detection is statistical.** The model is trained on synthetic files; always review the mapping,
  especially highlighted columns.
- **Reference data has an as-of date.**
  - NACE is Rev. 2. TPT V8 asks for the latest NACE version in force, which may be Rev. 2.1.
  - The CIC table was supplied and is not verified against the Official Journal.
  - EEA/OECD membership is as of November 2026.
- **Local storage only.** The security master and profiles live in one browser. There is no sync, and
  clearing browser data deletes them, so export regularly.
- **Size.** Processing runs on the page's main thread. 5,000 holdings take about 1 s to process and 2 s to
  export.
- FinDatEx does not assert copyright over the template. The names "FinDatEx" and "Financial Data Exchange"
  belong to FinDatEx, and this project is not affiliated with or endorsed by FinDatEx.
- **Not legal, regulatory or investment advice.** You remain responsible for the data you report.
