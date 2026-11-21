import { useEffect, useState } from 'preact/hooks';
import type { ProfileRepository, SourceProfile } from '../profiles/profiles.ts';
import { downloadBlob } from './session.ts';

interface Props {
  repo: ProfileRepository;
  version: number;
  onChanged: () => void;
}

export function ProfilesPanel({ repo, version, onChanged }: Props) {
  const [profiles, setProfiles] = useState<SourceProfile[]>([]);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    repo.list().then(setProfiles);
  }, [repo, version]);

  async function exportAll() {
    const data = await repo.exportAll();
    downloadBlob(JSON.stringify(data, null, 2), `tpt-source-profiles-${new Date().toISOString().slice(0, 10)}.json`, 'application/json');
  }

  async function importFile(file: File | undefined) {
    if (!file) return;
    try {
      const res = await repo.importAll(JSON.parse(await file.text()));
      setMsg(`Imported ${res.imported} profile(s)${res.skipped ? `, skipped ${res.skipped} invalid` : ''}.`);
      onChanged();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <details class="card">
      <summary>
        <strong>Saved source profiles ({profiles.length})</strong>
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
      <div class="filters">
        <button type="button" class="secondary" disabled={!profiles.length} onClick={exportAll}>
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
