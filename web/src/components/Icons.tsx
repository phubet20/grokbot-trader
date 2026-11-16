export function BotIcon({ size = 40, radius }: { size?: number; radius?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 100 100" style={{ borderRadius: radius ?? size * 0.24, display: 'block', flex: 'none' }}>
      <defs><linearGradient id="gbshade" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#2a2a2e" /><stop offset="1" stopColor="#050506" /></linearGradient></defs>
      <rect width="100" height="100" rx="24" fill="url(#gbshade)" />
      <path d="M20 55c0-18 14-30 31-30s30 11 30 26c0 17-14 28-31 28-18 0-30-9-30-24z" fill="#fff" />
      <path d="M41 41l5 15M56 39l6 14" stroke="#0b0b0c" strokeWidth="6.5" strokeLinecap="round" />
    </svg>
  );
}
export function PhantomIcon({ size = 40 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 100 100" style={{ borderRadius: size * 0.24, display: 'block', flex: 'none' }}>
      <rect width="100" height="100" rx="24" fill="#AB9FF2" />
      <path d="M24 66c9 0 15-9 19-16 5-9 11-20 25-20 12 0 18 9 18 20 0 15-10 26-21 26-5 0-7-3-7-3s-3 5-9 5c-5 0-7-4-7-4s-4 4-9 4c-6 0-9-5-9-12z" fill="#fff" />
      <ellipse cx="58" cy="48" rx="3.5" ry="5.5" fill="#AB9FF2" /><ellipse cx="72" cy="48" rx="3.5" ry="5.5" fill="#AB9FF2" />
    </svg>
  );
}
export function TokenAvatar({ src, symbol, size = 22 }: { src?: string; symbol?: string; size?: number }) {
  const hue = [...(symbol || '?')].reduce((a, c) => a + c.charCodeAt(0) * 37, 0) % 360;
  return src ? (
    <img src={src} alt="" width={size} height={size} referrerPolicy="no-referrer" style={{ borderRadius: '50%', objectFit: 'cover', flex: 'none', background: `hsl(${hue} 60% 85%)` }} onError={(e) => { (e.target as HTMLImageElement).style.visibility = 'hidden'; }} />
  ) : (
    <span style={{ width: size, height: size, borderRadius: '50%', background: `hsl(${hue} 65% 55%)`, color: '#fff', fontSize: size * 0.45, fontWeight: 700, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flex: 'none' }}>{(symbol || '?').replace('$', '').slice(0, 1).toUpperCase()}</span>
  );
}
const P = (d: string) => (p: { size?: number }) => (<svg width={p.size || 22} height={p.size || 22} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d={d} /></svg>);
export const HomeI = P('M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z');
export const AgentsI = P('M8 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM16 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM2 20c0-3 3-5 6-5s6 2 6 5M12 20c0-3 3-5 5-5s5 2 5 5');
export const PulseI = P('M3 12h4l3-7 4 14 3-7h4');
export const UserI = P('M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21c0-4 4-6 8-6s8 2 8 6');
export const BellI = P('M6 8a6 6 0 1 1 12 0c0 7 3 8 3 8H3s3-1 3-8M10 20a2 2 0 0 0 4 0');
export const SunI = P('M12 4V2M12 22v-2M4 12H2M22 12h-2M5 5l1.5 1.5M17.5 17.5L19 19M5 19l1.5-1.5M17.5 6.5L19 5M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8z');
export const MoonI = P('M21 13A9 9 0 1 1 11 3a7 7 0 0 0 10 10z');
export const BackI = P('M15 5l-7 7 7 7');
export const StarI = P('M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1-4.4-4.3 6.1-.9z');
export const WalletI = P('M3 7a2 2 0 0 1 2-2h13v4M3 7v10a2 2 0 0 0 2 2h15V9H5a2 2 0 0 1-2-2zM16 14h.01');
export const CheckI = P('M5 12l5 5 9-10');
export const XI = P('M6 6l12 12M18 6L6 18');
