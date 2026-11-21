import { useState } from 'preact/hooks';
import type { SkipReason } from '../ingest/table.ts';
import { datesFor, needsChoice } from '../ingest/split.ts';
import { chooseSlice, loadFile, reloadSheet, type LoadedSheet } from './session.ts';

const REASON_LABEL: Record<SkipReason, string> = {
  'above-header': 'Title / metadata above the table',
  blank: 'Blank rows',
  total: 'Totals and subtotals',
  'computed-total': 'Unlabelled totals (numbers equal the sum above)',
  'section-heading': 'Section headings',
  note: 'Notes and footers',
  'repeated-header': 'Repeated header rows',
};

interface Props {
  loaded: LoadedSheet | null;
  onLoaded: (s: LoadedSheet) => void;
  onContinue: () => void;
}

const cellText = (v: unknown) => (v == null ? '' : v instanceof Date ? v.toISOString().slice(0, 10) : String(v));

export function UploadStep({ loaded, onLoaded, onContinue }: Props) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [dragOver, setDragOver] = useState(false);

  async function handleFile(file: File | undefined) {
    if (!file) return;
    setError(null);
    setBusy(true);
    try {
      onLoaded(await loadFile(file));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  function change(sheetName: string, headerRow?: number) {
    if (!loaded) return;
    try {
      setError(null);
      onLoaded(reloadSheet(loaded, sheetName, headerRow));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  const t = loaded?.table;
  const grouped = t
    ? Object.entries(
        t.skipped.reduce<Record<string, typeof t.skipped>>((acc, s) => {
          (acc[s.reason] ??= []).push(s);
          return acc;
        }, {}),
      )
    : [];

  return (
    <section class="stack">
      <div
        class={`dropzone ${dragOver ? 'over' : ''}`}
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          handleFile(e.dataTransfer?.files[0]);
        }}
      >
        <p>
          <strong>Drop a holdings file here</strong> or{' '}
          <label class="linklike">
            choose a file
            <input type="file" accept=".xlsx,.xlsm,.xls,.csv,.txt,.tsv" hidden onChange={(e) => handleFile((e.target as HTMLInputElement).files?.[0])} />
          </label>
        </p>
        <p class="muted">xlsx, xls or csv. The file is read in this tab and never uploaded.</p>
        {busy && <p>Reading…</p>}
      </div>
      {error && <p class="error" role="alert">{error}</p>}

      {loaded && t && (
        <>
          <div class="card">
            <h2>{loaded.workbook.fileName}</h2>
            <div class="filters">
              {loaded.workbook.sheets.length > 1 && (
                <label>
                  Sheet{' '}
                  <select value={loaded.sheetName} onChange={(e) => change((e.target as HTMLSelectElement).value)}>
                    {loaded.workbook.sheets.map((s) => (
                      <option key={s.name} value={s.name}>
                        {s.name}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <label>
                Header row{' '}
                <input
                  type="number"
                  min={1}
                  class="narrow"
                  value={t.headerRows[t.headerRows.length - 1] + 1}
                  onChange={(e) => {
                    const v = Number((e.target as HTMLInputElement).value);
                    if (v >= 1) change(loaded.sheetName, v - 1);
                  }}
                />
              </label>
              {loaded.headerRowOverride !== undefined ? (
                <button type="button" class="secondary" onClick={() => change(loaded.sheetName)}>
                  Detect automatically
                </button>
              ) : (
                <span class="muted">
                  detected automatically{t.headerRows.length > 1 ? ` (two-row header: rows ${t.headerRows.map((r) => r + 1).join(' + ')})` : ''}
                </span>
              )}
            </div>
            <p>
              <strong>{t.rows.length}</strong> holdings rows{t.split && t.rows.length !== t.split.rowsInFile ? ` (of ${t.split.rowsInFile} in the file)` : ''},{' '}
              <strong>{t.headers.length}</strong> columns.{' '}
              {loaded.workbook.notes.join(' ')}
              {t.droppedColumns.length > 0 && ` ${t.droppedColumns.length} empty column(s) ignored.`}
            </p>
          </div>

          {t.split && needsChoice(t.split) && <SlicePicker loaded={loaded} onLoaded={onLoaded} />}

          {grouped.length > 0 && (
            <div class="card">
              <h3>Skipped rows ({t.skipped.length})</h3>
              <p class="muted">Row numbers are as in the spreadsheet. If a real holding was skipped, set the header row manually or fix the file.</p>
              {grouped.map(([reason, rows]) => (
                <details key={reason}>
                  <summary>
                    {REASON_LABEL[reason as SkipReason]}: {rows.length}
                  </summary>
                  <table class="grid compact">
                    <tbody>
                      {rows.slice(0, 50).map((s) => (
                        <tr key={s.row}>
                          <td class="num">{s.row + 1}</td>
                          <td>{s.detail}</td>
                          <td class="muted">{s.preview}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </details>
              ))}
            </div>
          )}

          <div class="card">
            <h3>Preview (first 10 holdings)</h3>
            <div class="table-wrap">
              <table class="grid compact">
                <thead>
                  <tr>
                    <th>Row</th>
                    {t.headers.map((h) => (
                      <th key={h}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {t.rows.slice(0, 10).map((r) => (
                    <tr key={r.row}>
                      <td class="num">{r.row + 1}</td>
                      {r.cells.map((c, i) => (
                        <td key={i}>{cellText(c)}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div>
            <button type="button" class="primary" disabled={!t.rows.length} onClick={onContinue}>
              Continue to column mapping →
            </button>
          </div>
        </>
      )}
    </section>
  );
}

/** A file with several portfolios and/or dates: one TPT is one portfolio on one date, so pick which. */
function SlicePicker({ loaded, onLoaded }: { loaded: LoadedSheet; onLoaded: (s: LoadedSheet) => void }) {
  const split = loaded.table.split!;
  const { choice } = split;
  const dates = datesFor(split, choice.portfolio);
  const headerOf = (i: number | undefined) => (i === undefined ? '' : loaded.table.headers[i]);
  const parts = [
    split.portfolios.length > 1 ? `${split.portfolios.length} portfolios` : '',
    split.dates.length > 1 ? `${split.dates.length} dates` : '',
  ].filter(Boolean);
  const pick = (next: { portfolio?: string; date?: string }) => {
    const portfolio = next.portfolio ?? choice.portfolio;
    const available = datesFor(split, portfolio);
    // Keep the date when the new portfolio has it, else its latest date.
    const date = next.date ?? (choice.date && available.includes(choice.date) ? choice.date : available.at(-1));
    onLoaded(chooseSlice(loaded, { portfolio, date }));
  };
  return (
    <div class="card">
      <h3>This file holds {parts.join(' on ')}</h3>
      <p class="muted">
        A TPT is for one portfolio on one valuation date. Choose which to convert; the other rows are left out. The rows are picked by the column
        {split.portfolioCol !== undefined && split.dateCol !== undefined ? 's' : ''}{' '}
        {[headerOf(split.portfolioCol), headerOf(split.dateCol)].filter(Boolean).map((h) => `"${h}"`).join(' and ')}.
      </p>
      <div class="filters">
        {split.portfolioCol !== undefined && (
          <label>
            Portfolio{' '}
            <select aria-label="Portfolio to convert" value={choice.portfolio} onChange={(e) => pick({ portfolio: (e.target as HTMLSelectElement).value })}>
              {split.portfolios.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          </label>
        )}
        {split.dateCol !== undefined && (
          <label>
            Date{' '}
            <select aria-label="Date to convert" value={choice.date} onChange={(e) => pick({ date: (e.target as HTMLSelectElement).value })}>
              {dates.map((d) => (
                <option key={d} value={d}>
                  {d}
                  {d === dates.at(-1) ? ' (latest)' : ''}
                </option>
              ))}
            </select>
          </label>
        )}
        <span class="muted">{loaded.table.rows.length} holdings</span>
      </div>
    </div>
  );
}
