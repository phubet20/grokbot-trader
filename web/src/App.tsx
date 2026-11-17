import { useEffect, useState, useCallback } from 'react';
import { useLive, api } from './api';
import { placeholderSnap } from './boot';
import { Splash } from './components/Splash';
import { ConnectSheet } from './components/ConnectSheet';
import { Setup } from './components/Setup';
import { Header, Ticker, Balance, EquityCard, AgentCards, Positions, Repos, AgentsList, Decisions, Activity, LowBalanceBanner, ScanStatus, AutoTunePanel } from './components/Dashboard';
import { TokenDetail } from './components/TokenDetail';
import { Toasts, Confetti, Recap } from './components/Overlays';
import { Account } from './components/Account';
import { Funds } from './components/Funds';
import { Approvals } from './components/Approvals';
import { HomeI, AgentsI, PulseI, UserI, WalletI, BotIcon } from './components/Icons';

type Tab = 'home' | 'funds' | 'agents' | 'activity' | 'account';

export default function App() {
  const { snap: liveSnap, toasts, setToasts, approvals, setApprovals, online, waking, live, retry } = useLive();
  const snap = liveSnap || placeholderSnap();
  const connecting = !online || waking || !live;
  const q = new URLSearchParams(location.search);
  const [stage, setStage] = useState<'splash' | 'connect' | 'setup' | 'app'>(q.get('skip') ? 'app' : 'splash');
  const [tab, setTab] = useState<Tab>((q.get('tab') as Tab) || 'home');
  const [theme, setTheme] = useState<string>(q.get('theme') || localStorage.getItem('theme') || 'light');
  const [token, setToken] = useState<string | null>(q.get('token'));
  const [recap, setRecap] = useState(!!q.get('recap'));
  const [fire, setFire] = useState(0);

  useEffect(() => { localStorage.setItem('theme', theme); document.documentElement.dataset.theme = theme; document.querySelector('meta[name=theme-color]')?.setAttribute('content', theme === 'dark' ? '#000000' : '#ffffff'); }, [theme]);
  useEffect(() => { if (snap?.appName) document.title = snap.appName; }, [snap?.appName]);
  useEffect(() => { if (toasts.some((t) => t.kind === 'profit')) setFire((f) => f + 1); }, [toasts]);
  useEffect(() => {
    // Never auto-start, auto-arm LIVE, or change mode just because the app opened or polled.
    if (!live || !liveSnap || stage !== 'app' || q.get('skip')) return;
    if (liveSnap.mode !== 'paper' && (liveSnap.botWallet?.publicKey || liveSnap.wallet?.connected)) return;
    if (!liveSnap.wallet?.connected) setStage('connect');
  }, [live, liveSnap, stage]);
  // ?toast=1 replays the latest winning paper trade as a take-profit toast (for demos/screenshots)
  useEffect(() => {
    if (!q.get('toast')) return;
    api('trades').then((ts: any[]) => {
      const w = ts.find((t) => t.pnlUsd > 0) || ts[0];
      if (!w) return;
      setToasts([{ id: 999, kind: w.pnlUsd > 0 ? 'profit' : 'fill', title: w.pnlUsd > 0 ? `Risk sold ${w.symbol} - locked the gain` : `Risk sold ${w.symbol}`, usd: w.pnlUsd, pct: w.pnlPct, symbol: w.symbol, image: w.image, text: w.reason }]);
    }).catch(() => {});
  }, []);
  const splashDone = useCallback(() => {
    // Never stay on the splash. Always show the Connect Phantom sheet unless
    // the URL skipped it (?skip=1) or opened Night recap directly (?recap=1).
    if (q.get('skip') || q.get('recap')) setStage('app');
    else setStage('connect');
  }, [liveSnap]);

  if (stage === 'splash') return <Splash appName={snap.appName || 'Grok Bot'} onDone={splashDone} />;
  if (stage === 'connect') return (
    <div className="app-shell">
      {connecting && <ConnectingBanner onRetry={retry} />}
      <ConnectSheet snap={snap} onStart={() => setStage('setup')} />
    </div>
  );
  if (stage === 'setup') return <div className="app-shell"><Setup snap={snap} onDone={() => setStage('app')} /></div>;

  const open = (m: string) => setToken(m);
  return (
    <div className="app-shell">
      <div className="screen">
        {connecting && <ConnectingBanner onRetry={retry} />}
        {tab === 'home' && <>
          <Header snap={snap} theme={theme} setTheme={setTheme} onRecap={() => setRecap(true)} />
          <LowBalanceBanner snap={snap} />
          <ScanStatus snap={snap} />
          <Ticker items={snap.ticker} onOpen={open} />
          <Balance snap={snap} />
          <EquityCard snap={snap} />
          <AutoTunePanel snap={snap} />
          <AgentCards snap={snap} onOpen={open} />
          <Positions snap={snap} onOpen={open} />
          <Activity snap={snap} onOpen={open} limit={6} />
          <Repos snap={snap} />
          <Decisions snap={snap} limit={6} />
        </>}
        {tab === 'agents' && <div className="page"><div className="page-title"><BotIcon size={28} /> Agents</div><ScanStatus snap={snap} /><AgentCards snap={snap} onOpen={open} /><AutoTunePanel snap={snap} /><AgentsList snap={snap} /><Repos snap={snap} /><Decisions snap={snap} limit={30} /></div>}
        {tab === 'activity' && <div className="page"><div className="page-title"><BotIcon size={28} /> Activity</div><Positions snap={snap} onOpen={open} /><Activity snap={snap} onOpen={open} limit={100} title={false} /></div>}
        {tab === 'funds' && <Funds snap={snap} />}
        {tab === 'account' && <><div className="page-title" style={{ padding: '16px 16px 0' }}><BotIcon size={28} /> Account</div><Account snap={snap} onRecap={() => setRecap(true)} onDisconnected={() => setStage('connect')} onConnect={() => setStage('connect')} /></>}
        <div style={{ height: 90 }} />
      </div>
      <nav className="tabbar">
        {([['home', 'Home', HomeI], ['funds', 'Funds', WalletI], ['agents', 'Agents', AgentsI], ['activity', 'Activity', PulseI], ['account', 'Account', UserI]] as const).map(([k, l, I]) => (
          <button key={k} className={tab === k ? 'on' : ''} onClick={() => { setTab(k); setToken(null); window.scrollTo(0, 0); }}><I size={21} /><span>{l}</span></button>
        ))}
      </nav>
      {token && <TokenDetail mint={token} onClose={() => setToken(null)} />}
      {recap && <Recap appName={snap.appName} stopPct={snap.config.hardStopPct} onClose={() => setRecap(false)} />}
      <Toasts toasts={toasts} appName={snap.appName} />
      <Confetti fire={fire} />
      <Approvals items={approvals} setItems={setApprovals} />
    </div>
  );
}


function ConnectingBanner({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="connecting-banner mono tiny" data-testid="connecting-banner">
      <span>Connecting… (server waking)</span>
      <button type="button" onClick={onRetry} data-testid="connecting-retry">Retry</button>
    </div>
  );
}
