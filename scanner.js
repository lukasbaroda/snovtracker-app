// Solana Copytrade — Etapas 0 skeneris (read-only)
// Kaupia treiderius, ima ju istorija, reitinguoja pagal PROPORCINGA simuliacija.
// Prie kiekvieno: recommendedMinUsd ir tiers (rezultatai ant $100/$500/$1000).
//
// Paleidimas:  node scanner.js   (Node 18+, zero-dep)

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CFG = JSON.parse(fs.readFileSync(path.join(__dirname, "config.json"), "utf8"));
const TRADES_FILE = path.join(__dirname, "trades.json");
const RANK_FILE = path.join(__dirname, "ranking.json");
const WALLETS_FILE = path.join(__dirname, "wallets.json");
const PAPER_FILE = path.join(__dirname, "paper.json");
const SEEDS_FILE = path.join(__dirname, "seeds.txt");

const SOL_MINT = "So11111111111111111111111111111111111111112";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const USDT_MINT = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";

const MIN_CLOSED = CFG.minClosed ?? 3;
const MIN_PEAK = CFG.minVolumeUsd ?? 100;
const HISTORY_PAGES = CFG.historyPages ?? 3;
const DISCOVERY_PAGES = CFG.discoveryPages ?? 2;
const MIN_POS_USD = CFG.simMinPositionUsd ?? 20;
const MAX_MULT = CFG.simMaxMultiple ?? 50;
const FEE_PCT = CFG.simFeePct ?? 0.5;
const MIN_TRADE = CFG.simMinTradeUsd ?? 5;
const MAX_WALLETS = CFG.maxWallets ?? 200;
const DISCOVERY_MIN_SWAP = CFG.discoveryMinSwapUsd ?? 50; // tik prasmingo dydzio swap'ai (filtruoja botus)
const TIERS = CFG.simTiers ?? [100, 500, 1000];
const SIM_WINDOWS = CFG.simWindowsDays ?? [30, 60, 90];

const loadJson = (f, def) => (fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : def);
// seeds.txt: wallet adresai (po viena eiluteje, arba CSV su adresu pirmoje vietoje).
// Ne-adresu eilutes (komentarai su #, ir t.t.) ignoruojamos.
function loadSeeds() {
  if (!fs.existsSync(SEEDS_FILE)) return [];
  const out = [];
  for (const line of fs.readFileSync(SEEDS_FILE, "utf8").split(/\r?\n/)) {
    const tok = (line.trim().split(/[,;\s]+/)[0] || "");
    if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(tok)) out.push(tok);
  }
  return out;
}
const saveJson = (f, o) => fs.writeFileSync(f, JSON.stringify(o, null, 2));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getSolPrice() {
  try {
    const r = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd");
    const j = await r.json();
    const p = Number(j && j.solana && j.solana.usd);
    if (p > 0) return p;
  } catch (e) {}
  console.warn("  ! SOL kainos fetch nepavyko, fallback:", CFG.solPriceFallback);
  return CFG.solPriceFallback || 150;
}

async function fetchSwaps(address, pages) {
  let all = [], before = null;
  for (let p = 0; p < (pages || 1); p++) {
    let url = `https://api.helius.xyz/v0/addresses/${address}/transactions`
      + `?api-key=${CFG.heliusApiKey}&type=SWAP&limit=100`;
    if (before) url += `&before=${before}`;
    const r = await fetch(url);
    if (!r.ok) { console.warn(`  ! ${address.slice(0, 6)} HTTP ${r.status}`); break; }
    const batch = await r.json();
    if (!batch.length) break;
    all = all.concat(batch);
    before = batch[batch.length - 1].signature;
    if (batch.length < 100) break;
    await sleep(120);
  }
  return all;
}

