// Orchestrates the 5 agents: SCANNER -> SAFETY -> ANALYST -> RISK -> EXECUTOR.
import { EventEmitter } from 'node:events';
import { randomUUID, randomBytes } from 'node:crypto';
import type { Config } from './config.ts';
import { liveGate } from './config.ts';
import type { MarketSource } from './market.ts';
import { SOL_MINT } from './market.ts';
import type { Candidate, Position, ClosedTrade, ActivityItem } from './types.ts';
import { Store } from './store.ts';
import { preCheck, securityCheck } from './safety.ts';
import { scoreCandidate } from './analyst.ts';
import { positionSizeUsd, entryBlocked, evaluateExit, activeStop, FEE_RESERVE_SOL, fmtPct } from './risk.ts';
import { PaperExecutor, buildLiveSwapTx, getSolBalance, getSignatureStatus, ATA_RENT_SOL } from './executor.ts';

export type Wallet = {
  connected: boolean;
  type: 'paper' | 'phantom';
  address: string;
  realSol: number | null;      // read-only on-chain balance of a connected Phantom wallet
  solBalance: number;          // trading cash (SOL) - simulated in paper mode
  depositUsd: number;          // "put in"
  startedAt: number;
  running: boolean;
  dayKey: string;
  dayStartEquity: number;
};

type Decision = { ts: number; side: 'BUY' | 'SELL' | 'SKIP'; symbol: string; image?: string; text: string; usd?: number };
type Pending = { id: string; side: 'buy' | 'sell'; mint: string; createdAt: number; tx: string; meta: any; signature?: string };

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const fakeAddr = () => Array.from(randomBytes(43), (b) => B58[b % 58]).join('');
const dayKey = (t = Date.now()) => new Date(t).toISOString().slice(0, 10);

export class Engine extends EventEmitter {
  cfg: Config;
  m: MarketSource;
  store: Store;
  exec: PaperExecutor;
  wallet: Wallet;
  private previewAddr = '';
  positions: Position[];
  solPrice = 0;
  candidates = new Map<string, Candidate & { score?: number; safety?: string; seenAt: number }>();
  cooldown: Record<string, number>;
  pending = new Map<string, Pending>();
  agents = {
    scanner: { pools: 0, total: 0, lastScanAt: 0, perHour: 0, top: '' as string, topImage: '' as string | undefined, calls: 0 },
    safety: { checked: 0, rejected: 0, passed: 0, last: '', lastSymbol: '', lastOk: true, calls: 0 },
    analyst: { scored: 0, lastScore: 0, lastSymbol: '', lastImage: '' as string | undefined, bull: 0, bear: 0, note: '', calls: 0 },
    risk: { status: 'Guarding', label: '', exits: 0 },
    executor: { fills: 0, last: '', failures: 0 },
  };
  private sellFails: Record<string, number> = {};
  private timers: NodeJS.Timeout[] = [];
  private scanning = false;
  private monitoring = false;
  private scanHistory: { t: number; n: number }[] = [];
  lastEquity = 0;

  constructor(cfg: Config, m: MarketSource, store: Store) {
    super();
    this.setMaxListeners(100);
    this.cfg = cfg; this.m = m; this.store = store;
    this.exec = new PaperExecutor(m, cfg);
    this.wallet = store.get<Wallet>('wallet', { connected: false, type: 'paper', address: '', realSol: null, solBalance: 0, depositUsd: 0, startedAt: 0, running: false, dayKey: '', dayStartEquity: 0 });
    this.positions = store.get<Position[]>('positions', []);
    this.cooldown = store.get<Record<string, number>>('cooldown', {});
    const saved = store.get<any>('agents', null);
    if (saved) for (const k of Object.keys(this.agents) as (keyof typeof this.agents)[]) Object.assign(this.agents[k], saved[k] || {});
  }

  get mode() { return liveGate(this.cfg).live ? 'live' : 'paper'; }

