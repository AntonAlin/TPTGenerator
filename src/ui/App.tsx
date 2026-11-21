import { useState } from 'preact/hooks';
import { spec } from '../spec/index.ts';
import { SpecBrowser } from './SpecBrowser.tsx';

type StepId = 'upload' | 'mapping' | 'fund' | 'master' | 'export' | 'spec';

interface Step {
  id: StepId;
  label: string;
  /** Phase in which the step gets implemented; undefined = available now. */
  comingInPhase?: number;
}

const STEPS: Step[] = [
  { id: 'upload', label: '1. Upload holdings', comingInPhase: 2 },
  { id: 'mapping', label: '2. Map columns', comingInPhase: 2 },
  { id: 'fund', label: '3. Fund / share class', comingInPhase: 3 },
  { id: 'master', label: '4. Security master', comingInPhase: 3 },
  { id: 'export', label: '5. Export & quality report', comingInPhase: 4 },
  { id: 'spec', label: `TPT ${spec.meta.version} field reference` },
];

export function App() {
  const [active, setActive] = useState<StepId>('spec');
  const step = STEPS.find((s) => s.id === active)!;

  return (
    <div class="app">
      <header class="app-header">
        <div class="brand">
          <strong>TPT Generator</strong>
          <span class="muted">Solvency II Tripartite Template {spec.meta.version}</span>
        </div>
        <p class="privacy" role="note">
          Your files are processed only in this browser tab. Nothing is uploaded and the app makes no network
          requests.
        </p>
      </header>

      <nav class="steps" aria-label="Workflow">
        {STEPS.map((s) => (
          <button
            key={s.id}
            type="button"
            class={`step ${s.id === active ? 'active' : ''} ${s.comingInPhase ? 'pending' : ''}`}
            aria-current={s.id === active ? 'page' : undefined}
            onClick={() => setActive(s.id)}
          >
            {s.label}
          </button>
        ))}
      </nav>

      <main class="content">
        {step.comingInPhase ? (
          <section class="placeholder">
            <h2>{step.label}</h2>
            <p class="muted">This step will be built in phase {step.comingInPhase}.</p>
          </section>
        ) : (
          <SpecBrowser />
        )}
      </main>

      <footer class="app-footer muted">
        Field definitions are generated from {spec.meta.sourceFile.split('#')[0].replace('spec/', '')} (
        {spec.meta.dateLine}). This tool does not use market or reference data. Derived values are estimates and are
        flagged as such. Not legal or regulatory advice.
      </footer>
    </div>
  );
}