function parseSwap(tx, wallet, solPrice) {
  const sw = tx && tx.events && tx.events.swap;
  if (!sw) return null;
  let spentUsd = 0, recvUsd = 0, tokenMint = null, side = null;
  const nIn = sw.nativeInput && Number(sw.nativeInput.amount) / 1e9;
  const nOut = sw.nativeOutput && Number(sw.nativeOutput.amount) / 1e9;
  if (nIn) spentUsd += nIn * solPrice;
  if (nOut) recvUsd += nOut * solPrice;
  const money = (m, amt) => (m === USDC_MINT || m === USDT_MINT) ? amt : (m === SOL_MINT ? amt * solPrice : null);
  for (const ti of sw.tokenInputs || []) {
    const amt = Number(ti.rawTokenAmount.tokenAmount) / 10 ** ti.rawTokenAmount.decimals;
    const u = money(ti.mint, amt);
    if (u !== null) spentUsd += u; else { tokenMint = ti.mint; side = "SELL"; }
  }
  for (const to of sw.tokenOutputs || []) {
    const amt = Number(to.rawTokenAmount.tokenAmount) / 10 ** to.rawTokenAmount.decimals;
    const u = money(to.mint, amt);
    if (u !== null) recvUsd += u; else { tokenMint = to.mint; side = "BUY"; }
  }
  if (!tokenMint || !side) return null;
  if (CFG.whitelistMints && Object.keys(CFG.whitelistMints).length
      && !CFG.whitelistMints[tokenMint]) return null;
  return {
    sig: tx.signature, ts: tx.timestamp, wallet, side, mint: tokenMint,
    spentUsd: Math.round(spentUsd * 100) / 100, recvUsd: Math.round(recvUsd * 100) / 100,
  };
}

function peakConcurrent(positions) {
  const ev = [];
  for (const p of positions) { ev.push([p.firstBuyTs, p.cost]); ev.push([p.lastSellTs, -p.cost]); }
  ev.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let cur = 0, peak = 0;
  for (const e of ev) { cur += e[1]; if (cur > peak) peak = cur; }
  return peak;
}

// Grazos kreive prie $amount (chronologiskai pagal uzdarymo data).
function curveAt(positions, peak, amount) {
  const ratio = peak > 0 ? amount / peak : 0;
  let b = amount;
  const pts = [{ ts: positions.length ? positions[0].firstBuyTs : 0, bankroll: Math.round(b) }];
  for (const p of positions) {
    const c = p.cost * ratio;
    if (c < MIN_TRADE) continue;
    b += c * (p.multiple * (1 - FEE_PCT / 100) - 1);
    pts.push({ ts: p.lastSellTs, mint: p.mint, mult: Math.round(p.multiple * 100) / 100, bankroll: Math.round(b) });
  }
  return pts;
}

// Proporcinis rezultatas prie sumos `amount` (su grindimis MIN_TRADE).
function simAt(positions, peak, amount) {
  const ratio = peak > 0 ? amount / peak : 0;
  let final = amount, copied = 0, skipped = 0;
  for (const p of positions) {
    const c = p.cost * ratio;
    if (c < MIN_TRADE) { skipped++; continue; }
    final += c * (p.multiple * (1 - FEE_PCT / 100) - 1);
    copied++;
  }
  return {
    amount, finalUsd: Math.round(final * 100) / 100,
    pnlPct: Math.round((final / amount - 1) * 1000) / 10,
    copied, skipped,
    coveragePct: positions.length ? Math.round((copied / positions.length) * 1000) / 10 : 0,
  };
}

// Maziausia suma, kad kopijuotum ~90% poziciju (likusios 10% maziausiu gali iskristi).
function recommendedMin(positions, peak) {
  if (!positions.length || peak <= 0) return 0;
  const costs = positions.map((p) => p.cost).sort((a, b) => a - b);
  const idx = Math.floor(0.1 * costs.length);
  const threshold = costs[Math.min(idx, costs.length - 1)];
  if (threshold <= 0) return 0;
  return Math.ceil((MIN_TRADE * peak / threshold) / 10) * 10;
}

