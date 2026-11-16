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
`http://<computer-ip>:8787` on your phone on the same Wi-Fi). Pick **Paper wallet · test**, set the test
balance (default **$81**, minimum **$10**), tap **Connect** → **Connected ✓** → dashboard.

Other commands:

| command | what it does |
|---|---|
| `npm test` | unit + engine tests (risk/stops, sizing, safety, analyst, live-mode gate, $10 end-to-end) |
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
| **SCANNER** | every 30 s pulls new + trending Solana pools | GeckoTerminal, DexScreener (public) |
| **SAFETY** | rejects: thin liquidity, too young/old, tiny/huge mcap, non-SOL/USDC quote, honeypot pattern (buys but no sells), wash-trading pattern, liq/mcap < 3%, active **mint or freeze authority**, few holders, top-holder concentration, RugCheck "danger" risks. Missing data = reject | RugCheck (public) |
| **ANALYST** | score 0-100: momentum (5m/15m/1h, blow-off penalty), buy pressure, volume/liquidity, liquidity depth, unique traders. Buys only ≥ 60 | pool stats |
| **RISK** | size = **8 % of current portfolio** (compounds up and down, no fixed capital), hard stop **-8 %**, trailing stop **12 % from the top**, time stop 120 min, max 4 positions, daily loss limit 15 %, 45 min cooldown per token | Jupiter price API (every 4 s) |
| **EXECUTOR** | TEST: fill at the real **Jupiter quote** (price impact included) − 0.5 % extra slippage − network + priority fee, token-account rent (0.002 SOL) locked while open. LIVE: builds an unsigned Jupiter swap tx that **you approve in Phantom** | Jupiter quote/swap API |

The paper wallet holds SOL (like a real Phantom wallet), so the $ balance also moves with the SOL price.

## Going live (later — only on the owner's explicit command)

Live mode is **off** and cannot be switched on from the app/API. It needs all of:
1. In `data/config.json` (or env): `"mode": "live"` **and** `"liveConfirm": "I UNDERSTAND REAL FUNDS ARE AT RISK"`, then restart.
2. Connect a real **Phantom** wallet (browser extension or the Phantom in-app browser).
3. Every swap opens a Phantom approval — nothing moves without your signature. No private key/seed phrase is
   ever stored or needed (the app has no code that accepts one).

Before real money: run test mode for days, check the numbers, start small, and expect worse results than paper.

## Honest limitations

* **Results will not look like the videos.** The videos show animated, cherry-picked profits ($81 → $2,745).
  Real meme-coin trading loses money most of the time; in our live-data test the first trades were losses.
* Paper fills use real quotes but can't model MEV/sandwiching, failed or delayed transactions, sudden rugs
  between price checks, or exact on-chain slippage. Stops are checked every 4 s, so on fast dumps the exit can
  be well below -8 % (we saw -13 %…-18 %).
* With $10, each trade is only ~$0.80; the 0.002 SOL token-account rent (refunded on close) and fees are a
  big share of such small trades in live mode.
* Live mode (Phantom approval flow) is implemented and the swap-building step is verified, but it has **not**
  been run with real funds. It requires you to approve every trade, so it is not fully hands-off; fully
  automatic live trading would need a dedicated hot-wallet key, which this build intentionally does not support.
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

เลือก **Paper wallet · test** ใส่ยอดทดสอบ (ค่าเริ่มต้น $81 ขั้นต่ำ $10) กด **Connect** → **Connected ✓** → เข้าแดชบอร์ด
ถ้าจะเปิดจากมือถือในวง Wi-Fi เดียวกัน ให้ตั้ง `HOST=0.0.0.0` แล้วเปิด `http://<IP เครื่อง>:8787`

* `npm test` — ทดสอบระบบ (จุดตัดขาดทุน, trailing stop, ขนาดไม้, ตัวกรองความปลอดภัย, ทดสอบพอร์ต $10)
* `npm run replay` — โหมดออฟไลน์ ใช้ตลาดจำลอง (กรณีเชื่อม API สาธารณะไม่ได้)
* ตั้งค่าได้ในแท็บ **Account** หรือไฟล์ `.env` ข้อมูลทั้งหมดเก็บใน `data/` ปิดเปิดใหม่ก็ไม่หาย

## กลยุทธ์

* ขนาดไม้ = **8% ของพอร์ตปัจจุบัน** (ไม่จำกัดทุน คำนวณจากเงินในพอร์ตเสมอ ใช้ได้ตั้งแต่ $10)
* ตัดขาดทุน **-8%** จากราคาซื้อ, trailing stop **ลง 12% จากจุดสูงสุด**, ถือไม่เกิน 120 นาที
* ถือพร้อมกันไม่เกิน 4 เหรียญ, ขาดทุนต่อวันเกิน 15% หยุดซื้อใหม่
* คัดเหรียญด้วยสภาพคล่อง, อายุ, จำนวนผู้ถือ, mint/freeze authority, รูปแบบ honeypot และคะแนน 0-100

## การเปลี่ยนเป็นเงินจริง (ทำเมื่อคุณสั่งเท่านั้น)

ปิดไว้และเปิดจากในแอปไม่ได้ ต้อง (1) แก้ `data/config.json` ใส่ `"mode": "live"` และ
`"liveConfirm": "I UNDERSTAND REAL FUNDS ARE AT RISK"` แล้วรีสตาร์ท (2) เชื่อมกระเป๋า Phantom จริง
(3) ทุกการซื้อขายต้องกดอนุมัติใน Phantom ระบบไม่เก็บและไม่ขอ private key / seed phrase เด็ดขาด

## ข้อจำกัด (ตรงไปตรงมา)

* **ผลจริงจะไม่เหมือนในคลิป** คลิปเป็นภาพจำลองที่เลือกเฉพาะช่วงกำไร เหรียญมีมส่วนใหญ่ขาดทุน
  ในการทดสอบกับตลาดจริงของเรา ไม้แรกๆ ก็ขาดทุน
* การจำลองใช้ราคาเสนอจริงจาก Jupiter แต่จำลอง MEV, ธุรกรรมล้มเหลว หรือการเทขายฉับพลันไม่ได้ทั้งหมด
  ตอนราคาร่วงเร็ว จุดตัดขาดทุนอาจหลุดไปที่ -13% ถึง -18%
* พอร์ต $10 ไม้ละประมาณ $0.80 ค่าธรรมเนียมและค่าเปิดบัญชีโทเคน (0.002 SOL ได้คืนตอนปิด) จะกินสัดส่วนสูงในโหมดจริง
* โหมดเงินจริงต้องกดอนุมัติใน Phantom ทุกไม้ จึงไม่ได้อัตโนมัติ 100% และยังไม่เคยทดสอบด้วยเงินจริง
* ไม่ใช่คำแนะนำการลงทุน

## Access gate / เปิดจากมือถือ

If `ACCESS_TOKEN.txt` (or env `ACCESS_TOKEN`, ≥16 chars) exists, the UI and every API route are served
only under `/<token>/` — everything else returns 404. Create one with
`node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))" > ACCESS_TOKEN.txt`.
Open `http://<host>:8787/<token>/` and use "Add to Home Screen" (PWA: icons + standalone mode).
To reach it from a phone outside your network, run a tunnel on the same machine, e.g.
`cloudflared tunnel --url http://127.0.0.1:8787`, then open `https://<random>.trycloudflare.com/<token>/`.
