// Solana Copytrade — simuliatorius (demo, jokiu pinigu). Self-contained.
// PROPORCINIS modelis: dydis = treiderio pozicija / jo piko kapitalo, taikom tavo sumai.
//   HISTORY TESTING:        node simulate.js backtest <wallet> <suma>
//   FORWARD PAPER TRADING:  node simulate.js paper   (pagal config paperSubscriptions)

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CFG = JSON.parse(fs.readFileSync(path.join(__dirname, "config.json"), "utf8"));
const PAPER_FILE = path.join(__dirname, "paper.json");

const SOL_MINT = "So11111111111111111111111111111111111111112";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const USDT_MINT = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";
const FEE_PCT = CFG.simFeePct ?? 0.5;
const PAGES = CFG.historyPages ?? 5;
const MIN_POS_USD = CFG.simMinPositionUsd ?? 20;   // dust filtras treiderio pusej
const MAX_MULT = CFG.simMaxMultiple ?? 50;          // outlier riba
const MIN_TRADE = CFG.simMinTradeUsd ?? 5;          // mūsų grindys (0 = demo, be grindu)

const loadJson = (f, def) => (fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : def);
const saveJson = (f, o) => fs.writeFileSync(f, JSON.stringify(o, null, 2));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getSolPrice() {
  try {
    const r = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd");
    const j = await r.json();
    const p = Number(j && j.solana && j.solana.usd);
    if (p > 0) return p;
  } catch (e) {}
  return CFG.solPriceFallback || 150;
}

async function fetchSwaps(address, pages) {
  let all = [], before = null;
  for (let p = 0; p < (pages || 1); p++) {
    let url = `https://api.helius.xyz/v0/addresses/${address}/transactions`
      + `?api-key=${CFG.heliusApiKey}&type=SWAP&limit=100`;
    if (before) url += `&before=${before}`;
    const r = await fetch(url);
    if (!r.ok) { console.warn(`  ! HTTP ${r.status}`); break; }
    const batch = await r.json();
    if (!batch.length) break;
    all = all.concat(batch);
    before = batch[batch.length - 1].signature;
    if (batch.length < 100) break;
    await sleep(120);
  }
  return all;
}

function parseSwap(tx, solPrice) {
  const sw = tx && tx.events && tx.events.swap;
  if (!sw) return null;
  let spentUsd = 0, recvUsd = 0, mint = null, side = null;
  const nIn = sw.nativeInput && Number(sw.nativeInput.amount) / 1e9;
  const nOut = sw.nativeOutput && Number(sw.nativeOutput.amount) / 1e9;
  if (nIn) spentUsd += nIn * solPrice;
  if (nOut) recvUsd += nOut * solPrice;
  const money = (m, amt) => (m === USDC_MINT || m === USDT_MINT) ? amt : (m === SOL_MINT ? amt * solPrice : null);
  for (const ti of sw.tokenInputs || []) {
    const amt = Number(ti.rawTokenAmount.tokenAmount) / 10 ** ti.rawTokenAmount.decimals;
    const u = money(ti.mint, amt);
    if (u !== null) spentUsd += u; else { mint = ti.mint; side = "SELL"; }
  }
  for (const to of sw.tokenOutputs || []) {
    const amt = Number(to.rawTokenAmount.tokenAmount) / 10 ** to.rawTokenAmount.decimals;
    const u = money(to.mint, amt);
    if (u !== null) recvUsd += u; else { mint = to.mint; side = "BUY"; }
  }
  if (!mint || !side) return null;
  return { ts: tx.timestamp, side, mint, spentUsd, recvUsd };
}

async function closedPositions(wallet) {
  const solPrice = await getSolPrice();
  const swaps = await fetchSwaps(wallet, PAGES);
  const tok = {};
  for (const tx of swaps) {
    const t = parseSwap(tx, solPrice);
    if (!t) continue;
    const o = (tok[t.mint] ||= { mint: t.mint, cost: 0, proceeds: 0, firstBuyTs: Infinity, lastSellTs: 0 });
    if (t.side === "BUY") { o.cost += t.spentUsd; if (t.ts < o.firstBuyTs) o.firstBuyTs = t.ts; }
    else { o.proceeds += t.recvUsd; if (t.ts > o.lastSellTs) o.lastSellTs = t.ts; }
  }
  const positions = Object.values(tok)
    .filter((o) => o.cost >= MIN_POS_USD && o.proceeds > 0 && o.firstBuyTs < Infinity && (o.proceeds / o.cost) <= MAX_MULT)
    .map((o) => ({ ...o, multiple: o.proceeds / o.cost }))
    .sort((a, b) => a.lastSellTs - b.lastSellTs);
  return { solPrice, positions };
}

