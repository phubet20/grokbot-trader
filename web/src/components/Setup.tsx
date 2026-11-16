import { useEffect, useState, useRef } from 'react';
import { BotIcon, PhantomIcon } from './Icons';

const REPOS = [
  {
    owner: 'TauriResearch/TradingAgents',
    stars: '91.7k',
    blurb: 'multi-agent LLM trading · analysts · risk team',
    color: '#8b5cf6',
    agents: [
      { id: 'analyst', name: 'ANALYST', color: '#8b5cf6', at: 500 },
      { id: 'risk', name: 'RISK', color: '#ec4899', at: 900 },
    ],
  },
  {
    owner: 'sendaifun/solana-agent-kit',
    stars: '1.7k',
    blurb: 'AI agents → Solana · Jupiter · pump.fun',
    color: '#22c55e',
    agents: [{ id: 'executor', name: 'EXECUTOR', color: '#10b981', at: 2100 }],
  },
  {
    owner: 'Jackhuang166/ai-memecoin-trading-bot',
    stars: '63',
    blurb: 'new token scan · honeypot check · win prob',
    color: '#f59e0b',
    agents: [
      { id: 'scanner', name: 'SCANNER', color: '#f59e0b', at: 1400 },
      { id: 'safety', name: 'SAFETY', color: '#ef4444', at: 1700 },
    ],
  },
];

function BotFace({ color, ready }: { color: string; ready: boolean }) {
  return (
    <span className="ag-face" style={{ background: ready ? color : '#e4e4ea', color: ready ? '#fff' : '#9a9aa3' }} aria-hidden>
      <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
        <rect x="1.5" y="3.5" width="11" height="8" rx="2.2" fill="currentColor" opacity="0.15" />
        <rect x="1.5" y="3.5" width="11" height="8" rx="2.2" stroke="currentColor" strokeWidth="1.2" />
        <circle cx="5" cy="7.2" r="1" fill="currentColor" />
        <circle cx="9" cy="7.2" r="1" fill="currentColor" />
      </svg>
    </span>
  );
}

export function Setup({ snap, onDone }: { snap: any; onDone: () => void }) {
  const [ready, setReady] = useState<Record<string, boolean>>({});
  const [shown, setShown] = useState(1);
  const doneRef = useRef(onDone);
  doneRef.current = onDone;

  useEffect(() => {
    const timers: number[] = [];
    const marks = [
      { t: 200, show: 2 },
      { t: 700, show: 3 },
    ];
    for (const m of marks) timers.push(window.setTimeout(() => setShown(m.show), m.t));
    for (const repo of REPOS) {
      for (const a of repo.agents) {
        timers.push(window.setTimeout(() => setReady((r) => ({ ...r, [a.id]: true })), a.at));
      }
    }
    timers.push(window.setTimeout(() => doneRef.current(), 2800));
    return () => { for (const t of timers) clearTimeout(t); };
  }, []);

  return (
    <div className="setup" data-testid="setup">
      <div className="setup-hdr">
        <BotIcon size={34} />
        <div className="hdr-title">{snap?.appName || 'Grok Bot'}</div>
        <span className="chip mono">setup</span>
        <div style={{ flex: 1 }} />
        <span className="ph-pill"><PhantomIcon size={22} /> Phantom</span>
      </div>
      <div className="setup-sub mono muted">3 repos → 5 agents · night mode 22:00 → 08:00</div>
      {REPOS.slice(0, shown).map((repo) => (
        <div key={repo.owner} className="setup-card">
          <div className="setup-card-hd">
            <b className="mono"><i className="dot" style={{ background: repo.color }} />{repo.owner}</b>
            <span className="muted mono">★ {repo.stars}</span>
          </div>
          <div className="muted tiny">{repo.blurb}</div>
          <div className="setup-pills">
            {repo.agents.map((a) => {
              const on = !!ready[a.id];
              return (
                <span key={a.id} className={'ag-pill' + (on ? ' ready' : '')} style={{ '--c': a.color } as React.CSSProperties}>
                  <BotFace color={a.color} ready={on} />
                  <span>{a.name} {on ? '✓ ready' : '…'}</span>
                </span>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
