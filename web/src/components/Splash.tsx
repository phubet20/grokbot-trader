import { useEffect, useRef, useState } from 'react';
import { BotIcon } from './Icons';
import { SPLASH_MS, splashProgress, splashShouldFinish } from '../boot';

const REPOS = ['TauriResearch/TradingAgents', 'sendaifun/solana-agent-kit', 'jackhuang166/ai-memecoin-trading-bot'];
const STARS = ['91.7k', '1.7k', '63'];

export function Splash({ appName, onDone }: { appName: string; onDone: () => void; ready?: boolean }) {
  const [p, setP] = useState(0);
  const done = useRef(false);
  const finish = () => {
    if (done.current) return;
    done.current = true;
    onDone();
  };

  useEffect(() => {
    const t0 = Date.now();
    const tick = () => {
      const elapsed = Date.now() - t0;
      setP(splashProgress(elapsed));
      if (splashShouldFinish(elapsed, false)) { clearInterval(iv); clearTimeout(hard); finish(); }
    };
    const iv = setInterval(tick, 50);
    const hard = setTimeout(() => { clearInterval(iv); finish(); }, SPLASH_MS);
    tick();
    return () => { clearInterval(iv); clearTimeout(hard); };
  }, []);

  const shown = Math.min(3, Math.floor(p * 3.3) || 1);
  return (
    <div className="splash" data-testid="splash" onClick={finish} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') finish(); }} role="button" tabIndex={0} aria-label="Skip splash">
      <div className="splash-center">
        <div className="splash-icon"><BotIcon size={96} /></div>
        <h1>{appName}</h1>
        <div className="badge-term mono">terminal · meme mode</div>
      </div>
      <div className="splash-term mono">
        <div className="muted">$ git clone · 3 repos</div>
        {REPOS.slice(0, shown).map((r, i) => (
          <div key={r} className="splash-repo"><span><span className="dot" style={{ background: ['#8b5cf6', '#22c55e', '#f59e0b'][i] }} />{r}</span><span className="muted">★ {STARS[i]}</span></div>
        ))}
        <div className="progress"><div style={{ width: `${p * 100}%` }} /></div>
        <div className="muted" style={{ textAlign: 'right' }}>{Math.round(p * 100)}%</div>
        <div className="muted splash-skip">tap to skip</div>
      </div>
    </div>
  );
}
