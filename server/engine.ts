// Orchestrates the 5 agents: SCANNER -> SAFETY -> ANALYST -> RISK -> EXECUTOR.
import { EventEmitter } from 'node:events';
import { randomUUID, randomBytes } from 'node:crypto';
import type { Config } from './config.ts';
import { liveGate } from './config.ts';
import { loadPaperPriors, pumpPathBoost, pumpPotential, isQuickRedExit, staleExitSec, isStalePosition, isDeadPosition, DEAD_EXIT_SEC, type PaperPriors } from './priors.ts';
import type { MarketSource } from './market.ts';
import { SOL_MINT } from './market.ts';
import type { Candidate, Position, ClosedTrade, ActivityItem } from './types.ts';
import { Store, type Book } from './store.ts';
import { preCheck, securityCheck, isPumpCurve, clampScore } from './safety.ts';
import { scoreCandidate } from './analyst.ts';
import { positionSizeUsd, slotSizeUsd, openSizeUsd, usableSlots, entryBlocked, activeStop, reserveSol, exitReserveSol, fmtPct, adaptFilters, lowBalanceReason, BASE_FEE_SOL, ATA_RENT_SOL } from './risk.ts';
import { summarizeSources } from './scan-feeds.ts';
import { STRAT_DEFAULTS, toSnap, liveEntryOk, exitReason, sellPressure, entrySignal, dipReclaim, liveExit, estimatedNetPnlPct, netPnlFromSellQuote, momentumConfirm, alreadyPumpedHard, signalAdjustments, currentlyPumping, SWAP_FEE_BPS, RUNNER_PARTIAL_PCT, type TapeSnap } from './strategy.ts';
import { PaperExecutor, buildLiveSwapTx, getSolBalance, getSignatureStatus, signAndSendSwap, reclaimEmptyAtas } from './executor.ts';
import { botPublicKey, hasBotWallet, verifyWithdrawLock, LOCK_MESSAGE } from './wallet.ts';
import { notifyTrade, pushEnabled, subscriberCount } from './push.ts';
import { keepaliveSnapshot } from './keepalive.ts';
import { persistRenderEnv, autoStartEnabled, ensureAutoStartEnv, canPersistRenderEnv } from './render-env.ts';
import { getUsdcBalance, canAutoSwapUsdc, swapUsdcToSol, transferUsdc, USDC_DECIMALS } from './usdc.ts';
import { parseWithdrawDestination, DEFAULT_WITHDRAW_TO, sendSolWithdraw, keepLamportsForWithdraw, previewSolWithdraw, WITHDRAW_ERR, shortAddr } from './withdraw.ts';
import { remoteStateStatus } from './remote-state.ts';
import { rebuildPositions } from './reconcile.ts';
import { getPumpFeed, mergePumpOnto } from './pump.ts';
import { AutoTune, patternKey } from './autotune.ts';
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