function computeRanking(trades) {
  const byWallet = {};
  for (const t of trades) {
    const w = (byWallet[t.wallet] ||= { wallet: t.wallet, tokens: {}, nTrades: 0 });
    w.nTrades++;
    const tok = (w.tokens[t.mint] ||= { mint: t.mint, cost: 0, proceeds: 0, firstBuyTs: Infinity, lastSellTs: 0 });
    if (t.side === "BUY") { tok.cost += t.spentUsd; if (t.ts < tok.firstBuyTs) tok.firstBuyTs = t.ts; }
    else { tok.proceeds += t.recvUsd; if (t.ts > tok.lastSellTs) tok.lastSellTs = t.ts; }
  }
  const nowSec = Math.floor(Date.now() / 1000);
  const rows = Object.values(byWallet).map((w) => {
    const pos = Object.values(w.tokens)
      .filter((tk) => tk.cost >= MIN_POS_USD && tk.proceeds > 0 && (tk.proceeds / tk.cost) <= MAX_MULT && tk.firstBuyTs < Infinity)
      .map((tk) => ({ mint: tk.mint, multiple: tk.proceeds / tk.cost, cost: tk.cost, proceeds: tk.proceeds, firstBuyTs: tk.firstBuyTs, lastSellTs: tk.lastSellTs }))
      .sort((a, b) => a.lastSellTs - b.lastSellTs);
    let rCost = 0, rProc = 0, wins = 0;
    for (const p of pos) { rCost += p.cost; rProc += p.proceeds; if (p.multiple > 1) wins++; }
    const peak = peakConcurrent(pos);
    const tiers = TIERS.map((a) => simAt(pos, peak, a));
    const main = tiers.find((t) => t.amount === 1000) || tiers[tiers.length - 1] || { pnlPct: 0, finalUsd: 0 };
    // Laiko langai (pagal uzdarymo data) — nuoseklumui
    const windows = SIM_WINDOWS.map((d) => {
      const wp = pos.filter((p) => p.lastSellTs >= nowSec - d * 86400);
      const wpeak = peakConcurrent(wp);
      const s = simAt(wp, wpeak, 1000);
      return { days: d, closed: wp.length, pnlPct: s.pnlPct, finalUsd: s.finalUsd };
    });
    return {
      wallet: w.wallet, nTrades: w.nTrades, closed: pos.length,
      peakUsd: Math.round(peak),
      roiPct: rCost > 0 ? Math.round(((rProc - rCost) / rCost) * 1000) / 10 : 0,
      winRatePct: pos.length ? Math.round((wins / pos.length) * 1000) / 10 : 0,
      recommendedMinUsd: recommendedMin(pos, peak),
      simPnlPct: main.pnlPct,
      tiers, windows,
      curve: curveAt(pos, peak, 1000),
    };
  });
  return rows
    .filter((r) => r.closed >= MIN_CLOSED && r.peakUsd >= MIN_PEAK)
    .sort((a, b) => b.simPnlPct - a.simPnlPct);
}

// Demo (paper) trading: sekti wallet'a su suma per slanku langa (days), proporcingai.
function paperResult(trades, wallet, amount, days) {
  const sinceTs = Math.floor(Date.now() / 1000) - (days || 30) * 86400;
  const toks = {};
  for (const t of trades) {
    if (t.wallet !== wallet) continue;
    const tk = (toks[t.mint] ||= { cost: 0, proceeds: 0, firstBuyTs: Infinity, lastSellTs: 0 });
    if (t.side === "BUY") { tk.cost += t.spentUsd; if (t.ts < tk.firstBuyTs) tk.firstBuyTs = t.ts; }
    else { tk.proceeds += t.recvUsd; if (t.ts > tk.lastSellTs) tk.lastSellTs = t.ts; }
  }
  const pos = Object.values(toks)
    .filter((tk) => tk.cost >= MIN_POS_USD && tk.proceeds > 0 && (tk.proceeds / tk.cost) <= MAX_MULT && tk.lastSellTs >= sinceTs && tk.firstBuyTs < Infinity)
    .map((tk) => ({ multiple: tk.proceeds / tk.cost, cost: tk.cost, firstBuyTs: tk.firstBuyTs, lastSellTs: tk.lastSellTs }));
  const peak = peakConcurrent(pos);
  const r = simAt(pos, peak, amount);
  return { wallet, amount, days: days || 30, positions: pos.length, finalUsd: r.finalUsd, pnlPct: r.pnlPct, copied: r.copied, skipped: r.skipped };
}
function updatePaper(store) {
  const subs = CFG.paperSubscriptions || [];
  if (!subs.length) return;
  const trades = Object.values(store);
  const portfolios = subs.map((s) => ({ id: s.id || s.wallet, ...paperResult(trades, s.wallet, s.amount, s.days) }));
  saveJson(PAPER_FILE, { generatedAt: new Date().toISOString(), portfolios });
  console.log(`Demo portfeliai atnaujinti: ${subs.length}`);
}

