// paper.js — paper/demo copy variklis.
// Mirror'ina treiderio sandorius proporcingai NUO prenumeratos pradzios (startTs).
// Mastelis = paper suma / treiderio peak kapitalas -> paper niekada nedeploy'ina daugiau nei suma.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CFG = JSON.parse(fs.readFileSync(path.join(__dirname, "config.json"), "utf8"));
const PERPS_API = "https://perps-api.jup.ag/v2";
const ASSET = { "So11111111111111111111111111111111111111112": "SOL", "3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh": "BTC", "7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs": "ETH" };
const num = (x) => { const n = Number(x); return isFinite(n) ? n : 0; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function fetchTraderTrades(wallet) {
  const headers = { "x-client-platform": "solcopytrade" };
  if (CFG.jupiterApiKey) headers["x-api-key"] = CFG.jupiterApiKey;
  let all = [], start = 0, count = 0;
  for (let p = 0; p < 60; p++) {
    const r = await fetch(`${PERPS_API}/trades?walletAddress=${wallet}&start=${start}&end=${start + 500}`, { headers });
    if (!r.ok) break;
    const j = await r.json(); count = j.count || count;
    const list = j.dataList || []; if (!list.length) break;
    all = all.concat(list); start += list.length;
    if (all.length >= count) break;
    await sleep(120);
  }
  return all.map((t) => {
    let ts = num(t.createdTime); if (ts > 1e12) ts = Math.floor(ts / 1000);
    return { ts, pk: t.positionPubkey, asset: ASSET[t.mint] || "?", action: t.action, side: t.side,
      coll: Math.abs(num(t.collateralUsdDelta)), size: num(t.size), price: num(t.price),
      fee: num(t.fee) + num(t.borrowFee), pnl: t.pnl != null ? num(t.pnl) : null };
  }).sort((a, b) => a.ts - b.ts);
}

// pilna istorija su veiksmu pavadinimais (open/add/addMargin/reduce/close), naujausi virsuje
export function labelHistory(trades) {
  const rem = {}, out = [];
  for (const e of trades) {
    let label;
    if (e.action === "Increase") { const had = rem[e.pk] > 1; rem[e.pk] = (rem[e.pk] || 0) + e.size; label = e.size <= 0 ? "addMargin" : (had ? "add" : "open"); }
    else { rem[e.pk] = (rem[e.pk] || 0) - e.size; label = rem[e.pk] <= 1 ? "close" : "reduce"; }
    const cAbs = Math.abs(e.coll);
    out.push({ ts: e.ts, asset: e.asset, action: label, side: e.side, priceUsd: Math.round(e.price * 100) / 100, sizeUsd: Math.round(e.size), collUsd: Math.round(cAbs), lev: (e.action === "Increase" && cAbs > 0 && e.size > 0 ? Math.round(e.size / cAbs * 100) / 100 : null), pnlUsd: e.pnl != null ? Math.round((e.pnl - e.fee) * 100) / 100 : null });
  }
  return out.reverse();
}

// treiderio PANAUDOTAS kapitalas (visu round-trip epizodu peak'u suma) — masteliui (ta pati baze kaip leaderboard'e)
function traderCapital(trades) {
  const pos = {}; let cap = 0;
  for (const e of trades) {
    if (e.action === "Increase") { if (!pos[e.pk]) pos[e.pk] = { coll: 0, rem: 0, epPeak: 0 }; pos[e.pk].coll += e.coll; pos[e.pk].rem += e.size; if (pos[e.pk].coll > pos[e.pk].epPeak) pos[e.pk].epPeak = pos[e.pk].coll; }
    else if (pos[e.pk]) { const out = Math.max(0, e.coll - (e.pnl || 0)); pos[e.pk].coll -= out; pos[e.pk].rem -= e.size; if (pos[e.pk].rem <= 1) { cap += pos[e.pk].epPeak; delete pos[e.pk]; } }
  }
  for (const k in pos) cap += pos[k].epPeak;
  return cap;
}

// dabartines kainos = paskutine matyta kaina kiekvienam turtui (is paciu sandoriu)
function lastPrices(trades) {
  const p = {};
  for (const e of trades) if (e.price > 0) p[e.asset] = e.price;
  return p;
}

// Pagrindinis: paper busena pagal treiderio sandorius
export function computePaper(account, trades) {
  const cap = traderCapital(trades);
  const scale = cap > 0 ? account.start / cap : 0;
  const prices = lastPrices(trades);
  const since = account.startTs || 0;

  const pos = {}; // pk -> { asset, side, size, coll, entry }
  let realized = 0; const orders = [];
  for (const e of trades) {
    if (e.ts < since) continue; // kopijuojam tik nuo prenumeratos pradzios
    const pSize = e.size * scale, pColl = e.coll * scale;
    if (e.action === "Increase") {
      if (!pos[e.pk]) pos[e.pk] = { asset: e.asset, side: e.side, size: 0, coll: 0, entry: e.price };
      const o = pos[e.pk];
      o.entry = (o.size + pSize) > 0 ? (o.entry * o.size + e.price * pSize) / (o.size + pSize) : e.price; // svertinis vid. iejimas
      o.size += pSize; o.coll += pColl;
      orders.push({ ts: e.ts, action: o.size === pSize ? "open" : "add", asset: e.asset, side: e.side, price: e.price, size: pSize, coll: pColl });
    } else { // Decrease
      const net = e.pnl != null ? (e.pnl - e.fee) * scale : 0;
      realized += net;
      if (pos[e.pk]) { const o = pos[e.pk]; o.size -= pSize; o.coll -= pColl; if (o.size <= o.size * 0 + 0.01) delete pos[e.pk]; }
      orders.push({ ts: e.ts, action: "close", asset: e.asset, side: e.side, price: e.price, size: pSize, pnl: net });
    }
  }
  // atviros pozicijos -> nerealizuotas PnL pagal dabartine kaina
  let unreal = 0; const open = [];
  for (const pk in pos) {
    const o = pos[pk]; const cur = prices[o.asset] || o.entry;
    const u = o.side === "long" ? o.size * (cur / o.entry - 1) : o.size * (1 - cur / o.entry);
    unreal += u;
    open.push({ asset: o.asset, side: o.side, size: Math.round(o.size * 100) / 100, coll: Math.round(o.coll * 100) / 100, entry: o.entry, cur, uPnl: Math.round(u * 100) / 100 });
  }
  const balance = account.start + realized;
  const equity = balance + unreal;
  return {
    id: account.id, wallet: account.wallet, start: account.start, startTs: since,
    balance: Math.round(balance * 100) / 100,
    equity: Math.round(equity * 100) / 100,
    realized: Math.round(realized * 100) / 100,
    unreal: Math.round(unreal * 100) / 100,
    returnPct: account.start > 0 ? Math.round((equity / account.start - 1) * 1000) / 10 : 0,
    scale, open, orders: orders.slice(-60).reverse(),
  };
}
