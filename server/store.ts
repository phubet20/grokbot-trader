// Persistence via Node's built-in SQLite (node:sqlite) - no native addon.
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { DATA_DIR } from './config.ts';

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
  }
  get<T>(k: string, def: T): T {
    const r = this.db.prepare('SELECT v FROM kv WHERE k=?').get(k) as any;
    return r ? JSON.parse(r.v) : def;
  }
  set(k: string, v: unknown) { this.db.prepare('INSERT INTO kv(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v').run(k, JSON.stringify(v)); }
  addTrade(t: { id: string; closedAt: number }) { this.db.prepare('INSERT OR REPLACE INTO trades(id,closed_at,j) VALUES(?,?,?)').run(t.id, t.closedAt, JSON.stringify(t)); }
  trades(limit = 1000): any[] { return (this.db.prepare('SELECT j FROM trades ORDER BY closed_at DESC LIMIT ?').all(limit) as any[]).map((r) => JSON.parse(r.j)); }
  addActivity(a: { id: string; ts: number }) {
    this.db.prepare('INSERT OR REPLACE INTO activity(id,ts,j) VALUES(?,?,?)').run(a.id, a.ts, JSON.stringify(a));
  }
  activity(limit = 100): any[] { return (this.db.prepare('SELECT j FROM activity ORDER BY ts DESC LIMIT ?').all(limit) as any[]).map((r) => JSON.parse(r.j)); }
  addDecision(d: { ts: number }) { this.db.prepare('INSERT INTO decisions(ts,j) VALUES(?,?)').run(d.ts, JSON.stringify(d)); }
  decisions(limit = 60): any[] { return (this.db.prepare('SELECT j FROM decisions ORDER BY ts DESC LIMIT ?').all(limit) as any[]).map((r) => JSON.parse(r.j)); }
  addEquity(ts: number, usd: number) { this.db.prepare('INSERT OR REPLACE INTO equity(ts,usd) VALUES(?,?)').run(ts, usd); }
  equity(since: number): { ts: number; usd: number }[] { return this.db.prepare('SELECT ts,usd FROM equity WHERE ts>=? ORDER BY ts').all(since) as any; }
  prune() {
    this.db.exec(`DELETE FROM activity WHERE ts < (SELECT ts FROM activity ORDER BY ts DESC LIMIT 1 OFFSET 2000);
      DELETE FROM decisions WHERE ts < (SELECT ts FROM decisions ORDER BY ts DESC LIMIT 1 OFFSET 2000);`);
  }
  reset() { this.db.exec('DELETE FROM kv; DELETE FROM trades; DELETE FROM activity; DELETE FROM decisions; DELETE FROM equity;'); }
  /** Wipe paper trades/positions/history but keep kv secrets such as the withdraw lock. */
  clearPaperSession() {
    this.db.exec('DELETE FROM trades; DELETE FROM activity; DELETE FROM decisions; DELETE FROM equity;');
    this.set('positions', []);
    this.set('cooldown', {});
    this.set('agents', null);
  }
}
