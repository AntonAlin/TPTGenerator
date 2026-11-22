import { useEffect, useState } from 'preact/hooks';
import type { ProfileRepository, SourceProfile } from '../profiles/profiles.ts';
import type { LearnedHeader, LearnedRepository, LearnedType } from '../profiles/learned.ts';
import { CANONICAL_INFO } from '../detect/canonical.ts';
import { ASSET_CLASSES } from '../derive/assetClass.ts';
import { downloadBlob } from './session.ts';

interface Props {
  repo: ProfileRepository;
  learnedRepo: LearnedRepository;
  version: number;
  onChanged: () => void;
}

export function ProfilesPanel({ repo, learnedRepo, version, onChanged }: Props) {
  const [profiles, setProfiles] = useState<SourceProfile[]>([]);
  const [learned, setLearned] = useState<LearnedHeader[]>([]);
  const [types, setTypes] = useState<LearnedType[]>([]);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    repo.list().then(setProfiles);
    learnedRepo.list().then(setLearned);
    learnedRepo.types().then(setTypes);
  }, [repo, learnedRepo, version]);

  async function exportAll() {
    const data = { ...(await repo.exportAll()), learned: await learnedRepo.list(), learnedTypes: await learnedRepo.types() };
    downloadBlob(JSON.stringify(data, null, 2), `tpt-source-profiles-${new Date().toISOString().slice(0, 10)}.json`, 'application/json');
  }

  async function importFile(file: File | undefined) {
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      const res = await repo.importAll(data);
      const l = await learnedRepo.importAll(data?.learned);
      const t = await learnedRepo.importTypes(data?.learnedTypes);
      const skipped = res.skipped + l.skipped + t.skipped;
      const extra = [l.imported && `${l.imported} learned header(s)`, t.imported && `${t.imported} asset type(s)`].filter(Boolean).join(' and ');
      setMsg(`Imported ${res.imported} profile(s)${extra ? ` and ${extra}` : ''}${skipped ? `, skipped ${skipped} invalid` : ''}.`);
      onChanged();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <details class="card">
      <summary>
        <strong>
          Saved source profiles ({profiles.length}) and learned headers ({learned.length})
        </strong>
      </summary>
      {profiles.length > 0 && (
        <table class="grid compact">
          <thead>
            <tr>
              <th>Name</th>
              <th>Columns</th>
              <th>Updated</th>
              <th>Used</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {profiles.map((p) => (
              <tr key={p.fingerprint}>
                <td>{p.name}</td>
                <td class="muted">{p.headers.length}</td>
                <td>{p.updatedAt.slice(0, 10)}</td>
                <td>{p.timesUsed}</td>
                <td>
                  <button
                    type="button"
                    class="secondary small"
                    onClick={async () => {
                      if (confirm(`Delete source profile "${p.name}"?`)) {
                        await repo.remove(p.fingerprint);
                        onChanged();
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
      <h4>Learned from your corrections</h4>
      {learned.length ? (
        <>
          <p class="muted small">
            When you map a column by hand, its header is remembered here and maps the same way in the next file from any source, as long as the values fit.
            The latest correction wins.
          </p>
          <table class="grid compact">
            <thead>
              <tr>
                <th>Header</th>
                <th>Maps to</th>
                <th>Taught</th>
                <th>Last file</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {learned.map((l) => (
                <tr key={l.header}>
                  <td>
                    <code>{l.header}</code>
                  </td>
                  <td>{CANONICAL_INFO[l.field].label}</td>
                  <td>{l.times}×</td>
                  <td class="muted">{l.sources[0]}</td>
                  <td>
                    <button
                      type="button"
                      class="secondary small"
                      onClick={async () => {
                        await learnedRepo.forget(l.header);
                        onChanged();
                      }}
                    >
                      Forget
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      ) : (
        <p class="muted small">Nothing yet. Columns you map by hand are remembered here for the next file.</p>
      )}
      {types.length > 0 && (
        <>
          <h4>Asset types you set</h4>
          <table class="grid compact">
            <thead>
              <tr>
                <th>Asset type text</th>
                <th>Class</th>
                <th>Last file</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {types.map((t) => (
                <tr key={t.text}>
                  <td>
                    <code>{t.shown}</code>
                  </td>
                  <td>{ASSET_CLASSES[t.cls].label}</td>
                  <td class="muted">{t.sources[0]}</td>
                  <td>
                    <button
                      type="button"
                      class="secondary small"
                      onClick={async () => {
                        await learnedRepo.forgetType(t.shown);
                        onChanged();
                      }}
                    >
                      Forget
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
      <div class="filters">
        <button type="button" class="secondary" disabled={!profiles.length && !learned.length && !types.length} onClick={exportAll}>
          Export all as JSON
        </button>
        <label class="button secondary">
          Import JSON…
          <input type="file" accept=".json,application/json" hidden onChange={(e) => importFile((e.target as HTMLInputElement).files?.[0])} />
        </label>
      </div>
      {msg && <p class="muted">{msg}</p>}
    </details>
  );
}
