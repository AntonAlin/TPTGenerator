# TPT Generator

A free, static web app that converts portfolio holdings files (xlsx, xls, csv) into the
FinDatEx **Solvency II Tripartite Template (TPT)**. It is intended for fund managers and custodians
and works at fund or share-class level. It does not do look-through.

**Everything runs in your browser.** There is no backend and no telemetry. The production build ships a
Content-Security-Policy with `connect-src 'none'`, so the browser itself blocks any network request
from the app.

> Status: **Phase 2**: file upload, table detection and column mapping work. Derivations, the security
> master and export are added in later phases.

## Run locally

Requires Node 20+ (22 recommended).

```bash
npm install
npm run dev        # http://localhost:5173
npm test           # unit tests (Vitest)
npm run build      # production build into dist/
npm run preview    # serve dist/ locally
```

SheetJS is installed from the official SheetJS CDN tarball (`https://cdn.sheetjs.com/`), not from the
npm registry, so `npm install` needs access to `cdn.sheetjs.com`.

## Deploy to GitHub Pages

1. In the GitHub repo, go to **Settings → Pages → Build and deployment → Source** and select **GitHub Actions**.
2. Push to `main`. The workflow `.github/workflows/deploy.yml` checks the spec, runs the tests, builds,
   and deploys `dist/` to Pages. Pull requests are built and tested but not deployed.

The Vite `base` is relative (`./`), so the site works under any repository name.

## TPT specification

All field definitions come from the official FinDatEx template in `/spec`. None are hard-coded.

| File | Purpose |
| --- | --- |
| `spec/TPT_V8_post_consultation_261008V2.xlsx` | Official FinDatEx TPT V8.0 template. This is the source of truth. |
| `spec/TPT_V8_Technical_Annex.pdf` | FinDatEx technical annex: key changes from V7 to V8. |
| `spec/tpt_v8.overrides.json` | The few facts that are not in the Excel file (exact value for field 1000, the "no longer maintained" list). Each entry cites the annex. |
| `spec/spec.config.json` | Which template, sheet and overrides file are active. |
| `scripts/build-spec.ts` | Parses the template into `src/spec/tpt_spec.json`. |
| `src/spec/tpt_spec.json` | **Generated.** Do not edit by hand. The app reads only this file, through `src/spec/index.ts`. |

For each field, the JSON contains:

- id, header, name and section
- export order
- definition, codification and comment, verbatim from the template
- requirement level (M/C/O/I/N/A)
- applicability per CIC category, plus the NW 675, SST and IORP columns
- whether the field changed since the previous version
- whether it must be left empty
- a data type inferred from the codification text, plus any closed list found in it

The template has no data-type column, so the data type is read from the codification by fixed rules. Each field records which rule matched (`dataTypeRule`). Fields the rules cannot classify are marked `unknown`; the parser lists them as warnings rather than guessing a type.

### Updating the TPT version

1. Put the new official template `.xlsx` in `/spec`. Add the technical annex too, if there is one.
2. Edit `spec/spec.config.json` to point to the new template and sheet name.
3. Create or update the overrides file from the new annex, citing sources. Remove it if nothing is needed.
4. Run `npm run spec:build` and review every warning it prints.
5. Run `npm test`, then commit the template and the regenerated `src/spec/tpt_spec.json`.

CI runs `npm run spec:check`, which fails if the committed JSON does not match the template.

The parser finds columns by their header text (`NUM_DATA`, `DEFINITION`, `CODIFICATION`, `(CIC x)`,
etc.), not by fixed column letters, so a moderately re-arranged template still parses.

## Reading files

`src/ingest/` reads xlsx, xls and csv files in the browser. SheetJS handles Excel files; CSV uses a small
built-in parser. CSV handling:

- Detects UTF-8 (with or without BOM), UTF-16, or Windows-1252.
- Detects the delimiter: `;`, `,`, tab or `|`.

The table detector (`src/ingest/table.ts`) then:

- Finds the header row, including two-row headers built from merged cells (e.g. "Marknadsvärde" over
  "Lokal | SEK").
- Skips and reports every non-holding row, with the reason shown in the upload step:
  - titles and metadata above the table
  - blank rows
  - section headings (kept as a hint for each row)
  - totals and subtotals, in EN/SV/DE/FR
  - unlabelled total rows, detected because their numbers equal the sum of the rows above
  - repeated header rows (page breaks)
  - notes and footers
- Drops empty columns.

Numbers are parsed with decimal comma or point, thousands separators, `%`, `(1,000)` and trailing minus. Dates
are parsed from ISO, `dd/mm/yyyy`, `mm/dd/yyyy`, `dd.mm.yy`, `15-NOV-32`, month names in four languages, and
Excel date cells.

