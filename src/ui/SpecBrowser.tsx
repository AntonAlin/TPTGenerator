import { useMemo, useState } from 'preact/hooks';
import { spec } from '../spec/index.ts';
import type { Requirement, SpecField } from '../spec/types.ts';

const REQ_LABEL: Record<Requirement, string> = {
  mandatory: 'Mandatory',
  conditional: 'Conditional',
  optional: 'Optional',
  indicative: 'Indicative',
  not_applicable: 'N/A',
  unknown: 'Unknown',
};

const CIC_CATEGORIES = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', 'A', 'B', 'C', 'D', 'E', 'F'];

export function SpecBrowser() {
  const [query, setQuery] = useState('');
  const [req, setReq] = useState<Requirement | ''>('');
  const [changedOnly, setChangedOnly] = useState(false);
  const [selected, setSelected] = useState<SpecField | null>(null);

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return spec.fields.filter(
      (f) =>
        (!req || f.requirement === req) &&
        (!changedOnly || f.changedFromPreviousVersion) &&
        (!q || `${f.header} ${f.definition} ${f.section}`.toLowerCase().includes(q)),
    );
  }, [query, req, changedOnly]);

  const counts = useMemo(() => {
    const c: Partial<Record<Requirement, number>> = {};
    for (const f of spec.fields) c[f.requirement] = (c[f.requirement] ?? 0) + 1;
    return c;
  }, []);

  return (
    <section class="spec-browser">
      <div class="spec-summary">
        <h2>TPT {spec.meta.version} field reference</h2>
        <p class="muted">
          {spec.fields.length} fields in {spec.sections.length} sections.{' '}
          {Object.entries(counts)
            .map(([k, v]) => `${REQ_LABEL[k as Requirement]}: ${v}`)
            .join(' · ')}
          . Version field value: <code>{spec.meta.versionFieldValue}</code>.
        </p>
        {spec.warnings.length > 0 && (
          <details class="warnings">
            <summary>{spec.warnings.length} spec parsing notes</summary>
            <ul>
              {spec.warnings.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          </details>
        )}
      </div>

      <div class="filters">
        <input
          type="search"
          placeholder="Search fields…"
          value={query}
          onInput={(e) => setQuery((e.target as HTMLInputElement).value)}
          aria-label="Search fields"
        />
        <select value={req} onChange={(e) => setReq((e.target as HTMLSelectElement).value as Requirement | '')} aria-label="Requirement">
          <option value="">All requirement levels</option>
          {(Object.keys(REQ_LABEL) as Requirement[])
            .filter((k) => counts[k])
            .map((k) => (
              <option key={k} value={k}>
                {REQ_LABEL[k]}
              </option>
            ))}
        </select>
        <label class="checkbox">
          <input type="checkbox" checked={changedOnly} onChange={(e) => setChangedOnly((e.target as HTMLInputElement).checked)} />
          Changed since previous version
        </label>
        <span class="muted">{rows.length} shown</span>
      </div>

      <div class="spec-layout">
        <div class="table-wrap">
          <table class="grid">
            <thead>
              <tr>
                <th>#</th>
                <th>Header</th>
                <th>Req.</th>
                <th>Type</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((f) => (
                <tr
                  key={f.id}
                  class={`${selected?.id === f.id ? 'selected' : ''} ${f.mustBeEmpty ? 'dim' : ''}`}
                  onClick={() => setSelected(f)}
                  tabIndex={0}
                  onKeyDown={(e) => e.key === 'Enter' && setSelected(f)}
                >
                  <td class="num">{f.id}</td>
                  <td>
                    {f.header}
                    {f.changedFromPreviousVersion && <span class="badge changed">changed</span>}
                  </td>
                  <td>
                    <span class={`badge req-${f.requirement}`}>{f.requirementRaw || '–'}</span>
                  </td>
                  <td>{f.dataType}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <aside class="detail">
          {selected ? (
            <FieldDetail f={selected} />
          ) : (
            <p class="muted">Select a field to see its official definition, codification and CIC applicability.</p>
          )}
        </aside>
      </div>
    </section>
  );
}

function FieldDetail({ f }: { f: SpecField }) {
  return (
    <div>
      <h3>
        {f.id} · {f.name}
      </h3>
      <p class="muted">{f.section}</p>
      <dl>
        <dt>Export header</dt>
        <dd>
          <code>{f.header}</code>
        </dd>
        <dt>Requirement</dt>
        <dd>
          {REQ_LABEL[f.requirement]} ({f.requirementRaw || 'blank'})
          {f.mustBeEmpty && ' — must be left empty (no longer maintained)'}
        </dd>
        <dt>Definition</dt>
        <dd class="pre">{f.definition || '—'}</dd>
        <dt>Codification</dt>
        <dd class="pre">{f.codification || '—'}</dd>
        <dt>Comment</dt>
        <dd class="pre">{f.comment || '—'}</dd>
        <dt>Data type (inferred)</dt>
        <dd>
          {f.dataType} <span class="muted">via rule {f.dataTypeRule}</span>
          {f.maxLength ? `, max length ${f.maxLength}` : ''}
        </dd>
        {f.codeList && (
          <>
            <dt>Closed list (from {f.codeListSource})</dt>
            <dd>
              <ul class="codes">
                {f.codeList.map((c) => (
                  <li key={c.code}>
                    <code>{c.code}</code> {c.label !== c.code && c.label}
                  </li>
                ))}
              </ul>
            </dd>
          </>
        )}
        <dt>Applies to CIC categories</dt>
        <dd>
          <div class="cic-row">
            {CIC_CATEGORIES.map((c) => (
              <span key={c} class={`cic ${f.cicApplicability[c] ? 'on' : ''}`} title={f.cicApplicability[c] ?? 'not applicable'}>
                {c}
                {f.cicApplicability[c] && f.cicApplicability[c].toLowerCase() !== 'x' ? `:${f.cicApplicability[c]}` : ''}
              </span>
            ))}
          </div>
        </dd>
        {Object.keys(f.otherRegimes).length > 0 && (
          <>
            <dt>Other regimes</dt>
            <dd>
              {Object.entries(f.otherRegimes)
                .map(([k, v]) => `${k}: ${v}`)
                .join(' · ')}
            </dd>
          </>
        )}
        <dt>FundsXML XPath</dt>
        <dd>
          <code class="wrap">{f.xpath || '—'}</code>
        </dd>
      </dl>
    </div>
  );
}
