// Orchestrates the 5 agents: SCANNER -> SAFETY -> ANALYST -> RISK -> EXECUTOR.
import { EventEmitter } from 'node:events';
import { randomUUID, randomBytes } from 'node:crypto';
import type { Config } from './config.ts';
import { liveGate } from './config.ts';
import type { MarketSource } from './market.ts';
import { SOL_MINT } from './market.ts';
import type { Candidate, Position, ClosedTrade, ActivityItem } from './types.ts';
import { Store } from './store.ts';
import { preCheck, securityCheck, isPumpCurve } from './safety.ts';
import { scoreCandidate } from './analyst.ts';
import { positionSizeUsd, slotSizeUsd, usableSlots, entryBlocked, activeStop, reserveSol, fmtPct, adaptFilters, lowBalanceReason, BASE_FEE_SOL, ATA_RENT_SOL } from './risk.ts';
import { STRAT_DEFAULTS, toSnap, liveEntryOk, exitReason, sellPressure, entrySignal, dipReclaim, liveExit, netPnlFromSellQuote, momentumConfirm, isEstablished, type TapeSnap } from './strategy.ts';
import { PaperExecutor, buildLiveSwapTx, getSolBalance, getSignatureStatus, signAndSendSwap, withdrawToLocked } from './executor.ts';
import { botPublicKey, hasBotWallet, verifyWithdrawLock, LOCK_MESSAGE } from './wallet.ts';
import { notifyTrade, pushEnabled, subscriberCount } from './push.ts';
import { keepaliveSnapshot } from './keepalive.ts';
import { persistRenderEnv, autoStartEnabled, canPersistRenderEnv } from './render-env.ts';
import { rebuildPositions } from './reconcile.ts';
import { getPumpFeed, mergePumpOnto } from './pump.ts';
import { AutoTune, patternKey } from './autotune.ts';
import { smcFromTimeframes } from './smc.ts';
import { dailyNarrative, narrativeBoost, type Narrative } from './narrative.ts';

export type Wallet = {
  connected: boolean;
  type: 'paper' | 'phantom' | 'bot';
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
const CHECK_TIMEOUT_MS = 4000;
const SCAN_FETCH_TIMEOUT_MS = 5500;

export function withTimeout<T>(p: Promise<T>, ms: number, label = 'timeout'): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(label)), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

