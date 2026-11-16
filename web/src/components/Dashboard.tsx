import { useEffect, useState } from 'react';
import { api, usd, pct, hm, hhmm, sUsd, compact } from '../api';
import { LineChart } from './Charts';
import { BotIcon, TokenAvatar, BellI, SunI, MoonI, WalletI } from './Icons';

const RANGES = ['LIVE', '1H', '4H', '1D', '1W', 'ALL'];

export function LowBalanceBanner({ snap }: { snap: any }) {
  if (!snap.lowBalance) return null;
  return <div className="low-bal" data-testid="low-balance">{snap.lowBalance}</div>;
}

export function Header({ snap, theme, setTheme, onRecap }: any) {
  return (
    <div className="hdr">
      <BotIcon size={34} />
      <div className="hdr-title">{snap.appName}</div>
      <span className="chip mono">meme mode</span>
      <div style={{ flex: 1 }} />
      <button className="icon-btn" onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')} aria-label="theme">{theme === 'dark' ? <SunI size={19} /> : <MoonI size={19} />}</button>
      <button className="icon-btn" onClick={onRecap} aria-label="recap"><BellI size={19} /></button>
      <span className={`live-pill ${snap.wallet.running ? '' : 'off'} ${snap.mode === 'paper' ? 'test' : 'real'}`} title={snap.modeReason}><i />{!snap.wallet.running ? 'Paused' : snap.mode === 'live-auto' ? 'Live auto' : snap.mode === 'live' ? 'Live $' : 'Live · test'}</span>
    </div>
  );
}

export function Ticker({ items, onOpen }: { items: any[]; onOpen: (m: string) => void }) {
  if (!items?.length) return null;
  const row = [...items, ...items];
  return (
    <div className="ticker"><div className="ticker-track" style={{ animationDuration: `${items.length * 4}s` }}>
      {row.map((t, i) => (
        <button key={i} className="tick mono" onClick={() => onOpen(t.mint)}><TokenAvatar src={t.image} symbol={t.symbol} size={16} />${t.symbol} <b className={t.change >= 0 ? 'pos' : 'neg'}>{pct(t.change, 2)}</b> <span className="muted">1h</span></button>
      ))}
    </div></div>
  );
}

export function Balance({ snap }: { snap: any }) {
  const s = snap.stats;
  const [whole, cents] = usd(s.equity).split('.');
  const today = s.pnlUsd;
  const mins = Math.floor(s.runtimeMin);
  return (
    <div className="balance">
      <div className="muted mono small"><WalletI size={13} /> {snap.wallet.type} · 3 repos · 5 agents · {Math.floor(mins / 60)}h {mins % 60}m in</div>
      <div className="bal-row">
        <div className="bal-big" data-testid="balance">{whole}<span className="cents">.{cents}</span></div>
        <span className={`delta-pill ${today >= 0 ? 'pos-bg' : 'neg-bg'}`}>{sUsd(today)}</span>
      </div>
      <div className="bal-sub">
        <span className="chip mono">in {usd(s.deposit, s.deposit % 1 ? 2 : 0)} · {s.trades} trades</span>
        <span className="mult mono">{s.multiplier.toFixed(2)}×</span>
      </div>
      <div className="mono small bal-line"><span className={s.pnlUsd >= 0 ? 'pos' : 'neg'}>{sUsd(s.pnlUsd)} ({pct(s.pnlPct, 2)}) · {s.wins}W {s.losses}L</span><span className="muted">{hhmm(Date.now())}</span></div>
    </div>
  );
}

export function EquityCard({ snap }: { snap: any }) {
  const [range, setRange] = useState('LIVE');
  const [pts, setPts] = useState<{ ts: number; usd: number }[]>([]);
  useEffect(() => { api('equity?range=' + range).then(setPts).catch(() => {}); }, [range, snap.wallet.startedAt]);
  useEffect(() => {
    const e = snap.lastEquity; if (!e) return;
    setPts((p) => (p.length && p[p.length - 1].ts >= e.ts ? p : [...p, e]));
  }, [snap.lastEquity]);
  useEffect(() => { const iv = setInterval(() => api('equity?range=' + range).then(setPts).catch(() => {}), 60000); return () => clearInterval(iv); }, [range]);
  return (
    <div className="equity">
      <LineChart points={pts} baseline={snap.stats.deposit} />
      <div className="ranges">{RANGES.map((r) => <button key={r} className={r === range ? 'on' : ''} onClick={() => setRange(r)}>{r === 'LIVE' ? '• LIVE' : r}</button>)}</div>
    </div>
  );
}