  async start() {
    await this.refreshSol();
    const loop = (fn: () => Promise<void>, sec: () => number) => {
      const tick = async () => { try { await fn(); } catch (e: any) { this.log('Core', 'info', `error: ${e?.message || e}`); } this.timers.push(setTimeout(tick, sec() * 1000)); };
      tick();
    };
    loop(() => this.scan(), () => this.cfg.scanIntervalSec);
    loop(() => this.monitor(), () => this.cfg.monitorIntervalSec);
    this.timers.push(setInterval(() => this.store.prune(), 10 * 60_000));
  }
  stop() { for (const t of this.timers) clearTimeout(t); this.timers = []; }

  // ---------------------------------------------------------------- wallet
  async connect(opts: { type: 'paper' | 'phantom'; address?: string; startUsd?: number }) {
    await this.refreshSol();
    if (!this.solPrice) throw new Error('SOL price unavailable - check internet / use DATA_SOURCE=replay');
    const startUsd = Math.max(10, Number(opts.startUsd) || this.cfg.startUsd);
    let realSol: number | null = null;
    if (opts.type === 'phantom') {
      if (!opts.address || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(opts.address)) throw new Error('invalid wallet address');
      realSol = await getSolBalance(this.cfg.rpcUrl, opts.address);
    }
    const live = this.mode === 'live' && opts.type === 'phantom';
    const solBalance = live ? (realSol ?? 0) : startUsd / this.solPrice;
    const fresh = !this.wallet.connected || this.wallet.depositUsd === 0;
    this.wallet = {
      ...this.wallet,
      connected: true, type: opts.type, address: opts.address || this.wallet.address || this.previewAddr || fakeAddr(), realSol,
      solBalance: fresh ? solBalance : this.wallet.solBalance,
      depositUsd: fresh ? solBalance * this.solPrice : this.wallet.depositUsd,
      startedAt: fresh ? Date.now() : this.wallet.startedAt,
      running: true,
    };
    if (fresh) { this.wallet.dayKey = dayKey(); this.wallet.dayStartEquity = this.wallet.depositUsd; this.store.addEquity(Date.now(), this.wallet.depositUsd); }
    this.saveWallet();
    this.log('Core', 'info', `${opts.type === 'phantom' ? 'Phantom' : 'Paper'} wallet connected · ${this.mode.toUpperCase()} mode · $${this.equity().toFixed(2)}`);
    this.emitState();
    return this.wallet;
  }
  /** Read-only preview used by the Connect sheet before connecting. */
  async preview(opts: { type: 'paper' | 'phantom'; address?: string; startUsd?: number }) {
    await this.refreshSol();
    const startUsd = Math.max(10, Number(opts.startUsd) || this.cfg.startUsd);
    let realSol: number | null = null;
    if (opts.type === 'phantom' && opts.address) realSol = await getSolBalance(this.cfg.rpcUrl, opts.address);
    const useReal = this.mode === 'live' && opts.type === 'phantom';
    const sol = useReal ? (realSol ?? 0) : startUsd / (this.solPrice || 1);
    const address = opts.address || this.wallet.address || (opts.type === 'paper' ? (this.previewAddr ||= fakeAddr()) : '');
    return { network: 'Solana', mode: this.mode, address, sol, usd: sol * this.solPrice, realSol, solPrice: this.solPrice };
  }
  disconnect() { this.wallet.connected = false; this.wallet.running = false; this.saveWallet(); this.emitState(); }
  setRunning(r: boolean) { this.wallet.running = r; this.saveWallet(); this.log('Core', 'info', r ? 'Bot resumed' : 'Bot paused - no new trades'); this.emitState(); }
  reset() {
    if (this.mode === 'live') throw new Error('reset is disabled in live mode');
    this.store.reset(); this.positions = []; for (const a of Object.values(this.agents)) for (const k of Object.keys(a)) if (typeof (a as any)[k] === 'number') (a as any)[k] = 0; this.cooldown = {}; this.pending.clear();
    this.wallet = { connected: false, type: 'paper', address: '', realSol: null, solBalance: 0, depositUsd: 0, startedAt: 0, running: false, dayKey: '', dayStartEquity: 0 };
    this.emitState();
  }

  equity() {
    const pos = this.positions.reduce((a, p) => a + p.qty * (p.lastPrice || p.entryPrice) + p.rentSol * this.solPrice, 0);
    return this.wallet.solBalance * this.solPrice + pos;
  }
  cashUsd() { return this.wallet.solBalance * this.solPrice; }

