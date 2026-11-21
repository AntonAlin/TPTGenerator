/**
 * Build-time script: parse the official FinDatEx TPT template (Excel) into
 * src/spec/tpt_spec.json, which is the only source of field definitions
 * used by the app.
 *
 *   node scripts/build-spec.ts           # (re)generate the JSON
 *   node scripts/build-spec.ts --check   # fail if the committed JSON is stale
 *
 * Configuration lives in spec/spec.config.json.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as XLSX from 'xlsx';
import { parseSpec, type Grid, type SpecOverrides } from '../src/spec/parseSpec.ts';

interface SpecConfig {
  template: string;
  sheet?: string;
  overrides?: string;
  output: string;
}

/** Fill colours the template uses to mark changes since the previous version. */
const HIGHLIGHT_RGB = new Set(['FFFF00', 'FFFFFF00']);

const root = resolve(import.meta.dirname, '..');
const config = JSON.parse(readFileSync(resolve(root, 'spec/spec.config.json'), 'utf8')) as SpecConfig;
const check = process.argv.includes('--check');

const templatePath = resolve(root, config.template);
if (!existsSync(templatePath)) {
  console.error(`Template not found: ${config.template}. Put the official FinDatEx TPT .xlsx in /spec and update spec/spec.config.json.`);
  process.exit(1);
}
const buf = readFileSync(templatePath);
const wb = XLSX.read(buf, { cellStyles: true, cellDates: false });
const sheetName = config.sheet && wb.Sheets[config.sheet] ? config.sheet : wb.SheetNames.find((n) => /TPT/i.test(n)) ?? wb.SheetNames[0];
const ws = wb.Sheets[sheetName];
if (!ws?.['!ref']) throw new Error(`Sheet "${sheetName}" is empty.`);

const range = XLSX.utils.decode_range(ws['!ref']);
const grid: Grid = [];
for (let r = 0; r <= range.e.r; r++) {
  const row = [];
  for (let c = 0; c <= range.e.c; c++) {
    const cell = ws[XLSX.utils.encode_cell({ r, c })] as XLSX.CellObject | undefined;
    const style = cell?.s as { patternType?: string; fgColor?: { rgb?: string } } | undefined;
    row.push({
      text: cell?.v == null ? '' : String(cell.v),
      highlighted: style?.patternType === 'solid' && HIGHLIGHT_RGB.has((style.fgColor?.rgb ?? '').toUpperCase()),
    });
  }
  grid.push(row);
}

const overrides: SpecOverrides = config.overrides
  ? (JSON.parse(readFileSync(resolve(root, config.overrides), 'utf8')) as SpecOverrides)
  : {};

const spec = parseSpec({
  grid,
  sourceFile: `${config.template}#${sheetName}`,
  sourceSha256: createHash('sha256').update(buf).digest('hex'),
  overrides,
});

const json = `${JSON.stringify(spec, null, 2)}\n`;
const outPath = resolve(root, config.output);

if (check) {
  const current = existsSync(outPath) ? readFileSync(outPath, 'utf8') : '';
  if (current !== json) {
    console.error(`${config.output} is out of date with ${config.template}. Run \`npm run spec:build\` and commit the result.`);
    process.exit(1);
  }
  console.log(`${config.output} is up to date (${spec.meta.version}, ${spec.fields.length} fields).`);
} else {
  writeFileSync(outPath, json);
  console.log(`Wrote ${config.output}: ${spec.meta.version}, ${spec.fields.length} fields, ${spec.sections.length} sections.`);
}
if (spec.warnings.length) {
  console.warn(`\n${spec.warnings.length} warning(s) to review:`);
  for (const w of spec.warnings) console.warn(`  - ${w}`);
}
