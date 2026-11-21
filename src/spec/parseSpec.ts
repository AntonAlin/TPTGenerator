/**
 * Parser that turns the official FinDatEx TPT Excel template into a TptSpec.
 *
 * It is deliberately independent of SheetJS: the caller passes a plain grid
 * of cells (text + "highlighted" flag), which keeps the logic unit-testable.
 *
 * The parser locates columns by their HEADER TEXT, not by fixed letters, so
 * a future template version with re-ordered or extra columns still parses.
 * Anything it cannot interpret is reported in `warnings` instead of guessed.
 */
import type {
  CodeListEntry,
  DataType,
  Requirement,
  SpecField,
  SpecMeta,
  TptSpec,
} from './types.ts';

export interface GridCell {
  text: string;
  /** True if the cell has the template's "changed since previous version" highlight. */
  highlighted: boolean;
}

export type Grid = GridCell[][];

/** Metadata that is not contained in the Excel template (with its source). */
export interface SpecOverrides {
  versionFieldValue?: string;
  fileNameVersionTag?: string;
  /** Field ids that must be left empty (e.g. "no longer maintained" list). */
  mustBeEmptyFieldIds?: string[];
  sources?: string[];
}

export interface ParseInput {
  grid: Grid;
  sourceFile: string;
  sourceSha256: string;
  overrides?: SpecOverrides;
}

const FIELD_ID_RE = /^(\d+)([a-z]?)_(.+)$/;

const cellText = (grid: Grid, r: number, c: number): string =>
  (grid[r]?.[c]?.text ?? '').replace(/\r\n?/g, '\n');

const clean = (s: string): string => s.replace(/ /g, ' ').trim();

interface ColumnMap {
  id: number;
  xpath: number;
  definition: number;
  codification: number;
  comment: number;
  requirement: number;
  cic: Record<string, number>;
  regimes: Record<string, number>;
}

function findHeaderRow(grid: Grid): number {
  for (let r = 0; r < Math.min(grid.length, 50); r++) {
    for (let c = 0; c < (grid[r]?.length ?? 0); c++) {
      if (/^NUM_DATA$/i.test(clean(cellText(grid, r, c)))) return r;
    }
  }
  throw new Error('Could not find the header row (a cell containing "NUM_DATA").');
}

function mapColumns(grid: Grid, headerRow: number, warnings: string[]): ColumnMap {
  const row = grid[headerRow] ?? [];
  const find = (re: RegExp): number => row.findIndex((cell) => re.test(clean(cell?.text ?? '')));
  const map: ColumnMap = {
    id: find(/^NUM_DATA$/i),
    xpath: find(/xpath/i),
    definition: find(/^DEFINITION$/i),
    codification: find(/^CODIFICATION$/i),
    comment: find(/^COMMENT$/i),
    requirement: find(/mandatory/i),
    cic: {},
    regimes: {},
  };
  for (const [key, idx] of Object.entries(map)) {
    if (typeof idx === 'number' && idx < 0 && key !== 'xpath') {
      throw new Error(`Required column "${key}" not found in header row ${headerRow + 1}.`);
    }
  }
  if (map.xpath < 0) warnings.push('No XPath column found; xpath will be empty.');
  row.forEach((cell, c) => {
    const t = clean(cell?.text ?? '');
    const cic = /\(CIC\s*([0-9A-F])\)/i.exec(t);
    if (cic) map.cic[cic[1].toUpperCase()] = c;
    if (/^NW\s*675/i.test(t)) map.regimes.NW675 = c;
    if (/^SST$/i.test(t)) map.regimes.SST = c;
    if (/^IORP/i.test(t)) map.regimes.IORP = c;
  });
  if (Object.keys(map.cic).length === 0) warnings.push('No CIC applicability columns found.');
  return map;
}

