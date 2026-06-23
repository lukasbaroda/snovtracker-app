// Kalibravimo inspektorius: parodo VISKA apie viena wallet'a (perps) + musu skaiciavimo zingsnius.
// Paleidimas:  node inspect.js <wallet>
// Tikslas: palyginti su tavo ZINOMA realybe ir sukalibruoti formule.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CFG = JSON.parse(fs.readFileSync(path.join(__dirname, "config.json"), "utf8"));
const PERPS_API = "https://perps-api.jup.ag/v2";
const ASSET = { "So11111111111111111111111111111111111111112": "SOL", "3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh": "BTC", "7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs": "ETH" };
const num = (x) => { const n = Number(x); return isFinite(n) ? n : 0; };
const usd = (n) => "$" + (Math.round(n * 100) / 100).toLocaleString("en-US");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const wallet = process.argv[2];
if (!wallet) { console.log("Naudojimas: node inspect.js <wallet>"); process.exit(1); }

async function fetchAll(w) {
  const headers = { "x-client-platform": "solcopytrade" };
  if (CFG.jupiterApiKey) headers["x-api-key"] = CFG.jupiterApiKey;
  let all = [], start = 0, count = 0;
  for (let p = 0; p < 100; p++) {
    const r = await fetch(`${PERPS_API}/trades?walletAddress=${w}&start=${start}&end=${start + 500}`, { headers });
    if (!r.ok) { console.log("HTTP", r.status); break; }
    const j = await r.json(); count = j.count || count;
    const list = j.dataList || [];
    if (!list.length) break;
    all = all.concat(list); start += list.length;
    if (all.length >= count) break;
    await sleep(120);
  }
  return { all, count };
}

