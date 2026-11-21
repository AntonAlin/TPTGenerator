/**
 * Shared UI bits: an input generated from a spec field's data type, source badges.
 */
import type { SpecField } from '../spec/types.ts';
import { countries, currencies, tptExtraCurrencies } from '../data/iso.ts';
import { validateFieldValue } from '../spec/validate.ts';
import type { Resolved, Source } from '../derive/provenance.ts';

const REQ_SHORT: Record<string, string> = { mandatory: 'M', conditional: 'C', optional: 'O', indicative: 'I', not_applicable: 'N/A', unknown: '?' };

export const SOURCE_LABEL: Record<Source, string> = {
  file: 'From file',
  master: 'From your security master',
  user: 'Entered by you',
  derived: 'Derived',
  missing: 'Missing',
};

export function SourceBadge({ r }: { r: Resolved }) {
  const title = [SOURCE_LABEL[r.source], r.method, r.confidence && `confidence: ${r.confidence}`, r.note].filter(Boolean).join('\n');
  return (
    <span class={`src src-${r.source} ${r.confidence === 'low' ? 'low' : ''}`} title={title} aria-label={title}>
      {r.source === 'missing' ? '–' : r.source[0].toUpperCase()}
    </span>
  );
}

export const display = (v: unknown) => (v === undefined || v === null ? '' : typeof v === 'number' ? (Number.isInteger(v) ? v.toLocaleString('en-US') : v.toLocaleString('en-US', { maximumFractionDigits: 6 })) : String(v));

const CURRENCY_OPTIONS = [...currencies.map((c) => ({ code: c.code, label: c.name })), ...tptExtraCurrencies];

interface FieldInputProps {
  f: SpecField;
  value: string;
  onChange: (v: string) => void;
  /** Value used when the input is blank (derived), shown as a hint. */
  fallback?: Resolved;
  compact?: boolean;
}

export function FieldInput({ f, value, onChange, fallback, compact }: FieldInputProps) {
  const error = validateFieldValue(f, value);
  const set = (e: Event) => onChange((e.target as HTMLInputElement).value);
  let input;
  if (f.dataType === 'date') input = <input type="date" value={value} onInput={set} />;
  else if (f.dataType === 'currency' || f.dataType === 'country' || f.dataType === 'code') {
    const opts =
      f.dataType === 'currency'
        ? CURRENCY_OPTIONS
        : f.dataType === 'country'
          ? countries.map((c) => ({ code: c.code, label: c.name }))
          : (f.codeList ?? []);
    input = (
      <select value={value} onChange={set}>
        <option value="">—</option>
        {opts.map((o) => (
          <option key={o.code} value={o.code}>
            {o.code} {o.label && o.label !== o.code ? `– ${o.label.slice(0, 60)}` : ''}
          </option>
        ))}
      </select>
    );
  } else input = <input type="text" value={value} onInput={set} inputMode={f.dataType === 'number' || f.dataType === 'integer' ? 'decimal' : undefined} />;

  if (compact) return <div class={`field compact ${error ? 'has-error' : ''}`} title={error}>{input}</div>;
  return (
    <label class={`field ${error ? 'has-error' : ''}`}>
      <span class="field-label" title={`${f.definition}\n\n${f.comment}`}>
        <span class={`badge req-${f.requirement}`}>{REQ_SHORT[f.requirement]}</span> {f.id} · {f.name}
      </span>
      {input}
      {!value && fallback?.value !== undefined && (
        <span class="hint">
          Will use {fallback.source === 'derived' ? 'derived' : ''} value <strong>{display(fallback.value)}</strong> — {fallback.method}
        </span>
      )}
      {error && <span class="error small">{error}</span>}
    </label>
  );
}