  private async refreshSol() {
    const p = await this.m.prices([SOL_MINT]);
    if (p[SOL_MINT]) this.solPrice = p[SOL_MINT];
  }

  // ---------------------------------------------------------------- SCANNER
  async scan() {
    if (this.scanning) return;
    this.scanning = true;
    try {
      const { list, scanned } = await this.m.candidates();
      const now = Date.now();
      const sc = this.agents.scanner;
      sc.pools = list.length; sc.total += scanned; sc.lastScanAt = now; sc.calls++;
      this.scanHistory.push({ t: now, n: scanned });
      this.scanHistory = this.scanHistory.filter((x) => now - x.t < 3600_000);
      const span = Math.max(60_000, now - this.scanHistory[0].t);
      sc.perHour = Math.round((this.scanHistory.reduce((a, x) => a + x.n, 0) / span) * 3600_000);
      for (const c of list) this.candidates.set(c.mint, { ...this.candidates.get(c.mint), ...c, seenAt: now });
      for (const [k, v] of this.candidates) if (now - v.seenAt > 3 * 3600_000 && !this.positions.some((p) => p.mint === k)) this.candidates.delete(k);

      // SAFETY pre-check + ANALYST scoring
      const scored: { c: Candidate; s: ReturnType<typeof scoreCandidate> }[] = [];
      for (const c of list) {
        const pc = preCheck(c, this.cfg, now);
        const cc = this.candidates.get(c.mint)!;
        if (!pc.ok) { cc.safety = pc.label; continue; }
        const s = scoreCandidate(c);
        cc.score = s.score;
        scored.push({ c, s });
      }
      this.agents.safety.checked += list.length;
      this.agents.safety.rejected += list.length - scored.length;
      this.agents.analyst.scored += scored.length;
      this.agents.analyst.calls++;
      scored.sort((a, b) => b.s.score - a.s.score);
      if (scored[0]) {
        const t = scored[0];
        Object.assign(this.agents.analyst, { lastScore: t.s.score, lastSymbol: t.c.symbol, lastImage: t.c.image, bull: t.s.bull, bear: t.s.bear, note: t.s.note });
        sc.top = t.c.symbol; sc.topImage = t.c.image;
      }
      this.emit('agents', this.agents);

      if (!this.wallet.connected || !this.wallet.running) return;
      this.rollDay();
      let checks = 0;
      for (const { c, s } of scored) {
        if (s.score < this.cfg.minScore) break;
        if (checks >= 4) break;
        const blocked = entryBlocked(this.cfg, {
          openPositions: this.positions.length + [...this.pending.values()].filter((p) => p.side === 'buy').length,
          dayStartEquityUsd: this.wallet.dayStartEquity, equityUsd: this.equity(),
          alreadyHolding: this.positions.some((p) => p.mint === c.mint) || [...this.pending.values()].some((p) => p.mint === c.mint),
          inCooldown: (this.cooldown[c.mint] || 0) > now,
        });
        if (blocked) {
          if (blocked.startsWith('max') || blocked.startsWith('daily')) { this.agents.risk.label = blocked; break; }
          continue;
        }
        checks++;
        const sec = await this.m.security(c.mint);
        this.agents.safety.calls++;
        const sr = securityCheck(sec, this.cfg);
        Object.assign(this.agents.safety, { last: sr.label, lastSymbol: c.symbol, lastOk: sr.ok });
        this.candidates.get(c.mint)!.safety = sr.label;
        if (!sr.ok) {
          this.agents.safety.rejected++;
          this.decision({ ts: Date.now(), side: 'SKIP', symbol: c.symbol, image: c.image, text: `safety: ${sr.reasons.slice(0, 2).join(', ')}` });
          this.cooldown[c.mint] = Date.now() + 30 * 60_000;
          continue;
        }
        this.agents.safety.passed++;
        this.log('Safety', 'info', `${sr.label}`, { symbol: c.symbol, mint: c.mint, image: c.image });
        await this.openPosition(c, s.score, `score ${s.score} · bull ${s.bull}/bear ${s.bear}`);
      }
      this.store.set('cooldown', this.cooldown);
    } finally {
      this.scanning = false;
      this.store.set('agents', this.agents);
      this.emit('agents', this.agents);
    }
  }