export function normalizeRequirement(raw: string): Requirement {
  const t = clean(raw).toUpperCase().replace(/["']/g, '');
  if (t === 'M') return 'mandatory';
  if (t === 'C' || t === 'X') return 'conditional';
  if (t === 'O') return 'optional';
  if (t === 'I') return 'indicative';
  if (t === 'N/A' || t === 'NA') return 'not_applicable';
  return 'unknown';
}

/** Line-based closed-list item: `1 - label`, `0 = label`, `"a" refers to label`, `0. label`, `3L – label`. */
const LIST_LINE_RE =
  /^\s*"?([0-9A-Za-z]{1,3})"?\s*(?:refers\s*to|[-–=:]|\.(?=\s))\s*(.+?)\s*;?\s*$/;
/** Inline `"code" = label` pairs separated by "/" or another quote. */
const INLINE_PAIR_RE = /"([^"]{1,12})"\s*=\s*([^/"()]+?)\s*(?=\/|"|\)|$)/g;
/** Inline list of quoted codes: `"Fixed" or "Floating"`, `("AM", "EU")`. */
const QUOTED_TOKEN_RE = /"([^"]{1,30})"/g;

/**
 * Extract a closed list from free text. Returns undefined unless at least two
 * entries are found, to avoid reading a sentence as a one-item list.
 */