async function run() {
  console.log(`\n=== Skeneris paleistas ${new Date().toISOString()} ===`);
  if (!CFG.heliusApiKey || CFG.heliusApiKey.indexOf("YOUR_") === 0) {
    console.error("! Irasyk Helius API rakta i config.json."); return;
  }
  const solPrice = await getSolPrice();
  console.log(`SOL kaina: $${solPrice} | tiers: $${TIERS.join("/$")} | filtrai: closed>=${MIN_CLOSED}, peak>=$${MIN_PEAK}`);

  const watch = new Set(loadJson(WALLETS_FILE, []));
  for (const w of CFG.wallets || []) watch.add(w);
  for (const t of Object.values(loadJson(TRADES_FILE, {}))) watch.add(t.wallet);
  const rk = loadJson(RANK_FILE, null);
  if (rk && rk.ranking) for (const r of rk.ranking) watch.add(r.wallet);
  const seeds = loadSeeds();
  for (const s of seeds) watch.add(s);
  if (seeds.length) console.log(`  seeds.txt: ${seeds.length} adresu`);
  const before = watch.size;

  for (const mint of CFG.discoverFromTokens || []) {
    const swaps = await fetchSwaps(mint, DISCOVERY_PAGES);
    let kept = 0;
    for (const tx of swaps) {
      if (!tx.feePayer) continue;
      const p = parseSwap(tx, tx.feePayer, solPrice);
      const size = p ? Math.max(p.spentUsd, p.recvUsd) : 0;
      if (size >= DISCOVERY_MIN_SWAP && !watch.has(tx.feePayer)) { watch.add(tx.feePayer); kept++; }
    }
    console.log(`  token ${mint.slice(0, 6)}: ${swaps.length} swapu, +${kept} kandidatu (>=$${DISCOVERY_MIN_SWAP})`);
    await sleep(120);
  }
  saveJson(WALLETS_FILE, Array.from(watch));

  let wallets = Array.from(watch);
  const capped = wallets.length > MAX_WALLETS;
  if (capped) wallets = wallets.slice(0, MAX_WALLETS);
  console.log(`  -> watchlist: ${watch.size} (+${watch.size - before})${capped ? `, skenuojam ${MAX_WALLETS}` : ""}. Imam istorija...`);

  const store = {};
  let i = 0;
  for (const wallet of wallets) {
    const swaps = await fetchSwaps(wallet, HISTORY_PAGES);
    for (const tx of swaps) {
      const p = parseSwap(tx, wallet, solPrice);
      if (p) store[p.sig] = p;
    }
    if (++i % 10 === 0) console.log(`     apdorota ${i}/${wallets.length}`);
    await sleep(120);
  }

  saveJson(TRADES_FILE, store);
  const ranking = computeRanking(Object.values(store));
  saveJson(RANK_FILE, { generatedAt: new Date().toISOString(), solPrice, model: "proportional", tiers: TIERS, ranking });
  updatePaper(store);

  console.log(`\nSandoriu: ${Object.keys(store).length}. Treideriu po filtru: ${ranking.length}`);
  console.log("\n--- TOP treideriai (sim $1000) ---");
  console.log("rank  wallet      closed  win%   $1000->    30d%    90d%    rekMin$");
  ranking.slice(0, 25).forEach((r, idx) => {
    const t1k = r.tiers.find((t) => t.amount === 1000) || {};
    const w30 = r.windows.find((w) => w.days === 30) || {};
    const w90 = r.windows.find((w) => w.days === 90) || {};
    console.log(
      String(idx + 1).padEnd(5),
      r.wallet.slice(0, 8).padEnd(12),
      String(r.closed).padEnd(7),
      String(r.winRatePct).padEnd(6),
      ("$" + (t1k.finalUsd ?? 0)).padEnd(10),
      String(w30.pnlPct ?? 0).padEnd(7),
      String(w90.pnlPct ?? 0).padEnd(7),
      "$" + r.recommendedMinUsd
    );
  });
  console.log(`\nReitingas issaugotas: ${RANK_FILE} (su tiers $${TIERS.join("/$")} ir rekomenduojama min. suma)`);
}

if (CFG.pollIntervalSec > 0) {
  const loop = async () => { try { await run(); } catch (e) { console.error(e); } setTimeout(loop, CFG.pollIntervalSec * 1000); };
  loop();
} else {
  run().catch(console.error);
}