## Column detection

Each input column is mapped to a canonical field (`src/detect/canonical.ts`), such as `isin`,
`security_name`, `quantity`, `market_value_local`, `weight` or `ignore`. The mapping combines three things:

1. **Header signals.** Fuzzy matching against `src/detect/synonyms.json`, in English, Swedish, German and
   French. Matching ignores case, accents and punctuation. **Edit this file to add header variants**; changes
   take effect without retraining. The `ignore` list holds headers that are usually not needed (comments,
   sector, cost, P/L, …).
2. **Value signals** (`src/detect/features.ts`):
   - ISIN check digit (Luhn) and LEI check digits (ISO 17442 / ISO 7064)
   - ISO 4217 currency and ISO 3166 country codes; CIC codes
   - ratings and dates
   - decimal style, percentages, columns summing to ~100 or ~1, row numbers, text vs numeric
   - cross-column checks: a column equal to the product of two others (value = quantity × price), or to
     another column divided by its total (weights)
3. **Model.** Multinomial logistic regression over all 62 features. The weights are in
   `src/detect/model.json`, and inference is a few lines of TypeScript.

Each field except `ignore` is assigned to at most one column. Confidence is the model probability. Mappings below 60% are highlighted for review, and each mapping lists the evidence behind it.

### Source profiles

When you save a mapping, the app stores it in IndexedDB, keyed by a fingerprint of the normalised headers.
The next file with the same headers, in any order, is mapped automatically. Profiles can be exported and
imported as JSON from the mapping step. They stay in your browser.

### Retraining the column model

```bash
python3 -m venv training/.venv
training/.venv/bin/pip install -r training/requirements.txt
training/retrain.sh            # TABLES=4000 SEED=7 by default
npm test
```

Retraining runs three steps:

1. `training/generate.py` creates synthetic, messy holdings tables: random header variants and languages,
   typos, generic "Column 7" headers, decimal comma/point, thousands separators, many date formats,
   noise columns, and equity/bond/fund/cash mixes.
2. `scripts/extract-features.ts` computes features with the **same TypeScript code the browser uses**, so
   training and inference cannot drift apart.
3. `training/train.py` trains with numpy alone and writes `src/detect/model.json`, including
   validation metrics.

Current model: 98.1% validation accuracy. On the 93% of columns predicted with ≥60% confidence, it is 99.7%.
If you change the feature list, retrain; the app refuses to load a model trained on a different feature set.

## Samples

`samples/` contains synthetic test files, generated by `npx tsx scripts/make-samples.ts`. The data is
fictional, apart from a few well-known public equity ISINs. `tests/samples.test.ts` checks detection and
mapping on each file, and `npx tsx scripts/check-samples.ts` prints what the app detects.

| File | What it exercises |
| --- | --- |
| `se_custodian_holdings.xlsx` | Swedish headers, title rows, merged two-row header, section headings, subtotals and total, notes column, footer, second sheet |
| `en_bond_portfolio.csv` | English, comma CSV, quoted thousands, text dates (`15-Nov-2032`), blank row, total |
| `se_fund_admin_semicolon.csv` | Swedish, semicolon CSV, Windows-1252, decimal comma, `%` weights, unlabelled total row |
| `de_depot_statement.xlsx` | German headers, header on row 3, repeated header after a page break, `Summe` row |
| `generic_headers.xlsx` | Meaningless headers (`Col1`…); detection from values only |

## Static reference data

| File | Source |
| --- | --- |
| `src/data/iso3166.json`, `src/data/iso4217.json` | ISO 3166-1 countries (249) and ISO 4217 currencies (178), generated by `scripts/build_reference_data.py` from pycountry (Debian iso-codes). The non-ISO currency codes the TPT spec allows (CNH, …) come from the spec itself. |
| `src/data/cic_table.json` | CIC table per Commission Implementing Regulation (EU) 2023/894, Annex VI: 16 categories (0-9, A-F), 115 sub-categories, XL/XT listing codes. Supplied by the project owner; not yet verified against the Official Journal text. `spec/cic/cic_table_source.png` is the older table image it replaced, kept for reference. `src/data/cic.test.ts` cross-checks it against the TPT spec. |

## Limitations (summary; expanded in later phases)

- No market data and no reference data vendor. Every TPT cell is filled in one of four ways:
  - taken from the input file
  - taken from the user's own security master
  - derived, and flagged with the method used and a confidence level
  - left blank and flagged
- SCR contribution fields and other regulatory values that cannot be derived are left blank.
- FinDatEx does not assert copyright over the template. The names "FinDatEx" and "Financial Data
  Exchange" are theirs. This project is not affiliated with or endorsed by FinDatEx.
- Not legal or regulatory advice.
