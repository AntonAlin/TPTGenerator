# TPT Generator

A free, static web app that converts portfolio holdings files (xlsx, xls, csv) into the
FinDatEx **Solvency II Tripartite Template (TPT)**. It is intended for fund managers and custodians
and works at fund or share-class level. It does not do look-through.

**Everything runs in your browser.** There is no backend and no telemetry. The production build ships a
Content-Security-Policy with `connect-src 'none'`, so the browser itself blocks any network request
from the app.

> Status: **Phase 1** covers the scaffold, the deployment workflow and spec ingestion. Upload, column
> mapping, derivations and export are added in later phases.

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

## Static reference data

| File | Source |
| --- | --- |
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
