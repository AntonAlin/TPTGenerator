import { useEffect, useState } from 'preact/hooks';
import { spec } from '../spec/index.ts';
import { SpecBrowser } from './SpecBrowser.tsx';
import { UploadStep } from './UploadStep.tsx';
import { MappingStep } from './MappingStep.tsx';
import type { LoadedSheet } from './session.ts';
import { ProfileRepository } from '../profiles/profiles.ts';
import { openStore } from '../profiles/store.ts';
import { CANONICAL_INFO, type CanonicalField } from '../detect/canonical.ts';

type StepId = 'upload' | 'mapping' | 'fund' | 'master' | 'export' | 'spec';

interface Step {
  id: StepId;
  label: string;
  /** Phase in which the step gets implemented; undefined = available now. */
  comingInPhase?: number;
}

const STEPS: Step[] = [
  { id: 'upload', label: '1. Upload holdings' },
  { id: 'mapping', label: '2. Map columns' },
  { id: 'fund', label: '3. Fund / share class', comingInPhase: 3 },
  { id: 'master', label: '4. Security master', comingInPhase: 3 },
  { id: 'export', label: '5. Export & quality report', comingInPhase: 4 },
  { id: 'spec', label: `TPT ${spec.meta.version} field reference` },
];

export function App() {
  const [active, setActive] = useState<StepId>('upload');
  const [loaded, setLoaded] = useState<LoadedSheet | null>(null);
  const [mapping, setMapping] = useState<CanonicalField[] | null>(null);
  const [repo, setRepo] = useState<{ repo: ProfileRepository; persistent: boolean } | null>(null);

  useEffect(() => {
    openStore().then((s) => setRepo({ repo: new ProfileRepository(s), persistent: s.persistent }));
  }, []);

  const step = STEPS.find((s) => s.id === active)!;
  const enabled = (id: StepId) => id === 'upload' || id === 'spec' || (id === 'mapping' && !!loaded) || STEPS.find((s) => s.id === id)?.comingInPhase;

  let body;
  if (active === 'spec') body = <SpecBrowser />;
  else if (active === 'upload')
    body = (
      <UploadStep
        loaded={loaded}
        onLoaded={(s) => {
          setLoaded(s);
          setMapping(null);
        }}
        onContinue={() => setActive('mapping')}
      />
    );
  else if (active === 'mapping' && loaded && repo)
    body = (
      <MappingStep
        loaded={loaded}
        repo={repo.repo}
        persistent={repo.persistent}
        onMapped={(m) => {
          setMapping(m);
          setActive('fund');
        }}
      />
    );
  else
    body = (
      <section class="placeholder">
        <h2>{step.label}</h2>
        <p class="muted">This step will be built in phase {step.comingInPhase}.</p>
        {mapping && loaded && (
          <>
            <p>Confirmed mapping for {loaded.workbook.fileName}:</p>
            <ul>
              {mapping.map((f, i) =>
                f === 'ignore' ? null : (
                  <li key={i}>
                    {loaded.table.headers[i]} → {CANONICAL_INFO[f].label}
                  </li>
                ),
              )}
            </ul>
          </>
        )}
      </section>
    );

  return (
    <div class="app">
      <header class="app-header">
        <div class="brand">
          <strong>TPT Generator</strong>
          <span class="muted">Solvency II Tripartite Template {spec.meta.version}</span>
        </div>
        <p class="privacy" role="note">
          Your files are processed only in this browser tab. Nothing is uploaded and the app makes no network requests.
        </p>
      </header>

      <nav class="steps" aria-label="Workflow">
        {STEPS.map((s) => (
          <button
            key={s.id}
            type="button"
            disabled={!enabled(s.id)}
            class={`step ${s.id === active ? 'active' : ''} ${s.comingInPhase ? 'pending' : ''}`}
            aria-current={s.id === active ? 'page' : undefined}
            onClick={() => setActive(s.id)}
          >
            {s.label}
          </button>
        ))}
      </nav>

      <main class="content">{body}</main>

      <footer class="app-footer muted">
        Field definitions are generated from {spec.meta.sourceFile.split('#')[0].replace('spec/', '')} ({spec.meta.dateLine}). This tool does not use
        market or reference data. Derived values are estimates and are flagged as such. Not legal or regulatory advice.
      </footer>
    </div>
  );
}