// Daugiausiai vienu metu atviru poziciju kainos (= treiderio prekybinis "balansas")
function peakConcurrent(positions) {
  const ev = [];
  for (const p of positions) { ev.push([p.firstBuyTs, p.cost]); ev.push([p.lastSellTs, -p.cost]); }
  ev.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let cur = 0, peak = 0;
  for (const e of ev) { cur += e[1]; if (cur > peak) peak = cur; }
  return peak;
}

// PROPORCINIS: kiekviena pozicija = tas pats % kaip treiderio (cost/peak), taikom tavo sumai.
function simProportional(positions, amount) {
  const peak = peakConcurrent(positions);
  const ratio = peak > 0 ? amount / peak : 0;
  let final = amount, copied = 0, skipped = 0, wins = 0;
  for (const p of positions) {
    const copyUsd = p.cost * ratio;
    if (copyUsd < MIN_TRADE) { skipped++; continue; }
    final += copyUsd * (p.multiple * (1 - FEE_PCT / 100) - 1);
    copied++;
    if (p.multiple > 1) wins++;
  }
  return {
    peak: Math.round(peak), scale: Math.round(ratio * 1000) / 1000,
    final: Math.round(final * 100) / 100, pnlPct: Math.round((final / amount - 1) * 1000) / 10,
    copied, skipped, winRatePct: copied ? Math.round((wins / copied) * 1000) / 10 : 0,
  };
}

async function backtest(wallet, amount) {
  if (!wallet) { console.log("node simulate.js backtest <wallet> <suma>"); return; }
  console.log(`Imu ${wallet.slice(0, 8)} istorija...`);
  const { positions } = await closedPositions(wallet);
  if (!positions.length) { console.log("Nera tinkamu uzdarytu poziciju."); return; }
  const r = simProportional(positions, amount);
  saveJson(path.join(__dirname, `backtest_${wallet.slice(0, 8)}.json`), { mode: "history", wallet, amount, generatedAt: new Date().toISOString(), ...r });
  console.log(`\n=== HISTORY TESTING: ${wallet.slice(0, 8)} su $${amount} ===`);
  console.log(`Treiderio piko kapitalas: $${r.peak} | tavo mastelis: ${r.scale}x`);
  console.log(`Pozicijos: ${positions.length} | kopijuota: ${r.copied} | praleista (per maza, <$${MIN_TRADE}): ${r.skipped}`);
  console.log(`Win%: ${r.winRatePct}`);
  console.log(`Galutinis: $${r.final}  (PnL ${r.pnlPct}%)`);
  if (r.skipped > 0) console.log(`! ${r.skipped} sandoriai per maži tavo sumai. Demo be grindu: config simMinTradeUsd = 0.`);
}

async function paper() {
  const subs = CFG.paperSubscriptions || [];
  if (!subs.length) { console.log('Pridek i config: "paperSubscriptions": [{ "id":"t1","wallet":"ADRESAS","amount":1000 }]'); return; }
  const state = loadJson(PAPER_FILE, {});
  for (const s of subs) {
    const id = s.id || s.wallet;
    const { positions } = await closedPositions(s.wallet);
    const r = simProportional(positions, s.amount);
    state[id] = { wallet: s.wallet, amount: s.amount, updatedAt: new Date().toISOString(), ...r };
    console.log(`FORWARD PAPER ${id}: $${s.amount} -> $${r.final} (${r.pnlPct}%) | kopijuota ${r.copied}, praleista ${r.skipped}`);
  }
  saveJson(PAPER_FILE, state);
  console.log(`Issaugota: ${PAPER_FILE}`);
}

const [mode, a, b] = process.argv.slice(2);
if (mode === "backtest") backtest(a, Number(b || 1000)).catch(console.error);
else if (mode === "paper") paper().catch(console.error);
else {
  console.log("Naudojimas:");
  console.log("  node simulate.js backtest <wallet> <suma>   # HISTORY TESTING");
  console.log("  node simulate.js paper                       # FORWARD PAPER TRADING");
}