function Ring({ v }: { v: number }) {
  const r = 17, c = 2 * Math.PI * r;
  const col = v >= 70 ? 'var(--green)' : v >= 50 ? '#f5a623' : 'var(--red)';
  return <svg width="44" height="44" className="ring"><circle cx="22" cy="22" r={r} stroke="var(--line)" strokeWidth="4" fill="none" /><circle cx="22" cy="22" r={r} stroke={col} strokeWidth="4" fill="none" strokeDasharray={`${(v / 100) * c} ${c}`} strokeLinecap="round" transform="rotate(-90 22 22)" /><text x="22" y="26.5" textAnchor="middle" fontSize="13" fontWeight="700" fill="currentColor">{v}</text></svg>;
}

export function AgentCards({ snap, onOpen }: { snap: any; onOpen: (m: string) => void }) {
  const a = snap.agents, pos = snap.positions || [];
  const trailing = pos.find((p: any) => p.stop?.kind === 'trailing') || pos[0];
  return (
    <div className="section">
      <div className="sec-hd"><b>Agents</b><span className="pos small">5 running</span></div>
      <div className="hscroll">
        <div className="agent-card"><div className="ag-hd"><span className="ag-ico" style={{ background: '#f59e0b' }}>🛰</span><div><b>Scanner</b><div className="muted tiny">{compact(a.scanner.perHour)}/h pools</div></div></div>
          <div className="big-num">{compact(a.scanner.total)}</div><div className="muted tiny">pools scanned · {a.scanner.pools} live</div>
          {a.scanner.top && <div className="tiny mono row"><TokenAvatar symbol={a.scanner.top} src={a.scanner.topImage} size={14} /> top: ${a.scanner.top}</div>}</div>
        <div className="agent-card"><div className="ag-hd"><span className="ag-ico" style={{ background: '#ef4444' }}>🛡</span><div><b>Safety</b><div className="muted tiny">{a.safety.lastOk ? 'Guarding' : 'Rejected'}</div></div></div>
          <div className="big-num">{a.safety.rejected}</div><div className="muted tiny">rejected · {a.safety.passed} passed</div>
          {a.safety.lastSymbol && <div className={`tiny mono ${a.safety.lastOk ? 'pos' : 'neg'}`}>${a.safety.lastSymbol} {a.safety.last}</div>}</div>
        <div className="agent-card"><div className="ag-hd"><span className="ag-ico" style={{ background: '#8b5cf6' }}>🧠</span><div><b>Analyst</b><div className="muted tiny">Scoring</div></div></div>
          <div className="row"><Ring v={a.analyst.lastScore || 0} /><div className="tiny"><div className="mono"><TokenAvatar symbol={a.analyst.lastSymbol} src={a.analyst.lastImage} size={14} /> ${a.analyst.lastSymbol || '—'}</div><div className="muted">bull {a.analyst.bull} / bear {a.analyst.bear}</div></div></div>
          <div className="muted tiny">score /100 · buy ≥ {snap.config.minScore}</div></div>
        <div className="agent-card"><div className="ag-hd"><span className="ag-ico" style={{ background: '#ec4899' }}>⚖️</span><div><b>Risk</b><div className="muted tiny">{a.risk.status}</div></div></div>
          {trailing ? <button className="mini-pos" onClick={() => onOpen(trailing.mint)}><TokenAvatar src={trailing.image} symbol={trailing.symbol} size={16} /> <span className="mono">${trailing.symbol}</span> <b className={trailing.pnlPct >= 0 ? 'pos' : 'neg'}>{pct(trailing.pnlPct)}</b></button> : <div className="muted tiny">no open risk</div>}
          <div className="tiny mono">size {snap.config.positionPct}% · catastrophic -{snap.config.hardStopPct}%</div>
          {a.risk.label && <div className="tiny muted">{a.risk.label}</div>}</div>
        <div className="agent-card"><div className="ag-hd"><span className="ag-ico" style={{ background: '#10b981' }}>⚡</span><div><b>Executor</b><div className="muted tiny">{pos.length} active trades</div></div></div>
          <div className="big-num">{pos.length}</div><div className="muted tiny">{a.executor.fills} fills · {snap.mode === 'live' ? 'Phantom' : 'paper'}</div>
          {a.executor.last && <div className="tiny mono pos">✓ {a.executor.last}</div>}</div>
      </div>
    </div>
  );
}

