# Grok Bot · Solana meme-coin trading bot (TEST / PAPER mode)

> 🇹🇭 ภาษาไทยอยู่ด้านล่าง · Thai version below

A mobile-first web app + Node.js engine that copies the look and entry flow of the concept videos:
loading screen → "Connect Phantom" sheet → dashboard (light/dark) with 5 agents, live portfolio chart,
activity feed, token detail with candlesticks, take-profit toast with confetti and a "Night recap".

**It runs in TEST mode by default**: real market data, real Jupiter quotes, **simulated fills**. No real
transaction is ever sent in test mode. Live trading is locked (see "Going live").

## Run

Requirements: Node.js ≥ 22.18 (tested on Node 24.22). No API keys needed.

```bash
cd grokbot-trader
npm install          # installs the web UI deps too
npm start            # builds the UI on first run, then serves http://127.0.0.1:8787
```

Open http://127.0.0.1:8787 (use your browser's mobile view, or set `HOST=0.0.0.0` and open
`http://<computer-ip>:8787` on your phone on the same Wi-Fi). On a fresh open the splash is followed by the Connect sheet. In paper mode set the test
balance (default **$81**, minimum **$2**), tap **Connect** → **Connected ✓** → **เริ่มใช้งาน** → setup → dashboard.

Other commands:

| command | what it does |
|---|---|
| `npm test` | unit + engine tests (risk/stops, $2/$5/$10 sizing, anti-martingale, signing dry-run, live-auto gate) |
| `npm run replay` | offline mode: synthetic market (use if the public APIs are unreachable) |
| `npm run screenshots -- http://127.0.0.1:8787` | 390×844 screenshots of every screen into `screenshots/` |
| `npm run check:live-build` | builds (does NOT sign/send) an unsigned Jupiter swap tx to prove the live path works |
| `docker compose up --build` | same app in Docker, data persisted in `./data` |

Settings: `.env.example` (copy to `.env`) or the **Account** tab in the app (position %, stops, max positions,
min score, liquidity/holder filters, slippage, app name). Everything is saved to `data/` (SQLite + `config.json`)
and survives restarts.

## How it works (5 agents)

| agent | logic | data |
|---|---|---|
| **SCANNER** | every ~3 s pulls brand-new + trending Solana pools (PumpSwap / pump.fun / Raydium / Meteora) and backs off on 429s | GeckoTerminal, DexScreener, Jupiter recent (public) |
| **SAFETY** | rejects: thin liquidity, too young/old, tiny/huge mcap, non-SOL/USDC quote, honeypot pattern (buys but no sells), wash-trading pattern, liq/mcap < 3%, active **mint or freeze authority**, few holders, top-holder concentration, RugCheck "danger" risks. Missing data = reject | RugCheck (public) |
| **ANALYST** | score 0-100: momentum (5m/15m/1h, blow-off penalty), buy pressure, volume/liquidity, liquidity depth, unique traders. Buys only if the score clears the adaptive floor and 5-minute momentum confirms | pool stats |
| **RISK** | default size = **5 % of current portfolio**; tiny books (≤ $5) use all spendable SOL minus fee/rent reserve. Hard stop **-7 %**, trailing **10 % from the top**, time stop 30 min, daily loss limit 12 %. After wins size grows slightly (anti-martingale); after losses it shrinks. Exits when momentum fades. | Jupiter price API (~1 s) |
| **EXECUTOR** | TEST: fill at the real **Jupiter quote** (price impact included) − extra slippage − fees; token-account rent is locked while open and reclaimed on sell. LIVE (Phantom): unsigned Jupiter swap that **you approve**. LIVE AUTO: the bot wallet signs and sends (priority fee, dynamic slippage, confirm + retry). Withdrawals go only to a locked destination. | Jupiter quote/swap API |

The paper wallet holds SOL (like a real Phantom wallet), so the $ balance also moves with the SOL price.

## Going live (only on the owner's explicit command)

The app/API cannot change the mode. Two live styles are supported, both requiring
`LIVE_CONFIRM="I UNDERSTAND REAL FUNDS ARE AT RISK"`:

**Phantom mode** (`MODE=live`): connect Phantom and approve every swap in the wallet.
On a phone, use **Open in Phantom** so Connect works inside the in-app browser.

**Live auto** (`MODE=live-auto` + `BOT_WALLET_SECRET`): the server holds a dedicated
Solana keypair and signs Jupiter swaps itself. The secret is an env var (or a local
`BOT_WALLET_SECRET.txt` that is gitignored). It is never logged, never returned by an
API, and never shown in the UI. `RPC_URL` is optional (defaults to public mainnet-beta
with backoff).

