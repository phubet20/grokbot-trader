import { useEffect, useState } from 'react';
import { BotIcon } from './Icons';

const REPOS = ['TauriResearch/TradingAgents', 'sendaifun/solana-agent-kit', 'jackhuang166/ai-memecoin-trading-bot'];
const STARS = ['91.7k', '1.7k', '63'];

export function Splash({ appName, onDone, ready }: { appName: string; onDone: () => void; ready: boolean }) {
  const [p, setP] = useState(0);
  useEffect(() => {
    const t0 = Date.now();
    const iv = setInterval(() => {
      const v = Math.min(1, (Date.now() - t0) / 2600);
      setP(v);
      if (v >= 1 && ready) { clearInterval(iv); setTimeout(onDone, 350); }
    }, 50);
    return () => clearInterval(iv);
  }, [ready, onDone]);
  const shown = Math.min(3, Math.floor(p * 3.3));
  return (
    <div className="splash">
      <div className="splash-center">
        <div className="splash-icon"><BotIcon size={96} /></div>
        <h1>{appName}</h1>
        <div className="badge-term mono">terminal · meme mode</div>
      </div>
      <div className="splash-term mono">
        <div className="muted">$ git clone · 3 repos</div>
        {REPOS.slice(0, Math.max(1, shown)).map((r, i) => (
          <div key={r} className="splash-repo"><span><span className="dot" style={{ background: ['#8b5cf6', '#22c55e', '#f59e0b'][i] }} />{r}</span><span className="muted">★ {STARS[i]}</span></div>
        ))}
        <div className="progress"><div style={{ width: `${p * 100}%` }} /></div>
        <div className="muted" style={{ textAlign: 'right' }}>{Math.round(p * 100)}%</div>
      </div>
    </div>
  );
}