  // ---------------------------------------------------------------- RISK sizing + EXECUTOR buy
  async openPosition(c: Candidate, score: number, why: string) {
    await this.refreshSol();
    if (!this.solPrice) return;
    const eq = this.equity();
    const reserveUsd = (FEE_RESERVE_SOL + ATA_RENT_SOL) * this.solPrice;
    const size = positionSizeUsd(this.cfg, eq, this.cashUsd(), reserveUsd);
    if (!size) { this.agents.risk.label = 'not enough free cash'; return; }
    const solAmt = size / this.solPrice;
    if (this.mode === 'live') return this.requestLive('buy', c, { solAmt, score, why });

    const f = await this.exec.buy(c.mint, solAmt, this.solPrice);
    if (!f.ok) { this.agents.executor.failures++; this.decision({ ts: Date.now(), side: 'SKIP', symbol: c.symbol, image: c.image, text: `executor: ${f.error}` }); return; }
    const costSol = f.solSpent + f.feesSol;
    this.wallet.solBalance -= costSol + f.rentSol;
    const pos: Position = {
      id: randomUUID(), mint: c.mint, pool: c.pool, symbol: c.symbol, name: c.name, image: c.image, openedAt: Date.now(),
      entryPrice: f.fillPrice, qty: f.tokens, decimals: f.decimals, costUsd: costSol * this.solPrice, costSol,
      peakPrice: f.fillPrice, lastPrice: f.fillPrice, score, rentSol: f.rentSol,
    };
    this.positions.push(pos);
    this.agents.executor.fills++; this.agents.executor.last = `BUY ${c.symbol}`;
    this.persist();
    const stake = (pos.costUsd / eq) * 100;
    this.decision({ ts: Date.now(), side: 'BUY', symbol: c.symbol, image: c.image, text: `${why} · $${pos.costUsd.toFixed(2)} via Jupiter (${f.route}, impact ${f.impactPct.toFixed(2)}%)`, usd: pos.costUsd });
    this.log('Executor', 'buy', `Bought ${c.symbol}`, { symbol: c.symbol, mint: c.mint, image: c.image, usd: pos.costUsd, stakePct: stake });
    this.emit('toast', { kind: 'fill', title: 'Paper fill', text: `${this.cfg.appName} · swap via Jupiter quote · simulated`, symbol: c.symbol });
    this.emitState();
  }

  // ---------------------------------------------------------------- RISK monitor + EXECUTOR sell
  async monitor() {
    if (this.monitoring) return;
    this.monitoring = true;
    try {
      const prices = await this.m.prices([SOL_MINT, ...this.positions.map((p) => p.mint)]);
      if (prices[SOL_MINT]) this.solPrice = prices[SOL_MINT];
      const now = Date.now();
      for (const p of [...this.positions]) {
        const px = prices[p.mint];
        if (!px) continue;
        p.lastPrice = px;
        const d = evaluateExit(this.cfg, p, px, now);
        p.peakPrice = d.peak;
        if (d.exit) await this.closePosition(p, d.kind!, d.reason);
      }
      const trailing = this.positions.filter((p) => activeStop(this.cfg, p).kind === 'trailing');
      this.agents.risk.status = trailing.length ? `Trailing ${trailing.length}` : this.positions.length ? 'Guarding' : 'Idle';
      if (trailing[0]) this.agents.risk.label = `${trailing[0].symbol} trailing ${fmtPct((trailing[0].lastPrice / trailing[0].entryPrice - 1) * 100)}`;
      if (this.wallet.connected && this.solPrice) {
        const eq = this.equity();
        this.lastEquity = eq;
        this.store.addEquity(now, eq);
        this.emit('equity', { ts: now, usd: eq });
      }
      if (this.mode === 'live' && this.wallet.type === 'phantom' && now % 60_000 < this.cfg.monitorIntervalSec * 1000) {
        const b = await getSolBalance(this.cfg.rpcUrl, this.wallet.address);
        if (b !== null) { this.wallet.realSol = b; this.wallet.solBalance = b; }
      }
      this.persist();
      this.emit('positions', this.positionsView());
    } finally { this.monitoring = false; }
  }

