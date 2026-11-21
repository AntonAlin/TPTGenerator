/**
 * Completeness and data quality report for a built TPT file.
 */
import type { SpecField } from '../spec/types.ts';
import { validateFieldValue } from '../spec/validate.ts';
import { looksLikeIsin, isValidIsin } from '../ingest/identifiers.ts';
import type { Source } from '../derive/provenance.ts';
import type { TptFile } from './buildTpt.ts';
import { ROLE_LABEL } from '../derive/amounts.ts';

export interface FieldStat {
  id: string;
  header: string;
  requirement: SpecField['requirement'];
  requirementRaw: string;
  /** Rows where the field applies (per the template's CIC columns). */
  applicable: number;
  counts: Record<Source, number>;
  filled: number;
  pctFilled: number;
  mustBeEmpty: boolean;
}

export interface CellRef {
  row: number;
  identifier: string;
  name: string;
  fieldId: string;
  header: string;
}

export interface MissingMandatory extends CellRef {
  note?: string;
}

export interface EstimatedValue extends CellRef {
  value: string | number;
  method: string;
  confidence: string;
  note?: string;
}

export interface ValidationIssue {
  severity: 'error' | 'warning';
  row?: number;
  identifier?: string;
  fieldId?: string;
  message: string;
}

export interface AmountRow {
  row: number;
  identifier: string;
  name: string;
  /** e.g. "Holding → nominal / notional; Market value → market value (local)". */
  reading: string;
  confidence: string;
  probability: number;
  evidence: string;
  alternative?: string;
  /** True if at least one cell was read differently from its column mapping. */
  moved: boolean;
}

export interface NotDerived {
  fieldId: string;
  header: string;
  reason: string;
}

export interface QualityReport {
  fileName: string;
  holdings: number;
  summary: {
    mandatoryCells: number;
    mandatoryFilled: number;
    applicableCells: number;
    filledCells: number;
    bySource: Record<Source, number>;
    errors: number;
    warnings: number;
  };
  fields: FieldStat[];
  missingMandatory: MissingMandatory[];
  estimated: EstimatedValue[];
  validation: ValidationIssue[];
  notDerived: NotDerived[];
  /** Rows whose amount cells were re-sorted, or whose reading is uncertain. */
  amounts: AmountRow[];
}

const PORTFOLIO_LEVEL = /Portfolio Characteristics/i;
const empty = (): Record<Source, number> => ({ file: 0, master: 0, user: 0, derived: 0, missing: 0 });

/** Whether a field applies to a holding with this CIC, per the template's CIC applicability columns. */
export function applies(f: SpecField, cic: unknown): boolean {
  if (PORTFOLIO_LEVEL.test(f.section) || f.id === '1000') return true;
  const cols = Object.keys(f.cicApplicability);
  if (!cols.length) return true; // no CIC columns marked: field is not CIC-specific
  if (typeof cic !== 'string' || cic.length !== 4) return true;
  return cols.includes(cic[2]);
}

