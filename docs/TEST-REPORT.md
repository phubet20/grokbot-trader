# Test report — 2026-11-16 (Asia/Bangkok)

## Unit / engine tests — `npm test`
19/19 pass: position sizing (% of portfolio, $10 wallet → $0.80 trades, cash reserve), entry gates
(max positions, daily loss limit, cooldown), hard stop -8 %, trailing stop 12 % from peak, time stop,
bad-price guard, analyst scoring, safety filters (liquidity/age/honeypot/mint+freeze authority/holders),
live-mode lock, config sanitising, end-to-end $10 paper engine on replay data (accounting consistent).

## Paper run on LIVE market data (GeckoTerminal + DexScreener + RugCheck + Jupiter)
20:28 → 21:13, ~45 min, two restarts (state persisted correctly). $81 paper wallet, 8 %/trade.
~2,100+ pools scanned; most rejected by SAFETY.

| token | in | P&L | exit |
|---|---|---|---|
| WIGGLES | $6.49 | -$1.16 (-17.9 %) | -8 % stop, slipped to -13.9 % |
| Stumpy | $6.39 | -$0.75 (-11.7 %) | -8 % stop, slipped to -13.0 % |
| bill | $6.35 | -$0.48 (-7.6 %) | -8 % stop |
| hello | $6.37 | **+$1.05 (+16.4 %)** | trailing stop +19.4 % |
| GTA | $6.48 | -$0.60 (-9.3 %) | -8 % stop |
| 1.0 | $6.39 | -$0.11 (-1.7 %) | trailing stop |
| WASTED6 (open) | $6.49 | +19.2 % unrealised | |
| Anthropig (open) | $6.33 | +7.6 % unrealised | |

Equity $81.00 → $80.89 (-0.14 %, 1W/5L closed). Jupiter returned one HTTP 429 burst before the
rate-limit fix (1 req/s limiter + retry); 0 API errors after it.

Also verified: live swap-tx *building* via Jupiter (unsigned, never signed/sent), browser-side
deserialisation of the tx for Phantom, clean `npm install && npm start` from a fresh copy, replay mode,
and that MODE=live without the confirm phrase (or via the API) stays in paper mode.
