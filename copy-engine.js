// copy-engine.js — kopijavimo variklis (DRY-RUN / LIVE).
// Kiekvienam whitelist treideriui su suma: skaičiuoja paper būseną (kiek uždirbo nuo starto,
// atviros pozicijos, kreivė) -> copy-accounts.json (kortelėms). Plius dry-run/live veiksmų logas.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fetchTraderTrades, computePaper } from "./paper.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(__dirname, "data"); try { fs.mkdirSync(DATA, { recursive: true }); } catch (e) {}
const CFG = (() => { try { return JSON.parse(fs.readFileSync(path.join(__dirname, "config.json"), "utf8")); } catch { return {}; } })();
const RANKF = path.join(DATA, "ranking.json");
const OVF = path.join(DATA, "overrides.json");
const STATEF = path.join(DATA, "copy-state.json");
const LOGF = path.join(DATA, "copy-log.json");
const ACCF = path.join(DATA, "copy-accounts.json");
const STOPF = path.join(DATA, "copy-STOP");

const CAPITAL = CFG.copyCapitalUsd || 1000;
const MAX_WATCH = CFG.copyMaxWatch || 3;
const POLL = (CFG.copyPollSec || 60) * 1000;
const LIVE = !!CFG.copyLive;
const MAXPOS = CFG.copyMaxPositionUsd || 25;
const MAXLEV = CFG.copyMaxLeverage || 10;
const DAILYMAX = CFG.copyDailyMaxUsd || 100;
const ASSETS_OK = CFG.copyAssets || ["SOL", "ETH", "BTC"];
const START_TS = Math.floor(Date.now() / 1000);

