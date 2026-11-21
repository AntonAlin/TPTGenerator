import { useEffect, useMemo, useState } from 'preact/hooks';
import { spec } from '../spec/index.ts';
import { SpecBrowser } from './SpecBrowser.tsx';
import { UploadStep } from './UploadStep.tsx';
import { MappingStep } from './MappingStep.tsx';
import { PortfolioStep } from './PortfolioStep.tsx';
import { ExportStep } from './ExportStep.tsx';
import { dateFromMetadata, type LoadedSheet } from './session.ts';
import { ProfileRepository } from '../profiles/profiles.ts';
import { openStore } from '../profiles/store.ts';
import { FundProfileRepository, baseCurrencyOf, emptyPortfolio, fundNav, type PortfolioState } from '../portfolio/portfolio.ts';
import type { CanonicalField } from '../detect/canonical.ts';
import { normalizeHoldings } from '../derive/holdings.ts';
import { buildFxTable, guessPortfolioCurrency, impliedFxRates } from '../derive/valuation.ts';
import { resolveHoldings } from '../derive/resolve.ts';
import { interpretAmounts } from '../derive/amounts.ts';
import { Promo } from './Promo.tsx';
import { HowItWorks } from './HowItWorks.tsx';

type StepId = 'upload' | 'mapping' | 'fund' | 'export' | 'spec' | 'how';

interface Step {
  id: StepId;
  label: string;
  comingInPhase?: number;
}

const STEPS: Step[] = [
  { id: 'upload', label: '1. Upload holdings' },
  { id: 'mapping', label: '2. Map columns' },
  { id: 'fund', label: '3. Fund / share class' },
  { id: 'export', label: '4. Export & quality report' },
  { id: 'spec', label: `TPT ${spec.meta.version} field reference` },
  { id: 'how', label: 'How it works' },
];

/** The "How it works" page has an address of its own, so it can be linked to. */
const HOW_HASH = '#how-it-works';
const stepFromHash = (): StepId => (typeof location !== 'undefined' && location.hash === HOW_HASH ? 'how' : 'upload');

interface Stores {
  profiles: ProfileRepository;
  funds: FundProfileRepository;
  persistent: boolean;
}

export function App() {
  const [active, setActiveState] = useState<StepId>(stepFromHash);
  const setActive = (id: StepId) => {
    setActiveState(id);
    // Keep the address in step with the page: #how-it-works only while that page is shown.
    const want = id === 'how' ? HOW_HASH : '';
    if (location.hash !== want) history.replaceState(null, '', `${location.pathname}${location.search}${want}`);
    if (id === 'how') window.scrollTo(0, 0);
  };
  useEffect(() => {
    const onHash = () => setActiveState((cur) => (location.hash === HOW_HASH ? 'how' : cur === 'how' ? 'upload' : cur));
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  const [loaded, setLoaded] = useState<LoadedSheet | null>(null);
  const [mapping, setMapping] = useState<CanonicalField[] | null>(null);
  const [portfolio, setPortfolio] = useState<PortfolioState>(emptyPortfolio);
  const [stores, setStores] = useState<Stores | null>(null);

  useEffect(() => {
    (async () => {
      const s = await openStore();
      setStores({ profiles: new ProfileRepository(s), funds: new FundProfileRepository(s), persistent: s.persistent });
    })();
  }, []);

  const normalized = useMemo(() => (loaded && mapping ? normalizeHoldings(loaded.table, mapping) : null), [loaded, mapping]);
  const implied = useMemo(() => (normalized ? impliedFxRates(normalized.holdings) : {}), [normalized]);
  const suggestions = useMemo(() => {
    if (!normalized || !loaded) return {};
    const g = guessPortfolioCurrency(normalized.holdings, normalized.portfolioValueHeader);
    return { baseCurrency: g.currency, baseWhy: g.why, valuationDate: dateFromMetadata(loaded.table) };
  }, [normalized, loaded]);

  const base = baseCurrencyOf(portfolio);
  const fx = useMemo(() => {
    const ccys = [
      ...(normalized?.holdings.map((h) => h.file.currency).filter((c): c is string => !!c) ?? []),
      ...(portfolio.level === 'share_class' ? portfolio.shareClasses.map((c) => c.values['4']).filter(Boolean) : []),
      ...(base ? [base] : []),
    ];
    return buildFxTable(ccys, base, implied, portfolio.fxUser);
  }, [normalized, portfolio, base, implied]);
  const navInfo = fundNav(portfolio, (c) => fx.table[c]?.rate);
  // Decide, cell by cell, what each amount is (units, nominal/notional, market value) and sort it.
  const amounts = useMemo(
    () =>
      normalized && loaded
        ? interpretAmounts(normalized.holdings, { portfolioCurrency: base, fx: (c) => fx.table[c]?.rate, nav: navInfo.nav, totals: loaded.table.totals })
        : null,
    [normalized, loaded, base, fx, navInfo.nav],
  );

  const result = useMemo(
    () =>
      amounts && stores
        ? resolveHoldings(amounts.holdings, {
            ...portfolio.conventions,
            valuationDate: portfolio.values['6'] || undefined,
            portfolioCurrency: base,
            fx: fx.table,
            nav: navInfo.nav,
          })
        : null,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [amounts, portfolio, base, fx, navInfo.nav, stores],
  );

  const step = STEPS.find((s) => s.id === active)!;
  const enabled = (id: StepId) =>
    id === 'upload' || id === 'spec' || id === 'how' || (id === 'mapping' && !!loaded) || ((id === 'fund' || id === 'export') && !!result) || !!STEPS.find((s) => s.id === id)?.comingInPhase;

  let body;
  if (active === 'spec') body = <SpecBrowser />;
  else if (active === 'how') body = <HowItWorks />;
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
  else if (active === 'mapping' && loaded && stores)
    body = (
      <MappingStep
        loaded={loaded}
        repo={stores.profiles}
        persistent={stores.persistent}
        onMapped={(m) => {
          setMapping(m);
          setActive('fund');
        }}
      />
    );
  else if (active === 'fund' && result && stores)
    body = (
      <PortfolioStep
        portfolio={portfolio}
        setPortfolio={setPortfolio}
        fx={fx}
        implied={implied}
        derivations={result.portfolio}
        navNote={navInfo.note}
        suggestions={suggestions}
        fundRepo={stores.funds}
        onContinue={() => setActive('export')}
      />
    );
  else if (active === 'export' && result)
    body = <ExportStep result={result} portfolio={portfolio} fx={fx.table} fxMissing={fx.missing} amountNotes={amounts?.notes ?? []} />;
  else
    body = (
      <section class="placeholder">
        <h2>{step.label}</h2>
        <p class="muted">{step.comingInPhase ? `This step will be built in phase ${step.comingInPhase}.` : 'Upload a file and confirm the column mapping first.'}</p>
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
          Your files are processed only in this browser tab. Nothing is uploaded and the app makes no network requests.{' '}
          <a href={HOW_HASH}>How it works</a>
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
        <p>
          Field definitions are generated from {spec.meta.sourceFile.split('#')[0].replace('spec/', '')} ({spec.meta.dateLine}). This tool does not use
          market or reference data. Derived values are estimates and are flagged as such. Not legal or regulatory advice.
        </p>
        <Promo />
      </footer>
    </div>
  );
}
