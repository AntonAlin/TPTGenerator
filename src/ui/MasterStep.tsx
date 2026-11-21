import { useMemo, useState } from 'preact/hooks';
import { ATTRS, ATTR, attrOptions, isNaceFormat, isRequired, type AttrDef, type AttrKey } from '../master/attributes.ts';
import type { SecurityMaster } from '../master/securityMaster.ts';
import type { ResolveResult, ResolvedHolding } from '../derive/resolve.ts';
import type { Resolved, Scalar } from '../derive/provenance.ts';
import { parseCic } from '../data/cic.ts';
import { countries } from '../data/iso.ts';
import { naceItems, naceLookup, naceClassification } from '../data/nace.ts';
import { SOURCE_LABEL, SourceBadge, display } from './fields.tsx';
import { downloadBlob } from './session.ts';

interface Props {
  result: ResolveResult;
  master: SecurityMaster;
  persistent: boolean;
  onChanged: () => void;
  onContinue: () => void;
}

const GRID = ATTRS.filter((a) => a.grid);

function needsAttention(r: ResolvedHolding): boolean {
  const cic = typeof r.attrs.cic.value === 'string' ? r.attrs.cic.value : undefined;
  return r.issues.length > 0 || ATTRS.some((a) => (isRequired(a.key, cic) && r.attrs[a.key].source === 'missing') || r.attrs[a.key].confidence === 'low');
}

export function MasterStep({ result, master, persistent, onChanged, onContinue }: Props) {
  const [filter, setFilter] = useState<'all' | 'attention'>('attention');
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<number | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return result.rows.filter(
      (r) =>
        (filter === 'all' || needsAttention(r)) &&
        (!q || `${r.attrs.name.value ?? ''} ${r.attrs.identifier.value ?? ''} ${r.attrs.issuer_name.value ?? ''}`.toLowerCase().includes(q)),
    );
  }, [result, filter, query]);
  const attentionCount = result.rows.filter(needsAttention).length;
  const sel = selected !== null ? result.rows[selected] : undefined;

  return (
    <section class="stack">
      <div class="card">
        <h2>Security master</h2>
        <p class="muted">
          Fill in or correct instrument and issuer data. Your entries are saved in this browser{persistent ? '' : ' (storage unavailable: export to keep them)'} and reused for every future
          file. They take priority over derived values, and over file values when you tick “override file”. Resolution order: file → your master → derived → blank.
        </p>
        <p class="legend small">
          {(['file', 'master', 'user', 'derived', 'missing'] as const).map((s) => (
            <span key={s}>
              <SourceBadge r={{ source: s }} /> {SOURCE_LABEL[s]}{' '}
            </span>
          ))}
          <span>
            <SourceBadge r={{ source: 'derived', confidence: 'low' }} /> low confidence
          </span>
        </p>
        <div class="filters">
          <label class="checkbox">
            <input type="radio" checked={filter === 'attention'} onChange={() => setFilter('attention')} /> Needs attention ({attentionCount})
          </label>
          <label class="checkbox">
            <input type="radio" checked={filter === 'all'} onChange={() => setFilter('all')} /> All holdings ({result.rows.length})
          </label>
          <input type="search" placeholder="Search name, id, issuer…" value={query} onInput={(e) => setQuery((e.target as HTMLInputElement).value)} />
          <span class="muted small">{master.size} record(s) in your master</span>
          <button type="button" class="secondary small" disabled={!master.size} onClick={() => downloadBlob(JSON.stringify(master.export(), null, 2), `tpt-security-master-${new Date().toISOString().slice(0, 10)}.json`, 'application/json')}>
            Export master
          </button>
          <label class="button secondary small">
            Import master…
            <input
              type="file"
              accept=".json"
              hidden
              onChange={async (e) => {
                const file = (e.target as HTMLInputElement).files?.[0];
                if (!file) return;
                try {
                  const r = await master.import(JSON.parse(await file.text()));
                  setMsg(`Imported ${r.records} record(s)${r.skipped ? `, skipped ${r.skipped}` : ''}.`);
                  onChanged();
                } catch (err) {
                  setMsg(String(err instanceof Error ? err.message : err));
                }
              }}
            />
          </label>
        </div>
        {msg && <p class="ok small">{msg}</p>}
      </div>

      <div class="master-layout">
        <div class="table-wrap">
          <table class="grid compact master-grid">
            <thead>
              <tr>
                <th>Row</th>
                {GRID.map((a) => (
                  <th key={a.key} title={a.tpt.length ? `TPT field ${a.tpt.join(', ')}` : 'Internal'}>
                    {a.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.holding.index} class={selected === r.holding.index ? 'selected' : ''} onClick={() => setSelected(r.holding.index)} tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && setSelected(r.holding.index)}>
                  <td class="num">
                    {r.holding.row + 1}
                    {r.issues.length > 0 && <span class="error" title={r.issues.join('\n')}> !</span>}
                  </td>
                  {GRID.map((a) => {
                    const v = r.attrs[a.key];
                    const cic = typeof r.attrs.cic.value === 'string' ? r.attrs.cic.value : undefined;
                    const req = isRequired(a.key, cic) && v.source === 'missing';
                    return (
                      <td key={a.key} class={req ? 'req-missing' : ''}>
                        <SourceBadge r={v} /> {display(v.value)}
                      </td>
                    );
                  })}
                </tr>
              ))}
              {!rows.length && (
                <tr>
                  <td colSpan={GRID.length + 1} class="muted">
                    Nothing needs attention. Switch to “All holdings” to review everything.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        <aside class="detail">
          {sel ? <HoldingDetail key={sel.holding.index} r={sel} all={result.rows} master={master} onChanged={onChanged} /> : <p class="muted">Select a holding to see every value, where it came from, and to edit it.</p>}
        </aside>
      </div>

      <div>
        <button type="button" class="primary" onClick={onContinue}>
          Continue →
        </button>
      </div>
    </section>
  );
}