export function parseCodeList(text: string): CodeListEntry[] | undefined {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const entries: CodeListEntry[] = [];
  let last: CodeListEntry | undefined;
  for (const line of lines) {
    const m = LIST_LINE_RE.exec(line);
    if (m) {
      last = { code: m[1], label: clean(m[2]) };
      entries.push(last);
    } else if (last && clean(line) && !/^[A-Z][a-z]+ /.test(clean(line)) && /^[a-z(]/.test(clean(line))) {
      // Continuation of a wrapped label, e.g. "participations)".
      last.label = `${last.label} ${clean(line)}`;
    } else if (!clean(line)) {
      last = undefined;
    }
  }
  if (entries.length >= 2 && new Set(entries.map((e) => e.code)).size === entries.length) {
    return entries;
  }

  const pairs = [...text.matchAll(INLINE_PAIR_RE)].map((m) => ({ code: m[1], label: clean(m[2]) }));
  if (pairs.length >= 2) return pairs;

  const tokens = [...text.matchAll(QUOTED_TOKEN_RE)].map((m) => m[1]);
  if (tokens.length >= 2 && !/=/.test(text)) {
    return [...new Set(tokens)].map((code) => ({ code, label: code }));
  }
  return undefined;
}

interface TypeInference {
  dataType: DataType;
  rule: string;
  codeList?: CodeListEntry[];
  codeListSource?: 'codification' | 'comment';
  additionalCodes?: CodeListEntry[];
  maxLength?: number;
}

/** Deterministic reading of the CODIFICATION text into a data type. */
export function inferDataType(header: string, codification: string, comment: string): TypeInference {
  const cod = codification;
  const maxLen = /max\s*(\d+)/i.exec(cod);
  const base: Pick<TypeInference, 'maxLength'> = maxLen ? { maxLength: Number(maxLen[1]) } : {};

  if (/YYYY-MM-DD/i.test(cod)) return { ...base, dataType: 'date', rule: 'codification:YYYY-MM-DD' };
  if (/ISO\s*4217/i.test(cod)) {
    const extra = parseCodeList(cod.split('\n').slice(1).join('\n'));
    return { ...base, dataType: 'currency', rule: 'codification:ISO 4217', ...(extra ? { additionalCodes: extra } : {}) };
  }
  if (/ISO\s*3166/i.test(cod)) return { ...base, dataType: 'country', rule: 'codification:ISO 3166' };
  if (/^\s*CIC\b/.test(cod) || (!cod && /(^|_)CIC(_|$)/.test(header)) || (/^Alphanumeric \(4\)$/i.test(cod) && /(^|_)CIC(_|$)/.test(header))) {
    return { ...base, dataType: 'cic', rule: /^\s*CIC\b/.test(cod) ? 'codification:CIC' : 'header:CIC' };
  }
  if (/NACE/.test(cod)) return { ...base, dataType: 'nace', rule: 'codification:NACE' };

  const fromCod = parseCodeList(cod);
  if (fromCod) return { ...base, dataType: 'code', rule: 'codification:closed-list', codeList: fromCod, codeListSource: 'codification' };
  // A closed list in the COMMENT only counts when the codification is a bare size
  // descriptor such as "num (1)"; otherwise the list describes something else
  // (e.g. the priority order of identifiers in field 68).
  if (/closed list/i.test(comment) && /^(num|int|alpha|alphanum\w*)\s*\(\d+\)$/i.test(cod)) {
    const fromComment = parseCodeList(comment);
    if (fromComment) {
      return { ...base, dataType: 'code', rule: 'comment:closed-list', codeList: fromComment, codeListSource: 'comment' };
    }
  }

  if (/^V\d+\.\d+/m.test(cod)) return { ...base, dataType: 'string', rule: 'codification:version-list' };
  // Alphanumeric must be tested before "numeric" because "Alphanumeric" contains it.
  if (/\balpha|\btext\b/i.test(cod)) return { ...base, dataType: 'string', rule: 'codification:alphanumeric' };
  if (/\bint(eger)?\b|\bnum\s*\(\d+\)/i.test(cod)) return { ...base, dataType: 'integer', rule: 'codification:integer' };
  if (/\bnumber\b|\bnumeric\b|\bdecimal\b/i.test(cod)) return { ...base, dataType: 'number', rule: 'codification:number' };
  if (/ISIN|identif|LEI|\bcode\b|example|ISO code/i.test(cod)) return { ...base, dataType: 'string', rule: 'codification:identifier-text' };
  if (/valu(e|ation)/i.test(cod)) return { ...base, dataType: 'number', rule: 'codification:value-text' };
  return { ...base, dataType: 'unknown', rule: 'none' };
}

/** Extract the exact version value (field 1000) for the newest version listed. */
function versionFromField1000(codification: string): string | undefined {
  const lines = codification.split('\n').map(clean).filter(Boolean);
  return lines.at(-1);
}

export function parseSpec(input: ParseInput): TptSpec {
  const { grid, overrides = {} } = input;
  const warnings: string[] = [];
  const headerRow = findHeaderRow(grid);
  const cols = mapColumns(grid, headerRow, warnings);

  // Template metadata above the header row.
  let title = '';
  let dateLine = '';
  let fileNamingConvention = '';
  for (let r = 0; r < headerRow; r++) {
    for (let c = 0; c < (grid[r]?.length ?? 0); c++) {
      const t = clean(cellText(grid, r, c));
      if (!t) continue;
      if (!title && /Tripartite Template/i.test(t)) title = t;
      if (!dateLine && /^Version\s+\d/i.test(t)) dateLine = t;
      const naming = /The naming convention is[^\n]*/i.exec(t);
      if (naming) fileNamingConvention = clean(naming[0]);
    }
  }
  const versionMatch = /Version\s+(\d+(?:\.\d+)?)/i.exec(dateLine) ?? /V(\d+(?:\.\d+)?)/.exec(title);
  const version = versionMatch ? `V${versionMatch[1]}` : 'unknown';
  if (version === 'unknown') warnings.push('Could not detect template version from header lines.');

  const fields: SpecField[] = [];
  const sections: string[] = [];
  let section = '';
  const mustBeEmpty = new Set(overrides.mustBeEmptyFieldIds ?? []);

  for (let r = headerRow + 1; r < grid.length; r++) {
    const idText = clean(cellText(grid, r, cols.id));
    if (!idText) continue;
    const m = FIELD_ID_RE.exec(idText);
    if (!m) {
      // A row with text in the id column but no field number is a section heading.
      section = idText.replace(/\s+/g, ' ');
      sections.push(section);
      continue;
    }
    const [, num, suffix, rest] = m;
    const id = `${num}${suffix}`;
    const definition = clean(cellText(grid, r, cols.definition));
    const codification = clean(cellText(grid, r, cols.codification));
    const comment = clean(cellText(grid, r, cols.comment));
    const requirementRaw = clean(cellText(grid, r, cols.requirement));
    const requirement = normalizeRequirement(requirementRaw);
    if (requirement === 'unknown') warnings.push(`Field ${id}: unrecognised requirement "${requirementRaw}".`);

    const inferred = inferDataType(idText, codification, comment);
    if (inferred.dataType === 'unknown' && requirement !== 'not_applicable') {
      warnings.push(`Field ${id}: data type could not be inferred from codification "${codification}".`);
    }

    const cicApplicability: Record<string, string> = {};
    for (const [cat, c] of Object.entries(cols.cic)) {
      const v = clean(cellText(grid, r, c));
      if (v) cicApplicability[cat] = v;
    }
    const otherRegimes: Record<string, string> = {};
    for (const [reg, c] of Object.entries(cols.regimes)) {
      const v = clean(cellText(grid, r, c));
      if (v) otherRegimes[reg] = v;
    }

    const highlightCols = [cols.id, cols.xpath, cols.definition, cols.codification, cols.comment, cols.requirement];
    const changed = highlightCols.some((c) => c >= 0 && grid[r]?.[c]?.highlighted);

    if (fields.some((f) => f.id === id)) warnings.push(`Duplicate field id ${id} at row ${r + 1}.`);

    const field: SpecField = {
      id,
      number: Number(num),
      suffix,
      header: idText,
      name: rest.replace(/_/g, ' ').replace(/\s+/g, ' ').trim(),
      section,
      order: fields.length,
      definition,
      codification,
      comment,
      xpath: cols.xpath >= 0 ? clean(cellText(grid, r, cols.xpath)) : '',
      requirementRaw,
      requirement,
      dataType: inferred.dataType,
      dataTypeRule: inferred.rule,
      cicApplicability,
      otherRegimes,
      changedFromPreviousVersion: changed,
      mustBeEmpty: requirement === 'not_applicable' || mustBeEmpty.has(id),
    };
    if (inferred.maxLength !== undefined) field.maxLength = inferred.maxLength;
    if (inferred.codeList) {
      field.codeList = inferred.codeList;
      field.codeListSource = inferred.codeListSource;
    }
    if (inferred.additionalCodes) field.additionalCodes = inferred.additionalCodes;
    fields.push(field);
  }

  // Cross-check supplementary "must be empty" list against the template's own N/A flags.
  for (const id of mustBeEmpty) {
    const f = fields.find((x) => x.id === id);
    if (!f) warnings.push(`Override lists field ${id} as must-be-empty but it is not in the template.`);
    else if (f.requirement !== 'not_applicable') {
      warnings.push(`Field ${id} is listed as must-be-empty by overrides but the template marks it "${f.requirementRaw}".`);
    }
  }

  const versionField = fields.find((f) => f.number === 1000);
  const fromTemplate = versionField ? versionFromField1000(versionField.codification) : undefined;
  const versionFieldValue = overrides.versionFieldValue ?? fromTemplate ?? '';
  if (!versionFieldValue) warnings.push('Could not determine the value for the TPT version field.');

  const meta: SpecMeta = {
    version,
    versionFieldValue,
    fileNameVersionTag: overrides.fileNameVersionTag ?? version.replace(/\.0$/, ''),
    fileNamingConvention,
    title,
    dateLine,
    sourceFile: input.sourceFile,
    sourceSha256: input.sourceSha256,
    supplementarySources: overrides.sources ?? [],
    generatedBy: 'scripts/build-spec.ts',
  };

  if (fields.length === 0) throw new Error('No fields found in template.');
  return { meta, sections, fields, warnings };
}