export function Positions({ snap, onOpen }: { snap: any; onOpen: (m: string) => void }) {
  const pos = snap.positions || [];
  if (!pos.length) return null;
  return (
    <div className="section card">
      <div className="sec-hd"><b>Open positions</b><span className="muted small">{pos.length}/{snap.config.maxPositions}</span></div>
      {pos.map((p: any) => (
        <button key={p.id} className="act-row" onClick={() => onOpen(p.mint)}>
          <TokenAvatar src={p.image} symbol={p.symbol} size={30} />
          <div className="act-mid"><b>{p.symbol}</b><div className="muted tiny">{p.stop.kind === 'trailing' ? 'trailing' : 'stop'} at {((p.stop.level / p.entryPrice - 1) * 100).toFixed(1)}% · {hm(p.openedAt)}</div></div>
          <div className="act-right"><b>{usd(p.valueUsd)}</b><div className={`tiny ${p.pnlPct >= 0 ? 'pos' : 'neg'}`}>{pct(p.pnlPct)}</div></div>
        </button>
      ))}
    </div>
  );
}

export function Repos({ snap }: { snap: any }) {
  const c = snap.calls || {};
  const rows = [
    ['TradingAgents', '91.7k', snap.agents.analyst.calls, '#8b5cf6'],
    ['solana-agent-kit', '1.7k', c.jupiter || 0, '#22c55e'],
    ['ai-memecoin-trading-bot', '63', (c.geckoterminal || 0) + (c.dexscreener || 0) + (c.rugcheck || 0) + (c.replay || 0), '#f59e0b'],
  ];
  return (
    <div className="section card mono small">
      {rows.map(([n, s, k, col]) => <div key={n as string} className="repo-row"><span><i className="dot" style={{ background: col as string }} />{n}</span><span className="muted">★ {s}</span><span className="pos">● {k} calls</span></div>)}
    </div>
  );
}

const AG_COL: Record<string, string> = { Scanner: '#f59e0b', Safety: '#ef4444', Analyst: '#8b5cf6', Risk: '#ec4899', Executor: '#10b981', Core: '#64748b' };
export function AgentsList({ snap }: { snap: any }) {
  const a = snap.agents;
  const rows = [
    ['SCANNER', `${compact(a.scanner.perHour)}/h → $${a.scanner.top || '—'}`, 'ai-memecoin-bot', '#f59e0b'],
    ['SAFETY', `$${a.safety.lastSymbol || '—'} ${a.safety.last || 'waiting'}`, 'ai-memecoin-bot', '#ef4444'],
    ['ANALYST', `$${a.analyst.lastSymbol || '—'} bull ${a.analyst.bull}/bear ${a.analyst.bear}`, 'TradingAgents', '#8b5cf6'],
    ['RISK', `size ${snap.config.positionPct}% · catastrophic -${snap.config.hardStopPct}%`, 'TradingAgents', '#ec4899'],
    ['EXECUTOR', a.executor.last || 'idle', 'solana-agent-kit', '#10b981'],
  ];
  return (
    <div className="section card">
      <div className="sec-hd"><b className="mono">agents · working on repos</b><span className="pos small mono">● 5 running</span></div>
      {rows.map(([n, t, r, col]) => <div key={n} className="agent-line mono small"><b style={{ color: col }}>{n}</b><span className="ellipsis">{t}</span><span className="repo-tag">{r}</span></div>)}
    </div>
  );
}

export function Decisions({ snap, limit = 8 }: { snap: any; limit?: number }) {
  return (
    <div className="section card">
      <div className="sec-hd"><b>{snap.appName.split(' ')[0]} core · decisions</b><span className="pos small mono">● streaming</span></div>
      {(snap.decisions || []).slice(0, limit).map((d: any, i: number) => (
        <div key={i} className="dec mono tiny"><span className="muted">{hhmm(d.ts)}</span><b className={d.side === 'BUY' ? 'blue' : d.side === 'SELL' ? 'pos' : 'muted'}>{d.side}</b><TokenAvatar src={d.image} symbol={d.symbol} size={14} /><span className="ellipsis">${d.symbol} · {d.text}</span></div>
      ))}
      {!snap.decisions?.length && <div className="muted tiny mono">waiting for first signal…</div>}
    </div>
  );
}

export function Activity({ snap, onOpen, limit = 8, title = true }: { snap: any; onOpen: (m: string) => void; limit?: number; title?: boolean }) {
  const items = (snap.activity || []).filter((a: any) => a.kind !== 'info' || a.agent === 'Core').slice(0, limit);
  return (
    <div className="section">
      {title && <div className="sec-hd"><b>Activity</b><span className="muted small">See all</span></div>}
      {items.map((a: any) => (
        <button key={a.id} className="act-row" onClick={() => a.mint && onOpen(a.mint)}>
          <span className="av-wrap"><TokenAvatar src={a.image} symbol={a.symbol || a.agent} size={30} /><i style={{ background: AG_COL[a.agent] }} /></span>
          <div className="act-mid"><b>{a.text}</b><div className="muted tiny">{a.agent}{a.text2 ? ` · ${a.text2}` : ''} · {hm(a.ts)}</div></div>
          <div className="act-right">
            {a.usd !== undefined && <b className={a.kind === 'buy' ? '' : a.usd >= 0 ? 'pos' : 'neg'}>{a.kind === 'buy' ? usd(a.usd) : sUsd(a.usd)}</b>}
            {a.kind === 'buy' && a.stakePct !== undefined && <div className="muted tiny">{a.stakePct.toFixed(0)}% of stack</div>}
            {a.pct !== undefined && a.kind !== 'buy' && <div className={`tiny ${a.pct >= 0 ? 'pos' : 'neg'}`}>{pct(a.pct)}</div>}
          </div>
        </button>
      ))}
      {!items.length && <div className="muted small" style={{ padding: 12 }}>No activity yet - the scanner is looking for setups.</div>}
    </div>
  );
}

