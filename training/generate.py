"""
Generate synthetic, messy portfolio holdings tables for training the column classifier.

Each table is a list of columns {header, values, label}. Values mimic what the
browser sees after reading a file: numbers (as from xlsx cells), formatted
strings (decimal comma/point, thousands separators, % signs), dates as
{"$date": "YYYY-MM-DD"} objects (xlsx date cells) or strings in many formats.

Headers come partly from src/detect/synonyms.json and partly from a separate
vocabulary below plus random mutations (case, typos, abbreviations, currency
suffixes, generic "Column 7" names), so the model cannot simply memorise the
dictionary and has to learn from the values too.

Usage:  python training/generate.py --tables 4000 --seed 7 --out training/data/tables.jsonl
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import random
import string
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SYNONYMS = {k: v for k, v in json.loads((ROOT / "src/detect/synonyms.json").read_text()).items() if not k.startswith("$")}

# Extra header variants NOT in the dictionary (held out from header features).
EXTRA_HEADERS = {
    "isin": ["ISIN-Code", "Isin Nr", "ISIN_ID", "Sec ISIN", "ISIN (12)", "IsinCode"],
    "other_identifier": ["BBG Ticker", "Bloomberg Code", "Sedol Code", "Short name", "SecID", "Kod", "Instrument code", "Ticker Symbol"],
    "security_name": ["Security Long Name", "Holding Description", "Papper", "Instr. name", "Asset", "Bezeichnung des Wertpapiers", "Libellé valeur", "Namn på innehav", "Long name"],
    "quantity": ["Units held", "Shares/Units", "Pos qty", "Nb titres", "Stk.", "Number held", "Current Qty"],
    "nominal": ["Par", "Face", "Nom. amount", "Nominal (orig)", "Nominellt bel.", "Nennwert"],
    "amount_mixed": ["Holding", "Antal/Nominellt", "Nennwert/Stück", "Qty / Face", "Pos. amount", "Units or nominal", "Bestand (Stk./Nom.)", "Quantité / Nominal", "Holding (shares/nominal)", "Nominal or units"],
    "amount_mixed_nv": ["Nominal / Market value", "Nominal or value", "Nominellt/Marknadsvärde", "Nominale/Kurswert", "Nominal/Valorisation", "Face or MV", "Amount (nominal/value)"],
    "market_value_local": ["MV (Local)", "Market Val LCL", "Värde (lokal)", "Kurswert Lokalwährung", "Valo. devise", "MktVal Local", "Local MV", "Market value issue ccy"],
    "market_value_portfolio": ["MV (Base)", "Base MV", "Market Val Base", "Värde (bas)", "Kurswert FW", "Valo. EUR", "MktVal Base", "Total value base"],
    "price": ["Px Close", "Kurs (lokal)", "Unit cost price", "Price (%)", "Dirty price", "Market Px", "Cours unitaire", "Pris/st"],
    "currency": ["CCY", "Local CCY", "Cur.", "Sec CCY", "Valutakod lokal", "Währ.", "Dev."],
    "coupon": ["Coupon (%)", "Cpn Rate", "Kup.", "Zins %", "Tx coupon", "Coupon rate %"],
    "maturity_date": ["Maturity Dt", "Mat.", "Förfallodag (datum)", "Fälligk.", "Date échéance", "Final mat", "Expiry/maturity"],
    "asset_type": ["Instrument class", "Asset sub type", "Tillgångsklass", "Asset Kategorie", "Type d'actif", "Sec Type", "Product"],
    "weight": ["% NAV", "Weight (%)", "Andel av fondförm.", "Gew. %", "Poids (%)", "Pct Port", "% of TNA"],
    "rating": ["S&P", "Moody's", "Fitch", "Rating (S&P)", "Lowest rating", "Kreditbetyg (S&P)"],
    "issuer_name": ["Issuer Long Name", "Emittent namn", "Ultimate issuer", "Ticker issuer", "Emetteur"],
    "issuer_lei": ["LEI Issuer", "Issuer LEI Code", "LEI-nummer", "Emittent LEI-Code"],
    "country": ["Cntry of Risk", "Country (ISO)", "Land (emittent)", "Domicile country", "Pays risque"],
    "accrued_interest": ["Accrued Int.", "Upplupen ränta (lokal)", "Stückzinsen FW", "Int. courus", "Accrued interest local"],
    "fx_rate": ["FX", "Exch. rate", "Valutakurs (bas)", "Devisenkurs EUR", "FX rate to base", "Cours de change"],
    "cic": ["CIC Code", "Solvency CIC", "CIC (S2)", "CIC-kod"],
    "dirty_price": ["Dirty Px", "Price incl. AI", "Kurs inkl. upplupet", "Kurs inkl. Stückzinsen", "Prix coupon couru", "Full Px"],
    "yield": ["YTM %", "Yld", "Eff. ränta", "Rendite (%)", "Tx rendement", "Yield (ytm)"],
    "modified_duration": ["Mod Dur", "MDuration", "Mod. dur. (år)", "Mod. Duration (J.)", "Duration mod.", "Dur (mod)"],
    "spread": ["Margin (bp)", "Spread vs index", "Räntemarg. (bp)", "Aufschlag (BP)", "Marge (pb)", "DM (bp)"],
    "interest_rate_type": ["Fixed/Float", "Rate basis", "Räntebas (fast/rörlig)", "Zinsbasis", "Taux (fixe/var.)", "Cpn type"],
    "coupon_frequency": ["Cpn freq", "Freq.", "Kupong/år", "Zahlungen p.a.", "Fréq.", "Payment freq."],
    "call_date": ["Next Call", "Call dt", "Nästa inlösen", "Kündigung", "Date call", "First call"],
    "cqs": ["CQS (Solvency II)", "Cred. qual. step", "Kreditkval.steg", "Bonitätsstufe S2", "ECQ"],
    "rating_agency": ["Agency (rating)", "Rating src", "Ratingbolag", "Ratingagentur (Quelle)", "Agence (note)"],
    "nace": ["NACE Rev. 2", "Nace cd", "SNI 2007", "WZ 2008", "NAF code", "Sector (NACE)"],
    "group_name": ["Parent name", "Group (issuer)", "Koncernbolag", "Konzernmutter", "Groupe (émetteur)", "Ultimate parent name"],
    "group_lei": ["Parent LEI", "Group LEI code", "Koncern LEI", "Konzern LEI-Code", "LEI groupe"],
    "contract_size": ["Mult.", "Contract mult", "Kontraktsstl.", "Kontraktgr.", "Quotité contrat", "Lot"],
    "strike": ["Strike Px", "Exercise Px", "Lösenpris (kr)", "Basis", "Prix exerc.", "K"],
    "call_put": ["Put/Call flag", "Opt type", "Köp/sälj (option)", "C/P", "Type opt.", "Call-Put"],
    "exercise_type": ["Ex. style", "Exercise", "Lösen (typ)", "Ausübung (Art)", "Exercice", "Opt style"],
    "underlying_name": ["Underlying desc", "Underlier", "Underl. tillgång", "Basiswert (Name)", "Sous-jacent (nom)", "Und. name"],
    "underlying_id": ["Underlier ISIN", "Underlying ID code", "Underl. ISIN", "Basiswert ISIN-Code", "Code s-j", "Und. ticker"],
    "underlying_price": ["Spot", "Underlier Px", "Underl. kurs", "Kurs Basiswert (aktuell)", "Cours s-j", "Und. price"],
    "delta": ["Opt Delta", "Delta (adj)", "Delta (opt.)", "Delta Option", "Δ", "Option delta %"],
}

IGNORE_HEADERS = {
    "row_id": ["#", "No.", "Nr", "Row", "Line", "Rad", "Pos."],
    "portfolio_code": ["Portfolio", "Fund code", "Portfölj", "Fonds", "Account", "Konto", "Depå"],
    "notes": ["Notes", "Comment", "Kommentar", "Bemerkung", "Remarques", "Remarks"],
    "purchase_date": ["Purchase date", "Trade date", "Anskaffningsdatum", "Kaufdatum", "Date d'achat", "Settlement date"],
    "valuation_date": ["Valuation date", "As of", "Värderingsdag", "Stichtag", "Date de valorisation", "Report date"],
    "cost": ["Book cost", "Cost value", "Anskaffningsvärde", "Einstandswert", "Prix de revient", "Acquisition cost"],
    "pnl": ["Unrealised P/L", "Unrealized gain/loss", "Orealiserat resultat", "Unrealisierter G/V", "Plus/moins-value", "P&L"],
    "sector": ["Sector", "Industry", "Bransch", "Sektor", "Secteur", "GICS sector"],
    "custodian": ["Custodian", "Depository", "Förvaringsinstitut", "Verwahrstelle", "Dépositaire"],
    "beta": ["Beta", "Beta (1y)", "Beta mot index"],
    "volume": ["Avg daily volume", "ADV", "Volym/dag", "Durchschn. Volumen"],
    "riskfree": ["Risk-free rate %", "Market rate %", "Riskfri ränta", "Risikoloser Zins"],
    "impvol": ["Implied vol %", "Implied volatility", "Impl. vol", "Implizite Vola"],
    "fxlegs": ["Buy amount", "Sell amount", "Köpbelopp", "Säljbelopp"],
    "avgcost": ["Average cost per unit", "Avg cost", "Snittkurs", "Durchschnittskurs"],
    "liquidity": ["Days to liquidate", "Likvidationsdagar", "Liquidation days"],
    "change": ["% change", "1D %", "Förändring %", "Veränderung %", "Var. %"],
    "account_no": ["Account no", "Kontonummer", "Kontonr", "Account number"],
}

CURRENCIES = ["SEK"] * 6 + ["EUR"] * 6 + ["USD"] * 6 + ["NOK", "DKK", "GBP", "GBP", "CHF", "JPY", "CAD", "AUD", "HKD", "PLN"]
FX_TO = {"SEK": 1.0, "EUR": 11.2, "USD": 10.4, "NOK": 0.97, "DKK": 1.5, "GBP": 13.1, "CHF": 11.8, "JPY": 0.07, "CAD": 7.6, "AUD": 6.9, "HKD": 1.33, "PLN": 2.6}
ISIN_PREFIX = ["SE"] * 5 + ["US"] * 4 + ["DE", "FR", "GB", "LU", "LU", "IE", "IE", "FI", "NO", "DK", "NL", "XS", "XS", "CH", "JP", "CA"]
COUNTRIES = ["SE", "US", "DE", "FR", "GB", "LU", "IE", "FI", "NO", "DK", "NL", "CH", "JP", "CA", "ES", "IT", "BE", "AT"]
RATINGS = ["AAA", "AA+", "AA", "AA-", "A+", "A", "A-", "BBB+", "BBB", "BBB-", "BB+", "BB", "B", "Aaa", "Aa1", "Aa2", "A1", "A2", "Baa1", "Baa2", "Ba1", "NR"]
SYLL = ["vol", "eri", "sson", "nord", "sand", "vik", "atlas", "tel", "gen", "ax", "hex", "skan", "bo", "lia", "ver", "dal", "berg", "mark", "tor", "ika", "sca", "alfa", "lun", "ess", "kin", "ro", "max", "tri", "on", "ex"]
SUFFIX = ["AB", "AB ser. B", "Inc", "Corp", "AG", "SA", "plc", "NV", "ASA", "Oyj", "SE", "Ltd", "Group", "Holding AB", "B", "A"]
GOV = [("SE", "Sweden", "SGB"), ("DE", "Germany", "Bund"), ("FR", "France", "OAT"), ("US", "United States Treasury", "UST"), ("IT", "Italy", "BTP"), ("GB", "United Kingdom Gilt", "UKT"), ("FI", "Finland", "RFGB"), ("NO", "Norway", "NGB")]

ASSET_TYPES = {
    "equity": ["Equity", "Equities", "Aktie", "Aktier", "Common Stock", "Stock", "Action", "Aktien", "EQ", "Shares", "Listed equity"],
    "bond_gov": ["Government bond", "Statsobligation", "Bond", "Obligation", "Staatsanleihe", "Obligation d'État", "FI", "Govt", "Sovereign bond", "Fixed income"],
    "bond_corp": ["Corporate bond", "Företagsobligation", "Bond", "Unternehmensanleihe", "Obligation", "FI", "Credit", "FRN", "Covered bond", "Säkerställd obligation"],
    "fund": ["Fund", "Fond", "Fonds", "ETF", "UCITS fund", "OPCVM", "Investment fund", "Mutual fund", "Fondandelar", "CIS"],
    "cash": ["Cash", "Likvida medel", "Kassa", "Bankguthaben", "Liquidités", "Cash & equivalents", "Deposit", "MM", "Money market"],
    "derivative": ["Future", "Futures", "FX forward", "Valutatermin", "Option", "Swap", "Derivat", "Devisentermingeschäft"],
}
CIC_CAT = {"equity": ("3", "1"), "bond_gov": ("1", "1"), "bond_corp": ("2", "1"), "fund": ("4", "1"), "cash": ("7", "1"), "derivative": ("A", "1")}
SECTORS = ["Financials", "Industrials", "IT", "Health Care", "Banks", "Fastigheter", "Industri", "Finans", "Energie", "Immobilier", "Utilities", "Consumer"]
NOTES = ["Pledged as collateral", "Check price", "See prospectus", "Ny position", "Wird verkauft", "Restricted", "Illiquid - fair valued", "Corporate action pending", ""]


RATE_TYPE = {
    "fixed": ["Fixed", "Fixed", "FIX", "Fast", "Fest", "Fixe", "fixed"],
    "float": ["Floating", "Float", "FRN", "Rörlig", "Variabel", "Variable", "floating"],
}
CQS = {"AAA": 0, "AA": 1, "A": 2, "BBB": 3, "BB": 4, "B": 5, "CCC": 6, "AAA1": 0, "AA1": 1, "AA2": 1, "A1": 2, "A2": 2, "BAA": 3, "BA1": 4, "BA": 4}
FREQ_WORDS = {1: ["Annual", "annually", "årlig", "jährlich", "annuel"], 2: ["Semi-annual", "halvår", "halbjährlich", "semestriel"], 4: ["Quarterly", "kvartal", "vierteljährlich", "trimestriel"], 12: ["Monthly", "månad", "monatlich", "mensuel"]}
CP_WORDS = {"call": ["Call", "call", "C", "CALL", "Köp", "Kaufoption"], "put": ["Put", "put", "P", "PUT", "Sälj", "Verkaufsoption"]}
EX_WORDS = {"american": ["American", "AM", "Amerikansk", "amerikanisch"], "european": ["European", "EU", "Europeisk", "europäisch", "européenne"]}
NACE_SECTIONS = [("K", "64", "1", "9"), ("C", "29", "1", "0"), ("C", "21", "2", "0"), ("J", "61", "1", "0"), ("D", "35", "1", "1"), ("L", "68", "2", "0"), ("G", "47", "1", "1"), ("H", "49", "1", "0"), ("C", "26", "1", "1"), ("K", "65", "1", "2")]


def nace_code(rng: random.Random) -> str:
    s, div, grp, cls = rng.choice(NACE_SECTIONS)
    return rng.choice([f"{s}{div}.{grp}.{cls}", f"{s}{div}{grp}{cls}", f"{div}.{grp}{cls}", f"{s}{div}.{grp}", f"{div}.{grp}{cls}Z", s])


def isin_check(payload: str) -> str:
    digits = "".join(str(int(c, 36)) for c in payload)
    total = 0
    for i, ch in enumerate(reversed(digits)):
        v = int(ch)
        if i % 2 == 0:
            v *= 2
            if v > 9:
                v -= 9
        total += v
    return str((10 - total % 10) % 10)


def make_isin(rng: random.Random, prefix: str | None = None) -> str:
    p = prefix or rng.choice(ISIN_PREFIX)
    body = "".join(rng.choice(string.digits if rng.random() < 0.85 else string.ascii_uppercase + string.digits) for _ in range(9))
    return p + body + isin_check(p + body)


def make_lei(rng: random.Random) -> str:
    base = "".join(rng.choice(string.ascii_uppercase + string.digits) for _ in range(18))
    num = int("".join(str(int(c, 36)) for c in base + "00"))
    return base + f"{98 - num % 97:02d}"


def company(rng: random.Random) -> str:
    name = "".join(rng.choice(SYLL) for _ in range(rng.randint(2, 3))).capitalize()
    return f"{name} {rng.choice(SUFFIX)}" if rng.random() < 0.85 else name


class Holding:
    def __init__(self, rng: random.Random, ref: dt.date, kind: str, pccy: str):
        self.kind = kind
        self.ccy = pccy if kind == "cash" and rng.random() < 0.5 else rng.choice(CURRENCIES)
        if kind.startswith("bond") and rng.random() < 0.4:
            self.ccy = pccy
        self.fx = round(FX_TO[self.ccy] / FX_TO[pccy] * rng.uniform(0.98, 1.02), 6)
        self.country = rng.choice(COUNTRIES)
        self.isin = make_isin(rng, self.country if rng.random() < 0.6 else None) if kind != "cash" else ""
        self.lei = make_lei(rng)
        self.rating = ""
        self.coupon = None
        self.maturity = None
        self.ticker = ""
        self.issuer = company(rng)
        if kind == "equity":
            self.name = self.issuer if rng.random() < 0.7 else self.issuer.upper()
            self.qty = rng.choice([rng.randint(1, 500) * 10, rng.randint(1, 200000)])
            self.price = round(rng.choice([rng.uniform(1, 80), rng.uniform(50, 600), rng.uniform(200, 5000)]), 2)
            self.ticker = (self.issuer.split()[0][:4].upper() + rng.choice([" B", " A", " US", " SS", " GY", ""])).strip()
        elif kind.startswith("bond"):
            self.coupon = rng.choice([0, 0.125, 0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 2.25, 2.5, 3, 3.375, 3.5, 4, 4.125, 4.75, 5.5, 6.25, 7])
            self.maturity = ref + dt.timedelta(days=rng.randint(60, 30 * 365))
            if kind == "bond_gov":
                cc, country, short = rng.choice(GOV)
                self.country = cc
                self.issuer = country if rng.random() < 0.5 else f"Kingdom of {country}" if cc in ("SE", "NO") else f"Republic of {country}"
                base = short if rng.random() < 0.5 else country.upper()
            else:
                base = self.issuer.upper() if rng.random() < 0.6 else self.issuer
            self.name = bond_name(rng, base, self.coupon, self.maturity, frn=(kind == "bond_corp" and rng.random() < 0.2))
            self.qty = rng.randint(1, 500) * rng.choice([1000, 10000, 100000])
            self.price = round(rng.uniform(78, 118), rng.choice([2, 3, 4]))
            self.rating = rng.choice(RATINGS)
        elif kind == "fund":
            self.name = f"{company(rng).split()[0]} {rng.choice(['Global Equity', 'Short Bond', 'Sverige', 'Europa Index', 'Core MSCI World UCITS ETF', 'Corporate Bond Fund', 'Räntefond', 'High Yield'])} {rng.choice(['A', 'B SEK', 'I EUR Acc', 'ETF', ''])}".strip()
            self.qty = round(rng.uniform(10, 500000), rng.choice([0, 2, 3, 4]))
            self.price = round(rng.uniform(8, 600), 4)
        elif kind == "cash":
            self.name = rng.choice(["Cash", "Likvida medel", "Bank account", "Kassa", "Cash at bank", "Liquidités", "Bankguthaben", "Cash collateral"]) + f" {self.ccy}"
            self.qty = round(rng.uniform(1000, 5e7), 2)
            self.price = 1.0
        else:
            self.name = f"{rng.choice(['OMXS30', 'EURO STOXX 50', 'S&P 500', 'US 10YR NOTE', 'EUR/SEK'])} {rng.choice(['FUT', 'Future', 'FWD', 'Termin'])} {(ref + dt.timedelta(days=rng.randint(10, 300))).strftime('%b%y').upper()}"
            self.qty = rng.randint(-50, 80) or 1
            self.price = round(rng.uniform(-3, 3), 4) if rng.random() < 0.5 else round(rng.uniform(100, 5000), 2)
            self.maturity = ref + dt.timedelta(days=rng.randint(10, 300))
        factor = 0.01 if kind.startswith("bond") else 1.0
        self.mv_local = round(self.qty * self.price * factor, 2)
        self.mv_port = round(self.mv_local * self.fx, 2)
        self.accrued = round(self.qty * (self.coupon or 0) / 100 * rng.uniform(0, 1), 2) if kind.startswith("bond") else None
        # --- extra attributes (new input fields) ---
        self.dirty = self.yld = self.mdur = self.spread = self.rate_type = self.freq = self.call_date = None
        self.cqs = self.agency = self.nace = self.group = self.group_lei = None
        self.csize = self.strike = self.cp = self.exercise = self.und_name = self.und_id = self.und_px = self.delta = None
        if kind.startswith("bond"):
            frn = "FRN" in self.name
            self.dirty = round(self.price + (self.accrued or 0) / self.qty * 100, 4) if self.accrued is not None else None
            self.yld = round(rng.uniform(0, 9), 3)
            self.mdur = round(rng.uniform(0.1, 0.4), 3) if frn else round(rng.uniform(0.3, 20), 3)
            self.spread = (rng.randint(20, 600) if rng.random() < 0.7 else round(rng.uniform(0.2, 6), 2)) if frn else None
            self.rate_type = rng.choice(RATE_TYPE["float" if frn else "fixed"])
            self.freq = rng.choice([1, 1, 2, 4, 12]) if not frn else 4
            if kind == "bond_corp" and rng.random() < 0.25 and self.maturity:
                self.call_date = ref + dt.timedelta(days=rng.randint(30, max(31, (self.maturity - ref).days - 1)))
            self.cqs = CQS.get(self.rating.rstrip("+-123").upper()[:3], rng.randint(0, 6)) if self.rating else None
            self.agency = rng.choice(["S&P", "Moody's", "Fitch", "S&P", "Moody's"]) if self.rating else None
        if kind in ("equity", "bond_corp"):
            self.nace = nace_code(rng)
            if rng.random() < 0.5:
                self.group = company(rng).split()[0] + rng.choice([" Group", " Holding AB", " AG", " Groupe"])
                self.group_lei = make_lei(rng)
        if kind == "derivative":
            self.csize = rng.choice([1, 10, 25, 50, 100, 100, 1000])
            self.und_px = round(rng.uniform(20, 5000), 2)
            self.und_name = rng.choice(["OMXS30", "EURO STOXX 50", "S&P 500", "DAX", "Volvo B", "Ericsson B", "SAP SE", "Brent", "Gold", "EUR/USD"])
            self.und_id = make_isin(rng) if rng.random() < 0.5 else self.und_name.split()[0].upper()[:6]
            if rng.random() < 0.55:  # an option
                self.cp = rng.choice(["call", "put"])
                self.strike = round(self.und_px * rng.uniform(0.8, 1.2), rng.choice([0, 2]))
                self.exercise = rng.choice(["american", "european", "european"])
                self.delta = round(rng.uniform(0.05, 0.95) * (1 if self.cp == "call" else -1), 4)
                self.name = f"{self.und_name} {'Call' if self.cp == 'call' else 'Put'} {self.strike:g} {(ref + dt.timedelta(days=rng.randint(10, 400))).strftime('%b%y').upper()}"
            else:
                self.delta = 1.0 if rng.random() < 0.7 else None
        cat, sub = CIC_CAT[kind]
        if kind == "bond_corp" and rng.random() < 0.3:
            sub = rng.choice(["2", "4", "6", "8"])
        if kind == "fund":
            sub = rng.choice(list("12345"))
        self.cic = (self.country if kind in ("equity", "bond_gov", "bond_corp", "fund") and rng.random() < 0.8 else rng.choice(["XL", "XT"])) + cat + sub


def bond_name(rng, base, cpn, mat, frn=False):
    if frn:
        return f"{base} FRN {mat.year}" if rng.random() < 0.5 else f"{base} FRN {mat.strftime('%d/%m/%Y')}"
    styles = [
        lambda: f"{base} {fmt_cpn(cpn)}% {mat.strftime('%d/%m/%Y')}",
        lambda: f"{base} {fmt_cpn(cpn)} {mat.strftime('%m/%d/%y')}",
        lambda: f"{base} {frac_cpn(cpn)} {mat.strftime('%d-%b-%y').upper()}",
        lambda: f"{base} {fmt_cpn(cpn).replace('.', ',')}% {mat.year}",
        lambda: f"{base} {mat.year} {fmt_cpn(cpn)}%",
        lambda: f"{base} {fmt_cpn(cpn)}% {mat.strftime('%Y-%m-%d')}",
    ]
    return rng.choice(styles)()


def fmt_cpn(c):
    return f"{c:g}"


def frac_cpn(c):
    whole = int(c)
    rem = c - whole
    fr = {0.125: "1/8", 0.25: "1/4", 0.375: "3/8", 0.5: "1/2", 0.75: "3/4"}.get(round(rem, 3))
    return f"{whole} {fr}" if fr else f"{c:g}"


# ---------------------------------------------------------------------------
# Formatting
# ---------------------------------------------------------------------------

class Style:
    def __init__(self, rng: random.Random):
        self.raw_numbers = rng.random() < 0.45  # xlsx numeric cells
        self.decimal = rng.choice([",", ".", ".", ","])
        self.thousands = rng.choice(["", " ", " ", "." if self.decimal == "," else ",", "'"])
        self.date_fmt = rng.choice(["$date", "$date", "%Y-%m-%d", "%d/%m/%Y", "%m/%d/%Y", "%d.%m.%Y", "%Y%m%d", "%d-%b-%y", "%d %b %Y", "%d.%m.%y"])
        self.pct_sign = rng.random() < 0.35
        self.weight_fraction = rng.random() < 0.3
        self.upper_headers = rng.random() < 0.15
        self.snake_headers = rng.random() < 0.1


def fmt_num(x, style: Style, rng: random.Random, decimals=None):
    if x is None:
        return None
    if style.raw_numbers:
        return x
    d = decimals if decimals is not None else (2 if abs(x) >= 1 or x == 0 else 6)
    s = f"{abs(x):,.{d}f}"
    ip, _, fp = s.partition(".")
    ip = ip.replace(",", style.thousands)
    out = ip + (style.decimal + fp if fp else "")
    if x < 0:
        out = rng.choice(["-", "-", "("]) + out + (")" if out[0] == "(" else "")
        if out.startswith("(") and not out.endswith(")"):
            out += ")"
    return out


def fmt_date(d: dt.date | None, style: Style):
    if d is None:
        return None
    if style.date_fmt == "$date":
        return {"$date": d.isoformat()}
    return d.strftime(style.date_fmt)


def mutate_header(h: str, rng: random.Random, style: Style) -> str:
    r = rng.random()
    if r < 0.08 and len(h) > 5:  # typo
        i = rng.randrange(1, len(h) - 1)
        h = h[:i] + h[i + 1:] if rng.random() < 0.5 else h[:i] + h[i + 1] + h[i] + h[i + 2:]
    if style.upper_headers:
        h = h.upper()
    elif rng.random() < 0.3:
        h = h.title() if rng.random() < 0.5 else h.lower()
    if style.snake_headers:
        h = h.replace(" ", "_")
    return h


# Generic identifier headers over a column of ISINs mixed with internal codes for the lines
# without one (derivatives, cash): common in fund admin and portfolio system exports.
ID_HEADERS = ["Identifier", "Security identifier", "Instrument ID", "Security ID", "ID", "Sec ID", "Instrument identifier",
              "Värdepappers-ID", "Identitet", "Kennung", "Wertpapierkennung", "Identifiant", "Code valeur", "Asset ID"]


def pick_header(label: str, rng: random.Random, style: Style, pccy: str) -> str:
    r = rng.random()
    if r < 0.05:
        return rng.choice(["", f"Column {rng.randint(1, 30)}", f"Unnamed: {rng.randint(1, 30)}", f"F{rng.randint(1, 30)}"])
    if label == "isin_mixed":
        return mutate_header(rng.choice(ID_HEADERS), rng, style)
    if label == "amount_mixed_nv":
        h = rng.choice(EXTRA_HEADERS["amount_mixed_nv"])
    elif label in SYNONYMS and r < 0.62:
        lang = rng.choice(list(SYNONYMS[label].keys()))
        h = rng.choice(SYNONYMS[label][lang])
    else:
        h = rng.choice(EXTRA_HEADERS.get(label) or IGNORE_HEADERS.get(label) or ["x"])
    if label == "market_value_portfolio" and rng.random() < 0.5:
        h = f"{h} ({pccy})" if rng.random() < 0.5 else f"{h} {pccy}"
    if label in ("market_value_local", "price", "accrued_interest") and rng.random() < 0.15:
        h = f"{h} (local)"
    if label == "weight" and rng.random() < 0.3 and "%" not in h:
        h = f"{h} %"
    return mutate_header(h, rng, style)


def make_table(rng: random.Random) -> list[dict]:
    style = Style(rng)
    ref = dt.date(2018, 1, 1) + dt.timedelta(days=rng.randint(0, 12 * 365))
    pccy = rng.choice(["SEK", "SEK", "EUR", "EUR", "USD", "NOK"])
    mix = rng.choice(["equity", "bond", "mixed", "mixed", "fund"])
    weights = {
        "equity": {"equity": 10, "cash": 1, "fund": 1, "derivative": 0.3},
        "bond": {"bond_gov": 4, "bond_corp": 6, "cash": 1, "derivative": 0.3},
        "mixed": {"equity": 4, "bond_gov": 2, "bond_corp": 3, "fund": 2, "cash": 1, "derivative": 0.3},
        "fund": {"fund": 8, "cash": 1, "equity": 1},
    }[mix]
    n = rng.choice([rng.randint(3, 15), rng.randint(10, 60), rng.randint(40, 150)])
    kinds = rng.choices(list(weights), weights=list(weights.values()), k=n)
    hs = [Holding(rng, ref, k, pccy) for k in kinds]
    total = sum(h.mv_port for h in hs) or 1.0

    lang_types = rng.random()
    def asset_type(h):
        opts = ASSET_TYPES[h.kind]
        return opts[int(lang_types * len(opts)) % len(opts)] if rng.random() < 0.8 else rng.choice(opts)

    blank_cash_px = rng.random() < 0.5
    gens = {
        "isin": lambda: [h.isin or None for h in hs],
        "isin_mixed": lambda: [h.isin or h.ticker or rng.choice([f"{h.kind[:3].upper()}-{rng.randint(1000, 9999)}", str(rng.randint(100000, 999999)), f"{h.ccy} CASH", None]) for h in hs],
        "other_identifier": lambda: [h.ticker or (f"SEC{rng.randint(1000, 999999)}" if rng.random() < 0.5 else None) for h in hs],
        "security_name": lambda: [h.name for h in hs],
        "quantity": lambda: [fmt_num(h.qty, style, rng, 0 if float(h.qty).is_integer() else 4) for h in hs],
        "nominal": lambda: [fmt_num(h.qty, style, rng, 0) if h.kind.startswith("bond") else None for h in hs],
        "market_value_local": lambda: [fmt_num(h.mv_local, style, rng) for h in hs],
        "market_value_portfolio": lambda: [fmt_num(h.mv_port, style, rng) for h in hs],
        # Real files often leave the price of a cash line or a derivative blank.
        "price": lambda: [None if (h.kind == "cash" and blank_cash_px) or (h.kind == "derivative" and rng.random() < 0.25) else fmt_num(h.price, style, rng, 4 if h.kind.startswith("bond") else 2) for h in hs],
        "currency": lambda: [h.ccy if rng.random() < 0.97 else h.ccy.lower() for h in hs],
        "coupon": lambda: [pct_str(fmt_num(h.coupon, style, rng, 3), style) if h.coupon is not None else None for h in hs],
        "maturity_date": lambda: [fmt_date(h.maturity, style) for h in hs],
        "asset_type": lambda: [asset_type(h) for h in hs],
        "weight": lambda: [weight_val(h.mv_port / total, style, rng) for h in hs],
        "rating": lambda: [h.rating or (rng.choice(["NR", None, None]) if h.kind != "cash" else None) for h in hs],
        "issuer_name": lambda: [h.issuer if h.kind != "cash" else rng.choice([None, "Custodian Bank"]) for h in hs],
        "issuer_lei": lambda: [h.lei if h.kind != "cash" and rng.random() < 0.9 else None for h in hs],
        "country": lambda: [h.country for h in hs],
        "accrued_interest": lambda: [fmt_num(h.accrued, style, rng) if h.accrued is not None else (fmt_num(0.0, style, rng) if rng.random() < 0.3 else None) for h in hs],
        "fx_rate": lambda: [fmt_num(h.fx, style, rng, 6) for h in hs],
        "cic": lambda: [h.cic for h in hs],
        "amount_mixed": lambda: [fmt_num(h.qty, style, rng, 0 if float(h.qty).is_integer() else 4) for h in hs],
        "amount_mixed_nv": lambda: [fmt_num(h.qty, style, rng, 0) if h.kind.startswith("bond") else fmt_num(h.mv_local, style, rng) for h in hs],
        "dirty_price": lambda: [fmt_num(h.dirty, style, rng, 4) if h.dirty is not None else None for h in hs],
        "yield": lambda: [pct_str(fmt_num(h.yld, style, rng, 3), style) if h.yld is not None else None for h in hs],
        "modified_duration": lambda: [fmt_num(h.mdur, style, rng, 3) if h.mdur is not None else None for h in hs],
        "spread": lambda: [fmt_num(h.spread, style, rng, 0 if isinstance(h.spread, int) else 2) if h.spread is not None else None for h in hs],
        "interest_rate_type": lambda: [h.rate_type for h in hs],
        "coupon_frequency": lambda: freq_values(hs, rng, style),
        "call_date": lambda: [fmt_date(h.call_date, style) for h in hs],
        "cqs": lambda: [(h.cqs if style.raw_numbers else str(h.cqs)) if h.cqs is not None else None for h in hs],
        "rating_agency": lambda: [h.agency for h in hs],
        "nace": lambda: [h.nace for h in hs],
        "group_name": lambda: [h.group for h in hs],
        "group_lei": lambda: [h.group_lei for h in hs],
        "contract_size": lambda: [fmt_num(h.csize, style, rng, 0) if h.csize is not None else None for h in hs],
        "strike": lambda: [fmt_num(h.strike, style, rng, 2) if h.strike is not None else None for h in hs],
        "call_put": lambda: [rng.choice(CP_WORDS[h.cp]) if h.cp else None for h in hs],
        "exercise_type": lambda: [rng.choice(EX_WORDS[h.exercise]) if h.exercise else None for h in hs],
        "underlying_name": lambda: [h.und_name for h in hs],
        "underlying_id": lambda: [h.und_id for h in hs],
        "underlying_price": lambda: [fmt_num(h.und_px, style, rng, 2) if h.und_px is not None else None for h in hs],
        "delta": lambda: [fmt_num(h.delta, style, rng, 4) if h.delta is not None else None for h in hs],
    }
    noise = {
        "row_id": lambda: [str(i + 1) if not style.raw_numbers else i + 1 for i in range(n)],
        "portfolio_code": lambda: [rng.choice(["FUND01", "Portfölj A", "SE-EQ-1", "4711"])] * n,
        "notes": lambda: [rng.choice(NOTES) or None if rng.random() < 0.3 else None for _ in hs],
        "purchase_date": lambda: [fmt_date(ref - dt.timedelta(days=rng.randint(1, 3000)), style) for _ in hs],
        "valuation_date": lambda: [fmt_date(ref, style)] * n,
        "cost": lambda: [fmt_num(round(h.mv_port * rng.uniform(0.6, 1.3), 2), style, rng) for h in hs],
        "pnl": lambda: [fmt_num(round(h.mv_port * rng.uniform(-0.3, 0.4), 2), style, rng) for h in hs],
        "sector": lambda: [rng.choice(SECTORS) if h.kind == "equity" else None for h in hs],
        "custodian": lambda: [rng.choice(["SEB", "JP Morgan", "BNP Paribas SS", "Clearstream"])] * n,
        "beta": lambda: [fmt_num(round(rng.uniform(0.4, 1.8), 2), style, rng) if h.kind == "equity" else None for h in hs],
        "volume": lambda: [fmt_num(rng.randint(10_000, 9_000_000), style, rng, 0) if h.kind == "equity" else None for h in hs],
        "riskfree": lambda: [fmt_num(round(rng.uniform(0, 5), 2), style, rng) if h.kind == "derivative" else None for h in hs],
        "impvol": lambda: [fmt_num(round(rng.uniform(8, 60), 1), style, rng, 1) if h.kind == "derivative" else None for h in hs],
        "fxlegs": lambda: [fmt_num(rng.randint(1, 50) * 100_000, style, rng, 0) if h.kind == "derivative" and rng.random() < 0.5 else None for h in hs],
        "avgcost": lambda: [fmt_num(round(h.price * rng.uniform(0.7, 1.2), 2), style, rng) for h in hs],
        "liquidity": lambda: [fmt_num(round(rng.uniform(0.1, 30), 1), style, rng, 1) for h in hs],
        "change": lambda: [fmt_num(round(rng.uniform(-5, 5), 2), style, rng) for _ in hs],
        "account_no": lambda: [f"{rng.randint(1000, 9999)}-{rng.randint(100000, 999999)}"] * n,
    }

    r_id = rng.random()
    core = ["security_name"] + (["isin"] if r_id < 0.7 else ["isin_mixed"] if r_id < 0.85 else ["other_identifier"])
    optional = [k for k in gens if k not in core and k != "isin_mixed" and not (k == "isin" and "isin_mixed" in core)]
    rng.shuffle(optional)
    chosen = core + optional[: rng.randint(3, min(20, len(optional)))]
    # Tables with derivatives often carry their terms together; bond tables their analytics.
    if any(h.kind == "derivative" for h in hs) and rng.random() < 0.4:
        chosen += [k for k in ["contract_size", "strike", "call_put", "underlying_name", "underlying_price", "delta", "exercise_type"] if k not in chosen and rng.random() < 0.7]
    if mix == "bond" and rng.random() < 0.5:
        chosen += [k for k in ["yield", "modified_duration", "coupon_frequency", "interest_rate_type", "dirty_price", "spread", "cqs"] if k not in chosen and rng.random() < 0.6]
    if mix == "bond" and "nominal" not in chosen and rng.random() < 0.5:
        chosen.append("nominal")
    # Mixed amount columns: one column holding units for equities, nominal for bonds, the balance for cash
    # (or nominal for bonds and the market value for everything else).
    r_mix = rng.random()
    if r_mix < 0.25:
        chosen = [k for k in chosen if k not in ("quantity", "nominal")] + ["amount_mixed"]
    elif r_mix < 0.33:
        chosen = [k for k in chosen if k not in ("quantity", "nominal", "market_value_local")] + ["amount_mixed_nv"]
    noise_keys = rng.sample(list(noise), k=rng.choice([0, 1, 1, 2, 3, 4]))
    cols = [(k, gens[k]()) for k in chosen] + [(k, noise[k]()) for k in noise_keys]
    # Gaps: real files leave cells blank here and there (a price not yet in, a rating not known).
    # Without them every field column is full in training, and a column with a few blanks would
    # look like noise to the model.
    for _, values in cols:
        if values and rng.random() < 0.3:
            share = rng.uniform(0.05, 0.35)
            for i in range(len(values)):
                if rng.random() < share:
                    values[i] = None
    rng.shuffle(cols)
    if ("isin" in chosen or "isin_mixed" in chosen) and rng.random() < 0.5:  # identifiers usually first
        cols.sort(key=lambda kv: kv[0] not in ("isin", "isin_mixed"))

    out = []
    for key, values in cols:
        label = ("amount_mixed" if key.startswith("amount_mixed") else "isin" if key == "isin_mixed" else key) if key in gens else "ignore"
        out.append({"header": pick_header(key, rng, style, pccy), "values": values, "label": label})
    return out


def freq_values(hs, rng, style):
    words = rng.random() < 0.4
    lang = rng.randrange(4)
    out = []
    for h in hs:
        if h.freq is None:
            out.append(None)
        elif words:
            ws = FREQ_WORDS[h.freq]
            out.append(ws[min(lang, len(ws) - 1)])
        else:
            out.append(h.freq if style.raw_numbers else str(h.freq))
    return out


def pct_str(v, style):
    return v + "%" if style.pct_sign and isinstance(v, str) else v


def weight_val(w, style, rng):
    if style.weight_fraction:
        return fmt_num(round(w, 6), style, rng, 6)
    v = fmt_num(round(w * 100, 4), style, rng, rng.choice([2, 4]))
    return v + "%" if style.pct_sign and isinstance(v, str) else v


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--tables", type=int, default=4000)
    ap.add_argument("--seed", type=int, default=7)
    ap.add_argument("--out", default=str(ROOT / "training/data/tables.jsonl"))
    a = ap.parse_args()
    rng = random.Random(a.seed)
    out = Path(a.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    with out.open("w", encoding="utf-8") as f:
        for i in range(a.tables):
            f.write(json.dumps({"id": i, "columns": make_table(rng)}, ensure_ascii=False) + "\n")
    print(f"Wrote {a.tables} tables to {out}")


if __name__ == "__main__":
    main()