async function poolRun<T>(items: T[], limit: number, fn: (item: T) => Promise<void>) {
  let i = 0;
  const n = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: n }, async () => {
    while (i < items.length) {
      const item = items[i++];
      await fn(item);
    }
  }));
}


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
    scanner: { pools: 0, total: 0, lastScanAt: 0, perHour: 0, perMin: 0, cadenceMs: 0, inFlightChecks: 0, inFlightBuys: 0, inFlightSells: 0, top: '' as string, topImage: '' as string | undefined, calls: 0 },
    safety: { checked: 0, rejected: 0, passed: 0, last: '', lastSymbol: '', lastOk: true, calls: 0, reasons: {} as Record<string, number> },
    analyst: { scored: 0, lastScore: 0, lastSymbol: '', lastImage: '' as string | undefined, bull: 0, bear: 0, note: '', calls: 0 },
    risk: { status: 'Guarding', label: '', exits: 0 },
    executor: { fills: 0, last: '', failures: 0 },
  };
  private sellFails: Record<string, number> = {};
  private timers: NodeJS.Timeout[] = [];
  private scanning = false;
  private ingestingPump = false;
  private monitoring = false;
  private evaluating = false;
  private lastRejectLogAt = 0;
  private scanHistory: { t: number; n: number }[] = [];
  private scanTimes: number[] = [];
  private inFlightChecks = new Set<string>();
  private buying = new Set<string>();
  private selling = new Set<string>();
  private bookGen = 0;
  private reservedSol = 0;
  private tuner = new AutoTune();
  private narrative: Narrative | null = null;
  private solDayOpen = 0;
  private uni = { scannedNew: 0, scannedTrending: 0, enteredNew: 0, enteredTrending: 0, watch: 0 };
  private smcBusy = false;

  private lastPairAt = 0;
  private lossPauseUntil = 0;
  private mintHist = new Map<string, TapeSnap[]>();
  private strat() { return { ...STRAT_DEFAULTS, hardStopPct: this.cfg.hardStopPct, trailingStopPct: this.cfg.trailingStopPct, maxHoldMin: this.cfg.maxHoldMin, minLiq: this.cfg.minLiquidityUsd, maxLiq: this.cfg.maxLiquidityUsd, minMcap: this.cfg.minMcapUsd, maxMcap: this.cfg.maxMcapUsd, minAgeMin: this.cfg.minAgeMin, maxAgeHours: this.cfg.maxAgeHours }; }
  private remember(c: Candidate, now: number) {
    const s = toSnap(now, c);
    const arr = this.mintHist.get(c.mint) || [];
    if (!arr.length || arr[arr.length - 1].t !== s.t) arr.push(s);
    if (arr.length > 24) arr.splice(0, arr.length - 24);
    this.mintHist.set(c.mint, arr);
    return arr;
  }

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
    this.tuner.load(store.get('autotune', null));
  }

  get mode(): 'paper' | 'live' | 'live-auto' {
    const g = liveGate(this.cfg);
    if (!g.live) return 'paper';
    return g.auto ? 'live-auto' : 'live';
  }


  async start() {
    await this.refreshSol();
    if (autoStartEnabled()) {
      this.wallet.running = true;
      this.saveWallet();
    }
    // Paper: start entries as soon as a paper book exists (or create one on AUTO_START).
    if (this.mode === 'paper' && autoStartEnabled() && !this.wallet.connected) {
      await this.connect({ type: 'paper', startUsd: this.cfg.startUsd });
    }
    if (this.mode === 'live-auto' && hasBotWallet()) {
      await this.syncBotBalance();
      if (this.wallet.running || autoStartEnabled()) {
        await this.connect({ type: 'paper' });
        await this.reconcileOnchain();
      }
    } else if (this.mode === 'live' && this.wallet.connected && (this.wallet.running || autoStartEnabled())) {
      await this.reconcileOnchain();
    }
    this.lossPauseUntil = this.store.get('lossPauseUntil', 0);
    // Independent loops: the next tick is scheduled immediately, so a slow
    // scan, buy, or sell never delays the cadence of the others.
    const loop = (fn: () => Promise<void>, sec: () => number, name: string) => {
      const tick = () => {
        this.timers.push(setTimeout(tick, Math.max(0.25, sec()) * 1000));
        fn().catch((e: any) => this.log('Core', 'info', `${name}: ${e?.message || e}`));
      };
      tick();
    };
    loop(() => this.ingestPump(), () => 1, 'pump');
    loop(() => this.scan(), () => this.cfg.scanIntervalSec, 'scan');
    loop(() => this.evaluateEntries(), () => 1, 'eval');
    loop(() => this.monitor(), () => this.cfg.monitorIntervalSec, 'monitor');
    this.timers.push(setInterval(() => this.store.prune(), 10 * 60_000));
    if (this.wallet.connected && this.wallet.running) {
      this.log('Core', 'info', 'resumed saved Start state — trading continues with the app closed');
    } else if (this.wallet.connected) {
      this.log('Core', 'info', 'bot is paused (saved Stop state); open the app and tap Start to resume');
    }
  }
  stop() { for (const t of this.timers) clearTimeout(t); this.timers = []; }

  // ---------------------------------------------------------------- wallet
  async connect(opts: { type: 'paper' | 'phantom'; address?: string; startUsd?: number }) {
    await this.refreshSol(this.solPrice ? 0 : 400);
    if (!this.solPrice && this.mode === 'paper') this.solPrice = (this.m as any).lastSolPrice || 70;
    if (!this.solPrice) throw new Error('SOL price unavailable - check internet / use DATA_SOURCE=replay');
    const startUsd = Math.max(2, Number(opts.startUsd) || this.cfg.startUsd);
    let realSol: number | null = null;
    if (opts.type === 'phantom') {
      if (!opts.address || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(opts.address)) throw new Error('invalid wallet address');
      realSol = await getSolBalance(this.cfg.rpcUrl, opts.address);
    }
    const auto = this.mode === 'live-auto';
    const livePhantom = this.mode === 'live' && opts.type === 'phantom';
    if (auto && hasBotWallet()) {
      const pub = botPublicKey()!;
      const onchain = await getSolBalance(this.cfg.rpcUrl, pub);
      this.wallet = {
        ...this.wallet,
        connected: true, type: 'bot', address: pub, realSol: onchain,
        solBalance: onchain ?? 0,
        depositUsd: (onchain ?? 0) * this.solPrice || this.wallet.depositUsd,
        startedAt: this.wallet.startedAt || Date.now(),
        running: true,
      };
      if (!this.wallet.dayKey) { this.wallet.dayKey = dayKey(); this.wallet.dayStartEquity = this.equity(); this.store.addEquity(Date.now(), this.equity()); }
      this.saveWallet();
      this.log('Core', 'info', `Bot wallet ready · LIVE AUTO · $${this.equity().toFixed(2)}`);
      this.emitState();
      return this.wallet;
    }
    const solBalance = livePhantom ? (realSol ?? 0) : startUsd / this.solPrice;
    // Paper: an explicit Connect with a test balance always resets the sim book
    // (close open paper positions) so a new amount is not stuck behind AUTO_START.
    const resetPaper = opts.type === 'paper' && this.mode === 'paper' && (this.wallet.connected || this.positions.length > 0 || this.wallet.depositUsd > 0);
    if (resetPaper) this.resetPaperBook();
    this.wallet = {
      ...this.wallet,
      connected: true, type: opts.type, address: opts.address || this.wallet.address || this.previewAddr || fakeAddr(), realSol,
      solBalance,
      depositUsd: livePhantom ? solBalance * this.solPrice : startUsd,
      startedAt: Date.now(),
      running: true,
    };
    this.wallet.dayKey = dayKey();
    this.wallet.dayStartEquity = this.wallet.depositUsd;
    this.store.addEquity(Date.now(), this.wallet.depositUsd);
    this.saveWallet();
    this.log('Core', 'info', `${opts.type === 'phantom' ? 'Phantom' : 'Paper'} wallet connected · ${this.mode.toUpperCase()} mode · $${this.equity().toFixed(2)}`);
    this.emitState();
    return this.wallet;
  }
  /** Read-only preview used by the Connect sheet before connecting. */
  async preview(opts: { type: 'paper' | 'phantom'; address?: string; startUsd?: number }) {
    await this.refreshSol(this.solPrice ? 0 : 300);
    const startUsd = Math.max(2, Number(opts.startUsd) || this.cfg.startUsd);
    let realSol: number | null = null;
    if (opts.type === 'phantom' && opts.address) realSol = await getSolBalance(this.cfg.rpcUrl, opts.address);
    const useReal = this.mode === 'live' && opts.type === 'phantom';
    const sol = useReal ? (realSol ?? 0) : startUsd / (this.solPrice || 1);
    const address = opts.address || this.wallet.address || (opts.type === 'paper' ? (this.previewAddr ||= fakeAddr()) : '');
    return { network: 'Solana', mode: this.mode, address, sol, usd: sol * this.solPrice, realSol, solPrice: this.solPrice };
  }
  disconnect() { this.wallet.connected = false; this.wallet.running = false; this.saveWallet(); this.emitState(); }
  setRunning(r: boolean) {
    this.wallet.running = r;
    this.saveWallet();
    this.log('Core', 'info', r ? 'Bot resumed' : 'Bot paused - no new trades');
    void persistRenderEnv({ AUTO_START: r ? '1' : '0' }).then((res) => {
      if (res.ok) this.log('Core', 'info', 'Start/Stop saved to host env so it survives a restart');
    });
    this.emitState();
  }
  reset() {
    if (this.mode === 'live') throw new Error('reset is disabled in live mode');
    this.store.reset(); this.tuner = new AutoTune(); this.resetPaperBook();
    this.wallet = { connected: false, type: 'paper', address: '', realSol: null, solBalance: 0, depositUsd: 0, startedAt: 0, running: false, dayKey: '', dayStartEquity: 0 };
    this.emitState();
  }
  /** Drop simulated positions and session history so a new test balance starts clean. */
  private resetPaperBook() {
    this.bookGen++;
    this.positions = [];
    this.pending.clear();
    this.buying.clear();
    this.selling.clear();
    this.inFlightChecks.clear();
    this.reservedSol = 0;
    this.cooldown = {};
    this.store.clearPaperSession();
  }

  equity() {
    const pos = this.positions.reduce((a, p) => a + p.qty * (p.lastPrice || p.entryPrice) + p.rentSol * this.solPrice, 0);
    return this.wallet.solBalance * this.solPrice + pos;
  }
  cashUsd() { return this.wallet.solBalance * this.solPrice; }
  private freeCashUsd() { return Math.max(0, (this.wallet.solBalance - this.reservedSol) * this.solPrice); }

  /** Prefer a cached SOL price so Connect/preview never wait on the Jupiter quote queue. */
  private async refreshSol(maxWaitMs = 2500) {
    const cached = this.solPrice || (this.m as any).lastSolPrice || 0;
    if (cached) this.solPrice = cached;
    const work = this.m.prices([SOL_MINT]).then((p) => {
      if (p[SOL_MINT]) this.solPrice = p[SOL_MINT];
    }).catch(() => {});
    if (cached && maxWaitMs <= 0) { void work; return; }
    const wait = cached ? Math.min(maxWaitMs, 400) : maxWaitMs;
    await Promise.race([work, new Promise((r) => setTimeout(r, Math.max(0, wait)))]);
  }
  private async syncBotBalance() {
    const pub = botPublicKey();
    if (!pub || !this.solPrice) return;
    const b = await getSolBalance(this.cfg.rpcUrl, pub);
    if (b !== null) { this.wallet.realSol = b; this.wallet.solBalance = b; if (!this.wallet.address) this.wallet.address = pub; this.wallet.type = 'bot'; }
  }
  private recentPnls(): number[] {
    return this.store.trades(40).slice().reverse().map((t: any) => t.pnlUsd);
  }
  private riskAdapted() {
    return adaptFilters({ minScore: this.cfg.minScore, trailingStopPct: this.cfg.trailingStopPct, hardStopPct: this.cfg.hardStopPct }, this.recentPnls());
  }

  private occupied() {
    const s = new Set(this.positions.map((p) => p.mint));
    for (const p of this.pending.values()) if (p.side === 'buy') s.add(p.mint);
    for (const m of this.buying) s.add(m);
    return s.size;
  }
  private alreadyHeld(mint: string) {
    return this.positions.some((p) => p.mint === mint) || [...this.pending.values()].some((p) => p.mint === mint && p.side === 'buy');
  }
  private alreadyOn(mint: string) {
    return this.alreadyHeld(mint) || this.buying.has(mint);
  }
  private noteReject(reason: string) {
    const key = (reason || 'unknown').slice(0, 80);
    const s = this.agents.safety as typeof this.agents.safety & { reasons: Record<string, number> };
    if (!s.reasons) s.reasons = {};
    s.reasons[key] = (s.reasons[key] || 0) + 1;
    const now = Date.now();
    if (now - this.lastRejectLogAt > 20_000) {
      this.lastRejectLogAt = now;
      const top = Object.entries(s.reasons).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, n]) => `${k}×${n}`).join(' · ');
      this.log('Safety', 'info', `rejects ${s.rejected} · passed ${s.passed} · ${top || 'none yet'}`);
    }
  }

  private bumpScanStats(now: number, scanned: number, pools: number) {
    const sc = this.agents.scanner;
    sc.pools = pools; sc.total += scanned; sc.lastScanAt = now; sc.calls++;
    this.scanHistory.push({ t: now, n: scanned });
    this.scanHistory = this.scanHistory.filter((x) => now - x.t < 3600_000);
    this.scanTimes.push(now);
    this.scanTimes = this.scanTimes.filter((t) => now - t < 5 * 60_000);
    const span = Math.max(60_000, now - this.scanHistory[0].t);
    sc.perHour = Math.round((this.scanHistory.reduce((a, x) => a + x.n, 0) / span) * 3600_000);
    const lastMin = this.scanHistory.filter((x) => now - x.t <= 60_000);
    sc.perMin = lastMin.reduce((a, x) => a + x.n, 0);
    if (this.scanTimes.length >= 2) {
      const gaps: number[] = [];
      for (let i = 1; i < this.scanTimes.length; i++) gaps.push(this.scanTimes[i] - this.scanTimes[i - 1]);
      gaps.sort((a, b) => a - b);
      sc.cadenceMs = gaps[Math.floor(gaps.length / 2)] || 0;
    }
    sc.inFlightChecks = this.inFlightChecks.size;
    sc.inFlightBuys = this.buying.size;
    sc.inFlightSells = this.selling.size;
  }
  scanStatus() {
    const sc = this.agents.scanner;
    return {
      lastScanAt: sc.lastScanAt,
      lastScanAgoSec: sc.lastScanAt ? Math.max(0, (Date.now() - sc.lastScanAt) / 1000) : null,
      candidatesPerMin: sc.perMin,
      inFlightChecks: this.inFlightChecks.size,
      inFlightBuys: this.buying.size,
      inFlightSells: this.selling.size,
      cadenceMs: sc.cadenceMs,
      newScanned: this.uni.scannedNew,
      trendingScanned: this.uni.scannedTrending,
      enteredNew: this.uni.enteredNew,
      enteredTrending: this.uni.enteredTrending,
      watch: this.uni.watch,
      sources: (this.m as any).sourceHits || {},
      narrative: this.narrative,
    };
  }
  async flushWork(ms = 8000) {
    const start = Date.now();
    await Promise.resolve();
    while (Date.now() - start < ms) {
      const idle = !this.scanning && !this.evaluating && !this.monitoring && !this.inFlightChecks.size && !this.buying.size && !this.selling.size;
      if (idle) {
        await new Promise((r) => setTimeout(r, 25));
        if (!this.scanning && !this.evaluating && !this.monitoring && !this.inFlightChecks.size && !this.buying.size && !this.selling.size) return;
      }
      await this.evaluateEntries().catch(() => {});
      await new Promise((r) => setTimeout(r, 40));
    }
  }

  // ---------------------------------------------------------------- SCANNER
  /** 1s path: merge PumpPortal creates immediately, score, and try entries the same tick. */
  async ingestPump() {
    if (this.ingestingPump) return;
    this.ingestingPump = true;
    try {
      await new Promise((r) => setImmediate(r));
      const now = Date.now();
      const list = getPumpFeed().toCandidates(this.solPrice || 70, now);
      if (!list.length) return;
      let newN = 0, scoredNew = 0, rejectedNew = 0;
      for (const c of list) {
        const prev = this.candidates.get(c.mint);
        const first = !prev;
        const merged = prev ? mergePumpOnto(prev, c) : c;
        this.candidates.set(c.mint, { ...merged, seenAt: now, score: prev?.score, safety: prev?.safety });
        this.remember(this.candidates.get(c.mint)!, now);
        const pc = preCheck(this.candidates.get(c.mint)!, this.cfg, now);
        const cc = this.candidates.get(c.mint)!;
        if (!pc.ok) {
          cc.safety = pc.label;
          if (first) { rejectedNew++; this.noteReject('pre:' + (pc.reasons[0] || pc.label)); }
          continue;
        }
        const s = scoreCandidate(cc);
        cc.score = s.score;
        if (first) scoredNew++;
        if (s.score >= (this.agents.analyst.lastScore || 0)) {
          Object.assign(this.agents.analyst, { lastScore: s.score, lastSymbol: cc.symbol, lastImage: cc.image, bull: s.bull, bear: s.bear, note: s.note });
          this.agents.scanner.top = cc.symbol; this.agents.scanner.topImage = cc.image;
        }
        if (first) newN++;
      }
      this.agents.safety.checked += newN + rejectedNew;
      this.agents.safety.rejected += rejectedNew;
      this.agents.analyst.scored += scoredNew;
      if (scoredNew) this.agents.analyst.calls++;
      this.agents.scanner.lastScanAt = now;
      if (newN + rejectedNew) this.bumpScanStats(now, newN + rejectedNew, this.candidates.size);
      this.emit('agents', this.agents);
      void this.evaluateEntries();
    } finally {
      this.ingestingPump = false;
    }
  }

  async scan() {
    if (this.scanning) return;
    this.scanning = true;
    try {
      const { list, scanned, sources } = await withTimeout(this.m.candidates(), SCAN_FETCH_TIMEOUT_MS, 'scan fetch timeout') as any;
      await new Promise((r) => setImmediate(r));
      const now = Date.now();
      if (this.solPrice && !this.solDayOpen) this.solDayOpen = this.solPrice;
      let nNew = 0, nTr = 0;
      for (const c of list) {
        const prev = this.candidates.get(c.mint);
        const merged = { ...prev, ...c, seenAt: now, smc: c.smc || prev?.smc } as Candidate;
        if (isEstablished(merged, now) || merged.universe === 'trending') { merged.universe = 'trending'; nTr++; }
        else { merged.universe = merged.universe || 'new'; nNew++; }
        this.candidates.set(c.mint, merged);
        this.remember(merged, now);
      }
      this.uni.scannedNew += nNew;
      this.uni.scannedTrending += nTr;
      for (const [k, v] of this.candidates) if (now - v.seenAt > 3 * 3600_000 && !this.positions.some((p) => p.mint === k)) this.candidates.delete(k);

      const solChg = this.solDayOpen ? ((this.solPrice - this.solDayOpen) / this.solDayOpen) * 100 : 0;
      this.narrative = dailyNarrative([...this.candidates.values()], solChg);

      // SAFETY pre-check + ANALYST scoring
      const scored: { c: Candidate; s: ReturnType<typeof scoreCandidate> }[] = [];
      for (const c of list) {
        const cc = this.candidates.get(c.mint)!;
        cc.narrativeBoost = narrativeBoost(cc, this.narrative);
        const pc = preCheck(cc, this.cfg, now);
        if (!pc.ok) { cc.safety = pc.label; this.noteReject('pre:' + (pc.reasons[0] || pc.label)); continue; }
        const s = scoreCandidate(cc);
        cc.score = s.score;
        scored.push({ c: cc, s });
      }
      void this.enrichSmc(scored.map((x) => x.c));
      this.agents.safety.checked += list.length;
      this.agents.safety.rejected += list.length - scored.length;
      this.agents.analyst.scored += scored.length;
      this.agents.analyst.calls++;
      scored.sort((a, b) => b.s.score - a.s.score);
      if (scored[0]) {
        const t = scored[0];
        Object.assign(this.agents.analyst, { lastScore: t.s.score, lastSymbol: t.c.symbol, lastImage: t.c.image, bull: t.s.bull, bear: t.s.bear, note: t.s.note });
        this.agents.scanner.top = t.c.symbol; this.agents.scanner.topImage = t.c.image;
      }
      this.emit('agents', this.agents);
      this.bumpScanStats(now, scanned, list.length);
      // Evaluation, buys, and sells run on their own loops — do not await them here.
      void this.evaluateEntries();
    } finally {
      this.scanning = false;
      this.store.set('agents', this.agents);
      this.emit('agents', this.agents);
    }
  }

  // ---------------------------------------------------------------- concurrent evaluation (does not block scanning)
  async evaluateEntries() {
    if (this.evaluating) return;
    if (!this.wallet.connected || !this.wallet.running) return;
    this.evaluating = true;
    try {
      this.rollDay();
      const now = Date.now();
      const adapted = this.riskAdapted();
      const minScore = adapted.minScore;
      const recent = [...this.candidates.values()].filter((c) => now - c.seenAt < 180_000);
      let watch = 0;
      for (const c of recent) {
        if (!c.score) c.score = scoreCandidate(c).score;
        const hist = this.mintHist.get(c.mint) || [];
        const sig = entrySignal(c, hist, this.strat(), now);
        if (sig.ok) (c as any)._sig = sig.reason;
        const conf = momentumConfirm(c, hist, now);
        (c as any)._conf = conf.ok;
        if (!(c as any)._conf) (c as any)._confWhy = conf.reason;
        const established = isEstablished(c, now);
        // Trending/FOMO: queue and wait for timing (SMC/dip/candle/flow). New coins still need thrust.
        if (established && !(c as any)._sig) { watch++; continue; }
      }
      this.uni.watch = watch;
      const scored = recent
        .filter((c) => {
          const established = isEstablished(c, now);
          if (!(c as any)._conf) { if ((c.score || 0) >= minScore || (c as any)._sig) this.noteReject('no thrust'); return false; }
          if (established) return !!(c as any)._sig;
          return (c.score || 0) >= minScore || !!(c as any)._sig;
        })
        .sort((a, b) => (b.score || 0) - (a.score || 0))
        .slice(0, 20);
      if (!scored.length) return;
      const full = this.occupied() >= this.cfg.maxPositions;
      if (full) this.agents.risk.label = `holding ${this.occupied()}/${this.cfg.maxPositions}`;
      const todo = scored.filter((c) => {
        if (this.inFlightChecks.has(c.mint) || this.buying.has(c.mint)) return false;
        const held = this.alreadyHeld(c.mint);
        if (held) return this.canAdd(c, now);
        if (full) return false;
        const blocked = entryBlocked(this.cfg, {
          openPositions: this.occupied(),
          dayStartEquityUsd: this.wallet.dayStartEquity, equityUsd: this.equity(),
          alreadyHolding: false,
          inCooldown: (this.cooldown[c.mint] || 0) > now,
          pausedUntil: this.lossPauseUntil, now,
        });
        if (blocked) { this.noteReject('risk:' + blocked); return false; }
        const why = (c as any)._sig || `score ${c.score} ≥ ${minScore}`;
        if (!this.tuneAllows(why, c.score || 0, minScore, !!(c as any)._sig)) return false;
        return true;
      }).slice(0, 10);
      await poolRun(todo, 4, async (c) => {
        const why = (c as any)._sig || `score ${c.score} ≥ ${minScore}`;
        await this.checkCandidate(c, c.score || 0, why).catch(() => {});
      });
      this.store.set('cooldown', this.cooldown);
    } finally {
      this.evaluating = false;
      this.agents.scanner.inFlightChecks = this.inFlightChecks.size;
      this.store.set('agents', this.agents);
      this.emit('agents', this.agents);
    }
  }

  private maxCoinUsd() { return this.equity() * 0.24; }
  private canAdd(c: Candidate, now = Date.now()) {
    const pos = this.positions.find((p) => p.mint === c.mint);
    if (!pos) return false;
    if ((pos.adds || 0) >= 2) return false;
    if (pos.costUsd >= this.maxCoinUsd() * 0.98) return false;
    if ((this.cooldown[c.mint] || 0) > now) return false;
    const hist = this.mintHist.get(c.mint) || [];
    const dip = dipReclaim(hist.length ? hist : [toSnap(now, c)]);
    return dip.ok;
  }

  private async checkCandidate(c: Candidate, score: number, why: string) {
    const adding = this.alreadyHeld(c.mint);
    if (adding && !this.canAdd(c)) return;
    if (!adding && (this.alreadyOn(c.mint) || this.occupied() >= this.cfg.maxPositions)) return;
    this.inFlightChecks.add(c.mint);
    this.agents.scanner.inFlightChecks = this.inFlightChecks.size;
    this.emit('agents', this.agents);
    let aborted = false;
    try {
      const work = (async () => {
        const pump = isPumpCurve(c);
        // Pump curve: don't wait on RugCheck (it isn't indexed yet). AMM still fail-closed.
        const sec = pump
          ? await withTimeout(this.m.security(c.mint), 1200, 'sec timeout').catch(() => null)
          : await this.m.security(c.mint);
        if (aborted) return;
        this.agents.safety.calls++;
        const sr = securityCheck(sec, this.cfg, { pumpCurve: pump, devHoldPct: c.flow?.devHoldPct });
        Object.assign(this.agents.safety, { last: sr.label, lastSymbol: c.symbol, lastOk: sr.ok });
        const cc = this.candidates.get(c.mint);
        if (cc) cc.safety = sr.label;
        if (!sr.ok) {
          this.agents.safety.rejected++;
          this.noteReject('sec:' + (sr.reasons[0] || sr.label));
          this.decision({ ts: Date.now(), side: 'SKIP', symbol: c.symbol, image: c.image, text: `safety: ${sr.reasons.slice(0, 2).join(', ')}` });
          this.cooldown[c.mint] = Date.now() + 20 * 60_000;
          return;
        }
        const reserveUsd = reserveSol(this.cfg.priorityFeeSol) * (this.solPrice || 0);
        const trialSize = slotSizeUsd(this.cfg, this.equity(), this.freeCashUsd(), reserveUsd, this.occupied());
        if (!trialSize) { this.noteReject('risk:no size'); return; }
        const okSell = await this.sellable(c.mint, trialSize / this.solPrice);
        if (aborted) return;
        if (!okSell) {
          this.noteReject(pump ? 'not sellable on curve' : 'not sellable on Jupiter');
          this.decision({ ts: Date.now(), side: 'SKIP', symbol: c.symbol, image: c.image, text: pump ? 'safety: curve sell quote failed' : 'safety: Jupiter reverse quote failed (not sellable)' });
          this.cooldown[c.mint] = Date.now() + 15 * 60_000;
          return;
        }
        this.agents.safety.passed++;
        this.log('Safety', 'info', `${sr.label}`, { symbol: c.symbol, mint: c.mint, image: c.image });
        // Buy is async: mark in-flight now, never await the fill here.
        this.buying.add(c.mint);
        this.agents.scanner.inFlightBuys = this.buying.size;
        void this.openPosition(c, score, why);
      })();
      await withTimeout(work, CHECK_TIMEOUT_MS, `check ${c.symbol} timeout`);
    } catch {
      aborted = true;
      this.noteReject('check timed out');
      this.decision({ ts: Date.now(), side: 'SKIP', symbol: c.symbol, image: c.image, text: 'check timed out — skipped, scan continues' });
    } finally {
      this.inFlightChecks.delete(c.mint);
      this.agents.scanner.inFlightChecks = this.inFlightChecks.size;
    }
  }

  // ---------------------------------------------------------------- RISK sizing + EXECUTOR buy
  async openPosition(c: Candidate, score: number, why: string) {
    const gen = this.bookGen;
    const existing = this.positions.find((p) => p.mint === c.mint);
    const adding = !!existing;
    if (adding && !this.canAdd(c)) return;
    if (!adding && this.occupied() >= this.cfg.maxPositions && !this.buying.has(c.mint)) return;
    this.buying.add(c.mint);
    this.agents.scanner.inFlightBuys = this.buying.size;
    try {
    if (!this.solPrice) await this.refreshSol();
    if (!this.solPrice) return;
    const eq = this.equity();
    const adapted = this.riskAdapted();
    const reserveUsd = reserveSol(this.cfg.priorityFeeSol) * this.solPrice;
    const low = lowBalanceReason(eq, this.freeCashUsd(), reserveUsd, this.cfg.minTradeUsd);
    if (low) { this.agents.risk.label = low; return; }
    const openNow = Math.max(0, this.occupied() - (this.buying.has(c.mint) ? 1 : 0));
    let size = slotSizeUsd(this.cfg, eq, this.freeCashUsd(), reserveUsd, adding ? Math.max(0, openNow - 1) : openNow);
    if (adding && existing) {
      const room = Math.max(0, this.maxCoinUsd() - existing.costUsd);
      size = Math.min(size, room);
    }
    if (this.mode === 'paper') size *= this.tuner.sizeMult(why);
    if (!size) { this.agents.risk.label = 'not enough free cash'; return; }
    const solAmt = size / this.solPrice;
    if (this.mode === 'live-auto') { await this.execLiveAuto('buy', c, { solAmt, score, why }); return; }
    if (this.mode === 'live') { await this.requestLive('buy', c, { solAmt, score, why }); return; }

    const needSol = solAmt + BASE_FEE_SOL + this.cfg.priorityFeeSol + (adding ? 0 : ATA_RENT_SOL);
    if (this.wallet.solBalance - this.reservedSol < needSol) { this.agents.risk.label = 'not enough free cash'; return; }
    this.reservedSol += needSol;
    let f: Awaited<ReturnType<PaperExecutor['buy']>> | undefined;
    try {
      f = await this.exec.buy(c.mint, solAmt, this.solPrice);
    } finally {
      this.reservedSol = Math.max(0, this.reservedSol - needSol);
    }
    if (!f || !f.ok) { this.agents.executor.failures++; this.decision({ ts: Date.now(), side: 'SKIP', symbol: c.symbol, image: c.image, text: `executor: ${f && !f.ok ? f.error : 'buy failed'}` }); return; }
    if (gen !== this.bookGen) return; // paper book was reset while this fill was in flight
    const costSol = f.solSpent + f.feesSol;
    const debit = costSol + (adding ? 0 : f.rentSol);
    if (this.wallet.solBalance < debit) { this.agents.risk.label = 'not enough free cash'; return; }
    this.wallet.solBalance -= debit;
    const addUsd = costSol * this.solPrice;
    if (adding && existing) {
      const newQty = existing.qty + f.tokens;
      existing.entryPrice = (existing.entryPrice * existing.qty + f.fillPrice * f.tokens) / Math.max(1e-12, newQty);
      existing.qty = newQty;
      existing.costUsd += addUsd;
      existing.costSol += costSol;
      existing.lastPrice = f.fillPrice;
      existing.peakPrice = Math.max(existing.peakPrice, f.fillPrice);
      existing.adds = (existing.adds || 0) + 1;
      (existing as any).origCost = ((existing as any).origCost ?? (existing.costUsd - addUsd)) + addUsd;
      this.agents.executor.fills++; this.agents.executor.last = `ADD ${c.symbol}`;
      this.persist();
      this.decision({ ts: Date.now(), side: 'BUY', symbol: c.symbol, image: c.image, text: `add #${existing.adds} on ${why} · $${addUsd.toFixed(2)}`, usd: addUsd });
      this.log('Executor', 'buy', `Added ${c.symbol}`, { symbol: c.symbol, mint: c.mint, image: c.image, usd: addUsd });
      this.emit('toast', { kind: 'fill', title: 'Paper add', text: `${this.cfg.appName} · dip-reclaim add · simulated`, symbol: c.symbol });
      void notifyTrade({ side: 'BUY', symbol: c.symbol, sizeUsd: addUsd, price: f.fillPrice });
      this.emitState();
      return;
    }
    const pos: Position = {
      id: randomUUID(), mint: c.mint, pool: c.pool, symbol: c.symbol, name: c.name, image: c.image, openedAt: Date.now(),
      entryPrice: f.fillPrice, qty: f.tokens, decimals: f.decimals, costUsd: addUsd, costSol,
      peakPrice: f.fillPrice, lastPrice: f.fillPrice, score, rentSol: f.rentSol, adds: 0, entryLiq: c.liquidityUsd,
      entryPattern: patternKey(why), maePct: 0, immediateRed: false,
      entryFeatures: { score, m5: c.change.m5 || 0, m15: c.change.m15 || 0, liq: c.liquidityUsd, netBuy: c.flow?.netBuySol || 0, ageMin: c.createdAt ? (Date.now() - c.createdAt) / 60000 : 0 },
    } as Position;
    (pos as any).origCost = pos.costUsd; (pos as any).partialTaken = false; (pos as any).breakeven = false;
    this.positions.push(pos);
    if (isEstablished(c) || c.universe === 'trending') this.uni.enteredTrending++; else this.uni.enteredNew++;
    this.agents.executor.fills++; this.agents.executor.last = `BUY ${c.symbol}`;
    this.persist();
    const stake = (pos.costUsd / eq) * 100;
    this.decision({ ts: Date.now(), side: 'BUY', symbol: c.symbol, image: c.image, text: `${why} · $${pos.costUsd.toFixed(2)} via Jupiter (${f.route}, impact ${f.impactPct.toFixed(2)}%)`, usd: pos.costUsd });
    this.log('Executor', 'buy', `Bought ${c.symbol}`, { symbol: c.symbol, mint: c.mint, image: c.image, usd: pos.costUsd, stakePct: stake });
    this.emit('toast', { kind: 'fill', title: 'Paper fill', text: `${this.cfg.appName} · swap via Jupiter quote · simulated`, symbol: c.symbol });
    void notifyTrade({ side: 'BUY', symbol: c.symbol, sizeUsd: pos.costUsd, price: f.fillPrice });
    this.emitState();
    } finally {
      this.buying.delete(c.mint);
      this.agents.scanner.inFlightBuys = this.buying.size;
    }
  }

  // ---------------------------------------------------------------- RISK monitor + EXECUTOR sell
  async monitor() {
    if (this.monitoring) return;
    this.monitoring = true;
    try {
      const prices = await this.m.prices([SOL_MINT, ...this.positions.map((p) => p.mint)]);
      if (prices[SOL_MINT]) this.solPrice = prices[SOL_MINT];
      const now = Date.now();
      const adapted = this.riskAdapted();
      if (this.positions.length && now - this.lastPairAt > 3000) {
        this.lastPairAt = now;
        const freshList = await withTimeout((this.m as any).pairs ? (this.m as any).pairs(this.positions.map((p) => p.mint)) : Promise.all(this.positions.map((p) => this.m.pair(p.mint))).then((xs: any[]) => xs.filter(Boolean)), 4000, 'pair refresh timeout').catch(() => [] as any[]);
        for (const fresh of freshList || []) {
          this.candidates.set(fresh.mint, { ...this.candidates.get(fresh.mint), ...fresh, seenAt: now } as any);
          this.remember(fresh, now);
        }
      }
      const tpMarks: Position[] = [];
      for (const p of [...this.positions]) {
        if (this.selling.has(p.id)) continue;
        const fresh = this.candidates.get(p.mint);
        const px = prices[p.mint] || fresh?.priceUsd || p.lastPrice;
        if (!px) continue;
        p.lastPrice = px;
        const fromEntry = (px / p.entryPrice - 1) * 100;
        p.maePct = Math.min(p.maePct ?? 0, fromEntry);
        if (now - p.openedAt < 45_000 && fromEntry <= -2) p.immediateRed = true;
        const hist = this.mintHist.get(p.mint) || [];
        const d = liveExit({ ...p, peakPrice: Math.max(p.peakPrice, px) }, px, fresh, hist, {
          catStopPct: this.cfg.hardStopPct,
          sensitivity: this.mode === 'paper' ? this.tuner.exitSensitivity : 1,
          takeProfitPct: this.mode === 'paper' ? (this.cfg.takeProfitPct ?? 0) : 0,
          extraSlippageBps: this.cfg.extraSlippageBps,
          feeUsd: (BASE_FEE_SOL + this.cfg.priorityFeeSol) * this.solPrice,
        });
        p.peakPrice = Math.max(p.peakPrice, px);
        if (d.exit && d.kind === 'take_profit') { tpMarks.push(p); continue; }
        if (d.exit) void this.closePosition(p, d.kind!, d.reason, 1);
      }
      // Confirm TP against a real sell quote so a stale mark cannot lock in a loss.
      if (tpMarks.length) {
        const target = this.cfg.takeProfitPct ?? 3;
        await poolRun(tpMarks, 3, async (p) => {
          if (this.selling.has(p.id)) return;
          const net = await this.quotedNetPnlPct(p);
          if (net == null || net < target) return;
          await this.closePosition(p, 'take_profit', `take profit +${net.toFixed(1)}% net (target +${target}%)`, 1);
        });
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
      if (((this.mode === 'live' && this.wallet.type === 'phantom') || this.mode === 'live-auto') && now % 20_000 < this.cfg.monitorIntervalSec * 1000) {
        if (this.mode === 'live-auto') await this.syncBotBalance();
        else {
          const b = await getSolBalance(this.cfg.rpcUrl, this.wallet.address);
          if (b !== null) { this.wallet.realSol = b; this.wallet.solBalance = b; }
        }
      }
      this.persist();
      this.emit('positions', this.positionsView());
    } finally { this.monitoring = false; }
  }

  async closePosition(p: Position, kind: string, reason: string, fraction = 1) {
    if (this.selling.has(p.id) && fraction >= 0.999) return;
    this.selling.add(p.id);
    this.agents.scanner.inFlightSells = this.selling.size;
    try {
    const frac = Math.min(1, Math.max(0.05, fraction));
    if (this.mode === 'live-auto') { await this.execLiveAuto('sell', p as any, { position: p, kind, reason, fraction: frac }); return; }
    if (this.mode === 'live') { await this.requestLive('sell', p as any, { position: p, kind, reason, fraction: frac }); return; }
    const qty = p.qty * frac;
    const f = await this.exec.sell(p.mint, qty, p.decimals, this.solPrice);
    let solBack: number, fillPrice: number, note = '';
    if (!f.ok) {
      this.sellFails[p.id] = (this.sellFails[p.id] || 0) + 1;
      if (this.sellFails[p.id] < 6) return;
      fillPrice = p.lastPrice * 0.85; solBack = (qty * fillPrice) / this.solPrice; note = ' (no route, est.)';
    } else { solBack = f.solReceived - f.feesSol; fillPrice = f.fillPrice; }
    delete this.sellFails[p.id];
    if (frac < 0.999 && p.qty - qty > 0) {
      this.wallet.solBalance += solBack;
      const costCut = p.costUsd * frac;
      (p as any).origCost = (p as any).origCost ?? p.costUsd;
      (p as any).realizedUsd = ((p as any).realizedUsd || 0) + solBack * this.solPrice;
      p.qty -= qty;
      p.costUsd -= costCut;
      p.costSol *= (1 - frac);
      (p as any).partialTaken = true;
      (p as any).breakeven = true;
      this.log('Risk', 'sell', `Partial ${p.symbol} ${reason}`, { symbol: p.symbol, mint: p.mint, image: p.image, usd: solBack * this.solPrice, pct: (fillPrice / p.entryPrice - 1) * 100, text2: reason } as any);
      this.persist();
      this.emitState();
      return;
    }
    this.wallet.solBalance += solBack + p.rentSol;
    const proceeds = solBack * this.solPrice + ((p as any).realizedUsd || 0);
    const cost = (p as any).origCost ?? p.costUsd;
    p.costUsd = cost;
    this.finishClose(p, fillPrice, proceeds, kind, reason + note);
    } finally {
      this.selling.delete(p.id);
      this.agents.scanner.inFlightSells = this.selling.size;
    }
  }

  private finishClose(p: Position, exitPrice: number, proceedsUsd: number, kind: string, reason: string) {
    this.positions = this.positions.filter((x) => x.id !== p.id);
    const pnlUsd = proceedsUsd - p.costUsd;
    const t: ClosedTrade = { ...p, closedAt: Date.now(), exitPrice, proceedsUsd, pnlUsd, pnlPct: (pnlUsd / p.costUsd) * 100, reason, kind, heldSec: (Date.now() - p.openedAt) / 1000 } as ClosedTrade;
    this.store.addTrade(t);
    if (this.mode === 'paper') {
      this.tuner.record({ reason: p.entryPattern || reason, exitKind: kind, exitReason: reason, pnlUsd, costUsd: p.costUsd, pnlPct: t.pnlPct, equity: this.equity(), immediateRed: !!p.immediateRed || ((p.maePct || 0) <= -2 && (Date.now() - p.openedAt) < 45_000) });
      this.store.set('autotune', this.tuner.dump());
    }
    const rug = /rug|catastrophic|dev\/top-holder/i.test(reason);
    this.cooldown[p.mint] = Date.now() + (rug ? 8 * 60_000 : Math.max(15_000, this.cfg.cooldownMin * 60_000));
    this.agents.risk.exits++; this.agents.executor.fills++; this.agents.executor.last = `SELL ${p.symbol}`;
    this.persist();
    const stopped = kind === 'hard_stop' || pnlUsd < 0;
    this.decision({ ts: Date.now(), side: 'SELL', symbol: p.symbol, image: p.image, text: `${reason} · ${pnlUsd >= 0 ? '+' : '-'}$${Math.abs(pnlUsd).toFixed(2)} via Jupiter`, usd: pnlUsd });
    void notifyTrade({ side: 'SELL', symbol: p.symbol, sizeUsd: proceedsUsd, price: exitPrice, pnlPct: t.pnlPct });
    this.log('Risk', stopped ? 'stop' : 'sell', `${stopped ? 'Stopped' : 'Sold'} ${p.symbol}`, { symbol: p.symbol, mint: p.mint, image: p.image, usd: pnlUsd, pct: t.pnlPct, text2: reason } as any);
    if (pnlUsd > 0) this.emit('toast', { kind: 'profit', title: kind === 'take_profit' ? `Take profit ${p.symbol}` : `Risk sold ${p.symbol} - locked the gain`, usd: pnlUsd, pct: t.pnlPct, symbol: p.symbol, image: p.image });
    const adapted = this.riskAdapted();
    if (pnlUsd < 0 && adapted.pauseMs) {
      this.lossPauseUntil = Date.now() + adapted.pauseMs;
      this.store.set('lossPauseUntil', this.lossPauseUntil);
      this.log('Risk', 'info', `consecutive losses — pausing new entries ${Math.round(adapted.pauseMs / 60000)}m`);
    }
    this.emitState();
    // Refill free slots without going through a market scan wait.
    if (this.wallet.running) void this.evaluateEntries();
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
      void notifyTrade({ side: 'BUY', symbol: c.symbol, sizeUsd: costSol * this.solPrice, price });
    } else {
      const pos: Position = p.meta.position; const sol = p.meta.outAmount / 1e9;
      this.finishClose(pos, (sol * this.solPrice) / pos.qty, sol * this.solPrice, p.meta.kind, p.meta.reason);
    }
    this.persist(); this.emitState();
  }
  liveRejected(id: string) { const p = this.pending.get(id); this.pending.delete(id); if (p) this.log('Core', 'info', `you rejected the ${p.side} in Phantom`); }

  private async sellable(mint: string, solAmt: number): Promise<boolean> {
    const lamports = BigInt(Math.max(1, Math.floor(solAmt * 1e9)));
    const buy = await this.m.quote(SOL_MINT, mint, lamports, this.cfg.slippageBps);
    if (!buy?.outAmount) return false;
    const sell = await this.m.quote(mint, SOL_MINT, BigInt(Math.floor(buy.outAmount)), this.cfg.slippageBps);
    if (!sell?.outAmount) return false;
    return sell.outAmount >= Number(lamports) * 0.85;
  }

  /** LIVE AUTO: bot wallet signs and sends. Never logs the secret. */
  private async execLiveAuto(side: 'buy' | 'sell', c: any, meta: any) {
    if (!hasBotWallet()) { this.log('Core', 'info', 'live-auto needs BOT_WALLET_SECRET'); return; }
    const pub = botPublicKey()!;
    try {
      const args = side === 'buy'
        ? { inputMint: SOL_MINT, outputMint: c.mint, amountRaw: BigInt(Math.floor(meta.solAmt * 1e9)), userPublicKey: pub }
        : { inputMint: c.mint, outputMint: SOL_MINT, amountRaw: BigInt(Math.floor(meta.position.qty * 10 ** meta.position.decimals)), userPublicKey: pub, closeOutputAta: true };
      if (side === 'sell' && [...this.pending.values()].some((x) => x.mint === c.mint && x.side === 'sell')) return;
      const built = await buildLiveSwapTx(this.cfg, this.m, args);
      // Prompt-equivalent: the swap is sent immediately; toast the user in the UI.
      this.emit('toast', { kind: 'fill', title: side === 'buy' ? `Sending buy ${c.symbol}` : `Sending sell ${c.symbol}`, text: 'bot wallet signing · real funds', symbol: c.symbol });
      const signature = await signAndSendSwap(this.cfg.rpcUrl, built.swapTransaction);
      const decimals = await this.m.decimals(c.mint);
      const id = randomUUID();
      this.pending.set(id, { id, side, mint: c.mint, createdAt: Date.now(), tx: built.swapTransaction, meta: { ...meta, candidate: side === 'buy' ? c : undefined, outAmount: built.quote.outAmount, decimals }, signature });
      await this.liveSigned(id, signature);
      this.log('Executor', 'info', `live-auto ${side} ${c.symbol} confirmed`);
    } catch (e: any) { this.log('Executor', 'info', `live-auto ${side} not sent: ${e.message}`); }
  }

  async reconcileOnchain() {
    if (this.mode === 'paper') return;
    const owner = this.mode === 'live-auto' ? botPublicKey() : this.wallet.address;
    if (!owner) return;
    try {
      const r = await rebuildPositions({
        rpcUrl: this.cfg.rpcUrl, owner, solPrice: this.solPrice,
        current: this.positions,
        priceOf: async (mint) => {
          const px = await this.m.prices([mint]);
          return px[mint] || this.candidates.get(mint)?.priceUsd || 0;
        },
        metaOf: (mint) => this.candidates.get(mint),
      });
      this.positions = r.positions;
      this.persist();
      if (r.added) this.log('Core', 'info', `reconciled ${r.added} on-chain position(s); monitoring resumes`);
    } catch (e: any) {
      this.log('Core', 'info', `reconcile skipped: ${e?.message || e}`);
    }
  }

  lockedWithdrawTo(): string | null {
    const env = (process.env.WITHDRAW_TO || '').trim();
    if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(env)) return env;
    const stored = this.store.get<string>('withdrawTo', '');
    return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(stored) ? stored : null;
  }
  withdrawLockedBy(): 'env' | 'signature' | null {
    const env = (process.env.WITHDRAW_TO || '').trim();
    if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(env)) return 'env';
    return this.lockedWithdrawTo() ? 'signature' : null;
  }
  lockWithdraw(address: string, message: string, signature: string) {
    if (this.lockedWithdrawTo()) throw new Error('withdraw address is already locked and cannot be changed in the app');
    if (!verifyWithdrawLock(address, message, signature)) throw new Error('invalid Phantom signature — withdraw address not locked');
    if (address === botPublicKey()) throw new Error('cannot lock withdrawals to the bot wallet');
    this.store.set('withdrawTo', address);
    this.log('Core', 'info', `withdraw address locked to ${address.slice(0, 4)}…${address.slice(-4)}`);
    this.emitState();
    void persistRenderEnv({ WITHDRAW_TO: address }).then((res) => {
      if (res.ok) this.log('Core', 'info', 'withdraw lock saved to host env — it will survive restarts');
      else this.log('Core', 'info', `withdraw lock is signed but not in host env yet (${res.error || 'no API key'}). Message the bot after locking so it can be saved.`);
    });
    return { ok: true, withdrawTo: address, persisted: canPersistRenderEnv() };
  }
  async withdraw() {
    const to = this.lockedWithdrawTo();
    if (!to) throw new Error('lock a withdraw address first (connect Phantom once and sign) or set WITHDRAW_TO');
    if (this.positions.length) throw new Error('close open positions and pause the bot before withdrawing');
    if (this.pending.size) throw new Error('a swap is still pending');
    const r = await withdrawToLocked(this.cfg.rpcUrl, to);
    await this.syncBotBalance();
    this.log('Core', 'info', `withdrew ${(r.lamports / 1e9).toFixed(4)} SOL to locked address (closed ${r.closedAccounts} empty token accounts)`);
    this.emitState();
    return { ok: true, signature: r.signature, sol: r.lamports / 1e9, closedAccounts: r.closedAccounts, to };
  }

  // ---------------------------------------------------------------- views
  private rollDay() {
    const k = dayKey();
    if (this.wallet.dayKey !== k) { this.wallet.dayKey = k; this.wallet.dayStartEquity = this.equity(); if (this.solPrice) this.solDayOpen = this.solPrice; this.saveWallet(); }
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
    const ticker = [...this.candidates.values()].filter((c) => c.liquidityUsd > 5000).sort((a, b) => (b.score || 0) - (a.score || 0)).slice(0, 12)
      .map((c) => ({ symbol: c.symbol, mint: c.mint, image: c.image, change: c.change.h1 }));
    const reserve = reserveSol(this.cfg.priorityFeeSol);
    const reserveUsd = reserve * (this.solPrice || 0);
    const low = this.wallet.connected ? lowBalanceReason(this.equity(), this.cashUsd(), reserveUsd, this.cfg.minTradeUsd) : null;
    const adapted = this.riskAdapted();
    const botPub = botPublicKey();
    return {
      appName: this.cfg.appName, mode: this.mode, modeReason: gate.reason, dataSource: this.m.name, auto: !!gate.auto,
      wallet: { ...this.wallet }, stats: this.stats(), positions: this.positionsView(), agents: this.agents,
      activity: this.store.activity(60), decisions: this.store.decisions(40), ticker,
      calls: { ...this.m.calls }, apiErrors: this.m.errors, lastApiError: this.m.lastError,
      config: { ...this.cfg, liveConfirm: undefined },
      pending: [...this.pending.values()].map((p) => ({ id: p.id, side: p.side, mint: p.mint, tx: p.tx, signature: p.signature })),
      lowBalance: low, reserveSol: reserve, reserveUsd, spendableUsd: Math.max(0, this.cashUsd() - reserveUsd),
      sizeMult: adapted.sizeMult, pauseUntil: this.lossPauseUntil, scan: this.scanStatus(),
      keepalive: keepaliveSnapshot(),
      push: { enabled: pushEnabled(), subscribers: subscriberCount() },
      background: { tradesWithoutApp: true, runningPersisted: !!this.wallet.running, autoStart: autoStartEnabled(), ephemeralStorage: !process.env.RENDER_DISK_MOUNT_PATH, withdrawPersist: canPersistRenderEnv() ? 'env' : 'local-until-saved' },
      pump: getPumpFeed().status,
      autotune: this.tuner.snapshot(),
      narrative: this.narrative,
      botWallet: botPub ? {
        publicKey: botPub,
        withdrawTo: this.lockedWithdrawTo(),
        withdrawLocked: !!this.lockedWithdrawTo(),
        lockedBy: this.withdrawLockedBy(),
        lockMessage: this.lockedWithdrawTo() ? '' : LOCK_MESSAGE('YOUR_PHANTOM_ADDRESS'),
      } : null,
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

  private async enrichSmc(list: Candidate[]) {
    if (this.smcBusy || this.mode !== 'paper') return;
    const want = list.filter((c) => c.pool && (c.universe === 'trending' || isEstablished(c)) && !c.smc?.ok).slice(0, 6);
    if (!want.length) return;
    this.smcBusy = true;
    try {
      await poolRun(want, 2, async (c) => {
        const one = await withTimeout(this.m.ohlcv(c.pool, '1m'), 1800, 'ohlcv 1m').catch(() => [] as any);
        await new Promise((r) => setImmediate(r));
        const five = one && one.length >= 40 ? [] : await withTimeout(this.m.ohlcv(c.pool, '5m'), 1800, 'ohlcv 5m').catch(() => [] as any);
        const sig = smcFromTimeframes(one || [], five || []);
        const cc = this.candidates.get(c.mint);
        if (cc && sig.ok) { cc.smc = sig; cc.score = scoreCandidate(cc).score; }
      });
    } finally { this.smcBusy = false; }
  }

  /** Paper TP check: net % from an actual sell quote after extra slip and fees. */
  private async quotedNetPnlPct(p: Position): Promise<number | null> {
    if (!this.solPrice || p.qty <= 0 || p.costUsd <= 0) return null;
    const raw = BigInt(Math.floor(p.qty * 10 ** p.decimals));
    if (raw <= 0n) return null;
    const q = await withTimeout(this.m.quote(p.mint, SOL_MINT, raw, this.cfg.slippageBps), 1500, 'tp quote').catch(() => null);
    if (!q || q.outAmount <= 0) return null;
    const solReceived = (q.outAmount / 1e9) * (1 - (this.cfg.extraSlippageBps || 0) / 1e4);
    const feesSol = BASE_FEE_SOL + this.cfg.priorityFeeSol;
    return netPnlFromSellQuote(p.costUsd, solReceived, feesSol, this.solPrice);
  }

  private tuneAllows(why: string, score: number, minScore: number, hasSignal: boolean) {
    if (this.mode !== 'paper') return true;
    const g = this.tuner.allow(why);
    if (!g.ok) { this.noteReject('tune:off ' + g.key); return false; }
    if (!hasSignal && score < minScore + g.minScoreAdj) { this.noteReject('tune:score ' + g.key); return false; }
    if (g.exploring) this.agents.analyst.label = `explore ${g.key}`;
    return true;
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