  async closePosition(p: Position, kind: string, reason: string) {
    if (this.mode === 'live') return this.requestLive('sell', p as any, { position: p, kind, reason });
    const f = await this.exec.sell(p.mint, p.qty, p.decimals, this.solPrice);
    let solBack: number, fillPrice: number, note = '';
    if (!f.ok) {
      this.sellFails[p.id] = (this.sellFails[p.id] || 0) + 1;
      if (this.sellFails[p.id] < 6) return; // retry next tick
      // paper only: assume a bad exit (-15% vs last price) when no route exists
      fillPrice = p.lastPrice * 0.85; solBack = (p.qty * fillPrice) / this.solPrice; note = ' (no route, est.)';
    } else { solBack = f.solReceived - f.feesSol; fillPrice = f.fillPrice; }
    delete this.sellFails[p.id];
    this.wallet.solBalance += solBack + p.rentSol;
    this.finishClose(p, fillPrice, solBack * this.solPrice, kind, reason + note);
  }

  private finishClose(p: Position, exitPrice: number, proceedsUsd: number, kind: string, reason: string) {
    this.positions = this.positions.filter((x) => x.id !== p.id);
    const pnlUsd = proceedsUsd - p.costUsd;
    const t: ClosedTrade = { ...p, closedAt: Date.now(), exitPrice, proceedsUsd, pnlUsd, pnlPct: (pnlUsd / p.costUsd) * 100, reason };
    this.store.addTrade(t);
    this.cooldown[p.mint] = Date.now() + this.cfg.cooldownMin * 60_000;
    this.agents.risk.exits++; this.agents.executor.fills++; this.agents.executor.last = `SELL ${p.symbol}`;
    this.persist();
    const stopped = kind === 'hard_stop' || pnlUsd < 0;
    this.decision({ ts: Date.now(), side: 'SELL', symbol: p.symbol, image: p.image, text: `${reason} · ${pnlUsd >= 0 ? '+' : '-'}$${Math.abs(pnlUsd).toFixed(2)} via Jupiter`, usd: pnlUsd });
    this.log('Risk', stopped ? 'stop' : 'sell', `${stopped ? 'Stopped' : 'Sold'} ${p.symbol}`, { symbol: p.symbol, mint: p.mint, image: p.image, usd: pnlUsd, pct: t.pnlPct, text2: reason } as any);
    if (pnlUsd > 0) this.emit('toast', { kind: 'profit', title: `Risk sold ${p.symbol} - locked the gain`, usd: pnlUsd, pct: t.pnlPct, symbol: p.symbol, image: p.image });
    this.emitState();
  }

