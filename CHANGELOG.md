# Changelog

## 1.1 (2026-11-22)

**Market values for derivatives the file does not value**

- Futures are valued at 0: they are margined daily, and the template's comment on fields 22 and 24 says
  listed derivatives with daily margin calls should be close to zero.
- Forwards and swaps are valued as the difference of their two legs' notionals at the FX rates of step 3:
  the received leg minus the paid leg. Marked as a low-confidence estimate (undiscounted, no forward
  points, no accrued swap interest); a value in the file always wins.
- Four new input columns are recognised: leg 1 (bought / received) amount and currency, and leg 2
  (sold / paid) amount and currency, in English, Swedish, German and French ("Buy amount", "Säljvaluta",
  "Kaufbetrag", "Montant vendu", …). The currencies of the legs are added to the FX table of step 3.
- Options, CDS and swaps without legs still need a pricing model and stay blank.

**More fields filled by the template's own rules**, each only for the instrument types the template asks
the field for, and never over a value in the file:

- Exposure (fields 27, 28, 30) of equity, currency and commodity futures and options: quantity × contract
  size × underlying price (× delta), as the field 27 comment says; negative for a put held long.
- Treasury bills: coupon 0, coupon frequency "0", redemption "Bullet" at 100%, and yield and duration from
  price and maturity.
- Credit sensitivity (92) equal to the modified duration for fixed-rate bonds without a call date.
- Delta 1 for currency and commodity futures and FX forwards; "Cal" for bonds with a call date.
- Credit quality step 9 when the file says the instrument is not rated.
- Infrastructure (132), collateral eligibility (138) and bail-in (142) reported as "0 – not assessed".
- Counterparty sector 12 for cash and deposits with a bank.
- Share price and number of shares from the NAV and the other one.

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
