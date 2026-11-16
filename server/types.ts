export type Candidate = {
  mint: string;
  pool: string;
  symbol: string;
  name: string;
  image?: string;
  dex: string;
  priceUsd: number;
  mcapUsd: number;
  liquidityUsd: number;
  createdAt: number;          // ms epoch (pool creation)
  change: { m5: number; m15: number; h1: number; h6: number; h24: number };
  volume: { m5: number; h1: number; h6: number; h24: number };
  txns: { m5b: number; m5s: number; h1b: number; h1s: number; h24b: number; h24s: number };
  traders1h: number;
  quoteSymbol: string;
  source: string;
  curve?: { progress: number; vSol: number; vTokens: number; graduated: boolean };
  flow?: FlowStats;
  entryPattern?: string;
};

export type FlowStats = {
  netBuySol: number;
  netBuyUsd?: number;
  largeBuys: number;
  largeSells: number;
  uniqueBuyers: number;
  uniqueSellers: number;
  whaleBuyUsd: number;
  bundled?: boolean;
  devSold?: boolean;
  devPubkey?: string;
  devHoldPct?: number;
  progress?: number;
  progressVel?: number;
};

export type TokenSecurity = {
  mintAuthority: string | null;
  freezeAuthority: string | null;
  holders: number | null;
  topHolderPct: number | null;   // largest non-pool holder %
  top10Pct: number | null;
  dangerRisks: string[];
  rugged: boolean;
  fetchedAt: number;
  available: boolean;
};

export type Position = {
  id: string;
  mint: string;
  pool: string;
  symbol: string;
  name: string;
  image?: string;
  openedAt: number;
  entryPrice: number;      // effective USD price per token (incl. slippage/fees)
  qty: number;             // tokens (ui units)
  decimals: number;
  costUsd: number;         // USD spent incl. fees
  costSol: number;
  peakPrice: number;
  lastPrice: number;
  score: number;
  rentSol: number;         // token-account rent locked while open
  reconciled?: boolean;
  entryEstimated?: boolean;
};

export type ClosedTrade = Position & {
  closedAt: number;
  exitPrice: number;
  proceedsUsd: number;
  pnlUsd: number;
  pnlPct: number;
  reason: string;
};

export type ActivityItem = {
  id: string;
  ts: number;
  kind: 'buy' | 'sell' | 'stop' | 'reject' | 'info' | 'scan';
  agent: 'Scanner' | 'Safety' | 'Analyst' | 'Risk' | 'Executor' | 'Core';
  symbol?: string;
  mint?: string;
  image?: string;
  text: string;
  usd?: number;
  pct?: number;
  stakePct?: number;
};
