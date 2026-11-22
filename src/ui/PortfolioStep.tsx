import { useEffect, useState } from 'preact/hooks';
import { CLASS_FIELDS, FUND_FIELDS, PORTFOLIO_FIELDS, baseCurrencyOf, resolvePortfolioField, type FundProfile, type FundProfileRepository, type PortfolioState } from '../portfolio/portfolio.ts';
import { currencies, tptExtraCurrencies } from '../data/iso.ts';
import { DAY_COUNTS, FREQUENCIES, type DayCount, type Frequency } from '../derive/fixedIncome.ts';
import type { FxEntry, ImpliedFx, MvConvention } from '../derive/valuation.ts';
import type { PortfolioDerivations } from '../derive/resolve.ts';
import { FieldInput, SourceBadge, display } from './fields.tsx';
import { downloadBlob } from './session.ts';

interface Props {
  portfolio: PortfolioState;
  setPortfolio: (p: PortfolioState) => void;
  fx: { table: Record<string, FxEntry>; missing: string[] };
  implied: Record<string, ImpliedFx>;
  derivations: PortfolioDerivations;
  navNote?: string;
  suggestions: { baseCurrency?: string; baseWhy?: string; valuationDate?: string; valuationDateWhy?: string; portfolioName?: string; portfolioNameWhy?: string; nav?: number; navWhy?: string };
  fundRepo: FundProfileRepository;
  onContinue: () => void;
}

const CCY = [...currencies.map((c) => c.code), ...tptExtraCurrencies.map((c) => c.code)];