export function ScanStatus({ snap }: { snap: any }) {
  const sc = snap.scan || {};
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const i = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(i); }, []);
  const ago = sc.lastScanAt ? (now - sc.lastScanAt) / 1000 : null;
  const agoTxt = ago == null ? 'not yet' : ago < 1.5 ? 'just now' : `${Math.round(ago)}s ago`;
  const cadence = sc.cadenceMs ? `${(sc.cadenceMs / 1000).toFixed(1)}s` : '—';
  const ka = snap.keepalive;
  return (
    <div className="scan-status mono tiny" data-testid="scan-status">
      <span>scan {agoTxt}</span>
      <span>{sc.candidatesPerMin || 0}/min</span>
      <span>{sc.inFlightChecks || 0} in-flight</span>
      <span>{cadence} cadence</span>
      {ka?.enabled && <span className="muted" title={ka.officialGuarantee ? 'guaranteed' : 'best-effort keepalive, not officially guaranteed'}>keep {ka.lastOkAt ? `${Math.round((now - ka.lastOkAt) / 60000)}m ago` : 'pending'}</span>}
    </div>
  );
}


function fmtExp(n: number) {
  if (!Number.isFinite(n)) return '—';
  const s = (n * 100).toFixed(1);
  return `${n >= 0 ? '+' : ''}${s}%`;
}

export function AutoTunePanel({ snap }: { snap: any }) {
  const t = snap.autotune;
  if (!t) return null;
  const rows = t.patterns || [];
  return (
    <section className="card autotune" data-testid="autotune">
      <div className="autotune-head">
        <div className="card-title">Auto-tune</div>
        <div className="mono tiny muted">{t.note}</div>
      </div>
      <div className="autotune-metrics mono tiny">
        <span>equity score <b>{(t.equityScore || 0).toFixed(2)}</b></span>
        <span>slope <b>{(t.slope || 0).toFixed(3)}</b></span>
        <span>smooth <b>{Math.round((t.smoothness || 0) * 100)}%</b></span>
        <span>exit sens <b>{(t.exitSensitivity || 1).toFixed(2)}</b></span>
        <span>closes <b>{t.trades || 0}</b></span>
        {t.exits && Object.keys(t.exits).length > 0 && (
          <span>exits <b>{['take_profit', 'momentum_fade', 'hard_stop'].filter((k) => t.exits[k]).map((k) => `${t.exits[k]} ${k === 'take_profit' ? 'TP' : k === 'momentum_fade' ? 'momentum' : 'stop'}`).concat(Object.entries(t.exits).filter(([k]) => !['take_profit', 'momentum_fade', 'hard_stop'].includes(k)).map(([k, n]) => `${n} ${k}`)).join(' · ')}</b></span>
        )}
      </div>
      {rows.length === 0 ? (
        <div className="mono tiny muted">No closed paper trades yet — patterns will appear here after the first exits.</div>
      ) : (
        <table className="tune-table mono">
          <thead>
            <tr>
              <th>pattern</th>
              <th className="num">n</th>
              <th className="num">win</th>
              <th className="num">E</th>
              <th>weight</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((p: any) => {
              const st = p.exploring ? 'explore' : p.n < (t.minSamples || 8) ? 'learning' : p.disabled ? 'off' : 'on';
              return (
                <tr key={p.key}>
                  <td>{p.key}</td>
                  <td className="num">{p.n}</td>
                  <td className="num">{Math.round((p.wr || 0) * 100)}%</td>
                  <td className="num">{fmtExp(p.expectancy)}</td>
                  <td>
                    <span className="bar-w"><i style={{ width: `${Math.min(100, (p.weight || 0) / 1.8 * 100)}%` }} /></span>
                    {(p.weight || 0).toFixed(2)}
                  </td>
                  <td><span className={`tune-pill ${st === 'on' ? 'on' : st === 'off' ? 'off' : st === 'explore' ? 'ex' : 'learn'}`}>{st}</span></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </section>
  );
}