  // ---------------------------------------------------------------- LIVE (Phantom approval) path
  private async requestLive(side: 'buy' | 'sell', c: any, meta: any) {
    if (this.wallet.type !== 'phantom') { this.log('Core', 'info', 'live mode needs a connected Phantom wallet'); return; }
    try {
      const args = side === 'buy'
        ? { inputMint: SOL_MINT, outputMint: c.mint, amountRaw: BigInt(Math.floor(meta.solAmt * 1e9)), userPublicKey: this.wallet.address }
        : { inputMint: c.mint, outputMint: SOL_MINT, amountRaw: BigInt(Math.floor(meta.position.qty * 10 ** meta.position.decimals)), userPublicKey: this.wallet.address };
      if (side === 'sell' && [...this.pending.values()].some((x) => x.mint === c.mint && x.side === 'sell')) return;
      const built = await buildLiveSwapTx(this.cfg, this.m, args);
      const id = randomUUID();
      const decimals = await this.m.decimals(c.mint);
      this.pending.set(id, { id, side, mint: c.mint, createdAt: Date.now(), tx: built.swapTransaction, meta: { ...meta, candidate: side === 'buy' ? c : undefined, outAmount: built.quote.outAmount, decimals } });
      this.emit('approval', { id, side, symbol: c.symbol, tx: built.swapTransaction, text: side === 'buy' ? `Buy ${c.symbol} for ${meta.solAmt.toFixed(4)} SOL` : `Sell ${c.symbol} (${meta.reason})` });
    } catch (e: any) { this.log('Executor', 'info', `live ${side} not sent: ${e.message}`); }
  }
  async liveSigned(id: string, signature: string) {
    const p = this.pending.get(id); if (!p) throw new Error('unknown request');
    p.signature = signature;
    for (let i = 0; i < 30; i++) {
      const s = await getSignatureStatus(this.cfg.rpcUrl, signature);
      if (s === 'failed') { this.pending.delete(id); this.log('Executor', 'info', 'transaction failed on-chain'); return; }
      if (s === 'confirmed' || s === 'finalized') break;
      await new Promise((r) => setTimeout(r, 2000));
    }
    this.pending.delete(id);
    // NOTE: quantities are taken from the Jupiter quote (estimate); on-chain balance is re-synced every minute.
    if (p.side === 'buy') {
      const c = p.meta.candidate; const tokens = p.meta.outAmount / 10 ** p.meta.decimals;
      const costSol = p.meta.solAmt; const price = (costSol * this.solPrice) / tokens;
      this.positions.push({ id, mint: c.mint, pool: c.pool, symbol: c.symbol, name: c.name, image: c.image, openedAt: Date.now(), entryPrice: price, qty: tokens, decimals: p.meta.decimals, costUsd: costSol * this.solPrice, costSol, peakPrice: price, lastPrice: price, score: p.meta.score, rentSol: 0 });
      this.log('Executor', 'buy', `Bought ${c.symbol}`, { symbol: c.symbol, mint: c.mint, image: c.image, usd: costSol * this.solPrice });
    } else {
      const pos: Position = p.meta.position; const sol = p.meta.outAmount / 1e9;
      this.finishClose(pos, (sol * this.solPrice) / pos.qty, sol * this.solPrice, p.meta.kind, p.meta.reason);
    }
    this.persist(); this.emitState();
  }
  liveRejected(id: string) { const p = this.pending.get(id); this.pending.delete(id); if (p) this.log('Core', 'info', `you rejected the ${p.side} in Phantom`); }