User steps for live auto:
1. Fund the bot wallet deposit address shown in the app (SOL only; keep a little extra for fees/rent).
2. Open the app in Phantom once and sign the lock message so withdrawals can go **only** to your Phantom address
   (or set `WITHDRAW_TO` in the server env). The UI cannot change the destination afterwards.
3. Tap **Start bot**. **Stop bot** pauses new entries and monitoring trades already open still exit on stops.

The **Withdraw** button sends all remaining SOL to the locked address and closes empty token accounts to reclaim rent.
Do not put the bot secret in git, chat, or screenshots.

### Render free plan (honest)

A Render free web service **sleeps after about 15 minutes without inbound HTTP**. Sleeping stops auto-trading.
This app pings its public `/healthz` every 8 minutes (`RENDER_EXTERNAL_URL` or `KEEPALIVE_URL`) in the hope of
counting as inbound traffic. **Render does not officially guarantee that a self-ping keeps a free instance awake.**
The free plan is also limited to **750 instance-hours per month**. Running 24/7 uses about 720–744 hours, which
fits only if the service is the only free instance and does not get extra hours from other services or failed starts.
If it sleeps, open the app (or `/healthz`) to wake it, then Start bot again if it was paused.

## Honest limitations

* **Results will not look like the videos.** The videos show animated, cherry-picked profits ($81 → $2,745).
  Real meme-coin trading loses money most of the time; in our live-data test the first trades were losses.
* Paper fills use real quotes but can't model MEV/sandwiching, failed or delayed transactions, sudden rugs
  between price checks, or exact on-chain slippage. Stops are checked every ~1 s, so on fast dumps the exit can
  still be worse than the hard-stop level.
* On a $2–$10 book, fees and ATA rent (≈0.002 SOL, refunded on close) are a large share of each trade.
  Fund a little extra SOL so the reserve is covered. Equity is SOL + open positions (not USDC).
* Live auto signs for real: a bug, a stolen secret, or a bad route can lose the whole bot-wallet balance.
  The withdraw lock only protects withdrawals, not trades. Paper results will look better than live.
* Public APIs have rate limits; if they fail the bot simply skips that cycle (errors are shown in Account).
* The "repos" panel and `git clone` loading text are cosmetic (as in the video); call counters are real.
* Not financial advice.

---

# 🇹🇭 Grok Bot · บอทเทรดเหรียญมีม Solana (โหมดทดสอบ)

แอปมือถือ (เปิดผ่านเว็บ) + เอนจินเทรด ที่ทำหน้าตาและขั้นตอนเข้าใช้งานตามคลิป:
หน้าโหลด → หน้าต่าง "Connect Phantom" → แดชบอร์ด (สว่าง/มืด) มีเอเจนต์ 5 ตัว กราฟพอร์ตแบบสด
ฟีดกิจกรรม หน้ารายละเอียดเหรียญพร้อมกราฟแท่งเทียน แจ้งเตือนขายทำกำไรพร้อมพลุ และสรุป "Night recap"

**ค่าเริ่มต้นคือโหมดทดสอบ (TEST/PAPER)**: ใช้ข้อมูลตลาดจริงและราคา Jupiter จริง แต่ **จำลองการซื้อขาย**
ไม่มีการส่งธุรกรรมจริงเลย โหมดเงินจริงถูกล็อกไว้

## วิธีเปิดใช้

ต้องมี Node.js 22.18 ขึ้นไป ไม่ต้องใช้ API key

```bash
cd grokbot-trader
npm install
npm start      # เปิด http://127.0.0.1:8787
```

เปิดแอปแล้วหน้าต่าง **Connect Phantom** จะเด้งขึ้นมาเอง กด **Connect** → **Approving…** → **Connected ✓** แล้วกด **เริ่มใช้งาน** เพื่อเข้าแดชบอร์ด (โหมดทดสอบจำลองการเชื่อมกระเป๋า ไม่แตะกระเป๋าจริง ยอดเริ่มต้น $81 ขั้นต่ำ $2 ปรับได้ตอนเชื่อมต่อ)
ถ้าจะเปิดจากมือถือในวง Wi-Fi เดียวกัน ให้ตั้ง `HOST=0.0.0.0` แล้วเปิด `http://<IP เครื่อง>:8787`

