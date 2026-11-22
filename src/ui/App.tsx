import { useEffect, useMemo, useState } from 'preact/hooks';
import { spec } from '../spec/index.ts';
import { SpecBrowser } from './SpecBrowser.tsx';
import { UploadStep } from './UploadStep.tsx';
import { MappingStep } from './MappingStep.tsx';
import { PortfolioStep } from './PortfolioStep.tsx';
import { ExportStep } from './ExportStep.tsx';
import { dateFromMetadata, type LoadedSheet } from './session.ts';
import { ProfileRepository } from '../profiles/profiles.ts';
import { LearnedRepository } from '../profiles/learned.ts';
import { openStore } from '../profiles/store.ts';
import { FundProfileRepository, baseCurrencyOf, emptyPortfolio, fundNav, type PortfolioState } from '../portfolio/portfolio.ts';
import type { CanonicalField } from '../detect/canonical.ts';
import { normalizeHoldings } from '../derive/holdings.ts';
import { buildFxTable, guessPortfolioCurrency, impliedFxRates } from '../derive/valuation.ts';
import { resolveHoldings } from '../derive/resolve.ts';
import type { AssetClass } from '../derive/assetClass.ts';
import { interpretAmounts } from '../derive/amounts.ts';
import { navFromLines, reconcile } from '../derive/reconcile.ts';
import { Promo } from './Promo.tsx';
import { HowItWorks } from './HowItWorks.tsx';
import { NEXUS_URL } from './links.ts';
import { APP_VERSION } from './version.ts';

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
  learned: LearnedRepository;
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
  const [typeLessons, setTypeLessons] = useState<Map<string, { cls: AssetClass; source?: string }>>(new Map());

  useEffect(() => {
    (async () => {
      const s = await openStore();
      const learned = new LearnedRepository(s);
      setStores({ profiles: new ProfileRepository(s), learned, funds: new FundProfileRepository(s), persistent: s.persistent });
      setTypeLessons(await learned.typeMap().catch(() => new Map()));
    })();
  }, []);

  const normalized = useMemo(() => (loaded && mapping ? normalizeHoldings(loaded.table, mapping) : null), [loaded, mapping]);
  const implied = useMemo(() => (normalized ? impliedFxRates(normalized.holdings) : {}), [normalized]);
  const suggestions = useMemo(() => {
    if (!normalized || !loaded) return {};
    const g = guessPortfolioCurrency(normalized.holdings, normalized.portfolioValueHeader);
    const split = loaded.table.split;
    const splitDate = split?.choice.date;
    const metaDate = dateFromMetadata(loaded.table);
    const navLine = navFromLines(loaded.table.skipped.filter((r) => r.reason === 'above-header' || r.reason === 'note').map((r) => r.preview));
    return {
      baseCurrency: g.currency,
      baseWhy: g.why,
      valuationDate: splitDate ?? metaDate,
      valuationDateWhy: splitDate ? `the rows chosen in the upload step have this date in "${loaded.table.headers[split!.dateCol!]}"` : 'found above the table in the file',
      portfolioName: split?.choice.portfolio,
      portfolioNameWhy: split?.portfolioCol !== undefined ? `from the file's "${loaded.table.headers[split.portfolioCol]}" column` : undefined,
      nav: navLine?.value,
      navWhy: navLine ? `written in the file: "${navLine.line.slice(0, 80)}"${navLine.currency ? ` (${navLine.currency})` : ''}` : undefined,
    };
  }, [normalized, loaded]);

  const base = baseCurrencyOf(portfolio);
  const fx = useMemo(() => {
    const ccys = [
      // The currencies of forward and swap legs need a rate too, to value them from their legs.
      ...(normalized?.holdings.flatMap((h) => [h.file.currency, h.file.leg1_currency, h.file.leg2_currency]).filter((c): c is string => !!c) ?? []),
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
        ? interpretAmounts(normalized.holdings, { portfolioCurrency: base, fx: (c) => fx.table[c]?.rate, nav: navInfo.nav, totals: normalized.totals })
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
            typeLessons,
          })
        : null,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [amounts, portfolio, base, fx, navInfo.nav, stores, typeLessons],
  );

  // Does the result add up to the file's own totals, NAV, weights and FX? Reported, never applied.
  const recon = useMemo(
    () =>
      result && amounts && normalized && loaded && mapping
        ? reconcile({ table: loaded.table, mapping, holdings: amounts.holdings, totals: normalized.totals, rows: result.rows, fx: fx.table, portfolioCurrency: base, nav: navInfo.nav })
        : undefined,
    [result, amounts, normalized, loaded, mapping, fx, base, navInfo.nav],
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
        learnedRepo={stores.learned}
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
    body = (
      <ExportStep
        result={result}
        portfolio={portfolio}
        fx={fx.table}
        fxMissing={fx.missing}
        amountNotes={[...(normalized?.notes ?? []), ...(amounts?.notes ?? [])]}
        typeLessons={typeLessons}
        reconciliation={recon}
        onTeachType={async (shown, cls) => {
          if (!stores) return;
          if (cls) await stores.learned.teachType(shown, cls, loaded?.workbook.fileName ?? 'this file');
          else await stores.learned.forgetType(shown);
          setTypeLessons(await stores.learned.typeMap());
        }}
      />
    );
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
          <img class="brand-logo" src={`${import.meta.env.BASE_URL}logo.svg`} alt="" width="40" height="40" />
          <div class="brand-text">
            <strong>
              TPT Generator <span class="version">Version {APP_VERSION}</span>
            </strong>
            <span class="muted">Solvency II Tripartite Template {spec.meta.version}</span>
          </div>
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
        <div class="footer-text">
          <p>
            Field definitions are generated from {spec.meta.sourceFile.split('#')[0].replace('spec/', '')} ({spec.meta.dateLine}). This tool does not use
            market or reference data. Derived values are estimates and are flagged as such. Not legal or regulatory advice.
          </p>
          <p>TPT Generator version {APP_VERSION}. © 2026 Anton Ålin. Free to use; not for sale, modification or republication.</p>
          <p class="sister">
            Also free, from the same developer:{' '}
            <a href={NEXUS_URL} target="_blank" rel="noopener noreferrer">
              Nexus Portfolio Lab
            </a>
            , portfolio analytics for fund managers: exposure, VaR, stress tests, liquidity and UCITS limit checks, in your browser.{' '}
            <a href={HOW_HASH} onClick={(e) => { e.preventDefault(); setActive('how'); setTimeout(() => document.getElementById('how-nexus')?.scrollIntoView(), 0); }}>
              What you can do there
            </a>
          </p>
        </div>
        <Promo />
      </footer>
    </div>
  );
}
