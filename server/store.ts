// Persistence via Node's built-in SQLite (node:sqlite) - no native addon.
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { DATA_DIR } from './config.ts';

export type Book = 'paper' | 'live';

export class Store {
  db: DatabaseSync;
  constructor(file = join(DATA_DIR, 'grokbot.db')) {
    this.db = new DatabaseSync(file);
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS trades (id TEXT PRIMARY KEY, closed_at INTEGER, j TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS activity (id TEXT PRIMARY KEY, ts INTEGER, j TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS decisions (ts INTEGER, j TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS equity (ts INTEGER PRIMARY KEY, usd REAL NOT NULL);
      CREATE INDEX IF NOT EXISTS act_ts ON activity(ts);
      CREATE INDEX IF NOT EXISTS dec_ts ON decisions(ts);
    `);
    this.ensureBookColumn();
  }

  private ensureBookColumn() {
    for (const table of ['trades', 'activity', 'decisions', 'equity'] as const) {
      try { this.db.exec(`ALTER TABLE ${table} ADD COLUMN book TEXT NOT NULL DEFAULT 'paper'`); } catch { /* already exists */ }
    }
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS trades_book_ts ON trades(book, closed_at);
      CREATE INDEX IF NOT EXISTS act_book_ts ON activity(book, ts);
      CREATE INDEX IF NOT EXISTS dec_book_ts ON decisions(book, ts);
      CREATE TABLE IF NOT EXISTS equity_books (
        ts INTEGER NOT NULL,
        book TEXT NOT NULL,
        usd REAL NOT NULL,
        PRIMARY KEY (ts, book)
      );
    `);
    try {
      this.db.exec(`INSERT OR IGNORE INTO equity_books(ts,book,usd) SELECT ts, COALESCE(book,'paper'), usd FROM equity`);
    } catch { /* source table may already be mirrored */ }
  }

  /** Move unprefixed legacy rows into the given book once. Autotune / withdraw lock stay shared. */
  migrateLegacyBooks(dest: Book) {
    if (this.get('booksMigrated', false)) return;
    const already = this.get('paper:wallet', null) || this.get('live:wallet', null);
    const legacyWallet = this.get('wallet', null);
    const legacyPos = this.get('positions', null);
    const nLegacy = (this.db.prepare("SELECT COUNT(*) AS n FROM trades").get() as any)?.n || 0;
    if (!already && (legacyWallet || legacyPos || nLegacy)) {
      for (const k of ['wallet', 'positions', 'cooldown', 'agents', 'lossPauseUntil'] as const) {
        const v = this.get(k, null);
        if (v != null) this.set(`${dest}:${k}`, v);
      }
      this.db.prepare('UPDATE trades SET book=?').run(dest);
      this.db.prepare('UPDATE activity SET book=?').run(dest);
      this.db.prepare('UPDATE decisions SET book=?').run(dest);
      this.db.prepare('UPDATE equity SET book=?').run(dest);
      this.db.prepare("UPDATE equity_books SET book=? WHERE book='paper'").run(dest);
    }
    this.set('booksMigrated', true);
  }

  bookKey(book: Book, k: string) { return `${book}:${k}`; }
  getBook<T>(book: Book, k: string, def: T): T { return this.get(this.bookKey(book, k), def); }
  setBook(book: Book, k: string, v: unknown) { this.set(this.bookKey(book, k), v); }

  get<T>(k: string, def: T): T {
    const r = this.db.prepare('SELECT v FROM kv WHERE k=?').get(k) as any;
    return r ? JSON.parse(r.v) : def;
  }
  set(k: string, v: unknown) { this.db.prepare('INSERT INTO kv(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v').run(k, JSON.stringify(v)); }
  addTrade(t: { id: string; closedAt: number; book?: Book }) {
    const book: Book = t.book === 'live' ? 'live' : 'paper';
    this.db.prepare('INSERT OR REPLACE INTO trades(id,closed_at,book,j) VALUES(?,?,?,?)').run(t.id, t.closedAt, book, JSON.stringify(t));
  }
  trades(limit = 1000, book?: Book): any[] {
    if (book) return (this.db.prepare('SELECT j FROM trades WHERE book=? ORDER BY closed_at DESC LIMIT ?').all(book, limit) as any[]).map((r) => JSON.parse(r.j));
    return (this.db.prepare('SELECT j FROM trades ORDER BY closed_at DESC LIMIT ?').all(limit) as any[]).map((r) => JSON.parse(r.j));
  }
  addActivity(a: { id: string; ts: number; book?: Book }) {
    const book: Book = a.book === 'live' ? 'live' : 'paper';
    this.db.prepare('INSERT OR REPLACE INTO activity(id,ts,book,j) VALUES(?,?,?,?)').run(a.id, a.ts, book, JSON.stringify(a));
  }
  activity(limit = 100, book?: Book): any[] {
    if (book) return (this.db.prepare('SELECT j FROM activity WHERE book=? ORDER BY ts DESC LIMIT ?').all(book, limit) as any[]).map((r) => JSON.parse(r.j));
    return (this.db.prepare('SELECT j FROM activity ORDER BY ts DESC LIMIT ?').all(limit) as any[]).map((r) => JSON.parse(r.j));
  }
  addDecision(d: { ts: number; book?: Book }) {
    const book: Book = d.book === 'live' ? 'live' : 'paper';
    this.db.prepare('INSERT INTO decisions(ts,book,j) VALUES(?,?,?)').run(d.ts, book, JSON.stringify(d));
  }
  decisions(limit = 60, book?: Book): any[] {
    if (book) return (this.db.prepare('SELECT j FROM decisions WHERE book=? ORDER BY ts DESC LIMIT ?').all(book, limit) as any[]).map((r) => JSON.parse(r.j));
    return (this.db.prepare('SELECT j FROM decisions ORDER BY ts DESC LIMIT ?').all(limit) as any[]).map((r) => JSON.parse(r.j));
  }
  addEquity(ts: number, usd: number, book: Book = 'paper') {
    this.db.prepare('INSERT OR REPLACE INTO equity_books(ts,book,usd) VALUES(?,?,?)').run(ts, book, usd);
  }
  equity(since: number, book?: Book): { ts: number; usd: number }[] {
    if (book) return this.db.prepare('SELECT ts,usd FROM equity_books WHERE book=? AND ts>=? ORDER BY ts').all(book, since) as any;
    return this.db.prepare('SELECT ts,usd FROM equity_books WHERE ts>=? ORDER BY ts').all(since) as any;
  }
  prune() {
    this.db.exec(`DELETE FROM activity WHERE ts < (SELECT ts FROM activity ORDER BY ts DESC LIMIT 1 OFFSET 2000);
      DELETE FROM decisions WHERE ts < (SELECT ts FROM decisions ORDER BY ts DESC LIMIT 1 OFFSET 2000);`);
  }
  reset() { this.db.exec('DELETE FROM kv; DELETE FROM trades; DELETE FROM activity; DELETE FROM decisions; DELETE FROM equity; DELETE FROM equity_books;'); }
  /** Wipe paper trades/positions/history only. Live book, learning, and the withdraw lock stay. */
  clearPaperSession() {
    this.db.exec("DELETE FROM trades WHERE book='paper'; DELETE FROM activity WHERE book='paper'; DELETE FROM decisions WHERE book='paper'; DELETE FROM equity WHERE book='paper'; DELETE FROM equity_books WHERE book='paper';");
    this.set('paper:positions', []);
    this.set('paper:cooldown', {});
    this.set('paper:agents', null);
    this.set('paper:lossPauseUntil', 0);
    this.set('positions', []); // legacy unprefixed
    this.set('cooldown', {});
  }
}

/** Keys that may be mirrored to the private GitHub state repo. Never include secrets. */
export const SYNC_KV = ['wallet', 'positions', 'cooldown', 'autotune', 'agents', 'lossPauseUntil', 'config', 'withdrawHistory', 'withdrawTo', 'runtimeMode', 'booksMigrated', 'paper:wallet', 'paper:positions', 'paper:cooldown', 'paper:agents', 'paper:lossPauseUntil', 'live:wallet', 'live:positions', 'live:cooldown', 'live:agents', 'live:lossPauseUntil'] as const;

export type PaperSnapshot = {
  v: 1;
  savedAt: number;
  kv: Record<string, unknown>;
  trades: any[];
  equity: { ts: number; usd: number }[];
};

export function exportSnapshot(store: Store): PaperSnapshot {
  const kv: Record<string, unknown> = {};
  for (const k of SYNC_KV) kv[k] = store.get(k, null);
  if (kv.config && typeof kv.config === 'object') {
    const cfg = { ...(kv.config as any) };
    delete cfg.liveConfirm; delete cfg.mode; delete cfg.rpcUrl;
    kv.config = cfg;
  }
  return { v: 1, savedAt: Date.now(), kv, trades: store.trades(1000), equity: store.equity(0).slice(-2000) };
}

export function importSnapshot(store: Store, snap: PaperSnapshot): boolean {
  if (!snap || snap.v !== 1 || typeof snap !== 'object') return false;
  const kv = snap.kv || {};
  const forbidden = /secret|token|private|seed|mnemonic|password|api[_-]?key/i;
  for (const k of SYNC_KV) {
    if (forbidden.test(k)) continue;
    if (k in kv && kv[k] != null) store.set(k, kv[k]);
  }
  // Never import live mode / confirm / rpc from a snapshot.
  if (kv.config && typeof kv.config === 'object') {
    const cfg = { ...(kv.config as any) };
    delete cfg.liveConfirm; delete cfg.mode; delete cfg.rpcUrl; delete cfg.port;
    store.set('config', cfg);
  }
  for (const t of snap.trades || []) {
    if (t && t.id && t.closedAt) store.addTrade(t);
  }
  for (const e of snap.equity || []) {
    if (e && Number.isFinite(e.ts) && Number.isFinite(e.usd)) store.addEquity(e.ts, e.usd);
  }
  return true;
}