export function PortfolioStep({ portfolio: p, setPortfolio, fx, implied, derivations, navNote, suggestions, fundRepo, onContinue }: Props) {
  const update = (fn: (draft: PortfolioState) => void) => {
    const next = structuredClone(p);
    fn(next);
    setPortfolio(next);
  };
  const setValue = (id: string, v: string) => update((d) => (d.values[id] = v));
  const base = baseCurrencyOf(p);
  const valuationDate = p.values['6'] ?? '';

  const formFields = (p.level === 'fund' ? PORTFOLIO_FIELDS : FUND_FIELDS).filter((f) => f.id !== '4' && f.id !== '6');

  return (
    <section class="stack">
      <div class="card">
        <h2>Fund and share class data</h2>
        <div class="filters">
          <span>Report at</span>
          <label class="checkbox">
            <input type="radio" name="level" checked={p.level === 'fund'} onChange={() => update((d) => (d.level = 'fund'))} /> fund level
          </label>
          <label class="checkbox">
            <input type="radio" name="level" checked={p.level === 'share_class'} onChange={() => update((d) => (d.level = 'share_class'))} /> share class level (one TPT per class)
          </label>
        </div>
        {suggestions.portfolioName && !p.values['3'] && (
          <p class="small">
            <button type="button" class="linklike" onClick={() => setValue('3', suggestions.portfolioName!)}>
              Use “{suggestions.portfolioName}” as 3 · Portfolio name
            </button>{' '}
            <span class="muted">({suggestions.portfolioNameWhy})</span>
          </p>
        )}
        {suggestions.nav !== undefined && p.level === 'fund' && !p.values['5'] && (
          <p class="small">
            <button type="button" class="linklike" onClick={() => setValue('5', String(suggestions.nav))}>
              Use {suggestions.nav.toLocaleString('en-US')} as 5 · Net asset valuation
            </button>{' '}
            <span class="muted">({suggestions.navWhy})</span>
          </p>
        )}
      </div>

      <div class="card">
        <h3>Valuation</h3>
        <div class="form-grid">
          <label class="field">
            <span class="field-label">
              <span class="badge req-mandatory">M</span> 6 · Valuation date
            </span>
            <input type="date" value={valuationDate} onInput={(e) => setValue('6', (e.target as HTMLInputElement).value)} />
            {!valuationDate && suggestions.valuationDate && (
              <button type="button" class="linklike small" onClick={() => setValue('6', suggestions.valuationDate!)}>
                Use {suggestions.valuationDate} ({suggestions.valuationDateWhy ?? 'found above the table in the file'})
              </button>
            )}
          </label>
          <label class="field">
            <span class="field-label">
              <span class="badge req-mandatory">M</span> {p.level === 'fund' ? '4 · Portfolio currency' : 'Fund base currency'}
            </span>
            <select
              value={base ?? ''}
              onChange={(e) => {
                const v = (e.target as HTMLSelectElement).value;
                update((d) => (d.level === 'fund' ? (d.values['4'] = v) : (d.baseCurrency = v)));
              }}
            >
              <option value="">—</option>
              {CCY.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
            {!base && suggestions.baseCurrency && (
              <button type="button" class="linklike small" onClick={() => update((d) => (d.level === 'fund' ? (d.values['4'] = suggestions.baseCurrency!) : (d.baseCurrency = suggestions.baseCurrency)))}>
                Use {suggestions.baseCurrency} ({suggestions.baseWhy})
              </button>
            )}
          </label>
          <label class="field">
            <span class="field-label">Market values in the file</span>
            <select value={p.conventions.mvConvention} onChange={(e) => update((d) => (d.conventions.mvConvention = (e.target as HTMLSelectElement).value as MvConvention))}>
              <option value="auto">Detect per bond (default: exclude accrued interest)</option>
              <option value="clean">Exclude accrued interest (clean)</option>
              <option value="dirty">Include accrued interest (dirty)</option>
            </select>
          </label>
          <label class="field">
            <span class="field-label">Day count for accrued interest</span>
            <select value={p.conventions.dayCount} onChange={(e) => update((d) => (d.conventions.dayCount = (e.target as HTMLSelectElement).value as DayCount))}>
              {DAY_COUNTS.map((dc) => (
                <option key={dc} value={dc}>
                  {dc}
                </option>
              ))}
            </select>
          </label>
          <div class="field">
            <span class="field-label">Assumed coupon frequency (for accrued interest, yield and duration)</span>
            <div class="freq-list">
              {Object.entries(p.conventions.frequencyByCurrency).map(([c, f]) => (
                <label key={c} class="small">
                  {c === '*' ? 'Default' : c}{' '}
                  <select value={f} onChange={(e) => update((d) => (d.conventions.frequencyByCurrency[c] = Number((e.target as HTMLSelectElement).value) as Frequency))}>
                    {FREQUENCIES.map((x) => (
                      <option key={x} value={x}>
                        {x}/yr
                      </option>
                    ))}
                  </select>
                </label>
              ))}
            </div>
          </div>
          <label class="checkbox small">
            <input type="checkbox" checked={p.conventions.issuerCountryFromIsin} onChange={(e) => update((d) => (d.conventions.issuerCountryFromIsin = (e.target as HTMLInputElement).checked))} />
            Estimate issuer country from the ISIN prefix when nothing better is known (flagged as estimated)
          </label>
        </div>
      </div>

      <div class="card">
        <h3>FX rates on the valuation date</h3>
        <p class="muted small">1 unit of the currency = rate × {base ?? 'base currency'}. Rates implied by the file are used unless you enter your own.</p>
        {!base ? (
          <p class="warn">Choose the portfolio currency first.</p>
        ) : (
          <table class="grid compact">
            <thead>
              <tr>
                <th>Currency</th>
                <th>Implied from file</th>
                <th>Your rate</th>
                <th>Used</th>
              </tr>
            </thead>
            <tbody>
              {[...new Set([...Object.keys(fx.table), ...fx.missing])].sort().map((c) => {
                const im = implied[c];
                const used = fx.table[c];
                return (
                  <tr key={c} class={used ? '' : 'missing-row'}>
                    <td>{c}</td>
                    <td>
                      {c === base ? '—' : im ? `${display(Number(im.rate.toPrecision(8)))} (${im.rows} row${im.rows > 1 ? 's' : ''}${im.maxDeviation > 0.005 ? `, rows differ by up to ${(im.maxDeviation * 100).toFixed(1)}%` : ''})` : 'not available'}
                    </td>
                    <td>
                      {c === base ? (
                        '1'
                      ) : (
                        <input
                          type="text"
                          inputMode="decimal"
                          class="narrow-wide"
                          value={p.fxUser[c] ?? ''}
                          placeholder={im ? '' : 'required'}
                          onInput={(e) => {
                            const v = Number((e.target as HTMLInputElement).value.replace(',', '.'));
                            update((d) => {
                              if (v > 0) d.fxUser[c] = v;
                              else delete d.fxUser[c];
                            });
                          }}
                        />
                      )}
                    </td>
                    <td>{used ? `${display(Number(used.rate.toPrecision(8)))} (${used.source})` : <span class="error">missing</span>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {p.level === 'share_class' && (
        <div class="card">
          <h3>Share classes</h3>
          <p class="muted small">One TPT file is produced per share class. Holdings and weights are the same for every class; NAV, currency and price are per class.</p>
          <div class="table-wrap unbounded">
            <table class="grid compact">
              <thead>
                <tr>
                  {CLASS_FIELDS.map((f) => (
                    <th key={f.id} title={f.definition}>
                      {f.id} · {f.name}
                    </th>
                  ))}
                  <th />
                </tr>
              </thead>
              <tbody>
                {p.shareClasses.map((c, i) => (
                  <tr key={i}>
                    {CLASS_FIELDS.map((f) => (
                      <td key={f.id}>
                        <FieldInput compact f={f} value={c.values[f.id] ?? ''} onChange={(v) => update((d) => (d.shareClasses[i].values[f.id] = v))} />
                      </td>
                    ))}
                    <td>
                      <button type="button" class="secondary small" disabled={p.shareClasses.length < 2} onClick={() => update((d) => d.shareClasses.splice(i, 1))}>
                        Remove
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <button type="button" class="secondary small" onClick={() => update((d) => d.shareClasses.push({ values: {} }))}>
            Add share class
          </button>
        </div>
      )}

      <div class="card">
        <h3>{p.level === 'fund' ? 'Fund' : 'Fund-level'} fields</h3>
        <p class="muted small">
          Generated from the TPT template. Hover a label for the official definition. Blank fields use the derived value shown, or stay empty in the export.
          {navNote && ` NAV: ${navNote}`}
        </p>
        <div class="form-grid">
          {formFields.map((f) => (
            <FieldInput key={f.id} f={f} value={p.values[f.id] ?? ''} onChange={(v) => setValue(f.id, v)} fallback={resolvePortfolioField(f.id, { ...p.values, [f.id]: '' }, derivations)} />
          ))}
        </div>
        <p class="small">
          NAV used for weights: <SourceBadge r={derivations.nav} /> {display(derivations.nav.value)} {base}
          {derivations.nav.note && <span class="muted"> — {derivations.nav.note}</span>}
        </p>
      </div>

      <FundProfiles repo={fundRepo} current={p} onLoad={(s) => setPortfolio({ ...s, values: { ...s.values, ...(valuationDate ? { '6': valuationDate } : {}) } })} />

      <div>
        <button type="button" class="primary" onClick={onContinue}>
          Continue to export →
        </button>
      </div>
    </section>
  );
}

function FundProfiles({ repo, current, onLoad }: { repo: FundProfileRepository; current: PortfolioState; onLoad: (s: PortfolioState) => void }) {
  const [list, setList] = useState<FundProfile[]>([]);
  const [name, setName] = useState(current.values['3'] ?? '');
  const [msg, setMsg] = useState<string | null>(null);
  const [v, setV] = useState(0);
  useEffect(() => {
    repo.list().then(setList);
  }, [repo, v]);
  return (
    <details class="card">
      <summary>
        <strong>Fund profiles ({list.length})</strong> <span class="muted small">— reuse identification, management company and conventions next period</span>
      </summary>
      <div class="filters">
        <input type="text" placeholder="Profile name" value={name} onInput={(e) => setName((e.target as HTMLInputElement).value)} />
        <button
          type="button"
          class="secondary"
          disabled={!name.trim()}
          onClick={async () => {
            await repo.save(name.trim(), current);
            setMsg(`Saved fund profile "${name.trim()}" (NAV, dates and FX rates are not saved).`);
            setV(v + 1);
          }}
        >
          Save current as profile
        </button>
        <button type="button" class="secondary" disabled={!list.length} onClick={async () => downloadBlob(JSON.stringify(await repo.exportAll(), null, 2), 'tpt-fund-profiles.json', 'application/json')}>
          Export
        </button>
        <label class="button secondary">
          Import…
          <input
            type="file"
            accept=".json"
            hidden
            onChange={async (e) => {
              const file = (e.target as HTMLInputElement).files?.[0];
              if (!file) return;
              try {
                setMsg(`Imported ${await repo.importAll(JSON.parse(await file.text()))} profile(s).`);
                setV(v + 1);
              } catch (err) {
                setMsg(String(err instanceof Error ? err.message : err));
              }
            }}
          />
        </label>
      </div>
      {msg && <p class="ok small">{msg}</p>}
      {list.length > 0 && (
        <table class="grid compact">
          <tbody>
            {list.map((fp) => (
              <tr key={fp.name}>
                <td>{fp.name}</td>
                <td class="muted">{fp.state.level === 'fund' ? 'fund level' : `${fp.state.shareClasses.length} share class(es)`}</td>
                <td class="muted">{fp.updatedAt.slice(0, 10)}</td>
                <td>
                  <button type="button" class="secondary small" onClick={() => onLoad(structuredClone(fp.state))}>
                    Load
                  </button>{' '}
                  <button
                    type="button"
                    class="secondary small"
                    onClick={async () => {
                      if (confirm(`Delete fund profile "${fp.name}"?`)) {
                        await repo.remove(fp.name);
                        setV(v + 1);
                      }
                    }}
                  >
                    Delete
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </details>
  );
}