* `npm test` — ทดสอบระบบ (จุดตัดขาดทุน, trailing stop, ขนาดไม้, ตัวกรองความปลอดภัย, ทดสอบพอร์ต $10)
* `npm run replay` — โหมดออฟไลน์ ใช้ตลาดจำลอง (กรณีเชื่อม API สาธารณะไม่ได้)
* ตั้งค่าได้ในแท็บ **Account** หรือไฟล์ `.env` ข้อมูลทั้งหมดเก็บใน `data/` ปิดเปิดใหม่ก็ไม่หาย

## กลยุทธ์ (ค่าเสถียร Nov 2026)

* ขนาดไม้เริ่มต้น = **5% ของพอร์ต** (ทุนเล็ก ≤ $5 จะใช้เงินที่ใช้ได้ทั้งหมดหักค่าธรรมเนียม/ค่าเช่าบัญชี)
* ตัดขาดทุน **-7%**, trailing **10% จากจุดสูงสุด**, ถือไม่เกิน 30 นาที, ขาดทุนต่อวันเกิน 12% หยุดซื้อใหม่
* กำไรแล้วค่อยขยายขนาดไม้ (ไม่ถัวเฉลี่ย/ไม่มาร์ติงเกล) ขาดทุนติดกันจะย่อขนาด
* คัดเหรียญเปิดใหม่เร็ว, ตรวจความปลอดภัย (mint/freeze, สภาพคล่อง, ผู้ถือ, Jupiter ขายกลับได้) แล้วเข้าเมื่อโมเมนตัมยืนยัน

## การเปลี่ยนเป็นเงินจริง (ทำเมื่อคุณสั่งเท่านั้น)

ปิดไว้และเปิดจากในแอปไม่ได้ มีสองแบบ ทั้งคู่ต้องตั้ง `LIVE_CONFIRM="I UNDERSTAND REAL FUNDS ARE AT RISK"`

* `MODE=live` — เชื่อม Phantom แล้วกดอนุมัติทุกไม้ (มือถือใช้ปุ่ม **Open in Phantom**)
* `MODE=live-auto` + `BOT_WALLET_SECRET` — บอทถือกระเป๋าเทรดของตัวเอง เซ็นสวอปให้อัตโนมัติ ความลับห้ามใส่ใน git/แชท/หน้าจอ

ขั้นตอนโหมดบอทเทรดเอง: เติม SOL ไปที่ที่อยู่กระเป๋าบอทที่แสดงในแอป → เปิดใน Phantom ครั้งหนึ่งแล้วเซ็นล็อกที่อยู่ถอนเงิน (ถอนได้เฉพาะกระเป๋าคุณ) → กด **Start bot**
แผนฟรีของ Render หลับเมื่อไม่มี HTTP ประมาณ 15 นาที (บอทจะหยุด) และจำกัด 750 ชั่วโมง/เดือน แอปจะ ping `/healthz` เองทุก 8 นาที แต่ไม่รับประกันว่าจะกันหลับได้

## ข้อจำกัด (ตรงไปตรงมา)

* **ผลจริงจะไม่เหมือนในคลิป** คลิปเป็นภาพจำลองที่เลือกเฉพาะช่วงกำไร เหรียญมีมส่วนใหญ่ขาดทุน
* การจำลองใช้ราคาเสนอจริงจาก Jupiter แต่จำลอง MEV, ธุรกรรมล้มเหลว หรือการเทขายฉับพลันไม่ได้ทั้งหมด
* ทุน $2–$10 ค่าธรรมเนียมและค่าเช่าบัญชีโทเคนจะกินสัดส่วนสูง เติม SOL เผื่อค่าธรรมเนียมด้วย
* โหมด live-auto ใช้เงินจริงทันทีหากเติมกระเป๋าบอท ผลในโหมดทดสอบจะดีกว่าของจริง
* ไม่ใช่คำแนะนำการลงทุน

## Access gate / เปิดจากมือถือ

If `ACCESS_TOKEN.txt` (or env `ACCESS_TOKEN`, ≥16 chars) exists, the UI and every API route are served
only under `/<token>/` — everything else returns 404. Create one with
`node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))" > ACCESS_TOKEN.txt`.
Open `http://<host>:8787/<token>/` and use "Add to Home Screen" (PWA: icons + standalone mode).
To reach it from a phone outside your network, run a tunnel on the same machine, e.g.
`cloudflared tunnel --url http://127.0.0.1:8787`, then open `https://<random>.trycloudflare.com/<token>/`.
