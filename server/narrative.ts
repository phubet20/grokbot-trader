// Daily main narrative / meta from names, symbols, and top-gainer themes.
import type { Candidate } from './types.ts';

export type Theme = { key: string; label: string; re: RegExp };

export const THEMES: Theme[] = [
  { key: 'ai', label: 'AI / agents', re: /\b(ai|gpt|claude|grok|agent|neural|llm|bot|agi)\b/i },
  { key: 'animals', label: 'animals / mascots', re: /\b(dog|doge|shib|cat|pepe|frog|wojak|capy|lion|tiger|penguin|fish|whale|monkey|ape|bear|bull)\b/i },
  { key: 'elon', label: 'Elon / x / mars', re: /\b(elon|musk|tesla|spacex|mars|doge|xai)\b/i },
  { key: 'politics', label: 'politics', re: /\b(trump|maga|biden|harris|vote|election|president|war|tariff)\b/i },
  { key: 'celeb', label: 'celeb / culture', re: /\b(kanye|ye |taylor|rihanna|khabib|messi|ronaldo|adidas|nike)\b/i },
  { key: 'tech', label: 'tech / solana', re: /\b(solana|sol |pump|bonk|jup|jupiter|wormhole|render|depin|rwa)\b/i },
  { key: 'money', label: 'money / treasury', re: /\b(money|cash|rich|wealth|treasury|gold|bitcoin|btc|fed|dollar|profit)\b/i },
  { key: 'crime', label: 'crime / degen', re: /\b(scam|rug|jail|crime|cartel|mafia|thief|steal)\b/i },
];

export function themesOf(name: string, symbol: string): string[] {
  const text = `${name || ''} ${symbol || ''}`;
  return THEMES.filter((t) => t.re.test(text)).map((t) => t.key);
}

export type Narrative = {
  key: string;
  label: string;
  count: number;
  solBias: number; // 24h-ish SOL move, if known
  note: string;
  updatedAt: number;
};

export function dailyNarrative(cands: Candidate[], solChangePct = 0): Narrative {
  const counts = new Map<string, number>();
  // Weight top gainers more so the "main" meta follows what's actually running.
  const ranked = [...cands].sort((a, b) => (b.change?.h1 || 0) - (a.change?.h1 || 0));
  ranked.forEach((c, i) => {
    const w = (c.change?.h1 || 0) > 8 ? 2 : 1;
    const boost = i < 12 ? 1.5 : 1;
    for (const k of themesOf(c.name, c.symbol)) counts.set(k, (counts.get(k) || 0) + w * boost);
  });
  let best: { key: string; n: number } = { key: 'mixed', n: 0 };
  for (const [key, n] of counts) if (n > best.n) best = { key, n };
  const theme = THEMES.find((t) => t.key === best.key);
  const sol = Number.isFinite(solChangePct) ? solChangePct : 0;
  const solBit = sol >= 2 ? 'SOL bid risk-on' : sol <= -2 ? 'SOL soft, fade weak metas' : 'SOL flat';
  const label = theme && best.n >= 3 ? theme.label : 'mixed tape';
  const key = theme && best.n >= 3 ? theme.key : 'mixed';
  return { key, label, count: best.n, solBias: sol, note: `${label} · ${solBit}`, updatedAt: Date.now() };
}

export function narrativeBoost(c: Candidate, n: Narrative | null): number {
  if (!n || n.key === 'mixed') return 0;
  return themesOf(c.name, c.symbol).includes(n.key) ? 8 : 0;
}
