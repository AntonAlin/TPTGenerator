import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { CANONICAL_FIELDS, CANONICAL_INFO, UNIQUE_FIELDS, type CanonicalField } from '../detect/canonical.ts';
import { LOW_CONFIDENCE, type ColumnPrediction } from '../detect/classify.ts';
import type { ProfileRepository, SourceProfile } from '../profiles/profiles.ts';
import { predict, sampleValues, type LoadedSheet } from './session.ts';
import { ProfilesPanel } from './ProfilesPanel.tsx';

interface Props {
  loaded: LoadedSheet;
  repo: ProfileRepository;
  persistent: boolean;
  onMapped: (mapping: CanonicalField[]) => void;
}

const KEY_FIELDS: CanonicalField[] = ['isin', 'security_name', 'currency', 'market_value_local', 'market_value_portfolio'];

export function MappingStep({ loaded, repo, persistent, onMapped }: Props) {
  const t = loaded.table;
  const [profile, setProfile] = useState<SourceProfile | undefined>();
  const [profileChecked, setProfileChecked] = useState(false);
  const [pins, setPins] = useState<Map<number, CanonicalField>>(new Map());
  const [profileName, setProfileName] = useState(loaded.workbook.fileName.replace(/\.[^.]+$/, ''));
  const [message, setMessage] = useState<string | null>(null);
  const [profilesVersion, setProfilesVersion] = useState(0);
  const countedFor = useRef<object | null>(null);

  useEffect(() => {
    let alive = true;
    setPins(new Map());
    repo.findFor(t.headers).then((p) => {
      if (!alive) return;
      setProfile(p);
      setProfileChecked(true);
      if (p) {
        setProfileName(p.name);
        // Count one use per loaded table, not per re-render or profile save.
        if (countedFor.current !== t) {
          countedFor.current = t;
          repo.markUsed(p);
        }
      }
    });
    return () => {
      alive = false;
    };
  }, [t, repo, profilesVersion]);

  const preds: ColumnPrediction[] = useMemo(() => (profileChecked ? predict(t, profile, pins) : []), [t, profile, pins, profileChecked]);
  const mapping = preds.map((p) => p.field);

  const duplicates = useMemo(() => {
    const seen = new Map<CanonicalField, number>();
    for (const f of mapping) if (UNIQUE_FIELDS.has(f)) seen.set(f, (seen.get(f) ?? 0) + 1);
    return new Set([...seen].filter(([, n]) => n > 1).map(([f]) => f));
  }, [mapping]);
  const missingKey = KEY_FIELDS.filter((f) => !mapping.includes(f));
  const lowCount = preds.filter((p) => p.source === 'model' && p.confidence < LOW_CONFIDENCE).length;

  function setField(col: number, field: CanonicalField) {
    const next = new Map(pins);
    next.set(col, field);
    // A unique field moved here: un-pin it elsewhere so the model can re-assign that column.
    if (UNIQUE_FIELDS.has(field)) for (const [c, f] of next) if (c !== col && f === field) next.delete(c);
    setPins(next);
  }

  async function saveProfile() {
    const saved = await repo.save({
      name: profileName.trim() || 'Unnamed source',
      headers: t.headers,
      mapping,
      options: { headerRowOffset: loaded.headerRowOverride, sheetName: loaded.sheetName },
    });
    setProfile(saved);
    setPins(new Map());
    setProfilesVersion((v) => v + 1);
    setMessage(`Saved source profile "${saved.name}". Files with the same columns will be mapped automatically.`);
  }

  if (!profileChecked) return <p>Analysing columns…</p>;

  return (
    <section class="stack">
      <div class="card">
        <h2>Review column mapping</h2>
        {profile ? (
          <p class="ok">
            Mapping loaded from source profile <strong>{profile.name}</strong> (saved {profile.updatedAt.slice(0, 10)}, used {profile.timesUsed + 1}{' '}
            times). You can still change any column.
          </p>
        ) : (
          <p class="muted">
            Each column was classified from its header and its values. {lowCount > 0 ? <strong class="warn">{lowCount} low-confidence mapping(s) are highlighted — please check them.</strong> : 'All mappings are high-confidence.'}
          </p>
        )}
        {missingKey.length > 0 && (
          <p class="muted">
            Not found in this file: {missingKey.map((f) => CANONICAL_INFO[f].label).join(', ')}. These can be derived or entered in later steps.
          </p>
        )}
        {duplicates.size > 0 && (
          <p class="error">Mapped to more than one column: {[...duplicates].map((f) => CANONICAL_INFO[f].label).join(', ')}.</p>
        )}
      </div>

      <div class="table-wrap unbounded">
        <table class="grid mapping">
          <thead>
            <tr>
              <th>Column in file</th>
              <th>Sample values</th>
              <th>Maps to</th>
              <th>Confidence</th>
              <th>Why</th>
            </tr>
          </thead>
          <tbody>
            {preds.map((p) => {
              const low = p.source === 'model' && p.confidence < LOW_CONFIDENCE;
              return (
                <tr key={p.index} class={`${low ? 'low' : ''} ${duplicates.has(p.field) ? 'dup' : ''}`}>
                  <td>
                    <strong>{p.header}</strong>
                    {p.decimal === ',' && <span class="badge">decimal comma</span>}
                  </td>
                  <td class="samples">
                    {sampleValues(t, p.index).map((s) => (
                      <code key={s}>{s}</code>
                    ))}
                  </td>
                  <td>
                    <select
                      value={p.field}
                      aria-label={`Mapping for ${p.header}`}
                      onChange={(e) => setField(p.index, (e.target as HTMLSelectElement).value as CanonicalField)}
                    >
                      {CANONICAL_FIELDS.map((f) => (
                        <option key={f} value={f}>
                          {CANONICAL_INFO[f].label}
                        </option>
                      ))}
                    </select>
                    {p.source === 'model' && p.ranked[0].field !== p.field && (
                      <div class="muted small">model's first choice: {CANONICAL_INFO[p.ranked[0].field].label}</div>
                    )}
                  </td>
                  <td>
                    {p.source === 'model' ? (
                      <div class="conf" title={p.ranked.slice(0, 3).map((r) => `${CANONICAL_INFO[r.field].label}: ${Math.round(r.p * 100)}%`).join('\n')}>
                        <div class="bar">
                          <span style={{ width: `${Math.round(p.confidence * 100)}%` }} />
                        </div>
                        {Math.round(p.confidence * 100)}%
                      </div>
                    ) : (
                      <span class="badge">{p.source === 'profile' ? 'profile' : 'you'}</span>
                    )}
                  </td>
                  <td class="small">
                    <ul class="reasons">
                      {p.reasons.map((r) => (
                        <li key={r}>{r}</li>
                      ))}
                    </ul>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div class="card">
        <h3>Remember this mapping</h3>
        <p class="muted">
          Saves the mapping as a source profile in this browser{persistent ? '' : ' (storage is unavailable here, so it lasts only for this session — export it to keep it)'}. It is
          matched by the file's column headers.
        </p>
        <div class="filters">
          <input type="text" value={profileName} onInput={(e) => setProfileName((e.target as HTMLInputElement).value)} aria-label="Profile name" />
          <button type="button" class="secondary" disabled={duplicates.size > 0} onClick={saveProfile}>
            {profile ? 'Update source profile' : 'Save as source profile'}
          </button>
        </div>
        {message && <p class="ok">{message}</p>}
      </div>

      <ProfilesPanel repo={repo} version={profilesVersion} onChanged={() => setProfilesVersion((v) => v + 1)} />

      <div>
        <button type="button" class="primary" disabled={duplicates.size > 0} onClick={() => onMapped(mapping)}>
          Confirm mapping →
        </button>
      </div>
    </section>
  );
}