(async () => {
  console.log(`\n=== INSPECT ${wallet} ===`);
  const { all, count } = await fetchAll(wallet);
  console.log(`API count: ${count} | uzkrauta: ${all.length}`);
  if (!all.length) { console.log("Nera perps sandoriu siam wallet'ui."); return; }

  // chronologiskai
  const ev = all.map((t) => ({
    ts: num(t.createdTime), pk: t.positionPubkey, asset: ASSET[t.mint] || "?",
    action: t.action, side: t.side, coll: num(t.collateralUsdDelta), size: num(t.size),
    price: num(t.price), fee: num(t.fee) + num(t.borrowFee), pnl: t.pnl != null ? num(t.pnl) : null,
  })).sort((a, b) => a.ts - b.ts);

  // bendri
  let grossPnl = 0, closed = 0, summedColl = 0, feesOpen = 0, feesClose = 0, totalSize = 0;
  for (const e of ev) {
    if (e.action === "Increase") { summedColl += Math.abs(e.coll); feesOpen += e.fee; totalSize += e.size; }
    if (e.action === "Decrease") { feesClose += e.fee; if (e.pnl != null) { closed++; grossPnl += e.pnl; } }
  }
  const allFees = feesOpen + feesClose;
  const avgLev = summedColl > 0 ? Math.round(totalSize / summedColl * 100) / 100 : 0;
  const afterBorrow = grossPnl - feesClose; // = Jupiter "In. close/borrow fees"
  const net = grossPnl - allFees;           // tikras neto su atidarymo mokesciais

  // peak-concurrent: pozicija uzdaryta kai likutis (atidaryta size - uzdaryta size) <= ~0
  const pc = {}, episodes = []; let openT = 0, peak = 0, capitalDeployed = 0;
  for (const e of ev) {
    if (e.action === "Increase") {
      if (!pc[e.pk]) pc[e.pk] = { coll: 0, rem: 0, epPeak: 0, epPnl: 0, epFee: 0 };
      pc[e.pk].coll += Math.abs(e.coll); pc[e.pk].rem += e.size; pc[e.pk].epFee += e.fee;
      if (pc[e.pk].coll > pc[e.pk].epPeak) pc[e.pk].epPeak = pc[e.pk].coll;
      openT += Math.abs(e.coll); if (openT > peak) peak = openT;
    } else if (pc[e.pk]) {
      pc[e.pk].epFee += e.fee; if (e.pnl != null) pc[e.pk].epPnl += e.pnl;
      const collOut = Math.max(0, Math.abs(e.coll) - (e.pnl || 0));
      pc[e.pk].coll -= collOut; openT -= collOut; if (openT < 0) openT = 0;
      pc[e.pk].rem -= e.size;
      if (pc[e.pk].rem <= 1) { openT -= Math.max(0, pc[e.pk].coll); capitalDeployed += pc[e.pk].epPeak; episodes.push(pc[e.pk].epPnl - pc[e.pk].epFee); delete pc[e.pk]; if (openT < 0) openT = 0; }
    }
  }
  for (const k in pc) capitalDeployed += pc[k].epPeak;
  const nEp = episodes.length, epWins = episodes.filter((p) => p > 0).length;
  const spanDays = Math.max(1, (ev.length ? (ev[ev.length - 1].ts - ev[0].ts) : 0) / 86400);
  const tradesPerDay = Math.round(nEp / spanDays * 100) / 100;

  console.log(`\n--- BENDRA ---`);
  console.log(`Uzbaigti sandoriai (epizodai): ${nEp} | ${tradesPerDay}/d | win (neto): ${nEp ? Math.round(epWins / nEp * 1000) / 10 : 0}% | daliniu uzdarymu: ${closed}`);
  console.log(`Vidutinis svertas: ${avgLev}x | aktyvus ~${Math.round(spanDays)} d.`);
  console.log(`Bruto PnL (kaina, = Jupiter "Ex."):       ${usd(grossPnl)}`);
  console.log(`Po close/borrow (= Jupiter "In."):        ${usd(afterBorrow)}`);
  console.log(`Mokesciai viso: ${usd(allFees)} (atidarymo ${usd(feesOpen)}, uzdarymo/borrow ${usd(feesClose)})`);
  console.log(`NETO pelnas (po VISU mokesciu):           ${usd(net)}`);
  console.log(`Collateral SUMA (visi Increase): ${usd(summedColl)}`);
  console.log(`Peak concurrent (rizikoje vienu metu): ${usd(peak)}`);
  console.log(`Panaudotas kapitalas (poziciju peak suma): ${usd(capitalDeployed)}`);
  console.log(`GRAZA nuo panaudoto kapitalo (neto): ${capitalDeployed ? Math.round(net / capitalDeployed * 1000) / 10 : 0}%`);

  // pagal pozicija (likutis = atidaryta size - uzdaryta size; <=1 => uzdaryta)
  const byPos = {};
  for (const e of ev) {
    const o = (byPos[e.pk] ||= { inc: 0, dec: 0, collIn: 0, opened: 0, closedSize: 0, pnl: 0, fee: 0, asset: e.asset, side: e.side });
    o.fee += e.fee;
    if (e.action === "Increase") { o.inc++; o.collIn += Math.abs(e.coll); o.opened += e.size; }
    else { o.dec++; o.closedSize += e.size; if (e.pnl != null) o.pnl += e.pnl; }
  }
  console.log(`\n--- POZICIJOS (${Object.keys(byPos).length}) | PnL = neto ---`);
  Object.entries(byPos).slice(0, 25).forEach(([pk, o]) => {
    const remn = o.opened - o.closedSize; const lev = o.collIn > 0 ? Math.round(o.opened / o.collIn * 100) / 100 : 0;
    console.log(`  ${pk.slice(0, 6)} ${o.asset} ${o.side} | atid:${o.inc} uzd:${o.dec} | collIn:${usd(o.collIn)} ${lev}x | netoPnl:${usd(o.pnl - o.fee)} | ${remn <= 1 ? "UZDARYTA" : (o.dec > 0 ? "dalinė" : "ATVIRA")}`);
  });

  // veiksmu pavadinimai pagal likuti (chronologiskai)
  const rt = {};
  for (const e of ev) {
    if (e.action === "Increase") { const had = rt[e.pk] > 1; rt[e.pk] = (rt[e.pk] || 0) + e.size; e.label = e.size <= 0 ? "PRIDEJO MARZA" : (had ? "PADIDINO" : "ATIDARE"); }
    else { rt[e.pk] = (rt[e.pk] || 0) - e.size; e.label = rt[e.pk] <= 1 ? "UZDARE" : "SUMAZINO"; }
  }
  console.log(`\n--- SANDORIAI (paskutiniai 25) | pnl = neto ---`);
  ev.slice(-25).reverse().forEach((e) => {
    const d = new Date(e.ts * 1000).toISOString().slice(0, 16).replace("T", " ");
    console.log(`  ${d} ${e.asset} ${e.label} ${e.side} | size:${usd(e.size)} collΔ:${usd(e.coll)} fee:${usd(e.fee)} | pnl:${e.pnl != null ? usd(e.pnl - e.fee) : "—"}`);
  });
  console.log(`\nPalygink su savo ZINOMA realybe ir pasakyk, kur neatitinka.`);
})();