/** Restore a missing deposit baseline so PnL after restart includes open positions. */
export function depositBaseline(saved: number, equity: number, cash: number, hasRestoredPos: boolean): number {
  if (saved > 0) {
    // Saved value that equals cash only (positions were left out) should be repaired.
    if (hasRestoredPos && equity > cash + 0.05 && Math.abs(saved - cash) <= Math.max(0.15, Math.abs(cash) * 0.02))
      return equity;
    return saved;
  }
  return equity > 0 ? equity : 0;
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
    scanner: { pools: 0, total: 0, lastScanAt: 0, perHour: 0, perMin: 0, cadenceMs: 0, inFlightChecks: 0, inFlightBuys: 0, inFlightSells: 0, top: '' as string, topImage: '' as string | undefined, calls: 0, sources: {} as Record<string, { total: number; last: number; ok: boolean; error?: string }> },
    safety: { checked: 0, rejected: 0, passed: 0, penalties: 0, last: '', lastSymbol: '', lastOk: true, lastAdj: 0, calls: 0, reasons: {} as Record<string, number> },
    analyst: { scored: 0, lastScore: 0, lastSymbol: '', lastImage: '' as string | undefined, bull: 0, bear: 0, note: '', calls: 0 },
    risk: { status: 'Guarding', label: '', exits: 0 },
    executor: { fills: 0, buys: 0, last: '', failures: 0 },
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
  private lastBuyFail = new Map<string, number>();
  private reservedSol = 0;
  private tuner = new AutoTune();
  private narrative: Narrative | null = null;
  private solDayOpen = 0;
  private uni = { scannedNew: 0, scannedTrending: 0, enteredNew: 0, enteredTrending: 0, watch: 0 };

  private lastPairAt = 0;
  private lossPauseUntil = 0;
  private mintHist = new Map<string, TapeSnap[]>();
  private priors: PaperPriors | null = null;
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
  private runtimeMode: 'paper' | 'live' | 'live-auto' = 'paper';
  private liveHeld: Position[] = [];
  private liveWallet: Wallet | null = null;


  constructor(cfg: Config, m: MarketSource, store: Store) {
    super();
    this.setMaxListeners(100);
    this.cfg = cfg; this.m = m; this.store = store;
    this.exec = new PaperExecutor(m, cfg);
    const gate0 = liveGate(cfg);
    const envMode: 'paper' | 'live' | 'live-auto' = !gate0.live ? 'paper' : (gate0.auto ? 'live-auto' : 'live');
    store.migrateLegacyBooks(envMode === 'paper' ? 'paper' : 'live');
    const savedMode = store.get<string>('runtimeMode', envMode);
    this.runtimeMode = savedMode === 'paper' ? 'paper' : (gate0.live ? envMode : 'paper');
    const emptyWallet: Wallet = { connected: false, type: 'paper', address: '', realSol: null, solBalance: 0, depositUsd: 0, startedAt: 0, running: false, dayKey: '', dayStartEquity: 0 };
    this.wallet = store.getBook<Wallet>(this.book, 'wallet', emptyWallet);
    this.positions = store.getBook<Position[]>(this.book, 'positions', []);
    this.cooldown = store.getBook<Record<string, number>>(this.book, 'cooldown', {});
    this.liveHeld = store.getBook<Position[]>('live', 'positions', []);
    this.liveWallet = store.getBook<Wallet | null>('live', 'wallet', null);
    const saved = store.get<any>('agents', null);
    if (saved) for (const k of Object.keys(this.agents) as (keyof typeof this.agents)[]) Object.assign(this.agents[k], saved[k] || {});
    this.tuner.load(store.get('autotune', null));
    this.priors = loadPaperPriors();
    if (this.priors?.events?.length) {
      this.tuner.seedFromPriors(this.priors.events.map((ev) => ({
        pattern: ev.pattern, pnlUsd: ev.pnlUsd, costUsd: ev.costUsd, pnlPct: ev.pnlPct,
        weight: ev.weight, exitKind: ev.exitKind, exitReason: ev.exitReason,
      })));
    }

  }

  get mode(): 'paper' | 'live' | 'live-auto' {
    if (this.runtimeMode === 'paper') return 'paper';
    const g = liveGate(this.cfg);
    if (!g.live) return 'paper';
    return g.auto ? 'live-auto' : 'live';
  }
  get book(): Book { return this.mode === 'paper' ? 'paper' : 'live'; }
  liveArmed() { const g = liveGate(this.cfg); return g.live; }

  isLiveBookPos(p: Position) { return p.book === 'live' || (this.mode !== 'paper' && p.book !== 'paper'); }

  private monitoredPositions() {
    if (this.mode !== 'paper') return this.positions;
    const ids = new Set(this.positions.map((p) => p.id));
    const live = this.liveHeld.filter((p) => !ids.has(p.id));
    for (const p of live) { p.book = 'live'; p.liveManaged = true; }
    return [...this.positions, ...live];
  }

  private saveActiveBook() {
    const b = this.book;
    this.store.setBook(b, 'wallet', this.wallet);
    this.store.setBook(b, 'positions', this.positions);
    this.store.setBook(b, 'cooldown', this.cooldown);
    this.store.setBook(b, 'agents', this.agents);
    if (b === 'live') { this.liveHeld = this.positions; this.liveWallet = this.wallet; }
    this.store.set('runtimeMode', this.runtimeMode);
  }

  private loadActiveBook() {
    const emptyWallet: Wallet = { connected: false, type: 'paper', address: '', realSol: null, solBalance: 0, depositUsd: 0, startedAt: 0, running: false, dayKey: '', dayStartEquity: 0 };
    this.wallet = this.store.getBook<Wallet>(this.book, 'wallet', emptyWallet);
    this.positions = this.store.getBook<Position[]>(this.book, 'positions', []);
    this.cooldown = this.store.getBook<Record<string, number>>(this.book, 'cooldown', {});
    this.liveHeld = this.store.getBook<Position[]>('live', 'positions', this.liveHeld || []);
    this.liveWallet = this.store.getBook<Wallet | null>('live', 'wallet', this.liveWallet);
    if (this.book === 'live') this.liveHeld = this.positions;
  }

  /** Runtime TEST <-> LIVE switch. Does not change MODE/LIVE_CONFIRM env and does not wipe the other book. */
  async setRuntimeMode(next: 'paper' | 'live-auto' | 'live') {
    const wantPaper = next === 'paper' || next === 'test' as any;
    if (!wantPaper) {
      const g = liveGate(this.cfg);
      if (!g.live) throw new Error('LIVE is not armed: MODE and LIVE_CONFIRM must already be set on the host');
    }
    const current = this.mode;
    const dest: 'paper' | 'live-auto' | 'live' = wantPaper ? 'paper' : (liveGate(this.cfg).auto ? 'live-auto' : 'live');
    if (current === dest || (current === 'paper' && dest === 'paper')) {
      if (dest === 'paper' && !this.hasPaperBook()) {
        const startUsd = Math.max(2, (this.solPrice || 70) * 1);
        await this.connect({ type: 'paper', startUsd });
      }
      this.emitState();
      return { ok: true, mode: this.mode, unchanged: true, liveOpen: this.liveHeld.length };
    }
    this.saveActiveBook();
    this.runtimeMode = dest === 'paper' ? 'paper' : dest;
    this.store.set('runtimeMode', this.runtimeMode);
    this.tuner.resetEquityWindow();
    this.loadActiveBook();
    if (dest === 'paper') {
      if (!this.hasPaperBook()) {
        const startUsd = Math.max(2, (this.solPrice || 70) * 1);
        await this.connect({ type: 'paper', startUsd });
      } else {
        this.wallet.connected = true;
        this.wallet.type = 'paper';
        if (autoStartEnabled() || this.wallet.running) this.wallet.running = true;
        this.saveWallet();
      }
      await this.refreshLiveBook().catch(() => {});
      this.log('Core', 'info', `Switched to TEST · paper book is separate. ${this.liveHeld.length} live position(s) stay open and will still exit on-chain; no new live buys until you switch back.`);
    } else {
      if (liveGate(this.cfg).auto && hasBotWallet()) {
        await this.connect({ type: 'paper' });
        await this.reconcileOnchain();
      }
      this.log('Core', 'info', 'Switched to LIVE · showing on-chain balances only. Paper history is kept and hidden.');
    }
    this.persist();
    this.emitState();
    if (this.wallet.connected && this.wallet.running) void this.kickoffTrading('mode-switch');
    return { ok: true, mode: this.mode, liveOpen: this.liveHeld.length, paperEquity: dest === 'paper' ? this.equity() : undefined };
  }

  private async refreshLiveBook() {
    if (!liveGate(this.cfg).live || !hasBotWallet()) return;
    await this.syncBotBalance();
    await this.reconcileOnchain();
  }


  async start() {
    // Force scanning/trading on boot — no Start tap, no warm-up wait.
    // AUTO_START stays on so a restart or redeploy auto-resumes.
    ensureAutoStartEnv();
    this.wallet.running = true;
    this.saveWallet();
    void persistRenderEnv({ AUTO_START: '1' });
    this.lossPauseUntil = this.store.getBook(this.book, 'lossPauseUntil', this.store.get('lossPauseUntil', 0));
    // Start loops immediately so the first scan does not wait on RPC/reconcile.
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
    loop(() => this.convertUsdc(), () => 20, 'usdc');
    this.timers.push(setInterval(() => this.store.prune(), 10 * 60_000));
    // Connect the book in the background, then enter as soon as any candidate passes.
    await this.bootSession();
  }

  /** Connect/resume the active book and kick off the first scan + entries. */
  private async bootSession() {
    try {
      await this.refreshSol();
      this.wallet.running = true;
      // Always refresh the live book if armed, even while TEST is selected, so open
      // live positions can still be exited on-chain. Never drop the other book.
      if (liveGate(this.cfg).live && hasBotWallet()) {
        try {
          const pub = botPublicKey();
          if (pub) this.usdcBal = await getUsdcBalance(this.cfg.rpcUrl, pub);
        } catch {}
        await this.syncBotBalance();
        if (this.mode !== 'paper') {
          await this.connect({ type: 'paper' });
          await this.reconcileOnchain();
        } else {
          await this.reconcileOnchain();
        }
      } else if (this.mode === 'live' && this.wallet.connected) {
        await this.reconcileOnchain();
      }
      if (this.mode === 'paper') {
        if (this.hasPaperBook() || this.wallet.connected) {
          this.wallet.connected = true;
          this.wallet.running = true;
          this.wallet.type = 'paper';
          this.saveWallet();
          this.log('Core', 'info', `TEST book resumed · $${this.equity().toFixed(2)}`);
        } else {
          const startUsd = Math.max(2, Number(this.cfg.startUsd) || (this.solPrice || 70));
          const paperUsd = this.cfg.startUsd === 81 && this.solPrice ? Math.max(2, this.solPrice) : startUsd;
          await this.connect({ type: 'paper', startUsd: paperUsd });
        }
      }
      this.wallet.running = true;
      this.saveWallet();
      this.log('Core', 'info', 'auto-started — scanning and trading immediately (no Start tap)');
      if (this.wallet.connected) void this.kickoffTrading('boot');
    } catch (e: any) {
      this.log('Core', 'info', `auto-start: ${e?.message || e}`);
      if (this.wallet.connected && this.wallet.running) void this.kickoffTrading('boot-retry');
    }
  }
  stop() { for (const t of this.timers) clearTimeout(t); this.timers = []; }

  // ---------------------------------------------------------------- wallet
  async connect(opts: { type: 'paper' | 'phantom'; address?: string; startUsd?: number; setBalance?: boolean }) {
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
      const fromPaper = this.wallet.type !== 'bot';
      this.wallet = {
        ...this.wallet,
        connected: true, type: 'bot', address: pub, realSol: onchain,
        solBalance: onchain ?? 0,
        startedAt: (!fromPaper && this.wallet.startedAt) ? this.wallet.startedAt : Date.now(),
        running: true,
      };
      this.repairDepositBaseline();
      this.wallet.dayKey = this.wallet.dayKey || dayKey();
      this.wallet.dayStartEquity = this.wallet.dayStartEquity || this.equity();
      this.store.addEquity(Date.now(), this.equity(), this.book);
      this.saveWallet();
      this.log('Core', 'info', `Bot wallet ready · LIVE AUTO · $${this.equity().toFixed(2)} (${(onchain ?? 0).toFixed(4)} SOL + ${(this.usdcBal?.ui || 0).toFixed(2)} USDC)`);
      this.emitState();
      return this.wallet;
    }
    // Connect sheet "test balance" explicitly starts a fresh TEST book at that amount.
    if (opts.type === 'paper' && this.mode === 'paper' && opts.setBalance) {
      this.resetPaperBook();
    }
    // Paper: never wipe an existing book on Connect / reload / AUTO_START.
    // Only the explicit "Reset paper book" path (or setBalance from Connect) may start a fresh test balance.
    if (opts.type === 'paper' && this.mode === 'paper' && this.hasPaperBook()) {
      this.wallet.connected = true;
      this.wallet.running = true;
      this.wallet.type = 'paper';
      this.wallet.address = opts.address || this.wallet.address || this.previewAddr || fakeAddr();
      this.wallet.startedAt = this.wallet.startedAt || Date.now();
      if (!this.wallet.dayKey) { this.wallet.dayKey = dayKey(); this.wallet.dayStartEquity = this.equity(); }
      this.saveWallet();
      this.log('Core', 'info', `Paper book resumed · ${this.mode.toUpperCase()} mode · $${this.equity().toFixed(2)}`);
      this.emitState();
      void this.kickoffTrading('resume');
      return this.wallet;
    }
    const solBalance = livePhantom ? (realSol ?? 0) : startUsd / this.solPrice;
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
    this.store.addEquity(Date.now(), this.wallet.depositUsd, this.book);
    this.saveWallet();
    this.lossPauseUntil = 0;
    this.store.setBook(this.book, 'lossPauseUntil', 0);
    this.log('Core', 'info', `${opts.type === 'phantom' ? 'Phantom' : 'Paper'} wallet connected · ${this.mode.toUpperCase()} mode · $${this.equity().toFixed(2)}`);
    this.emitState();
    void this.kickoffTrading('connect');
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
    this.log('Core', 'info', r ? 'Bot resumed' : 'Bot paused - no new trades (will auto-resume on restart or when the app reopens)');
    // Keep AUTO_START on so a restart, redeploy, or app reopen resumes immediately.
    ensureAutoStartEnv();
    void persistRenderEnv({ AUTO_START: '1' }).then((res) => {
      if (res.ok && r) this.log('Core', 'info', 'AUTO_START kept on so trading resumes after a restart');
    });
    this.emitState();
    if (r && this.wallet.connected) {
      this.lossPauseUntil = 0;
      this.store.setBook(this.book, 'lossPauseUntil', 0);
      void this.kickoffTrading('start');
    }
  }

  /** Restart loops / clear stuck in-flight flags and rescan now. Does not wipe positions, trades, or the withdraw lock. */
  restartTrading() {
    const locked = this.lockedWithdrawTo();
    this.kickingOff = false;
    this.scanning = false;
    this.evaluating = false;
    this.monitoring = false;
    this.inFlightChecks.clear();
    this.buying.clear();
    this.selling.clear();
    this.reservedSol = 0;
    this.lastBuyFail.clear();
    this.agents.scanner.inFlightChecks = 0;
    this.agents.scanner.inFlightBuys = 0;
    this.agents.scanner.inFlightSells = 0;
    this.agents.risk.label = '';
    const wasRunning = this.wallet.running;
    if (!this.wallet.running) {
      this.wallet.running = true;
      this.saveWallet();
      void persistRenderEnv({ AUTO_START: '1' });
    }
    this.log('Core', 'info', wasRunning
      ? 'Restart / rescan — in-flight flags cleared, scanning now (positions and withdraw lock kept)'
      : 'Restart / rescan — bot resumed, scanning now (positions and withdraw lock kept)');
    this.emitState();
    if (this.wallet.connected) void this.kickoffTrading('restart');
    return { ok: true, running: this.wallet.running, positions: this.positions.length, withdrawLocked: !!locked };
  }

  /** Zero scan/reject/cooldown/display counters and rescan immediately.
   *  Does not sell or forget positions, the withdraw lock, the wallet, trades, or learning. */
  resetBot() {
    const locked = this.lockedWithdrawTo();
    const liveN = (this.mode === 'paper' ? this.liveHeld : this.positions).length;
    this.kickingOff = false;
    this.scanning = false;
    this.evaluating = false;
    this.monitoring = false;
    this.inFlightChecks.clear();
    this.buying.clear();
    this.selling.clear();
    this.reservedSol = 0;
    this.lastBuyFail.clear();
    this.rejectSeen.clear();
    this.cooldown = {};
    this.lossPauseUntil = 0;
    this.store.setBook(this.book, 'cooldown', {});
    this.store.setBook(this.book, 'lossPauseUntil', 0);
    this.candidates.clear();
    this.mintHist.clear();
    this.scanHistory = [];
    this.scanTimes = [];
    this.uni = { scannedNew: 0, scannedTrending: 0, enteredNew: 0, enteredTrending: 0, watch: 0 };
    this.agents = {
      scanner: { pools: 0, total: 0, lastScanAt: 0, perHour: 0, perMin: 0, cadenceMs: 0, inFlightChecks: 0, inFlightBuys: 0, inFlightSells: 0, top: '' as string, topImage: '' as string | undefined, calls: 0, sources: {} as Record<string, { total: number; last: number; ok: boolean; error?: string }> },
      safety: { checked: 0, rejected: 0, passed: 0, penalties: 0, last: '', lastSymbol: '', lastOk: true, lastAdj: 0, calls: 0, reasons: {} as Record<string, number> },
      analyst: { scored: 0, lastScore: 0, lastSymbol: '', lastImage: '' as string | undefined, bull: 0, bear: 0, note: '', calls: 0 },
      risk: { status: 'Guarding', label: '', exits: 0 },
      executor: { fills: 0, buys: 0, last: '', failures: 0 },
    };
    this.store.setBook(this.book, 'agents', this.agents);
    this.log('Core', 'info', 'Reset bot — scan counters, rejected/seen caches and cooldowns cleared; rescanning now. Positions, wallet, withdraw lock, trade history and shared learning kept.');
    this.emitState();
    if (this.wallet.connected) void this.kickoffTrading('reset-bot');
    return { ok: true, running: this.wallet.running, positions: this.positions.length, livePositions: liveN, withdrawLocked: !!locked, learningKept: true };
  }

  /** If deposit was saved as cash-only after a restart, include restored positions. */
  repairDepositBaseline() {
    const target = this.mode === 'paper' ? this.wallet : (this.liveWallet || this.wallet);
    const cash = (this.mode === 'paper' ? this.wallet.solBalance * this.solPrice : ((this.wallet.solBalance || 0) * this.solPrice + (this.usdcBal?.ui || 0)));
    const bag = this.mode === 'paper' ? this.positions : (this.positions.length ? this.positions : this.liveHeld);
    const eq = this.mode === 'paper' ? this.equity() : (cash + bag.reduce((a, p) => a + p.qty * (p.lastPrice || p.entryPrice) + (p.rentSol || 0) * this.solPrice, 0));
    const next = depositBaseline(target.depositUsd || 0, eq, cash, bag.length > 0);
    if (next > 0 && next !== target.depositUsd) {
      target.depositUsd = next;
      if (this.mode !== 'paper' && this.liveWallet) this.liveWallet.depositUsd = next;
      if (this.mode !== 'paper') this.wallet.depositUsd = next;
      if (this.mode === 'paper') this.wallet.depositUsd = next;
    } else if ((target.depositUsd || 0) <= 0 && next > 0) {
      target.depositUsd = next;
      if (this.mode !== 'paper') this.wallet.depositUsd = next;
    }
  }

  /** Immediate scan + entries on Connect/Start — do not wait for the interval loops. */
  private kickingOff = false;
  private async kickoffTrading(reason = 'start') {
    if (!this.wallet.connected || !this.wallet.running) return;
    if (this.kickingOff) return;
    this.kickingOff = true;
    try {
      this.log('Core', 'info', `scanning for entries immediately (${reason})`);
      const pump = this.ingestPump().catch(() => {});
      const scan = this.scan().catch(() => {});
      // First entry as soon as any source returns — no warm-up interval.
      await Promise.race([pump, scan, new Promise((r) => setTimeout(r, 1200))]);
      if (!this.wallet.connected || !this.wallet.running) return;
      await this.evaluateEntries().catch(() => {});
      await Promise.race([Promise.all([pump, scan]), new Promise((r) => setTimeout(r, 4000))]);
      if (this.wallet.connected && this.wallet.running) await this.evaluateEntries().catch(() => {});
    } finally { this.kickingOff = false; }
  }

  /** Explicit "Reset paper book" only. Never called from Connect, reload, or AUTO_START. */
  reset() {
    if (this.mode === 'live' || this.mode === 'live-auto') throw new Error('reset is disabled in live mode — use Reset paper balance from TEST mode');
    this.resetPaperBook();
    this.wallet = { connected: false, type: 'paper', address: '', realSol: null, solBalance: 0, depositUsd: 0, startedAt: 0, running: false, dayKey: '', dayStartEquity: 0 };
    this.positions = [];
    this.saveWallet();
    this.emitState();
  }
  private hasPaperBook() {
    const w = this.book === 'paper' ? this.wallet : this.store.getBook<Wallet>('paper', 'wallet', this.wallet);
    const pos = this.book === 'paper' ? this.positions : this.store.getBook<Position[]>('paper', 'positions', []);
    return pos.length > 0
      || (w.depositUsd || 0) > 0
      || (w.solBalance || 0) > 0
      || this.store.trades(1, 'paper').length > 0;
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
    this.lossPauseUntil = 0;
    this.store.clearPaperSession();
    const empty: Wallet = { connected: false, type: 'paper', address: '', realSol: null, solBalance: 0, depositUsd: 0, startedAt: 0, running: false, dayKey: '', dayStartEquity: 0 };
    this.store.setBook('paper', 'wallet', empty);
    this.store.setBook('paper', 'lossPauseUntil', 0);
    if (this.book === 'paper') this.wallet = empty;
  }

  equity() {
    const pos = this.positions.reduce((a, p) => a + p.qty * (p.lastPrice || p.entryPrice) + p.rentSol * this.solPrice, 0);
    const usdcUsd = this.mode === 'paper' ? 0 : (this.usdcBal?.ui || 0);
    return this.wallet.solBalance * this.solPrice + pos + usdcUsd;
  }
  cashUsd() { return this.wallet.solBalance * this.solPrice; }
  private freeCashUsd() { return Math.max(0, (this.wallet.solBalance - this.reservedSol) * this.solPrice); }
  private exitReserveSolAmt(openingNew = true) {
    return exitReserveSol(this.cfg.priorityFeeSol, this.positions.length, openingNew);
  }
  private exitReserveUsd(openingNew = true) {
    return this.exitReserveSolAmt(openingNew) * (this.solPrice || 0);
  }

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
    if (b === null) return;
    const base = this.liveWallet || { connected: true, type: 'bot' as const, address: pub, realSol: b, solBalance: b, depositUsd: 0, startedAt: Date.now(), running: true, dayKey: '', dayStartEquity: 0 };
    this.liveWallet = { ...base, type: 'bot', address: pub, realSol: b, solBalance: b, connected: true };
    this.store.setBook('live', 'wallet', this.liveWallet);
    if (this.mode !== 'paper') {
      this.wallet.realSol = b;
      this.wallet.solBalance = b;
      if (!this.wallet.address) this.wallet.address = pub;
      this.wallet.type = 'bot';
    }
  }
  private recentPnls(): number[] {
    return this.store.trades(40, this.book).slice().reverse().map((t: any) => t.pnlUsd);
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
  private rejectSeen = new Map<string, number>();
  private noteReject(reason: string, mint?: string) {
    let key = (reason || 'unknown').slice(0, 80);
    if (key.startsWith('risk:daily loss limit')) key = 'risk:daily loss limit hit';
    if (mint) {
      const id = mint + '|' + key;
      const prev = this.rejectSeen.get(id) || 0;
      if (Date.now() - prev < 20_000) return;
      this.rejectSeen.set(id, Date.now());
    }
    const s = this.agents.safety as typeof this.agents.safety & { reasons: Record<string, number> };
    if (!s.reasons) s.reasons = {};
    s.reasons[key] = (s.reasons[key] || 0) + 1;
    const now = Date.now();
    if (now - this.lastRejectLogAt > 20_000) {
      this.lastRejectLogAt = now;
      const top = Object.entries(s.reasons).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, n]) => `${k}×${n}`).join(' · ');
      this.log('Safety', 'info', `penalties ${s.penalties || s.rejected} · passed ${s.passed} · ${top || 'none yet'}`);
    }
  }

  private refreshSources() {
    const m: any = this.m;
    if (typeof m.sourceSummary === 'function') this.agents.scanner.sources = m.sourceSummary();
    else this.agents.scanner.sources = summarizeSources(m.sourceLast || m.sourceHits || {}, m.sourceTotals || {});
  }
  private bumpScanStats(now: number, scanned: number, pools: number) {
    const sc = this.agents.scanner;
    sc.pools = pools; sc.total += scanned; sc.lastScanAt = now; sc.calls++;
    this.refreshSources();
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
      sources: this.agents.scanner.sources || (this.m as any).sourceHits || {},
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
        const cc = this.candidates.get(c.mint)!;
        const pc = preCheck(cc, this.cfg, now);
        cc.safety = pc.label;
        (cc as any)._preAdj = pc.adj;
        const s = scoreCandidate(cc);
        cc.score = clampScore(s.score + pc.adj);
        if (pc.adj < 0) {
          if (first) rejectedNew++;
          this.noteReject('pre:' + (pc.reasons[0] || pc.label));
        }
        if (first) scoredNew++;
        if (cc.score >= (this.agents.analyst.lastScore || 0)) {
          Object.assign(this.agents.analyst, { lastScore: cc.score, lastSymbol: cc.symbol, lastImage: cc.image, bull: s.bull, bear: s.bear, note: s.note });
          this.agents.scanner.top = cc.symbol; this.agents.scanner.topImage = cc.image;
        }
        if (first) newN++;
      }
      this.agents.safety.checked += newN + rejectedNew;
      this.agents.safety.penalties = (this.agents.safety.penalties || 0) + rejectedNew;
      this.agents.safety.rejected = this.agents.safety.penalties;
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
        const merged = { ...prev, ...c, seenAt: now } as Candidate;
        if (merged.universe === 'trending') { nTr++; }
        else { merged.universe = merged.universe || 'new'; nNew++; }
        this.candidates.set(c.mint, merged);
        this.remember(merged, now);
      }
      this.uni.scannedNew += nNew;
      this.uni.scannedTrending += nTr;
      for (const [k, v] of this.candidates) if (now - v.seenAt > 3 * 3600_000 && !this.positions.some((p) => p.mint === k)) this.candidates.delete(k);

      const solChg = this.solDayOpen ? ((this.solPrice - this.solDayOpen) / this.solDayOpen) * 100 : 0;
      this.narrative = dailyNarrative([...this.candidates.values()], solChg);

      // SAFETY flags become score penalties; every coin is scored and can be bought.
      const scored: { c: Candidate; s: ReturnType<typeof scoreCandidate> }[] = [];
      let penalized = 0;
      for (const c of list) {
        const cc = this.candidates.get(c.mint)!;
        cc.narrativeBoost = narrativeBoost(cc, this.narrative);
        const pc = preCheck(cc, this.cfg, now);
        cc.safety = pc.label;
        (cc as any)._preAdj = pc.adj;
        const s = scoreCandidate(cc);
        cc.score = clampScore(s.score + pc.adj);
        if (pc.adj < 0) { penalized++; this.noteReject('pre:' + (pc.reasons[0] || pc.label)); }
        scored.push({ c: cc, s: { ...s, score: cc.score } });
      }
      this.agents.safety.checked += list.length;
      this.agents.safety.penalties = (this.agents.safety.penalties || 0) + penalized;
      this.agents.safety.rejected = this.agents.safety.penalties;
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
      this.store.setBook(this.book, 'agents', this.agents);
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
      const gov = this.tuner.governor(this.cfg.takeProfitPct ?? 1.8);
      const minScore = adapted.minScore + (gov.minScoreAdj || 0);
      const recent = [...this.candidates.values()].filter((c) => now - c.seenAt < 180_000);
      this.uni.watch = 0;
      for (const c of recent) {
        const base = scoreCandidate(c).score;
        const hist = this.mintHist.get(c.mint) || [];
        const sig = entrySignal(c, hist, this.strat(), now);
        if (sig.ok) (c as any)._sig = sig.reason;
        else delete (c as any)._sig;
        const conf = momentumConfirm(c, hist, now);
        (c as any)._conf = conf.ok;
        if (!(c as any)._conf) (c as any)._confWhy = conf.reason;
        const adj = signalAdjustments(c, hist, now);
        const preAdj = Number((c as any)._preAdj || 0);
        c.score = clampScore(base + preAdj + adj.adj);
        (c as any)._adjNotes = adj.notes;
        if (adj.why && adj.why !== 'score') (c as any)._sig = (c as any)._sig || adj.why;
        c.score = clampScore(c.score + this.tuner.patternAdj((c as any)._sig || 'score'));
        const path = pumpPathBoost(c, hist, this.priors);
        if (path.boost) {
          c.score = clampScore(c.score + path.boost);
          (c as any)._pathBoost = path.boost;
        }
        const pot = pumpPotential(c, hist, this.priors);
        (c as any)._tier = pot.tier;
        (c as any)._potential = pot.score;
        if (pot.tier) {
          c.score = clampScore(c.score + (pot.tier === 1000 ? 6 : pot.tier === 100 ? 4 : 2));
          (c as any)._sig = (c as any)._sig || pot.reason;
        }
      }
      const scored = recent
        .filter((c) => {
          const pump = currentlyPumping(c, now);
          if (!pump.ok) {
            this.noteReject(pump.reason || 'not pumping', c.mint);
            return false;
          }
          if (!(c as any)._sig) (c as any)._sig = pump.reason;
          if ((c.score || 0) >= minScore) return true;
          this.noteReject(`score ${c.score} < ${minScore}`, c.mint);
          return false;
        })
        .sort((a, b) => {
          const ta = Number((a as any)._tier || 0), tb = Number((b as any)._tier || 0);
          if (tb !== ta) return tb - ta;
          const pa = Number((a as any)._potential || 0), pb = Number((b as any)._potential || 0);
          if (pb !== pa) return pb - pa;
          return (b.score || 0) - (a.score || 0);
        })
        .slice(0, 20);
      if (!scored.length) return;
      const reserveUsd = this.exitReserveUsd(true);
      if (!openSizeUsd(this.cfg, this.equity(), this.freeCashUsd(), reserveUsd)) {
        this.agents.risk.label = 'holding until cash frees up';
      }
      const todo = scored.filter((c) => {
        if (this.inFlightChecks.has(c.mint) || this.buying.has(c.mint)) return false;
        const held = this.alreadyHeld(c.mint);
        if (held) return this.canAdd(c, now);
        if (!openSizeUsd(this.cfg, this.equity(), this.freeCashUsd(), reserveUsd)) return false;
        // Risk/cooldown/autotune are penalties, not blocks. Only cash is mechanical.
        let score = c.score || 0;
        if ((this.cooldown[c.mint] || 0) > now) score = clampScore(score - 15);
        if (this.lossPauseUntil && now < this.lossPauseUntil) score = clampScore(score - 15);
        if (this.wallet.dayStartEquity > 0) {
          const ddPct = ((this.wallet.dayStartEquity - this.equity()) / this.wallet.dayStartEquity) * 100;
          if (ddPct >= this.cfg.dailyLossLimitPct) score = clampScore(score - 20);
        }
        const why = (c as any)._sig || `score ${score} ≥ ${minScore}`;
        score = this.tuneAdjust(why, score);
        c.score = score;
        if (score < minScore) { this.noteReject(`score ${score} < ${minScore}`, c.mint); return false; }
        return true;
      }).slice(0, 20);
      await poolRun(todo, 6, async (c) => {
        const why = (c as any)._sig || `score ${c.score} ≥ ${minScore}`;
        await this.checkCandidate(c, c.score || 0, why).catch(() => {});
      });
      this.store.setBook(this.book, 'cooldown', this.cooldown);
    } finally {
      this.evaluating = false;
      this.agents.scanner.inFlightChecks = this.inFlightChecks.size;
      this.store.setBook(this.book, 'agents', this.agents);
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
    if (!adding && this.alreadyOn(c.mint)) return;
    this.inFlightChecks.add(c.mint);
    this.agents.scanner.inFlightChecks = this.inFlightChecks.size;
    this.emit('agents', this.agents);
    let aborted = false;
    try {
      const work = (async () => {
        const pump = isPumpCurve(c);
        // Never block the first-entry path on a slow/failed RugCheck — timeout and fail open.
        const sec = await withTimeout(this.m.security(c.mint), pump ? 1200 : 2000, 'sec timeout').catch(() => null);
        if (aborted) return;
        this.agents.safety.calls++;
        const sr = securityCheck(sec, this.cfg, { pumpCurve: pump, devHoldPct: c.flow?.devHoldPct });
        const adjScore = clampScore(score + (sr.adj || 0));
        Object.assign(this.agents.safety, { last: sr.label, lastSymbol: c.symbol, lastOk: true, lastAdj: sr.adj || 0 });
        const cc = this.candidates.get(c.mint);
        if (cc) { cc.safety = sr.label; cc.score = adjScore; }
        if (sr.adj < 0) {
          this.agents.safety.penalties = (this.agents.safety.penalties || 0) + 1;
          this.agents.safety.rejected = this.agents.safety.penalties;
          this.noteReject('sec:' + (sr.reasons[0] || sr.label));
        }
        const gov = this.tuner.governor(this.cfg.takeProfitPct ?? 1.8);
        const minScore = this.riskAdapted().minScore + (gov.minScoreAdj || 0);
        if (adjScore < minScore) {
          this.noteReject(`score ${adjScore} < ${minScore} after safety ${sr.adj}`, c.mint);
          return;
        }
        const reserveUsd = this.exitReserveUsd(true);
        const trialSize = openSizeUsd(this.cfg, this.equity(), this.freeCashUsd(), reserveUsd);
        if (!trialSize) { this.noteReject('risk:no size'); return; }
        if (this.isDumpingEarly(c)) {
          this.noteReject('dumping in first seconds');
          this.decision({ ts: Date.now(), side: 'SKIP', symbol: c.symbol, image: c.image, text: 'dumping in first seconds — skip' });
          return;
        }
        // Only mechanical skip: no route or quote, retry later (no long cooldown).
        if (this.mode !== 'paper') {
          const okSell = await this.sellable(c.mint, trialSize / this.solPrice);
          if (aborted) return;
          if (!okSell) {
            this.noteReject(pump ? 'no curve quote' : 'no Jupiter route');
            this.decision({ ts: Date.now(), side: 'SKIP', symbol: c.symbol, image: c.image, text: 'no route/quote — skip and retry' });
            return;
          }
        }
        this.agents.safety.passed++;
        this.log('Safety', 'info', `${sr.label}`, { symbol: c.symbol, mint: c.mint, image: c.image });
        void this.openPosition(c, adjScore, why);
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

  private isDumpingEarly(c: Candidate) {
    const ageSec = c.createdAt ? (Date.now() - c.createdAt) / 1000 : 9999;
    const m5 = c.change?.m5 || 0;
    const sells = c.txns?.m5s || 0, buys = c.txns?.m5b || 0;
    if (ageSec <= 90 && m5 <= -3) return true;
    if (ageSec <= 45 && m5 < 0 && sells > buys) return true;
    return false;
  }

  private logBuyFail(c: { symbol?: string; mint?: string; image?: string }, reason: string) {
    this.agents.executor.failures++;
    const key = `${c.mint || c.symbol || ''}::${reason}`;
    const now = Date.now();
    if ((this.lastBuyFail.get(key) || 0) + 15_000 > now) return;
    this.lastBuyFail.set(key, now);
    this.log('Executor', 'reject', `Buy ${c.symbol || 'token'} failed: ${reason}`, { symbol: c.symbol, mint: c.mint, image: c.image });
    this.decision({ ts: now, side: 'SKIP', symbol: c.symbol, image: c.image, text: `buy failed: ${reason}` });
  }

  // ---------------------------------------------------------------- RISK sizing + EXECUTOR buy
  async openPosition(c: Candidate, score: number, why: string) {
    const gen = this.bookGen;
    const existing = this.positions.find((p) => p.mint === c.mint);
    const adding = !!existing;
    if (adding && !this.canAdd(c)) return;
    if (!adding && this.alreadyHeld(c.mint)) return;
    if (this.buying.has(c.mint)) return;
    // Live: one in-flight buy at a time and reserve the SOL first so a second
    // all-in attempt cannot race and spam "insufficient lamports".
    if (this.mode !== 'paper' && this.buying.size >= 1) return;
    this.buying.add(c.mint);
    this.agents.scanner.inFlightBuys = this.buying.size;
    try {
    if (!this.solPrice) await this.refreshSol();
    if (!this.solPrice) return;
    const eq = this.equity();
    const adapted = this.riskAdapted();
    const reserveUsd = this.exitReserveUsd(true);
    const low = lowBalanceReason(eq, this.freeCashUsd(), reserveUsd, this.cfg.minTradeUsd, this.usdcBal?.ui || 0);
    if (low) { this.agents.risk.label = low; this.logBuyFail(c, low); return; }
    let size = openSizeUsd(this.cfg, eq, this.freeCashUsd(), reserveUsd);
    if (adding && existing) {
      const room = Math.max(0, this.maxCoinUsd() - existing.costUsd);
      size = Math.min(size, room);
    }
    size *= this.tuner.entrySizeMult(why);
    size = Math.min(size, Math.max(0, this.freeCashUsd() - reserveUsd));
    if (!size) { this.agents.risk.label = 'not enough free cash'; this.logBuyFail(c, 'not enough free cash'); return; }
    const solAmt = size / this.solPrice;
    if (this.mode === 'live-auto') {
      const needSol = solAmt + BASE_FEE_SOL + this.cfg.priorityFeeSol + (adding ? 0 : ATA_RENT_SOL);
      if (this.wallet.solBalance - this.reservedSol < needSol) { this.logBuyFail(c, 'not enough free cash for fees'); return; }
      this.reservedSol += needSol;
      try { await this.execLiveAuto('buy', c, { solAmt, score, why }); }
      finally { this.reservedSol = Math.max(0, this.reservedSol - needSol); }
      await this.syncBotBalance().catch(() => {});
      return;
    }
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
    if (!f || !f.ok) { this.logBuyFail(c, f && !f.ok ? f.error : 'buy failed'); return; }
    if (gen !== this.bookGen) return; // paper book was reset while this fill was in flight
    const held = this.positions.find((p) => p.mint === c.mint) || existing;
    const costSol = f.solSpent + f.feesSol;
    const debit = costSol + (held ? 0 : f.rentSol);
    if (this.wallet.solBalance < debit) { this.agents.risk.label = 'not enough free cash'; return; }
    this.wallet.solBalance -= debit;
    const addUsd = costSol * this.solPrice;
    if (held) {
      const existing = held;
      const newQty = existing.qty + f.tokens;
      existing.entryPrice = (existing.entryPrice * existing.qty + f.fillPrice * f.tokens) / Math.max(1e-12, newQty);
      existing.qty = newQty;
      existing.costUsd += addUsd;
      existing.costSol += costSol;
      existing.lastPrice = f.fillPrice;
      existing.peakPrice = Math.max(existing.peakPrice, f.fillPrice);
      existing.adds = (existing.adds || 0) + 1;
      (existing as any).origCost = ((existing as any).origCost ?? (existing.costUsd - addUsd)) + addUsd;
      this.agents.executor.fills++; this.agents.executor.buys++; this.agents.executor.last = `ADD ${c.symbol}`;
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
      book: this.book, entryPattern: patternKey(why), maePct: 0, immediateRed: false,
      entryFeatures: { score, m5: c.change.m5 || 0, m15: c.change.m15 || 0, liq: c.liquidityUsd, netBuy: c.flow?.netBuySol || 0, ageMin: c.createdAt ? (Date.now() - c.createdAt) / 60000 : 0 },
    } as Position;
    (pos as any).origCost = pos.costUsd; (pos as any).partialTaken = false; (pos as any).breakeven = false;
    this.positions.push(pos);
    if (c.universe === 'trending') this.uni.enteredTrending++; else this.uni.enteredNew++;
    this.agents.executor.fills++; this.agents.executor.buys++; this.agents.executor.last = `BUY ${c.symbol}`;
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
      const bag = this.monitoredPositions();
      const prices = await this.m.prices([SOL_MINT, ...bag.map((p) => p.mint)]);
      if (prices[SOL_MINT]) this.solPrice = prices[SOL_MINT];
      const now = Date.now();
      const adapted = this.riskAdapted();
      const gov = this.tuner.governor(this.cfg.takeProfitPct ?? 1.8);
      // TP is a floor for weak/flat positions. Runners scale then trail.
      const target = gov.tpPct || this.cfg.takeProfitPct || 1.8;
      const tpOpts = {
        extraSlippageBps: this.cfg.extraSlippageBps,
        swapFeeBps: SWAP_FEE_BPS,
        feeUsd: (BASE_FEE_SOL + this.cfg.priorityFeeSol) * (this.solPrice || 0),
      };
      const tpMarks: { p: Position; markNet: number }[] = [];
      const partialFrac = RUNNER_PARTIAL_PCT / 100;
      for (const p of [...bag]) {
        if (this.selling.has(p.id)) continue;
        const fresh = this.candidates.get(p.mint);
        const px = prices[p.mint] || fresh?.priceUsd || p.lastPrice;
        if (!px) continue;
        p.lastPrice = px;
        const fromEntry = (px / p.entryPrice - 1) * 100;
        p.maePct = Math.min(p.maePct ?? 0, fromEntry);
        if (now - p.openedAt < 45_000 && fromEntry <= -2) p.immediateRed = true;
        p.peakPrice = Math.max(p.peakPrice, px);
        const markNet = estimatedNetPnlPct(p, px, tpOpts);
        const hist = this.mintHist.get(p.mint) || [];
        const d = liveExit({ ...p, peakPrice: p.peakPrice, partialTaken: (p as any).partialTaken }, px, fresh, hist, {
          catStopPct: this.cfg.hardStopPct,
          sensitivity: this.isLiveBookPos(p) ? 1 : this.tuner.exitSensitivity,
          takeProfitPct: target,
          extraSlippageBps: this.cfg.extraSlippageBps,
          feeUsd: tpOpts.feeUsd,
        });
        if (d.exit && d.kind === 'take_profit') { tpMarks.push({ p, markNet }); continue; }
        if (d.exit && d.partial) { void this.closePosition(p, d.kind!, d.reason, partialFrac); continue; }
        if (d.exit) void this.closePosition(p, d.kind!, d.reason, 1);
      }
      // Prefer a live sell quote, but if it fails or times out, close on the mark-based net.
      if (tpMarks.length) {
        await poolRun(tpMarks, 3, async ({ p, markNet }) => {
          if (this.selling.has(p.id)) return;
          const quoted = await this.quotedNetPnlPct(p);
          // Live always attempts the on-chain sell once the target is reached.
          if (this.isLiveBookPos(p)) {
            const net = (quoted != null && quoted >= target) ? quoted : markNet;
            if (net < target) return;
            await this.closePosition(p, 'take_profit', `take profit +${net.toFixed(1)}% net (target +${target}%)`, 1);
            return;
          }
          const realistic = this.cfg.realisticPaper !== false;
          if (realistic) {
            // Only close when a real sell quote is in profit. No mark fallback.
            if (quoted == null || quoted < target) return;
            await this.closePosition(p, 'take_profit', `take profit +${quoted.toFixed(1)}% net (quote, target +${target}%)`, 1);
            return;
          }
          const useQuote = quoted != null && quoted >= target;
          const net = useQuote ? quoted! : markNet;
          if (net < target) return;
          const how = useQuote ? 'quote' : 'mark';
          await this.closePosition(p, 'take_profit', `take profit +${net.toFixed(1)}% net (${how}, target +${target}%)`, 1);
        });
      }
      if (gov.earlyCutSec > 0) {
        for (const p of [...bag]) {
          if (this.selling.has(p.id)) continue;
          if (now - p.openedAt < gov.earlyCutSec * 1000) continue;
          const fresh = this.candidates.get(p.mint);
          const hist = this.mintHist.get(p.mint) || [];
          const conf = fresh ? momentumConfirm(fresh, hist, now) : { ok: false, reason: 'no tape' };
          const fromEntry = p.entryPrice ? (p.lastPrice / p.entryPrice - 1) * 100 : 0;
          if (!conf.ok && fromEntry < 1) {
            void this.closePosition(p, 'momentum_fade', `no thrust within ${gov.earlyCutSec}s of entry`, 1);
          }
        }
      }
      const redSec = this.cfg.redExitSec || 45;
      const eqNow = this.equity();
      const dep = this.wallet.depositUsd || 0;
      for (const p of [...bag]) {
        if (this.selling.has(p.id)) continue;
        if (isQuickRedExit({
          openedAt: p.openedAt, entryPrice: p.entryPrice, lastPrice: p.lastPrice, now,
          redExitSec: redSec, equity: eqNow, deposit: dep,
        })) {
          const fromEntry = p.entryPrice ? (p.lastPrice / p.entryPrice - 1) * 100 : 0;
          const held = Math.round((now - p.openedAt) / 1000);
          void this.closePosition(p, 'time_stop', `red ${held}s · ${fromEntry.toFixed(1)}%, rotating into stronger pumps`, 1);
        }
      }
      const staleSec = staleExitSec(this.priors);
      for (const p of [...bag]) {
        if (this.selling.has(p.id)) continue;
        const fresh = this.candidates.get(p.mint);
        const hist = this.mintHist.get(p.mint) || [];
        const vol = { volumeM5: fresh?.volume?.m5, txM5: fresh ? (fresh.txns.m5b + fresh.txns.m5s) : undefined };
        if (isStalePosition({
          openedAt: p.openedAt, entryPrice: p.entryPrice, lastPrice: p.lastPrice, now, staleSec, hist, ...vol,
        })) {
          void this.closePosition(p, 'stale_flat', `stale ${staleSec}s · no price/volume, rotating capital`, 1);
          continue;
        }
        if (isDeadPosition({
          openedAt: p.openedAt, entryPrice: p.entryPrice, lastPrice: p.lastPrice, now, deadSec: DEAD_EXIT_SEC, hist, ...vol,
        })) {
          void this.closePosition(p, 'stale_flat', `dead ${Math.round(DEAD_EXIT_SEC / 60)}m · down and no volume, rotating capital`, 1);
        }
      }
      if (bag.length && now - this.lastPairAt > 3000) {
        this.lastPairAt = now;
        const freshList = await withTimeout((this.m as any).pairs ? (this.m as any).pairs(bag.map((p) => p.mint)) : Promise.all(bag.map((p) => this.m.pair(p.mint))).then((xs: any[]) => xs.filter(Boolean)), 4000, 'pair refresh timeout').catch(() => [] as any[]);
        for (const fresh of freshList || []) {
          this.candidates.set(fresh.mint, { ...this.candidates.get(fresh.mint), ...fresh, seenAt: now } as any);
          this.remember(fresh, now);
        }
      }
      const trailing = bag.filter((p) => activeStop(this.cfg, p).kind === 'trailing');
      this.agents.risk.status = trailing.length ? `Trailing ${trailing.length}` : bag.length ? 'Guarding' : 'Idle';
      if (trailing[0]) this.agents.risk.label = `${trailing[0].symbol} trailing ${fmtPct((trailing[0].lastPrice / trailing[0].entryPrice - 1) * 100)}`;
      if (this.wallet.connected && this.solPrice) {
        const eq = this.equity();
        this.lastEquity = eq;
        this.store.addEquity(now, eq, this.book);
        this.tuner.observeEquity(eq, now);
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

  /** User-tapped close: sell 100% of one position. Other positions are left alone. */
  async manualClose(id: string): Promise<{ ok: boolean; symbol?: string; pnlUsd?: number; pending?: boolean; error?: string }> {
    const key = String(id || '').trim();
    if (!key) return { ok: false, error: 'position id required' };
    const matches = this.monitoredPositions().filter((x) => x.id === key || x.mint === key);
    if (matches.length !== 1) return { ok: false, error: matches.length ? 'ambiguous position' : 'position not found' };
    const p = matches[0];
    if (this.selling.has(p.id)) return { ok: false, error: 'already closing' };
    const others = this.positions.filter((x) => x.id !== p.id).map((x) => x.id);
    const r = await this.closePosition(p, 'manual', 'manual', 1);
    const stillOthers = this.positions.filter((x) => others.includes(x.id));
    if (stillOthers.length !== others.length) return { ok: false, error: 'other positions were affected' };
    if (!r.ok) return { ok: false, symbol: p.symbol, error: r.error || 'close failed' };
    const last = this.store.trades(1)[0];
    const pnlUsd = last && last.id === p.id ? last.pnlUsd : undefined;
    if (this.mode === 'paper' && !r.pending && this.positions.some((x) => x.id === p.id))
      return { ok: false, symbol: p.symbol, error: 'sell failed' };
    return { ok: true, symbol: p.symbol, pnlUsd, pending: r.pending };
  }

  /** Sell every open position in parallel with retries. Paper uses sim fills; live/live-auto use the real swap path. */
  async closeAll(): Promise<{ ok: boolean; closed: number; failed: number; results: { id: string; symbol: string; ok: boolean; pnlUsd?: number; error?: string; pending?: boolean }[] }> {
    const list = [...this.positions];
    const results: { id: string; symbol: string; ok: boolean; pnlUsd?: number; error?: string; pending?: boolean }[] = [];
    await poolRun(list, 6, async (p) => {
      let lastErr = 'close failed';
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const r = await this.closePosition(p, 'manual', 'close all', 1);
          if (r.ok) {
            const last = this.store.trades(1)[0];
            results.push({ id: p.id, symbol: p.symbol, ok: true, pending: r.pending, pnlUsd: last && last.id === p.id ? last.pnlUsd : undefined });
            return;
          }
          lastErr = r.error || lastErr;
        } catch (e: any) {
          lastErr = e?.message || String(e);
        }
        await new Promise((res) => setTimeout(res, 400 * (attempt + 1)));
      }
      results.push({ id: p.id, symbol: p.symbol, ok: false, error: lastErr });
    });
    this.emitState();
    return { ok: results.every((r) => r.ok), closed: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length, results };
  }

  async closePosition(p: Position, kind: string, reason: string, fraction = 1): Promise<{ ok: boolean; error?: string; pending?: boolean }> {
    if (this.selling.has(p.id) && fraction >= 0.999) return { ok: false, error: 'already closing' };
    this.selling.add(p.id);
    this.agents.scanner.inFlightSells = this.selling.size;
    try {
    const frac = Math.min(1, Math.max(0.05, fraction));
    if (this.isLiveBookPos(p) || this.mode === 'live-auto') { await this.execLiveAuto('sell', p as any, { position: p, kind, reason, fraction: frac }); return { ok: true }; }
    if (this.mode === 'live') { await this.requestLive('sell', p as any, { position: p, kind, reason, fraction: frac }); return { ok: true, pending: true }; }
    const qty = p.qty * frac;
    const f = await this.exec.sell(p.mint, qty, p.decimals, this.solPrice);
    let solBack: number, fillPrice: number, note = '';
    const hair = (SWAP_FEE_BPS + (this.cfg.extraSlippageBps || 0)) / 1e4;
    const markPx = p.lastPrice * (1 - hair);
    const markBack = this.solPrice > 0 ? (qty * markPx) / this.solPrice : 0;
    const realistic = this.mode === 'paper' && this.cfg.realisticPaper !== false;
    if (!f.ok) {
      // Realistic TP never invents a fill. Manual Close / Close all may still
      // settle on the mark after a failed quote so the user can flatten.
      const allowMark = this.mode === 'paper' && (kind === 'manual' || (!realistic && kind === 'take_profit'));
      if (realistic && kind === 'take_profit') return { ok: false, error: f.error || 'no sell quote' };
      if (!allowMark && kind === 'manual') return { ok: false, error: f.error || 'sell failed' };
      this.sellFails[p.id] = (this.sellFails[p.id] || 0) + 1;
      if (!allowMark && this.sellFails[p.id] < 6) return { ok: false, error: f.error || 'sell failed' };
      fillPrice = markPx;
      solBack = markBack;
      note = ' (mark estimate, no quote)';
    } else {
      solBack = f.solReceived - f.feesSol;
      fillPrice = f.fillPrice;
      // Optimistic paper only: if the quote would miss the TP target while the
      // mark is in profit, settle on the mark. Realistic paper always books the quote.
      if (!realistic && this.mode === 'paper' && kind === 'take_profit' && this.solPrice > 0) {
        const fillPnl = solBack * this.solPrice - (p.costUsd * frac);
        const markPnl = markBack * this.solPrice - (p.costUsd * frac);
        const targetUsd = p.costUsd * frac * (this.tuner.takeProfitPct(this.cfg.takeProfitPct ?? 3) / 100);
        if (fillPnl < targetUsd && markPnl >= targetUsd) {
          fillPrice = markPx;
          solBack = markBack;
          note = ' (mark estimate, quote not in profit)';
        }
      }
    }
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
      return { ok: true };
    }
    this.wallet.solBalance += solBack + p.rentSol;
    const proceeds = solBack * this.solPrice + ((p as any).realizedUsd || 0);
    const cost = (p as any).origCost ?? p.costUsd;
    p.costUsd = cost;
    this.finishClose(p, fillPrice, proceeds, kind, reason + note);
    return { ok: true };
    } finally {
      this.selling.delete(p.id);
      this.agents.scanner.inFlightSells = this.selling.size;
    }
  }

  private finishClose(p: Position, exitPrice: number, proceedsUsd: number, kind: string, reason: string) {
    const book: Book = this.isLiveBookPos(p) ? 'live' : 'paper';
    this.positions = this.positions.filter((x) => x.id !== p.id);
    if (book === 'live') this.liveHeld = this.liveHeld.filter((x) => x.id !== p.id);
    const pnlUsd = proceedsUsd - p.costUsd;
    const t: ClosedTrade = { ...p, book, closedAt: Date.now(), exitPrice, proceedsUsd, pnlUsd, pnlPct: (pnlUsd / p.costUsd) * 100, reason, kind, heldSec: (Date.now() - p.openedAt) / 1000 } as ClosedTrade;
    this.store.addTrade(t);
    // Shared learning: paper (realistic weight 1) and live fills both train the tuner.
    this.tuner.record({
      reason: p.entryPattern || reason, exitKind: kind, exitReason: reason, pnlUsd, costUsd: p.costUsd, pnlPct: t.pnlPct,
      equity: this.equity(), weight: book === 'paper' ? 1 : 1,
      immediateRed: !!p.immediateRed || ((p.maePct || 0) <= -2 && (Date.now() - p.openedAt) < 45_000),
    });
    this.store.set('autotune', this.tuner.dump());
    const rug = /rug|catastrophic|dev\/top-holder/i.test(reason);
    this.cooldown[p.mint] = Date.now() + (rug ? 8 * 60_000 : Math.max(15_000, this.cfg.cooldownMin * 60_000));
    this.agents.risk.exits++; this.agents.executor.fills++; this.agents.executor.last = `SELL ${p.symbol}`;
    this.persist();
    const stopped = kind !== 'manual' && kind !== 'take_profit' && (kind === 'hard_stop' || pnlUsd < 0);
    this.decision({ ts: Date.now(), side: 'SELL', symbol: p.symbol, image: p.image, text: `${reason} · ${pnlUsd >= 0 ? '+' : '-'}$${Math.abs(pnlUsd).toFixed(2)} via Jupiter`, usd: pnlUsd });
    void notifyTrade({ side: 'SELL', symbol: p.symbol, sizeUsd: proceedsUsd, price: exitPrice, pnlPct: t.pnlPct });
    this.log('Risk', stopped ? 'stop' : 'sell', `${stopped ? 'Stopped' : 'Sold'} ${p.symbol}`, { symbol: p.symbol, mint: p.mint, image: p.image, usd: pnlUsd, pct: t.pnlPct, text2: reason } as any);
    if (kind === 'manual') this.emit('toast', { kind: pnlUsd > 0 ? 'profit' : 'fill', title: `Closed ${p.symbol}`, usd: pnlUsd, pct: t.pnlPct, symbol: p.symbol, image: p.image, text: 'manual close' });
    else if (pnlUsd > 0) this.emit('toast', { kind: 'profit', title: kind === 'take_profit' ? `Take profit ${p.symbol}` : `Risk sold ${p.symbol} - locked the gain`, usd: pnlUsd, pct: t.pnlPct, symbol: p.symbol, image: p.image });
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
    } catch (e: any) { if (side === 'buy') this.logBuyFail(c, e?.message || 'not sent'); else this.log('Executor', 'reject', `Sell ${c.symbol} failed: ${e.message}`, { symbol: c.symbol, mint: c.mint, image: c.image }); }
  }
  async liveSigned(id: string, signature: string) {
    const p = this.pending.get(id); if (!p) throw new Error('unknown request');
    p.signature = signature;
    for (let i = 0; i < 30; i++) {
      const s = await getSignatureStatus(this.cfg.rpcUrl, signature);
      if (s === 'failed') { this.pending.delete(id); this.agents.executor.failures++; this.log('Executor', 'reject', `Buy/sell failed on-chain${p.meta?.candidate?.symbol ? ' · ' + p.meta.candidate.symbol : ''}`); return; }
      if (s === 'confirmed' || s === 'finalized') break;
      await new Promise((r) => setTimeout(r, 2000));
    }
    this.pending.delete(id);
    // NOTE: quantities are taken from the Jupiter quote (estimate); on-chain balance is re-synced every minute.
    if (p.side === 'buy') {
      const c = p.meta.candidate; const tokens = p.meta.outAmount / 10 ** p.meta.decimals;
      const costSol = p.meta.solAmt; const price = (costSol * this.solPrice) / tokens;
      this.positions.push({ id, mint: c.mint, pool: c.pool, symbol: c.symbol, name: c.name, image: c.image, openedAt: Date.now(), entryPrice: price, qty: tokens, decimals: p.meta.decimals, costUsd: costSol * this.solPrice, costSol, peakPrice: price, lastPrice: price, score: p.meta.score, rentSol: ATA_RENT_SOL, book: 'live' });
      this.liveHeld = this.positions.filter((x) => x.book === 'live' || this.mode !== 'paper');
      this.agents.executor.fills++; this.agents.executor.buys++; this.agents.executor.last = `BUY ${c.symbol}`;
      this.log('Executor', 'buy', `Bought ${c.symbol}`, { symbol: c.symbol, mint: c.mint, image: c.image, usd: costSol * this.solPrice });
      void notifyTrade({ side: 'BUY', symbol: c.symbol, sizeUsd: costSol * this.solPrice, price });
    } else {
      const pos: Position = p.meta.position; const sol = p.meta.outAmount / 1e9;
      this.finishClose(pos, (sol * this.solPrice) / pos.qty, sol * this.solPrice, p.meta.kind, p.meta.reason);
      if (this.mode === 'live-auto') {
        try {
          const n = await reclaimEmptyAtas(this.cfg.rpcUrl);
          if (n) this.log('Executor', 'info', `reclaimed rent from ${n} empty token account(s)`);
          await this.syncBotBalance();
        } catch (e: any) {
          this.log('Core', 'info', `ATA rent reclaim skipped: ${e?.message || e}`);
        }
      }
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
    } catch (e: any) { if (side === 'buy') this.logBuyFail(c, e?.message || 'not sent'); else this.log('Executor', 'reject', `Sell ${c.symbol} failed: ${e.message}`, { symbol: c.symbol, mint: c.mint, image: c.image }); }
  }

  async reconcileOnchain() {
    if (this.mode === 'paper') return;
    const owner = this.mode === 'live-auto' ? botPublicKey() : this.wallet.address;
    if (!owner) return;
    try {
      const r = await rebuildPositions({
        rpcUrl: this.cfg.rpcUrl, owner, solPrice: this.solPrice,
        current: this.mode === 'paper' ? this.liveHeld : this.positions,
        priceOf: async (mint) => {
          const px = await this.m.prices([mint]);
          return px[mint] || this.candidates.get(mint)?.priceUsd || 0;
        },
        metaOf: (mint) => this.candidates.get(mint),
      });
      this.liveHeld = r.positions.map((x: Position) => ({ ...x, book: 'live' as const }));
      this.store.setBook('live', 'positions', this.liveHeld);
      if (this.mode !== 'paper') this.positions = this.liveHeld;
      this.repairDepositBaseline();
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
  async withdraw(opts: { to?: string; asset?: 'SOL' | 'USDC' | string; sol?: number; usdc?: number; max?: boolean; dryRun?: boolean } = {}) {
    const parsed = parseWithdrawDestination(opts.to || this.lockedWithdrawTo() || DEFAULT_WITHDRAW_TO);
    if (!parsed.ok) throw new Error(parsed.error);
    if (this.mode === 'paper') throw new Error(WITHDRAW_ERR.paper);
    const asset = String(opts.asset || 'SOL').toUpperCase() === 'USDC' ? 'USDC' : 'SOL';
    if (asset !== 'SOL' && asset !== 'USDC') throw new Error(WITHDRAW_ERR.asset);
    const liveOpen = this.positions.length;
    const keep = keepLamportsForWithdraw({ priorityFeeSol: this.cfg.priorityFeeSol, openLivePositions: liveOpen });
    const pub = botPublicKey();
    if (!pub) throw new Error('bot wallet is not configured');
    if (parsed.address === pub) throw new Error(WITHDRAW_ERR.self);

    if (opts.dryRun) {
      if (asset === 'USDC') {
        const bal = await getUsdcBalance(this.cfg.rpcUrl, pub);
        const raw = opts.max || opts.usdc == null ? bal.raw : BigInt(Math.floor(Number(opts.usdc) * 10 ** USDC_DECIMALS));
        const send = raw > bal.raw ? bal.raw : raw;
        return { ok: true, dryRun: true, to: parsed.address, asset, usdc: Number(send) / 10 ** USDC_DECIMALS, sol: 0 };
      }
      const lamports = opts.max || opts.sol == null || !Number.isFinite(Number(opts.sol))
        ? undefined
        : Math.floor(Number(opts.sol) * 1e9);
      const prev = await previewSolWithdraw(this.cfg.rpcUrl, pub, lamports, keep);
      return { ok: true, dryRun: true, to: parsed.address, asset, sol: prev.send / 1e9, keepSol: prev.keep / 1e9, balanceSol: prev.balance / 1e9 };
    }

    if (this.pending.size) throw new Error('ยังมีรายการสวอปค้างอยู่ กรุณารอให้เสร็จก่อนถอน');
    if (this.wallet.running) this.setRunning(false);

    if (asset === 'USDC') {
      const raw = opts.max || opts.usdc == null
        ? undefined
        : BigInt(Math.floor(Number(opts.usdc) * 10 ** USDC_DECIMALS));
      if (raw !== undefined && raw <= 0n) throw new Error(WITHDRAW_ERR.amount);
      const u = await transferUsdc(this.cfg.rpcUrl, parsed.address, raw, { priorityFeeSol: this.cfg.priorityFeeSol });
      if (!u) throw new Error(WITHDRAW_ERR.noFunds);
      await this.syncBotBalance();
      const rec = {
        ts: Date.now(), asset: 'USDC' as const, sol: 0, usdc: u.usdc, to: parsed.address,
        signature: u.signature, solscan: `https://solscan.io/tx/${u.signature}`, attempts: u.attempts,
      };
      const hist = this.store.get<any[]>('withdrawHistory', []);
      hist.unshift(rec);
      this.store.set('withdrawHistory', hist.slice(0, 50));
      this.log('Core', 'info', `withdrew ${u.usdc.toFixed(2)} USDC to ${shortAddr(parsed.address)}`);
      this.emitState();
      return { ok: true, ...rec };
    }

    const lamports = opts.max || opts.sol == null || !Number.isFinite(Number(opts.sol))
      ? undefined
      : Math.floor(Number(opts.sol) * 1e9);
    if (lamports !== undefined && lamports <= 0) throw new Error(WITHDRAW_ERR.amount);
    let closedAccounts = 0;
    try { closedAccounts = await reclaimEmptyAtas(this.cfg.rpcUrl); } catch (e: any) {
      this.log('Core', 'info', `close empty accounts: ${e?.message || e}`);
    }
    const r = await sendSolWithdraw(this.cfg.rpcUrl, parsed.address, lamports, {
      priorityFeeSol: this.cfg.priorityFeeSol,
      keepLamports: keep,
    });
    await this.syncBotBalance();
    const rec = {
      ts: Date.now(), asset: 'SOL' as const, sol: r.lamports / 1e9, usdc: 0, to: parsed.address,
      signature: r.signature, solscan: `https://solscan.io/tx/${r.signature}`,
      closedAccounts, attempts: r.attempts,
    };
    const hist = this.store.get<any[]>('withdrawHistory', []);
    hist.unshift(rec);
    this.store.set('withdrawHistory', hist.slice(0, 50));
    this.log('Core', 'info', `withdrew ${rec.sol.toFixed(4)} SOL to ${shortAddr(parsed.address)}`);
    this.emitState();
    return { ok: true, ...rec };
  }

  async fundsView() {
    const bot = botPublicKey();
    const onchain = bot ? await getSolBalance(this.cfg.rpcUrl, bot) : null;
    if (this.mode !== 'paper' && bot && onchain != null) {
      this.wallet.realSol = onchain;
      if (this.mode === 'live-auto') this.wallet.solBalance = onchain;
    }
    const usdc = bot ? await getUsdcBalance(this.cfg.rpcUrl, bot) : { ui: 0, raw: 0n, ata: null };
    this.usdcBal = usdc;
    return {
      mode: this.mode,
      paperDisabled: this.mode !== 'paper',
      paperEquity: this.mode === 'paper' ? this.equity() : null,
      paperSol: this.mode === 'paper' ? this.wallet.solBalance : null,
      botAddress: bot || '2VscQ33yZudTXXNjCpfB5X4jsJVL4ZoZxGDzS5xCtLYo',
      onchainSol: onchain,
      onchainUsd: onchain != null ? onchain * (this.solPrice || 0) : null,
      onchainUsdc: usdc.ui,
      onchainUsdcUsd: usdc.ui,
      autoSwapUsdc: this.mode !== 'paper',
      network: 'solana',
      solPrice: this.solPrice,
      withdrawTo: this.lockedWithdrawTo() || DEFAULT_WITHDRAW_TO,
      defaultTo: this.lockedWithdrawTo() || DEFAULT_WITHDRAW_TO,
      canWithdraw: this.mode !== 'paper',
      reserveSol: keepLamportsForWithdraw({ priorityFeeSol: this.cfg.priorityFeeSol, openLivePositions: this.mode === 'paper' ? this.liveHeld.length : this.positions.length }) / 1e9,
      maxSol: Math.max(0, (onchain || 0) - keepLamportsForWithdraw({ priorityFeeSol: this.cfg.priorityFeeSol, openLivePositions: this.mode === 'paper' ? this.liveHeld.length : this.positions.length }) / 1e9),
      maxUsdc: usdc.ui,
      withdrawLocked: !!this.lockedWithdrawTo(),
      lockedBy: this.withdrawLockedBy(),
      history: this.store.get<any[]>('withdrawHistory', []).slice(0, 50),
      positionsOpen: this.mode === 'paper' ? this.positions.length : this.positions.length,
      livePositionsOpen: this.mode === 'paper' ? this.liveHeld.length : this.positions.length,
      running: this.wallet.running,
    };
  }

  private usdcBal: { ui: number; raw: bigint; ata: string | null } = { ui: 0, raw: 0n, ata: null };
  private lastUsdcSwapAt = 0;
  private lastUsdcNeedSolAt = 0;
  private usdcBusy = false;

  async convertUsdc(force = false) {
    if (!liveGate(this.cfg).live || !hasBotWallet()) return;
    if (this.usdcBusy) return;
    if (!force && Date.now() - this.lastUsdcSwapAt < 15_000) return;
    this.usdcBusy = true;
    try {
      const bot = botPublicKey();
      if (!bot) return;
      const bal = await getUsdcBalance(this.cfg.rpcUrl, bot);
      this.usdcBal = bal;
      const sol = (this.wallet.realSol ?? this.wallet.solBalance ?? 0);
      const gate = canAutoSwapUsdc(this.mode === 'paper' ? 'live-auto' : this.mode, bal.ui, sol);
      if (!gate.ok) {
        if (gate.reason === 'need SOL for fees' && bal.ui > 0) {
          const now = Date.now();
          if (now - this.lastUsdcNeedSolAt > 60_000) {
            this.lastUsdcNeedSolAt = now;
            this.log('Core', 'info', `USDC ${bal.ui.toFixed(2)} waiting: need ~0.005 SOL in the bot wallet to pay swap fees (have ${sol.toFixed(4)} SOL)`);
            this.emit('toast', { kind: 'warn', title: 'USDC received — send a little SOL', text: `${bal.ui.toFixed(2)} USDC is in the bot wallet but auto-swap needs ~0.005 SOL for fees (currently ${sol.toFixed(4)} SOL). Trading cannot start until then.` });
          }
        }
        return;
      }
      const r = await swapUsdcToSol(this.cfg, this.m);
      this.lastUsdcSwapAt = Date.now();
      // RPC can lag behind a just-landed gasless swap; don't zero out equity.
      let synced = 0;
      for (let i = 0; i < 5; i++) {
        await this.syncBotBalance();
        synced = this.wallet.realSol ?? this.wallet.solBalance ?? 0;
        if (synced > 0) break;
        await new Promise((res) => setTimeout(res, 800));
      }
      if (synced <= 0 && r.solOutEst > 0) {
        this.wallet.solBalance = r.solOutEst;
        this.wallet.realSol = r.solOutEst;
      }
      this.usdcBal = await getUsdcBalance(this.cfg.rpcUrl, bot);
      const how = r.gasless ? 'gasless Jupiter' : 'Jupiter';
      this.log('Executor', 'info', `swapped ${r.usdcIn.toFixed(2)} USDC to ~${r.solOutEst.toFixed(4)} SOL via ${how} · ${r.signature}`);
      this.emit('toast', { kind: 'fill', title: `Swapped ${r.usdcIn.toFixed(2)} USDC to SOL`, text: `~${r.solOutEst.toFixed(4)} SOL · ${how} · ${r.signature.slice(0, 8)}…` });
      this.emitState();
    } catch (e: any) {
      const msg = e?.message || String(e);
      if (!/no USDC|dust|paper/.test(msg)) {
        this.log('Core', 'info', `USDC swap skipped: ${msg}`);
        if (/Need ~0.01 SOL|need at least|gasless/i.test(msg) && Date.now() - this.lastUsdcNeedSolAt > 60_000) {
          this.lastUsdcNeedSolAt = Date.now();
          this.emit('toast', { kind: 'warn', title: 'Need ~0.01 SOL for fees', text: msg });
        }
      }
    } finally { this.usdcBusy = false; }
  }

  // ---------------------------------------------------------------- views
  private rollDay() {
    const k = dayKey();
    if (this.wallet.dayKey !== k) { this.wallet.dayKey = k; this.wallet.dayStartEquity = this.equity(); if (this.solPrice) this.solDayOpen = this.solPrice; this.saveWallet(); }
  }
  positionsView() {
    const paper = this.mode === 'paper' ? this.positions : [];
    const primary = this.mode === 'paper' ? paper : this.positions;
    const view = (p: Position, live: boolean) => ({
      ...p, book: live ? 'live' as const : (p.book || this.book), liveManaged: live,
      valueUsd: p.qty * p.lastPrice, pnlPct: p.entryPrice ? (p.lastPrice / p.entryPrice - 1) * 100 : 0,
      stop: activeStop(this.cfg, p),
    });
    const out = primary.map((p) => view(p, this.isLiveBookPos(p)));
    if (this.mode === 'paper') {
      const ids = new Set(out.map((p) => p.id));
      for (const p of this.liveHeld) {
        if (!ids.has(p.id)) out.push(view({ ...p, book: 'live' }, true));
      }
    }
    return out;
  }
  stats() {
    const trades = this.store.trades(5000, this.book);
    const wins = trades.filter((t) => t.pnlUsd > 0);
    const eq = this.wallet.connected ? this.equity() : 0;
    const best = trades.reduce((a: any, t) => (!a || t.pnlUsd > a.pnlUsd ? t : a), null);
    const worst = trades.reduce((a: any, t) => (!a || t.pnlUsd < a.pnlUsd ? t : a), null);
    return {
      mode: this.mode, book: this.book,
      equity: eq, deposit: this.wallet.depositUsd, pnlUsd: eq - this.wallet.depositUsd,
      pnlPct: this.wallet.depositUsd ? (eq / this.wallet.depositUsd - 1) * 100 : 0,
      multiplier: this.wallet.depositUsd ? eq / this.wallet.depositUsd : 1,
      trades: trades.length + this.positions.length, closed: trades.length, wins: wins.length, losses: trades.length - wins.length,
      winRate: trades.length ? (wins.length / trades.length) * 100 : 0,
      coins: new Set([...trades.map((t) => t.mint), ...this.positions.map((p) => p.mint)]).size,
      best: best && { symbol: best.symbol, usd: best.pnlUsd }, worst: worst && { symbol: worst.symbol, usd: worst.pnlUsd },
      cashUsd: this.cashUsd(), solBalance: this.wallet.solBalance, solPrice: this.solPrice,
      usdc: this.mode === 'paper' ? 0 : (this.usdcBal?.ui || 0),
      runtimeMin: this.wallet.startedAt ? (Date.now() - this.wallet.startedAt) / 60_000 : 0,
    };
  }
  snapshot() {
    const gate = liveGate(this.cfg);
    const ticker = [...this.candidates.values()].filter((c) => c.liquidityUsd > 5000).sort((a, b) => (b.score || 0) - (a.score || 0)).slice(0, 12)
      .map((c) => ({ symbol: c.symbol, mint: c.mint, image: c.image, change: c.change.h1 }));
    const reserve = this.exitReserveSolAmt(true);
    const reserveUsd = this.exitReserveUsd(true);
    const low = this.wallet.connected ? lowBalanceReason(this.equity(), this.cashUsd(), reserveUsd, this.cfg.minTradeUsd, this.usdcBal?.ui || 0) : null;
    const adapted = this.riskAdapted();
    const botPub = botPublicKey();
    return {
      appName: this.cfg.appName, mode: this.mode,
      modeReason: this.mode === 'paper'
        ? (gate.live
          ? `TEST mode — paper book only. Live is armed; ${this.liveHeld.length} live position(s) stay open and still exit on-chain. No new live buys until you switch back.`
          : 'TEST mode — paper book only. Live is not armed on this host.')
        : gate.reason,
      dataSource: this.m.name, auto: !!gate.auto, liveArmed: !!gate.live, canSwitchLive: !!gate.live,
      modeBadge: this.mode === 'paper' ? 'TEST' : 'LIVE',
      liveOpen: this.liveHeld.length,
      liveOverlay: this.mode === 'paper' ? {
        positions: this.liveHeld.length,
        sol: this.liveWallet?.solBalance ?? this.liveWallet?.realSol ?? null,
        note: 'Live positions stay open and are still managed on-chain.',
      } : null,
      wallet: { ...this.wallet }, stats: this.stats(), positions: this.positionsView(), agents: this.agents,
      activity: this.store.activity(60, this.book), decisions: this.store.decisions(40, this.book), ticker,
      calls: { ...this.m.calls }, apiErrors: this.m.errors, lastApiError: this.m.lastError,
      config: { ...this.cfg, liveConfirm: undefined },
      pending: [...this.pending.values()].map((p) => ({ id: p.id, side: p.side, mint: p.mint, tx: p.tx, signature: p.signature })),
      lowBalance: low, reserveSol: reserve, reserveUsd, spendableUsd: Math.max(0, this.cashUsd() - reserveUsd),
      sizeMult: adapted.sizeMult, pauseUntil: this.lossPauseUntil, scan: this.scanStatus(),
      keepalive: keepaliveSnapshot(),
      push: { enabled: pushEnabled(), subscribers: subscriberCount() },
      background: { tradesWithoutApp: true, runningPersisted: !!this.wallet.running, autoStart: autoStartEnabled(), ephemeralStorage: !process.env.RENDER_DISK_MOUNT_PATH, withdrawPersist: canPersistRenderEnv() ? 'env' : 'local-until-saved', remoteState: remoteStateStatus() },
      pump: getPumpFeed().status,
      autotune: this.tuner.snapshot(),
      narrative: this.narrative,
      botWallet: botPub ? {
        publicKey: botPub,
        withdrawTo: this.lockedWithdrawTo(),
        withdrawLocked: !!this.lockedWithdrawTo(),
        lockedBy: this.withdrawLockedBy(),
        lockMessage: this.lockedWithdrawTo() ? '' : LOCK_MESSAGE('YOUR_PHANTOM_ADDRESS'),
        usdc: this.usdcBal.ui,
        onchainSol: this.wallet.realSol ?? this.wallet.solBalance,
        autoSwapUsdc: this.mode !== 'paper',
      } : null,
    };
  }
  equitySeries(range: string) {
    const span: Record<string, number> = { LIVE: 15 * 60_000, '1H': 3600_000, '4H': 4 * 3600_000, '1D': 86400_000, '1W': 7 * 86400_000, ALL: 1e15 };
    const since = Math.max(this.wallet.startedAt || 0, Date.now() - (span[range] ?? span.ALL));
    const rows = this.store.equity(since, this.book);
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
    const trades = this.store.trades(2000, this.book).filter((t) => t.mint === mint);
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

  private tuneAdjust(why: string, score: number) {
    const g = this.tuner.allow(why);
    const nudge = Math.max(-3, Math.min(3, g.minScoreAdj || 0));
    const s = nudge ? clampScore(score - nudge) : score;
    if (g.exploring) (this.agents.analyst as any).label = `explore ${g.key}`;
    return s;
  }

  // ---------------------------------------------------------------- helpers
  private lastReconcileAt = 0;
  async maybeReconcile() {
    if (!liveGate(this.cfg).live) return;
    if (Date.now() - this.lastReconcileAt < 8000) return;
    this.lastReconcileAt = Date.now();
    await this.reconcileOnchain();
  }
  private persist() {
    this.store.setBook(this.book, 'positions', this.positions);
    this.store.setBook(this.book, 'cooldown', this.cooldown);
    this.saveWallet();
    this.store.setBook('live', 'positions', this.mode === 'paper' ? this.liveHeld : this.positions);
    if (this.liveWallet) this.store.setBook('live', 'wallet', this.liveWallet);
    this.store.set('runtimeMode', this.runtimeMode);
    const cfg = { ...this.cfg } as any;
    delete cfg.liveConfirm; delete cfg.mode; delete cfg.rpcUrl; delete cfg.port;
    this.store.set('config', cfg);
    this.store.set('autotune', this.tuner.dump());
  }
  private saveWallet() { this.store.setBook(this.book, 'wallet', this.wallet); }

  private decision(d: Decision) { this.store.addDecision({ ...d, book: this.book }); this.emit('decision', d); }
  log(agent: ActivityItem['agent'], kind: ActivityItem['kind'], text: string, extra: Partial<ActivityItem> & { text2?: string } = {}) {
    const book: Book = (extra as any).book === 'live' ? 'live' : this.book;
    const a = { id: randomUUID(), ts: Date.now(), agent, kind, text, ...extra, book } as ActivityItem;
    this.store.addActivity(a);
    this.emit('activity', a);
    const t = new Date().toLocaleTimeString('en-GB', { hour12: false });
    console.log(`[${t}] ${agent.padEnd(8)} ${text}${extra.usd !== undefined ? ` $${extra.usd.toFixed(2)}` : ''}${(extra as any).text2 ? ' · ' + (extra as any).text2 : ''}`);
  }
  emitState() { this.emit('state', this.snapshot()); }
}
