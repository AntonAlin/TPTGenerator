import { useMemo, useState } from 'preact/hooks';
import type { ResolveResult } from '../derive/resolve.ts';
import type { FxEntry } from '../derive/valuation.ts';
import type { PortfolioState } from '../portfolio/portfolio.ts';
import { buildTptFiles } from '../export/buildTpt.ts';
import { buildQualityReport, type QualityReport } from '../export/quality.ts';
import { writeQualityXlsx, writeTptCsv, writeTptXlsx } from '../export/write.ts';
import type { Source } from '../derive/provenance.ts';
import { SOURCE_LABEL, display } from './fields.tsx';
import { downloadBlob } from './session.ts';

interface Props {
  result: ResolveResult;
  portfolio: PortfolioState;
  fx: Record<string, FxEntry>;
  fxMissing: string[];
  /** Table-level findings from the amount interpretation (column totals). */
  amountNotes: string[];
}

type Tab = 'validation' | 'amounts' | 'missing' | 'estimated' | 'fields' | 'notDerived';
const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const SOURCES: Source[] = ['file', 'user', 'derived', 'missing'];
const pct = (a: number, b: number) => (b ? `${((a / b) * 100).toFixed(1)}%` : '–');

export function ExportStep({ result, portfolio, fx, fxMissing, amountNotes }: Props) {
  const [freeText, setFreeText] = useState(portfolio.values['3']?.replace(/\s+/g, '-').slice(0, 30) || 'TPT');
  const [includeSource, setIncludeSource] = useState(true);
  const [delimiter, setDelimiter] = useState(',');
  const [fileIdx, setFileIdx] = useState(0);
  const [tab, setTab] = useState<Tab>('validation');
  const [busy, setBusy] = useState<string | null>(null);
  /** Let the browser paint the busy state before the (synchronous) file generation starts. */
  const generate = (label: string, make: () => void) => {
    setBusy(label);
    setTimeout(() => {
      try {
        make();
      } finally {
        setBusy(null);
      }
    }, 30);
  };

  const files = useMemo(() => buildTptFiles(result, portfolio, fx, { freeText }), [result, portfolio, fx, freeText]);
  const file = files[Math.min(fileIdx, files.length - 1)];
  const report: QualityReport = useMemo(() => buildQualityReport(file), [file]);
  const s = report.summary;
  const prerequisites = [
    !portfolio.values['6'] && 'valuation date (field 6)',
    !(portfolio.level === 'fund' ? portfolio.values['4'] : portfolio.baseCurrency) && 'portfolio currency',
    fxMissing.length > 0 && `FX rates for ${fxMissing.join(', ')}`,
  ].filter(Boolean);

  return (
    <section class="stack">
      <div class="card">
        <h2>Export TPT and quality report</h2>
        {prerequisites.length > 0 && <p class="warn">Still missing in step 3: {prerequisites.join(', ')}. You can export anyway; affected fields stay blank and are listed below.</p>}
        <div class="filters">
          <label>
            Free text in file name <input type="text" value={freeText} onInput={(e) => setFreeText((e.target as HTMLInputElement).value)} />
          </label>
          <label class="checkbox">
            <input type="checkbox" checked={includeSource} onChange={(e) => setIncludeSource((e.target as HTMLInputElement).checked)} /> add a “Source” sheet (origin of every cell, for audit)
          </label>
          <label>
            CSV delimiter{' '}
            <select value={delimiter} onChange={(e) => setDelimiter((e.target as HTMLSelectElement).value)}>
              <option value=",">comma</option>
              <option value=";">semicolon</option>
            </select>
          </label>
        </div>
        {files.length > 1 && (
          <div class="filters">
            <span>Share class:</span>
            {files.map((f, i) => (
              <label key={f.fileName} class="checkbox">
                <input type="radio" checked={i === fileIdx} onChange={() => setFileIdx(i)} /> {f.shareClass} ({f.portfolioCurrency})
              </label>
            ))}
          </div>
        )}
        <p class="small">
          <code>{file.fileName}</code> — {report.holdings} holdings × {file.fields.length} fields, in the column order and with the headers of the active template.
        </p>
        <div class="filters">
          <button type="button" class="primary" disabled={!!busy} onClick={() => generate('TPT workbook', () => downloadBlob(writeTptXlsx(file, includeSource), `${file.fileName}.xlsx`, XLSX_TYPE))}>
            Download TPT (.xlsx)
          </button>
          <button type="button" class="secondary" disabled={!!busy} onClick={() => generate('CSV', () => downloadBlob(writeTptCsv(file, delimiter), `${file.fileName}.csv`, 'text/csv;charset=utf-8'))}>
            Download TPT (.csv)
          </button>
          <button type="button" class="secondary" disabled={!!busy} onClick={() => generate('quality report', () => downloadBlob(writeQualityXlsx(report), `${file.fileName}_quality_report.xlsx`, XLSX_TYPE))}>
            Download quality report (.xlsx)
          </button>
          {busy && <span class="muted" role="status">Preparing {busy}…</span>}
          {files.length > 1 && (
            <button
              type="button"
              class="secondary"
              disabled={!!busy}
              onClick={() => files.forEach((f, i) => setTimeout(() => downloadBlob(writeTptXlsx(f, includeSource), `${f.fileName}.xlsx`, XLSX_TYPE), i * 400))}
            >
              Download all {files.length} TPT files
            </button>
          )}
        </div>
      </div>

      <div class="tiles">
        <div class="tile">
          <span class="tile-label">Mandatory cells filled</span>
          <span class="tile-value">{pct(s.mandatoryFilled, s.mandatoryCells)}</span>
          <span class="muted small">
            {s.mandatoryFilled.toLocaleString('en-US')} of {s.mandatoryCells.toLocaleString('en-US')}
          </span>
        </div>
        <div class="tile">
          <span class="tile-label">All applicable cells filled</span>
          <span class="tile-value">{pct(s.filledCells, s.applicableCells)}</span>
          <span class="muted small">
            {s.filledCells.toLocaleString('en-US')} of {s.applicableCells.toLocaleString('en-US')}
          </span>
        </div>
        <div class="tile">
          <span class="tile-label">Validation</span>
          <span class={`tile-value ${s.errors ? 'error' : ''}`}>{s.errors} errors</span>
          <span class="muted small">{s.warnings} warnings</span>
        </div>
        <div class="tile wide">
          <span class="tile-label">Where the values come from</span>
          <div class="stack-bar" role="img" aria-label={SOURCES.map((x) => `${SOURCE_LABEL[x]} ${s.bySource[x]}`).join(', ')}>
            {SOURCES.map((x) => (s.bySource[x] ? <span key={x} class={`seg seg-${x}`} style={{ flexGrow: s.bySource[x] }} title={`${SOURCE_LABEL[x]}: ${s.bySource[x]}`} /> : null))}
          </div>
          <div class="legend small">
            {SOURCES.map((x) => (
              <span key={x}>
                <i class={`sw seg-${x}`} /> {SOURCE_LABEL[x]} {pct(s.bySource[x], s.applicableCells)}
              </span>
            ))}
          </div>
        </div>
      </div>

      <div class="card">
        <div class="tabs" role="tablist">
          {(
            [
              ['validation', `Validation (${report.validation.length})`],
              ['amounts', `Amounts (${report.amounts.length})`],
              ['missing', `Missing mandatory (${report.missingMandatory.length})`],
              ['estimated', `Estimated values (${report.estimated.length})`],
              ['fields', 'Completeness per field'],
              ['notDerived', `Left blank on purpose (${report.notDerived.length})`],
            ] as [Tab, string][]
          ).map(([id, label]) => (
            <button key={id} type="button" role="tab" aria-selected={tab === id} class={`tab ${tab === id ? 'active' : ''}`} onClick={() => setTab(id)}>
              {label}
            </button>
          ))}
        </div>
        <div class="table-wrap">
          {tab === 'validation' && (
            <Table
              head={['Severity', 'Row', 'Identifier', 'Field', 'Message']}
              rows={report.validation.map((v) => [<span class={v.severity === 'error' ? 'error' : 'warn'}>{v.severity}</span>, v.row ?? '', v.identifier ?? '', v.fieldId ?? '', v.message])}
              empty="No validation problems."
            />
          )}
          {tab === 'amounts' && (
            <>
              <p class="muted small">
                Amount columns can mix shares, nominal, notional and market values. Each cell was read using the row's arithmetic (quantity × price, nominal × price ÷ 100,
                value × FX, value ÷ NAV = weight), the row type and column totals. Listed: rows where a cell was sorted into a different field than its column, or where the
                reading is uncertain.
              </p>
              {amountNotes.length > 0 && (
                <ul class="small">
                  {amountNotes.map((n) => (
                    <li key={n}>{n}</li>
                  ))}
                </ul>
              )}
              <Table
                head={['Row', 'Identifier', 'Name', 'Read as', 'Confidence', 'Evidence', 'Alternative']}
                rows={report.amounts.map((a) => [
                  a.row,
                  a.identifier,
                  a.name,
                  a.reading,
                  <span class={`conf-${a.confidence}`}>
                    {a.confidence} ({Math.round(a.probability * 100)}%)
                  </span>,
                  a.evidence,
                  a.alternative ?? '',
                ])}
                empty="Every amount column was read as mapped, with high confidence."
              />
            </>
          )}
          {tab === 'missing' && (
            <Table head={['Row', 'Identifier', 'Name', 'Field', 'Why missing']} rows={report.missingMandatory.map((m) => [m.row || '', m.identifier, m.name, m.header, m.note ?? ''])} empty="All mandatory fields are filled." />
          )}
          {tab === 'estimated' && (
            <Table
              head={['Row', 'Identifier', 'Field', 'Value', 'Confidence', 'Method']}
              rows={report.estimated.map((e) => [e.row || '', e.identifier, e.header, display(e.value), <span class={`conf-${e.confidence}`}>{e.confidence}</span>, [e.method, e.note].filter(Boolean).join(' — ')])}
              empty="No estimated values."
            />
          )}
          {tab === 'fields' && (
            <Table
              head={['Field', 'Req.', 'Applies to', 'Filled', 'File', 'User', 'Derived', 'Missing']}
              rows={report.fields
                .filter((f) => !f.mustBeEmpty)
                .map((f) => [
                  f.header,
                  f.requirementRaw,
                  f.applicable,
                  <span class="fill-cell">
                    <span class="mini-bar">
                      <span style={{ width: `${Math.round(f.pctFilled * 100)}%` }} />
                    </span>
                    {f.applicable ? `${Math.round(f.pctFilled * 100)}%` : '–'}
                  </span>,
                  f.counts.file || '',
                  f.counts.user || '',
                  f.counts.derived || '',
                  f.counts.missing || '',
                ])}
              empty=""
            />
          )}
          {tab === 'notDerived' && (
            <Table
              head={['Field', 'Why left blank']}
              rows={[
                ...report.notDerived.map((n) => [n.header, n.reason]),
                ...file.fields.filter((f) => f.mustBeEmpty).map((f) => [f.header, 'No longer maintained by FinDatEx: must be left empty.']),
              ]}
              empty=""
            />
          )}
        </div>
      </div>
    </section>
  );
}

function Table({ head, rows, empty }: { head: string[]; rows: unknown[][]; empty: string }) {
  if (!rows.length) return <p class="muted">{empty}</p>;
  return (
    <table class="grid compact report">
      <thead>
        <tr>
          {head.map((h) => (
            <th key={h}>{h}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.slice(0, 2000).map((r, i) => (
          <tr key={i}>
            {r.map((c, j) => (
              <td key={j}>{c as preact.ComponentChildren}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