function HoldingDetail({ r, all, master, onChanged }: { r: ResolvedHolding; all: ResolvedHolding[]; master: SecurityMaster; onChanged: () => void }) {
  const [editing, setEditing] = useState<AttrKey | null>(null);
  const cic = typeof r.attrs.cic.value === 'string' ? r.attrs.cic.value : undefined;
  return (
    <div>
      <h3>{display(r.attrs.name.value) || '(no name)'}</h3>
      <p class="muted small">
        {display(r.attrs.identifier.value)} · row {r.holding.row + 1}
        {r.holding.section ? ` · section "${r.holding.section}"` : ''}
      </p>
      <p class="small">
        <strong>{display(r.attrs.asset_class.value)}</strong> ({r.assetClass.confidence} confidence): {r.assetClass.evidence.join('; ')}
      </p>
      {r.issues.length > 0 && (
        <ul class="error small">
          {r.issues.map((i) => (
            <li key={i}>{i}</li>
          ))}
        </ul>
      )}
      <table class="grid compact detail-table">
        <tbody>
          {ATTRS.filter((a) => a.key !== 'asset_class').map((a) => {
            const v = r.attrs[a.key];
            const req = isRequired(a.key, cic);
            return (
              <tr key={a.key} class={req && v.source === 'missing' ? 'req-missing' : ''}>
                <td>
                  {a.label}
                  <div class="muted small">{a.tpt.length ? `TPT ${a.tpt.join(', ')}${req ? ' · mandatory' : ''}` : 'internal'}</div>
                </td>
                <td>
                  <SourceBadge r={v} /> {display(v.value)}
                  <div class="muted small">{[v.method, v.note].filter(Boolean).join(' — ')}</div>
                  {a.key === 'cic' && r.cicAlternatives.length > 0 && v.source === 'derived' && <div class="small">Alternatives: {r.cicAlternatives.join(', ')}</div>}
                  {editing === a.key && <AttrEditor attr={ATTR[a.key]} r={r} all={all} current={v} master={master} onDone={() => { setEditing(null); onChanged(); }} />}
                </td>
                <td>
                  {a.master && editing !== a.key && (
                    <button type="button" class="secondary small" onClick={() => setEditing(a.key)}>
                      Edit
                    </button>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function parseInput(attr: AttrDef, raw: string): { value?: Scalar; error?: string } {
  const s = raw.trim();
  if (!s) return {};
  switch (attr.kind) {
    case 'number': {
      const n = Number(s.replace(',', '.'));
      return Number.isFinite(n) ? { value: n } : { error: 'Not a number.' };
    }
    case 'date':
      return /^\d{4}-\d{2}-\d{2}$/.test(s) ? { value: s } : { error: 'Use YYYY-MM-DD.' };
    case 'cic': {
      const c = parseCic(s);
      return c.valid ? { value: c.code } : { error: c.errors.join(' ') };
    }
    case 'nace': {
      const code = s.split(/\s/)[0].toUpperCase();
      if (!isNaceFormat(code)) return { error: 'Section letter plus up to 4 digits, no dots (e.g. K6419).' };
      return naceLookup(code) ? { value: code } : { error: `${code} is not in the ${naceClassification} list.` };
    }
    default:
      return { value: s };
  }
}

function AttrEditor({ attr, r, all, current, master, onDone }: { attr: AttrDef; r: ResolvedHolding; all: ResolvedHolding[]; current: Resolved; master: SecurityMaster; onDone: () => void }) {
  const level = attr.master!;
  const key = level === 'instrument' ? r.instrumentKey : r.issuerKey;
  const [raw, setRaw] = useState(current.value !== undefined ? String(current.value) : '');
  const [override, setOverride] = useState(false);
  const [applyIssuer, setApplyIssuer] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const options = attr.kind === 'code' ? attrOptions(attr.key) : attr.kind === 'country' ? [...countries.map((c) => ({ code: c.code, label: c.name })), { code: 'XA', label: 'Supranational' }, { code: 'EU', label: 'EU institutions' }] : undefined;
  const sameIssuer = r.issuerKey ? all.filter((x) => x.issuerKey === r.issuerKey && x.instrumentKey && x.instrumentKey !== r.instrumentKey) : [];
  const issuerCount = r.issuerKey ? all.filter((x) => x.issuerKey === r.issuerKey).length : 0;
  const label = level === 'instrument' ? String(r.attrs.name.value ?? r.attrs.identifier.value ?? key) : String(r.attrs.issuer_name.value ?? r.attrs.issuer_id.value ?? key);

  if (!key) return <p class="warn small">{level === 'issuer' ? 'Set the issuer name (or LEI) first: issuer data is stored per issuer.' : 'This holding has no identifier or name to store data under.'}</p>;

  async function save(clear = false) {
    const parsed = clear ? {} : parseInput(attr, raw);
    if (parsed.error) return setError(parsed.error);
    await master.set(attr.key, key!, label, parsed.value, override);
    if (applyIssuer && level === 'instrument') {
      for (const x of sameIssuer) await master.set(attr.key, x.instrumentKey!, String(x.attrs.name.value ?? x.instrumentKey), parsed.value, override);
    }
    onDone();
  }

  return (
    <div class="editor">
      {options ? (
        <select value={raw} onChange={(e) => setRaw((e.target as HTMLSelectElement).value)}>
          <option value="">—</option>
          {options.map((o) => (
            <option key={o.code} value={o.code}>
              {o.code} – {o.label.slice(0, 70)}
            </option>
          ))}
        </select>
      ) : (
        <>
          <input
            type={attr.kind === 'date' ? 'date' : 'text'}
            value={raw}
            list={attr.kind === 'nace' ? 'nace-list' : undefined}
            onInput={(e) => setRaw((e.target as HTMLInputElement).value)}
            placeholder={attr.kind === 'cic' ? 'e.g. SE21' : attr.kind === 'nace' ? 'Type a code or words, e.g. bank' : ''}
          />
          {attr.kind === 'nace' && (
            <>
              <datalist id="nace-list">
                {naceItems.map((n) => (
                  <option key={n.code} value={`${n.code} ${n.label}`} />
                ))}
              </datalist>
              {naceLookup(raw.split(/\s/)[0] ?? '') && <span class="muted small">{naceLookup(raw.split(/\s/)[0])!.label}</span>}
            </>
          )}
        </>
      )}
      {attr.key === 'cic' && r.cicAlternatives.length > 0 && (
        <div class="small">
          {[String(current.value ?? ''), ...r.cicAlternatives].filter(Boolean).map((c) => (
            <button key={c} type="button" class="linklike small" onClick={() => setRaw(c)}>
              {c}
            </button>
          ))}
        </div>
      )}
      <div class="small">
        {current.source === 'file' && (
          <label class="checkbox">
            <input type="checkbox" checked={override} onChange={(e) => setOverride((e.target as HTMLInputElement).checked)} /> override the file value
          </label>
        )}
        {level === 'instrument' && sameIssuer.length > 0 && (
          <label class="checkbox">
            <input type="checkbox" checked={applyIssuer} onChange={(e) => setApplyIssuer((e.target as HTMLInputElement).checked)} /> apply to all {sameIssuer.length + 1} holdings of this issuer
          </label>
        )}
        {level === 'issuer' && <span class="muted">Stored for the issuer: applies to {issuerCount} holding(s) here and to future files.</span>}
      </div>
      {error && <p class="error small">{error}</p>}
      <button type="button" class="primary small" onClick={() => save()}>
        Save to master
      </button>{' '}
      {current.source === 'master' && (
        <button type="button" class="secondary small" onClick={() => save(true)}>
          Remove from master
        </button>
      )}{' '}
      <button type="button" class="secondary small" onClick={onDone}>
        Cancel
      </button>
    </div>
  );
}