  // ---------------------------------------------------------------- views
  private rollDay() {
    const k = dayKey();
    if (this.wallet.dayKey !== k) { this.wallet.dayKey = k; this.wallet.dayStartEquity = this.equity(); this.saveWallet(); }
  }
  positionsView() {
    return this.positions.map((p) => ({ ...p, valueUsd: p.qty * p.lastPrice, pnlPct: (p.lastPrice / p.entryPrice - 1) * 100, stop: activeStop(this.cfg, p) }));
  }
  stats() {
    const trades = this.store.trades(5000);
    const wins = trades.filter((t) => t.pnlUsd > 0);
    const eq = this.wallet.connected ? this.equity() : 0;
    const best = trades.reduce((a: any, t) => (!a || t.pnlUsd > a.pnlUsd ? t : a), null);
    const worst = trades.reduce((a: any, t) => (!a || t.pnlUsd < a.pnlUsd ? t : a), null);
    return {
      equity: eq, deposit: this.wallet.depositUsd, pnlUsd: eq - this.wallet.depositUsd,
      pnlPct: this.wallet.depositUsd ? (eq / this.wallet.depositUsd - 1) * 100 : 0,
      multiplier: this.wallet.depositUsd ? eq / this.wallet.depositUsd : 1,
      trades: trades.length + this.positions.length, closed: trades.length, wins: wins.length, losses: trades.length - wins.length,
      winRate: trades.length ? (wins.length / trades.length) * 100 : 0,
      coins: new Set([...trades.map((t) => t.mint), ...this.positions.map((p) => p.mint)]).size,
      best: best && { symbol: best.symbol, usd: best.pnlUsd }, worst: worst && { symbol: worst.symbol, usd: worst.pnlUsd },
      cashUsd: this.cashUsd(), solBalance: this.wallet.solBalance, solPrice: this.solPrice,
      runtimeMin: this.wallet.startedAt ? (Date.now() - this.wallet.startedAt) / 60_000 : 0,
    };
  }
  snapshot() {
    const gate = liveGate(this.cfg);
    const ticker = [...this.candidates.values()].filter((c) => c.liquidityUsd > 10000).sort((a, b) => (b.score || 0) - (a.score || 0)).slice(0, 12)
      .map((c) => ({ symbol: c.symbol, mint: c.mint, image: c.image, change: c.change.h1 }));
    return {
      appName: this.cfg.appName, mode: this.mode, modeReason: gate.reason, dataSource: this.m.name,
      wallet: { ...this.wallet }, stats: this.stats(), positions: this.positionsView(), agents: this.agents,
      activity: this.store.activity(60), decisions: this.store.decisions(40), ticker,
      calls: { ...this.m.calls }, apiErrors: this.m.errors, lastApiError: this.m.lastError,
      config: { ...this.cfg, liveConfirm: undefined },
      pending: [...this.pending.values()].map((p) => ({ id: p.id, side: p.side, mint: p.mint, tx: p.tx, signature: p.signature })),
    };
  }
  equitySeries(range: string) {
    const span: Record<string, number> = { LIVE: 15 * 60_000, '1H': 3600_000, '4H': 4 * 3600_000, '1D': 86400_000, '1W': 7 * 86400_000, ALL: 1e15 };
    const since = Math.max(this.wallet.startedAt || 0, Date.now() - (span[range] ?? span.ALL));
    const rows = this.store.equity(since);
    const max = 240;
    if (rows.length <= max) return rows;
    const step = rows.length / max;
    const out = [] as typeof rows;
    for (let i = 0; i < max; i++) out.push(rows[Math.floor(i * step)]);
    out.push(rows[rows.length - 1]);
    return out;
  }
  async tokenDetail(mint: string, tf = '1m') {
    const c = this.candidates.get(mint);
    const pos = this.positions.find((p) => p.mint === mint);
    const trades = this.store.trades(2000).filter((t) => t.mint === mint);
    const pool = c?.pool || pos?.pool || trades[0]?.pool;
    const candles = pool ? await this.m.ohlcv(pool, tf) : [];
    const sec = await this.m.security(mint).catch(() => null);
    const markers: any[] = [];
    for (const t of [...trades, ...(pos ? [pos] : [])]) {
      markers.push({ ts: t.openedAt, price: t.entryPrice, kind: 'buy', label: 'Executor buy' });
      if ((t as any).closedAt) markers.push({ ts: (t as any).closedAt, price: (t as any).exitPrice, kind: 'sell', label: (t as any).reason?.includes('trailing') ? 'Risk trailing stop' : 'Risk stop' });
    }
    return {
      mint, pool, symbol: c?.symbol || pos?.symbol || trades[0]?.symbol, name: c?.name || pos?.name || trades[0]?.name, image: c?.image || pos?.image || trades[0]?.image,
      priceUsd: pos?.lastPrice || c?.priceUsd, mcapUsd: c?.mcapUsd, liquidityUsd: c?.liquidityUsd, volume24h: c?.volume.h24, change: c?.change, createdAt: c?.createdAt,
      holders: sec?.holders ?? null, score: c?.score, safety: c?.safety,
      position: pos ? { ...pos, valueUsd: pos.qty * pos.lastPrice, stop: activeStop(this.cfg, pos) } : null,
      trades, candles, markers, trailingStopPct: this.cfg.trailingStopPct, hardStopPct: this.cfg.hardStopPct,
    };
  }

  // ---------------------------------------------------------------- helpers
  private persist() { this.store.set('positions', this.positions); this.saveWallet(); }
  private saveWallet() { this.store.set('wallet', this.wallet); }
  private decision(d: Decision) { this.store.addDecision(d); this.emit('decision', d); }
  log(agent: ActivityItem['agent'], kind: ActivityItem['kind'], text: string, extra: Partial<ActivityItem> & { text2?: string } = {}) {
    const a = { id: randomUUID(), ts: Date.now(), agent, kind, text, ...extra } as ActivityItem;
    this.store.addActivity(a);
    this.emit('activity', a);
    const t = new Date().toLocaleTimeString('en-GB', { hour12: false });
    console.log(`[${t}] ${agent.padEnd(8)} ${text}${extra.usd !== undefined ? ` $${extra.usd.toFixed(2)}` : ''}${(extra as any).text2 ? ' · ' + (extra as any).text2 : ''}`);
  }
  emitState() { this.emit('state', this.snapshot()); }
}
