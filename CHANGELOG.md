# Changelog

## 1.0 (2026-11-22)

The first release. Everything runs in the browser; no file, value or header ever leaves it.

**Reading files**

- xlsx, xls and csv in local number and date formats; titles, sections, sub-totals and totals found and
  set aside; two-row headers; repeated headers.
- Files with several portfolios and several dates: pick the portfolio and date to convert.
- Amounts in thousands or millions (TSEK, MSEK, "000s") and prices in pence or cents, recognised and
  converted, each cell saying why.

**Matching columns**

- 41 input fields: identifiers, amounts and values, prices, bond terms and analytics, ratings, issuer and
  group, NACE, and option and future terms.
- A calibrated gradient-boosted tree model over 75 features, plus relations between the columns' numbers
  (quantity × price = value, one rate per currency, shares of a total), with all columns assigned at once.
- Learns from your corrections: a column you map by hand maps the same way in the next file. Source
  profiles also fit a source's next file when its columns changed a little.

**Amounts and asset classes**

- Mixed amount columns read cell by cell: units, nominal, notional, cash balance or value, decided by the
  row's arithmetic, the row type, weights and column totals.
- Asset class from the file's type text, the name, sections and structure; a row model where those are
  unsure; and the file's own type codes once you give them a class.
- CIC codes with derivative sub-categories from the underlying.

**Checks and output**

- TPT V8 in the template's exact layout, as xlsx or csv, with a Source sheet giving every cell's origin.
- A quality report: completeness, missing mandatory fields, every estimated value, amount readings and a
  reconciliation against the file's own totals, sub-totals, NAV, weights and FX rates.

**Measured**

- A matching benchmark of twelve realistic layouts, every check at 100% on the gated seeds, and 950 random
  portfolios converted without an error.