const load = (f, d) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return d; } };
const save = (f, o) => { const t = f + ".tmp"; fs.writeFileSync(t, JSON.stringify(o, null, 2)); fs.renameSync(t, f); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function peakOf(w) { const rank = (load(RANKF, { ranking: [] }).ranking) || []; const r = rank.find((x) => x.wallet === w); return r ? (r.peakUsd || r.capitalDeployed || 1000) : 1000; }
function downsample(arr, n) { if (arr.length <= n) return arr; const out = [], step = (arr.length - 1) / (n - 1); for (let i = 0; i < n; i++) out.push(arr[Math.round(i * step)]); return out; }
function logEntry(e) { const log = load(LOGF, []); log.unshift(e); save(LOGF, log.slice(0, 300)); console.log(`[${e.mode}/${e.status}] ${e.text}`); }

// ką stebim: whitelist su sumomis (arba top N pagal balą jei whitelist tuščias)
function watched() {
  const ov = load(OVF, {}); const wl = ov.whitelist || []; const amts = ov.copyAmounts || {}; const starts = ov.copyStart || {};
  if (wl.length) return wl.slice(0, 20).map((w) => ({ w, amt: amts[w] || CAPITAL, startTs: starts[w] || 0 }));
  const rank = (load(RANKF, { ranking: [] }).ranking) || [];
  return rank.slice(0, MAX_WATCH).map((r) => ({ w: r.wallet, amt: CAPITAL, startTs: 0 }));
}

let EXEC = null, EXEC_ERR = null;
async function executor() { if (EXEC) return EXEC; try { EXEC = await import("./perps-trade.js"); return EXEC; } catch (e) { EXEC_ERR = e.message; return null; } }
function dayKey() { return new Date().toISOString().slice(0, 10); }

async function tick() {
  const stop = fs.existsSync(STOPF);
  const liveNow = LIVE && !stop;
  const ws = watched();
  const state = load(STATEF, {});
  if (!state._daily || state._daily.date !== dayKey()) state._daily = { date: dayKey(), usd: 0, count: 0 };
  const accounts = [];

  for (const { w, amt, startTs } of ws) {
    let trades = [];
    try { trades = await fetchTraderTrades(w); } catch (e) {}
    if (!trades.length) { await sleep(200); continue; }

    // ---- KORTELĖ: paper būsena nuo starto ----
    const ps = computePaper({ wallet: w, start: amt, startTs: startTs || 0 }, trades);
    const ords = ps.orders.slice().reverse(); // chronologiškai
    let cum = amt; const curve = [{ ts: startTs || (ords[0] ? ords[0].ts : START_TS), bankroll: amt }];
    ords.forEach((o) => { if (o.pnl != null) { cum += o.pnl; curve.push({ ts: o.ts, bankroll: Math.round(cum * 100) / 100 }); } });
    const closes = ps.orders.filter((o) => o.action === "close");
    const wins = closes.filter((o) => (o.pnl || 0) > 0).length;
    const winPct = closes.length ? Math.round(wins / closes.length * 1000) / 10 : 0;
    const opensA = ps.orders.filter((o) => o.action === "open" || o.action === "add");
    const levs = opensA.filter((o) => o.coll > 0).map((o) => o.size / o.coll);
    const avgLev = levs.length ? Math.round(levs.reduce((a, b) => a + b, 0) / levs.length * 10) / 10 : 0;
    const firstTs = ps.orders.length ? Math.min.apply(null, ps.orders.map((o) => o.ts)) : (startTs || 0);
    accounts.push({
      wallet: w, amount: amt, startTs: startTs || 0, firstTs,
      equity: ps.equity, returnPct: ps.returnPct, realized: ps.realized, unreal: ps.unreal,
      openCount: ps.open.length, tradesCount: closes.length, winPct, avgLev, open: ps.open,
      curve: downsample(curve, 30), orders: ps.orders,
    });

    // ---- VEIKSMŲ LOGAS (nauji sandoriai) ----
    const peak = peakOf(w);
    const ratio = amt / Math.max(peak, 1);
    const baseTs = state[w] ? state[w].ts : (trades.length > 2 ? trades[trades.length - 3].ts : 0);
    let newest = baseTs;
    for (const e of trades) {
      if (e.ts <= baseTs) continue;
      newest = Math.max(newest, e.ts);
      let myColl = Math.round(e.coll * ratio * 100) / 100;
      let lev = (e.coll > 0 && e.size > 0) ? Math.round(e.size / e.coll * 10) / 10 : 0;
      const short = `${w.slice(0, 4)}…${w.slice(-4)}`;
      const base = { at: new Date().toISOString(), ts: e.ts, wallet: w, asset: e.asset, side: e.side, action: e.action, myCollUsd: myColl, lev };
      const isOpen = e.action === "Increase";
      let blocked = null;
      if (ASSETS_OK.indexOf(e.asset) < 0) blocked = `turtas ${e.asset} neleidžiamas (leidžiami: ${ASSETS_OK.join("/")})`;
      else if (lev > MAXLEV) { lev = MAXLEV; base.lev = lev; }
      if (!blocked && isOpen && myColl > MAXPOS) blocked = `per didelė pozicija: ~$${myColl} > limito $${MAXPOS} (didink copyMaxPositionUsd config'e)`;
      if (!blocked && isOpen && (state._daily.usd + myColl) > DAILYMAX) blocked = `dienos limitas: jau $${Math.round(state._daily.usd)} + $${myColl} viršytų $${DAILYMAX}`;
      const tooOld = e.ts < START_TS;
      if (!liveNow || blocked || tooOld) {
        const status = blocked ? "blocked" : (tooOld ? "skip-senas" : "dry");
        const note = blocked || (tooOld ? "senas sandoris (nevykdomas)" : (LIVE ? (stop ? "STOP įjungtas" : "") : "dry-run režimas"));
        logEntry({ ...base, mode: liveNow ? "LIVE" : "DRY", status, note, text: `${short} → ${e.side} ${e.asset} ${e.action}: ~${myColl} USDC (${lev}x)${note ? " — " + note : ""}` });
        continue;
      }
      const ex = await executor();
      if (!ex) { logEntry({ ...base, mode: "LIVE", status: "error", note: EXEC_ERR || "exec nepasiekiamas", text: `${short} → ${e.asset}: vykdymas negalimas` }); continue; }
      try {
        if (isOpen) { await ex.openPosition({ asset: e.asset, side: e.side, collateralUsd: myColl, leverage: lev }); state._daily.usd += myColl; state._daily.count++; }
        else { await ex.closePosition({ asset: e.asset, side: e.side }); }
        logEntry({ ...base, mode: "LIVE", status: "executed", note: "", text: `${short} → ${e.side} ${e.asset} ${e.action}: ĮVYKDYTA ~${myColl} USDC (${lev}x)` });
      } catch (err) { logEntry({ ...base, mode: "LIVE", status: "error", note: String(err.message || err).slice(0, 120), text: `${short} → ${e.asset}: KLAIDA` }); }
    }
    state[w] = { ts: newest };
    await sleep(300);
  }

  save(ACCF, { accounts, generatedAt: new Date().toISOString(), live: LIVE });
  save(STATEF, state);
}

console.log(`[copy-engine] ${LIVE ? "LIVE" : "DRY-RUN"} startas. Default kapitalas $${CAPITAL}, max poz $${MAXPOS}, svertas ${MAXLEV}x, dienos $${DAILYMAX}.`);
const ONCE = process.argv.includes("once");
if (ONCE) { tick().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); }); }
else { (async function loop() { try { await tick(); } catch (e) { console.error(e.message); } setTimeout(loop, POLL); })(); }