export function buildQualityReport(file: TptFile): QualityReport {
  const { fields, rows, holdings } = file;
  const ref = (i: number, f: SpecField): CellRef => ({
    row: holdings[i].holding.row + 1,
    identifier: String(holdings[i].attrs.identifier.value ?? ''),
    name: String(holdings[i].attrs.name.value ?? ''),
    fieldId: f.id,
    header: f.header,
  });
  const cicIdx = fields.findIndex((f) => f.id === '12');

  const stats: FieldStat[] = fields.map((f) => ({
    id: f.id,
    header: f.header,
    requirement: f.requirement,
    requirementRaw: f.requirementRaw,
    applicable: 0,
    counts: empty(),
    filled: 0,
    pctFilled: 0,
    mustBeEmpty: f.mustBeEmpty,
  }));
  const missingMandatory: MissingMandatory[] = [];
  const estimated: EstimatedValue[] = [];
  const validation: ValidationIssue[] = [];
  const notDerived = new Map<string, NotDerived>();
  const portfolioReported = new Set<string>();
  const bySource = empty();

  rows.forEach((row, i) => {
    const cic = cicIdx >= 0 ? row[cicIdx].value : undefined;
    row.forEach((cell, j) => {
      const f = fields[j];
      if (f.mustBeEmpty) return;
      const portfolioField = PORTFOLIO_LEVEL.test(f.section) || f.id === '1000';
      if (!applies(f, cic) && cell.source === 'missing') return;
      const s = stats[j];
      s.applicable++;
      s.counts[cell.source]++;
      bySource[cell.source]++;
      if (cell.source !== 'missing') s.filled++;
      // Portfolio fields repeat on every row: report them once.
      if (portfolioField && portfolioReported.has(f.id)) return;
      if (portfolioField) portfolioReported.add(f.id);
      const r = portfolioField ? { row: 0, identifier: '(portfolio)', name: '', fieldId: f.id, header: f.header } : ref(i, f);

      if (cell.source === 'missing') {
        if (/SCR contributions|must be left empty|not derivable|not computed/i.test(cell.note ?? '')) {
          if (!notDerived.has(f.id)) notDerived.set(f.id, { fieldId: f.id, header: f.header, reason: cell.note! });
        }
        if (f.requirement === 'mandatory') missingMandatory.push({ ...r, note: cell.note });
        return;
      }
      if (cell.source === 'derived') {
        estimated.push({ ...r, value: cell.value!, method: cell.method ?? '', confidence: cell.confidence ?? '', note: cell.note });
      }
      const err = validateFieldValue(f, cell.value);
      if (err) validation.push({ severity: 'error', row: r.row || undefined, identifier: r.identifier, fieldId: f.id, message: err });
    });
  });

  for (const s of stats) s.pctFilled = s.applicable ? s.filled / s.applicable : 0;

  // Holding-level issues found during resolution (invalid ISIN, LEI, CIC, conflicts).
  holdings.forEach((h) => {
    for (const msg of h.issues) {
      validation.push({ severity: /not a valid|fails|not valid/.test(msg) ? 'error' : 'warning', row: h.holding.row + 1, identifier: String(h.attrs.identifier.value ?? ''), message: msg });
    }
  });

  // Portfolio identifier.
  const f1 = fields.findIndex((f) => f.id === '1');
  const id1 = rows[0]?.[f1]?.value;
  if (typeof id1 === 'string' && looksLikeIsin(id1) && !isValidIsin(id1)) validation.push({ severity: 'error', identifier: '(portfolio)', fieldId: '1', message: `Portfolio identifier "${id1}" looks like an ISIN but fails the check digit.` });

  // Weights sum to 100%.
  const wIdx = fields.findIndex((f) => f.id === '26');
  const weights = rows.map((r) => r[wIdx]?.value).filter((v): v is number => typeof v === 'number');
  if (weights.length === rows.length && rows.length) {
    const sum = weights.reduce((a, b) => a + b, 0);
    if (Math.abs(sum - 1) > 0.005) validation.push({ severity: 'warning', fieldId: '26', message: `Valuation weights sum to ${(sum * 100).toFixed(2)}%, not 100% (liabilities, receivables or holdings missing from the file, or NAV differs).` });
  } else if (rows.length) validation.push({ severity: 'warning', fieldId: '26', message: `${rows.length - weights.length} holding(s) have no valuation weight.` });

  // NAV vs sum of holdings.
  const navIdx = fields.findIndex((f) => f.id === '5');
  const mvIdx = fields.findIndex((f) => f.id === '24');
  const nav = rows[0]?.[navIdx]?.value;
  const mvs = rows.map((r) => r[mvIdx]?.value).filter((v): v is number => typeof v === 'number');
  if (typeof nav === 'number' && mvs.length && rows[0][navIdx].source !== 'derived') {
    const sum = mvs.reduce((a, b) => a + b, 0);
    if (Math.abs(sum / nav - 1) > 0.01) validation.push({ severity: 'warning', fieldId: '5', message: `Sum of holdings (${sum.toFixed(2)}) differs from the NAV (${nav}) by ${((sum / nav - 1) * 100).toFixed(2)}%.` });
  }

  // Duplicate instrument identifiers.
  const idIdx = fields.findIndex((f) => f.id === '14');
  const seen = new Map<string, number>();
  rows.forEach((r) => {
    const v = r[idIdx]?.value;
    if (typeof v === 'string') seen.set(v, (seen.get(v) ?? 0) + 1);
  });
  for (const [v, n] of seen) if (n > 1) validation.push({ severity: 'warning', fieldId: '14', identifier: v, message: `Identifier ${v} appears on ${n} rows (TPT codes must be unique per position; merge lots or add leg suffixes).` });

  // Maturity before valuation date.
  const matIdx = fields.findIndex((f) => f.id === '39');
  const valIdx = fields.findIndex((f) => f.id === '6');
  rows.forEach((r, i) => {
    const m = r[matIdx]?.value;
    const v = r[valIdx]?.value;
    if (typeof m === 'string' && typeof v === 'string' && m < v) validation.push({ severity: 'warning', row: holdings[i].holding.row + 1, identifier: String(holdings[i].attrs.identifier.value ?? ''), fieldId: '39', message: `Maturity ${m} is before the valuation date ${v}.` });
  });

  // Amount cells that were re-sorted or are uncertain.
  const amounts: AmountRow[] = [];
  for (const h of holdings) {
    const a = h.holding.amounts;
    if (!a) continue;
    const moved = a.cells.some((c) => c.moved);
    if (!moved && a.confidence === 'high') continue;
    amounts.push({
      row: h.holding.row + 1,
      identifier: String(h.attrs.identifier.value ?? ''),
      name: String(h.attrs.name.value ?? ''),
      reading: a.cells.map((c) => `${c.cell.header} → ${ROLE_LABEL[c.role]}`).join('; '),
      confidence: a.confidence,
      probability: a.probability,
      evidence: a.evidence.join('; '),
      ...(a.runnerUp ? { alternative: `${a.runnerUp.description} (${Math.round(a.runnerUp.probability * 100)}%)` } : {}),
      moved,
    });
    if (a.confidence === 'low') {
      validation.push({ severity: 'warning', row: h.holding.row + 1, identifier: String(h.attrs.identifier.value ?? ''), message: `Uncertain reading of the amount columns (${Math.round(a.probability * 100)}%): ${amounts.at(-1)!.reading}. Check the "Amounts" list.` });
    }
  }

  const mandatory = stats.filter((s) => s.requirement === 'mandatory');
  return {
    fileName: file.fileName,
    holdings: rows.length,
    summary: {
      mandatoryCells: mandatory.reduce((a, s) => a + s.applicable, 0),
      mandatoryFilled: mandatory.reduce((a, s) => a + s.filled, 0),
      applicableCells: stats.reduce((a, s) => a + s.applicable, 0),
      filledCells: stats.reduce((a, s) => a + s.filled, 0),
      bySource,
      errors: validation.filter((v) => v.severity === 'error').length,
      warnings: validation.filter((v) => v.severity === 'warning').length,
    },
    fields: stats,
    missingMandatory,
    estimated,
    validation,
    notDerived: [...notDerived.values()],
    amounts,
  };
}
