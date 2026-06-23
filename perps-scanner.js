// Solana Copytrade — v2 BLUE-CHIP skeneris (SOL/BTC/ETH) per Jupiter Perps API.
// LOGISKAS modelis: graza = realus pelnas / ideto collateral (be sverto kompaundavimo).
//   Adresai: seeds.txt (perps treideriai) + config.wallets + auto-discovery (Perps programa).
// Paleidimas:  node perps-scanner.js   (Node 18+, zero-dep)

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(__dirname, "data"); try { fs.mkdirSync(DATA, { recursive: true }); } catch (e) {}
const CFG = JSON.parse(fs.readFileSync(path.join(__dirname, "config.json"), "utf8"));
const RANK_FILE = path.join(DATA, "ranking.json");
const SEEDS_FILE = path.join(__dirname, CFG.seedsFile || "seeds.txt");
const WALLETS_FILE = path.join(DATA, "perps-wallets.json");
const TIER_FILE = path.join(DATA, "perps-tiers.json"); // { wallet: { tier, nextScanAt } }
const OVERRIDES_FILE = path.join(DATA, "overrides.json"); // rankiniai: { blacklist:[], whitelist:[], forceTier:{} }
const HIST_DIR = path.join(DATA, "history"); // pilna kiekvieno treiderio istorija (kad dashboard'ui nereiktu Jupiter API)
if (!fs.existsSync(HIST_DIR)) fs.mkdirSync(HIST_DIR);
const FWD_FILE = path.join(DATA, "forward.json"); // { wallet: startTs } - kada paleidom $1000 demo
const FWD_USD = CFG.forwardStartUsd ?? 1000;
const FWD_SEED_DAYS = CFG.forwardSeedDays ?? 0;
const FWD_BURN = CFG.forwardBurnUsd ?? 50;
const LOG_FILE = path.join(DATA, "scanner.log");      // visi logai (admin "Logai")
const SCAN_STATUS = path.join(DATA, "scan-status.json"); // ar dirba dabar + progresas
try { if (fs.existsSync(LOG_FILE) && fs.statSync(LOG_FILE).size > 5e6) fs.writeFileSync(LOG_FILE, ""); } catch (e) {}
const _log = console.log.bind(console);
console.log = (...a) => { _log(...a); try { fs.appendFileSync(LOG_FILE, new Date().toISOString().slice(11, 19) + " " + a.join(" ") + "\n"); } catch (e) {} };
const setScan = (o) => { try { fs.writeFileSync(SCAN_STATUS, JSON.stringify(o)); } catch (e) {} };
const ACTIVE_DAYS = CFG.tierActiveDays ?? 14;   // aktyvus jei treidino per tiek dienu
const DAY = 86400;

const PERPS_API = "https://perps-api.jup.ag/v2";
const PERPS_PROGRAM = "PERPHjGBqRHArX4DySjwM6UJHiR3sWAatqfdBS2qQJu";
const ASSET_BY_MINT = {
  "So11111111111111111111111111111111111111112": "SOL",
  "3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh": "BTC",
  "7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs": "ETH",
};

const MIN_CLOSED = CFG.minClosed ?? 3;
const SIM_AMOUNT = CFG.simAmount ?? 1000;
const TIERS = CFG.simTiers ?? [100, 500, 1000];
const SIM_WINDOWS = CFG.simWindowsDays ?? [30, 60, 90];
const MAX_WALLETS = CFG.maxWallets ?? 300;
const DRAIN_MS = (CFG.drainSec ?? 90) * 1000;
const DRAIN_MIN = CFG.drainThreshold ?? 400; // drenuojam greitai tik jei liko daugiau nei tiek (kad nesisuktų amžinai) // jei eileje liko virs limito, sekantis skenas po tiek (greitas drenavimas)
const MIN_CAPITAL = CFG.minVolumeUsd ?? 100; // min ideto collateral (pasitikejimo filtras)

const loadJson = (f, def) => (fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : def);
const saveJson = (f, o) => { const tmp = f + ".tmp"; fs.writeFileSync(tmp, JSON.stringify(o, null, 2)); fs.renameSync(tmp, f); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const num = (x) => { const n = Number(x); return isFinite(n) ? n : 0; };

function loadSeeds() {
  if (!fs.existsSync(SEEDS_FILE)) return [];
  const out = [];
  for (const line of fs.readFileSync(SEEDS_FILE, "utf8").split(/\r?\n/)) {
    const tok = (line.trim().split(/[,;\s]+/)[0] || "");
    if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(tok)) out.push(tok);
  }
  return out;
}

async function perpsTrades(wallet) {
  const headers = { "x-client-platform": "solcopytrade" };
  if (CFG.jupiterApiKey) headers["x-api-key"] = CFG.jupiterApiKey;
  const pageSize = CFG.perpsPageSize ?? 500;
  const maxTrades = CFG.perpsMaxTrades ?? 5000;
  let all = [], start = 0, count = 0, failed = false;
  for (let p = 0; p < 60; p++) {
    let r;
    try { r = await fetch(`${PERPS_API}/trades?walletAddress=${wallet}&start=${start}&end=${start + pageSize}`, { headers, signal: AbortSignal.timeout(15000) }); }
    catch (e) { if (p === 0) { failed = true; console.warn(`  ! ${wallet.slice(0, 6)} fetch klaida/timeout`); } break; }
    if (!r.ok) { if (p === 0) { failed = true; console.warn(`  ! ${wallet.slice(0, 6)} HTTP ${r.status}`); } break; }
    const j = await r.json();
    count = j.count || count;
    const list = (j && j.dataList) || [];
    if (!list.length) break;                      // tikrai nebera
    all = all.concat(list);
    start += list.length;                         // einam pagal tai, kiek realiai gavom (kintamas puslapio dydis)
    if (all.length >= Math.min(count || all.length, maxTrades)) break;
    await sleep(120);
  }
  return { trades: all, count, ok: !failed }; // ok=false tik jei PIRMAS puslapis nepavyko (API klaida)
}

// Is raw sandoriu: ideto collateral (Increase) ir uzdaryti sandoriai su pnl (Decrease).
function walletData(rawTrades) {
  let openCollateral = 0, openFees = 0, totalFees = 0;
  const closed = [], history = [];
  // Visi ivykiai su info, chronologiskai (reikia likuciui sekti)
  const evs = rawTrades.map((t) => {
    let ts = num(t.createdTime); if (ts > 1e12) ts = Math.floor(ts / 1000);
    return {
      ts, pk: t.positionPubkey, action: t.action,
      coll: Math.abs(num(t.collateralUsdDelta)), size: num(t.size),
      asset: ASSET_BY_MINT[t.mint] || (t.mint || "?").slice(0, 4), side: t.side,
      price: num(t.price), fee: num(t.fee) + num(t.borrowFee),
      pnl: t.pnl != null ? num(t.pnl) : null, pnlPct: num(t.pnlPercentage),
    };
  }).sort((a, b) => a.ts - b.ts);

  // Vienas chronologinis perejimas: peak + veiksmo tipas + uzdaryti + istorija.
  // Pozicija uzdaryta kai likutis (atidaryta size - uzdaryta size) ~= 0.
  const pos = {}, episodes = []; let openTotal = 0, peakCollateral = 0, capitalDeployed = 0, totalSize = 0;
  for (const e of evs) {
    totalFees += e.fee;
    let label;
    if (e.action === "Increase") {
      openCollateral += e.coll; openFees += e.fee; totalSize += e.size;
      const existed = pos[e.pk] && pos[e.pk].rem > 1;
      if (!pos[e.pk]) pos[e.pk] = { coll: 0, rem: 0, epPeak: 0, epPnl: 0, epFee: 0, asset: e.asset, side: e.side, startTs: e.ts };
      pos[e.pk].coll += e.coll; pos[e.pk].rem += e.size; pos[e.pk].epFee += e.fee;
      if (pos[e.pk].coll > pos[e.pk].epPeak) pos[e.pk].epPeak = pos[e.pk].coll; // sio epizodo peak
      openTotal += e.coll; if (openTotal > peakCollateral) peakCollateral = openTotal;
      label = e.size <= 0 ? "addMargin" : (existed ? "add" : "open");
    } else { // Decrease
      if (pos[e.pk]) {
        pos[e.pk].epFee += e.fee; if (e.pnl != null) pos[e.pk].epPnl += e.pnl;
        const collOut = Math.max(0, e.coll - (e.pnl || 0)); // atgautas collateral (be pnl)
        pos[e.pk].coll -= collOut; openTotal -= collOut; if (openTotal < 0) openTotal = 0;
        pos[e.pk].rem -= e.size;
        if (pos[e.pk].rem <= 1) {
          openTotal -= Math.max(0, pos[e.pk].coll); capitalDeployed += pos[e.pk].epPeak;
          episodes.push({ ts: e.ts, openTs: pos[e.pk].startTs, asset: pos[e.pk].asset, side: pos[e.pk].side, pnlUsd: pos[e.pk].epPnl - pos[e.pk].epFee, peak: pos[e.pk].epPeak });
          delete pos[e.pk]; if (openTotal < 0) openTotal = 0; label = "close";
        } else label = "reduce";
      } else label = "close";
      if (e.pnl != null) closed.push({ ts: e.ts, pk: e.pk, asset: e.asset, side: e.side, pnlUsd: e.pnl - e.fee, pnlGross: e.pnl, feeUsd: e.fee, pnlPct: e.pnlPct, full: label === "close" });
    }
    history.push({
      ts: e.ts, asset: e.asset, action: label, side: e.side,
      priceUsd: Math.round(e.price * 100) / 100, sizeUsd: Math.round(e.size),
      collUsd: Math.round(e.coll), lev: (e.action === "Increase" && e.coll > 0 && e.size > 0 ? Math.round(e.size / e.coll * 100) / 100 : null),
      feeUsd: Math.round(e.fee * 100) / 100,
      pnlUsd: e.pnl != null ? Math.round((e.pnl - e.fee) * 100) / 100 : null,
    });
  }
  for (const k in pos) capitalDeployed += pos[k].epPeak; // dar atviros pozicijos
  closed.sort((a, b) => a.ts - b.ts);
  history.sort((a, b) => b.ts - a.ts);
  const avgLev = openCollateral > 0 ? Math.round((totalSize / openCollateral) * 100) / 100 : 0;
  const firstTs = evs.length ? evs[0].ts : 0, lastTs = evs.length ? evs[evs.length - 1].ts : 0;
  const activeDays = new Set(evs.map((e) => Math.floor(e.ts / 86400))).size; // skirtingu dienu su sandoriais
  return { openCollateral, peakCollateral, capitalDeployed, avgLev, firstTs, lastTs, activeDays, closed, episodes, history, openFees, totalFees, evs };
}

// LINIJINIS sim: graza = realizedPnL / ideto collateral. $amount -> amount*(1+graza). Be kompaundavimo.
function sim(closed, openCollateral, amount, openFees = 0) {
  // closed.pnlUsd jau neto close/borrow fees; atimam dar atidarymo fees
  const realized = closed.reduce((s, t) => s + t.pnlUsd, 0) - openFees;
  const base = openCollateral > 0 ? openCollateral : amount;
  const ratio = amount / base;
  let cum = 0;
  const curve = [{ ts: closed.length ? closed[0].ts : 0, bankroll: Math.round(amount) }];
  for (const t of closed) {
    cum += t.pnlUsd;
    curve.push({ ts: t.ts, mint: t.asset, mult: Math.round((1 + t.pnlPct / 100) * 1000) / 1000, bankroll: Math.round((amount + cum * ratio) * 100) / 100 });
  }
  return {
    finalUsd: Math.round((amount + realized * ratio) * 100) / 100,
    pnlPct: Math.round((realized / base) * 1000) / 10,
    realized: Math.round(realized * 100) / 100, curve,
  };
}

// sumazina kreive iki ~n tasku (sparkline kortelei; pilna istorija - per /api/history)
function downsample(arr, n) {
  if (!arr || arr.length <= n) return (arr || []).map((p) => ({ ts: p.ts, bankroll: p.bankroll }));
  const out = [], step = (arr.length - 1) / (n - 1);
  for (let i = 0; i < n; i++) { const p = arr[Math.round(i * step)]; out.push({ ts: p.ts, bankroll: p.bankroll }); }
  return out;
}

// FORWARD demo: $startUsd kompaundinamas pagal epizodus (round-trip) PO startTs.
// Pozicijos svoris = epizodo peak / treiderio peak (kiek didele pozicija jo masteliu). Gali sudegti.
// FORWARD demo nuo startTs: kopijuojam TIK pozicijas, atidarytas PO startTs (kaip realiai sektum nuo tada).
// Mastelis S = $startUsd / treiderio peak. Kiekvieno sandorio demo dydis/pnl perskaiciuotas i $startUsd.
// log[] -> lentelei (dydziai/pnl jau tavo $1000 terminais, susumuoja iki gražos).
function forwardSim(evs, startTs, traderPeak, startUsd) {
  const S = traderPeak > 0 ? startUsd / traderPeak : 0;
  let bank = startUsd, realized = 0, n = 0;
  const curve = [{ ts: startTs, bankroll: startUsd }], log = [], rem = {};
  for (const e of evs) {
    if (e.ts < startTs) continue; // viskas nuo sekimo pradzios
    const sizeD = e.size * S, collD = e.coll * S;
    if (e.action === "Increase") {
      const had = rem[e.pk] > 1; rem[e.pk] = (rem[e.pk] || 0) + e.size;
      log.push({ ts: e.ts, asset: e.asset, side: e.side, action: e.size <= 0 ? "addMargin" : (had ? "add" : "open"), priceUsd: Math.round(e.price * 100) / 100, sizeUsd: Math.round(sizeD), collUsd: Math.round(collD), lev: (e.coll > 0 && e.size > 0 ? Math.round(e.size / e.coll * 100) / 100 : null), pnlUsd: null });
    } else {
      rem[e.pk] = (rem[e.pk] || 0) - e.size;
      const dPnl = e.pnl != null ? (e.pnl - e.fee) * S : 0;
      realized += dPnl; bank = startUsd + realized; if (e.pnl != null) n++;
      curve.push({ ts: e.ts, bankroll: Math.round(bank * 100) / 100 });
      log.push({ ts: e.ts, asset: e.asset, side: e.side, action: rem[e.pk] <= 1 ? "close" : "reduce", priceUsd: Math.round(e.price * 100) / 100, sizeUsd: Math.round(sizeD), collUsd: Math.round(collD), lev: null, pnlUsd: Math.round(dPnl * 100) / 100 });
    }
  }
  return { equity: Math.round(bank * 100) / 100, realized: Math.round(realized * 100) / 100, nEp: n, curve, log: log.reverse().slice(0, 120) };
}

async function discoverPerpsTraders(pages) {
  if (!CFG.heliusApiKey || String(CFG.heliusApiKey).indexOf("YOUR_") === 0) return [];
  const found = new Set();
  let before = null;
  for (let p = 0; p < (pages || 3); p++) {
    let url = `https://api.helius.xyz/v0/addresses/${PERPS_PROGRAM}/transactions?api-key=${CFG.heliusApiKey}&limit=100`;
    if (before) url += `&before=${before}`;
    const r = await fetch(url);
    if (!r.ok) { console.warn(`  ! discovery HTTP ${r.status}`); break; }
    const batch = await r.json();
    if (!batch.length) break;
    for (const tx of batch) if (tx.feePayer) found.add(tx.feePayer);
    before = batch[batch.length - 1].signature;
    if (batch.length < 100) break;
    await sleep(150);
  }
  return Array.from(found);
}

// --- BALANSO SKAITYTUVAS (Helius) — jo realus equity sizingui ---
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const HELIUS_RPC = () => `https://mainnet.helius-rpc.com/?api-key=${CFG.heliusApiKey}`;
let SOL_PRICE = CFG.solPriceFallback || 150;
async function fetchSolPrice() {
  try {
    const r = await fetch(`${PERPS_API}/market-stats?mint=So11111111111111111111111111111111111111112`, { signal: AbortSignal.timeout(8000) });
    if (r.ok) { const j = await r.json(); const p = num(j.price || j.markPrice || (j.data && j.data.price)); if (p > 0) { SOL_PRICE = p; return; } }
  } catch (e) {}
  // atsarginis: paskutine SOL kaina is bet kurio nuskenuoto sandorio (nustatoma run() metu)
}
async function rpc(method, params) {
  const r = await fetch(HELIUS_RPC(), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: AbortSignal.timeout(12000) });
  const j = await r.json(); return j.result;
}
// jo realus balansas USD: idle SOL + USDC + atviru perp poziciju collateral + nerealizuotas
async function walletEquity(wallet) {
  try {
    let sol = 0, usdc = 0, perp = 0;
    try { const b = await rpc("getBalance", [wallet]); sol = (b && b.value ? b.value : 0) / 1e9; } catch (e) {}
    try {
      const ta = await rpc("getTokenAccountsByOwner", [wallet, { mint: USDC_MINT }, { encoding: "jsonParsed" }]);
      for (const a of (ta && ta.value ? ta.value : [])) usdc += num(a.account.data.parsed.info.tokenAmount.uiAmount);
    } catch (e) {}
    try {
      const pr = await fetch(`${PERPS_API}/positions?walletAddress=${wallet}`, { signal: AbortSignal.timeout(10000) });
      if (pr.ok) { const pj = await pr.json(); for (const p of (pj.dataList || pj.positions || [])) perp += (num(p.collateralUsd) + num(p.pnlAfterFeesUsd)) / 1e6; } // positions endpoint: USD x1e6
    } catch (e) {}
    const eq = sol * SOL_PRICE + usdc + perp;
    return eq > 0 ? Math.round(eq) : 0;
  } catch (e) { return 0; }
}

async function run() {
  console.log(`\n=== Perps skeneris (BLUE-CHIP SOL/BTC/ETH) ${new Date().toISOString()} ===`);
  const watch = new Set(loadJson(WALLETS_FILE, []));
  for (const w of CFG.wallets || []) watch.add(w);
  for (const s of loadSeeds()) watch.add(s);
  const before = watch.size;
  const disc = (CFG.discoveryPages > 0) ? await discoverPerpsTraders(CFG.discoveryPages) : [];
  for (const d of disc) watch.add(d);
  if (disc.length) console.log(`  Perps programa: +${watch.size - before} nauju (viso ${watch.size})`);
  // rankiniai valdikliai (is admin panelės)
  const ov = loadJson(OVERRIDES_FILE, {});
  const blacklist = new Set(ov.blacklist || []);
  const whitelist = new Set(ov.whitelist || []);
  const forceTier = ov.forceTier || {};
  for (const w of whitelist) watch.add(w); // whitelist visada stebim
  saveJson(WALLETS_FILE, Array.from(watch));
  const nowSec = Math.floor(Date.now() / 1000);
  // Tier'ai: A=kas karta, B=kas diena, C=kas savaite. Skenuojam tik tuos, kuriu laikas atejo.
  const tierState = loadJson(TIER_FILE, {});
  const fwd = loadJson(FWD_FILE, {}); // { wallet: startTs } - $1000 demo paleidimo laikas
  // cache: paskutiniai zinomi eilucu duomenys (kad neskenuoti A/B kiekviena karta)
  const cache = {};
  for (const r of (loadJson(RANK_FILE, { ranking: [] }).ranking || [])) cache[r.wallet] = r;
  let wallets = Array.from(watch).filter((w) => {
    if (blacklist.has(w)) return false;                 // blacklist -> niekada neskenuojam
    if (whitelist.has(w)) return true;                  // whitelist -> visada
    const t = tierState[w]; return !t || (t.nextScanAt || 0) <= nowSec;
  });
  // prioritetas: nauji (dar neskenuoti) + Tier A pirmi, C paskutiniai
  const prio = (w) => { const t = tierState[w]; if (!t) return 0; return t.tier === "A" ? 1 : t.tier === "B" ? 2 : 3; };
  wallets.sort((a, b) => prio(a) - prio(b));
  const dueCount = wallets.length;
  if (wallets.length > MAX_WALLETS) wallets = wallets.slice(0, MAX_WALLETS);
  const leftover = Math.max(0, dueCount - wallets.length); // liko eileje (virs limito) -> drenuojam greitai
  for (const w of blacklist) { delete cache[w]; delete tierState[w]; } // pasalinam is lentos
  console.log(`Stebimu: ${watch.size}. Skenuojam siandien (atejes laikas): ${wallets.length}. Imam Perps istorija...`);
  setScan({ running: true, startedAt: Date.now(), progress: 0, total: wallets.length, watched: watch.size });

  let i = 0;
  const now = nowSec;
  let skipped = 0;
  for (const wallet of wallets) {
    const { trades: raw, count: apiCount, ok } = await perpsTrades(wallet);
    if (!ok) { skipped++; await sleep(150); continue; } // API klaida -> NEtrinam is lentos, paliekam paskutinius duomenis
    const { openCollateral, peakCollateral, capitalDeployed, avgLev, firstTs, lastTs, activeDays, closed, episodes, history, openFees, evs } = walletData(raw);
    for (const e of evs) if (e.asset === "SOL" && e.price > 0) SOL_PRICE = e.price; // tiksli SOL kaina balanso skaiciavimui
    const base = peakCollateral > 0 ? peakCollateral : openCollateral;
    // uzbaigti round-trip epizodai = tikras sandoriu skaicius (Jupiter pakartoja ta pati pk)
    const nClosed = episodes.length;
    const spanDays = Math.max(1, (lastTs - firstTs) / 86400);
    const tradesPerDay = Math.round((nClosed / spanDays) * 100) / 100;
    // consistency: ar kasdienis pastovus, ar trumpalaike sekme, ar laiko ilgai
    const tradesPerActiveDay = activeDays > 0 ? Math.round((nClosed / activeDays) * 10) / 10 : 0;
    const consistencyPct = Math.min(100, Math.round((activeDays / spanDays) * 100)); // kiek % dienu treidino
    const avgHoldH = nClosed > 0 ? Math.round((episodes.reduce((s, e) => s + Math.max(0, e.ts - (e.openTs || e.ts)), 0) / nClosed) / 3600 * 10) / 10 : 0;
    let profile;
    if (nClosed < 8) profile = "Maža imtis";
    else if (avgHoldH > 72) profile = "Pozicinis";          // laiko ilgai (>3d)
    else if (tradesPerActiveDay >= 3 && consistencyPct >= 40) profile = "Kasdienis"; // 3-5/d, dažnai
    else if (tradesPerActiveDay > 8) profile = "Scalperis";
    else if (consistencyPct < 20) profile = "Proginis";
    else profile = "Mišrus";
    const realizedPnl = closed.reduce((s, t) => s + t.pnlUsd, 0) - openFees; // NETO (po visu mokesciu)
    const daysSince = lastTs > 0 ? (now - lastTs) / DAY : 999;
    let row = null;
    if (nClosed >= MIN_CLOSED && base >= MIN_CAPITAL) {
      const wins = episodes.filter((e) => e.pnlUsd > 0).length;
      const winRatePct = Math.round((wins / nClosed) * 1000) / 10;
      // VISUR ta pati baze = panaudotas kapitalas (logiska, sutampa su returnPct; ne "peak" kuris sprogsta kompaunderiams)
      const simBase = capitalDeployed > 0 ? capitalDeployed : base;
      const main = sim(closed, simBase, SIM_AMOUNT, openFees); // tik kreivei (sparkline)
      const assets = Array.from(new Set(closed.map((t) => t.asset))).join("/");
      // GRAZA: neto pelnas / peak (daugiausiai kapitalo rizikoje vienu metu) -> realu, paprasta, be balanso
      const returnPct = base > 0 ? Math.round((realizedPnl / base) * 1000) / 10 : 0;
      // COPYSCORE: kiek verta kopijuoti = graza x pastovumas x imties dydis x aktyvumas (svertas nebaudziamas)
      const sampleF = Math.min(1, nClosed / 12);
      const winF = winRatePct / 100;
      const activityF = Math.max(0.3, Math.min(1, tradesPerDay / 0.5));
      const copyScore = Math.round(returnPct * winF * sampleF * activityF * 10) / 10;
      row = {
        wallet, apiCount, loaded: raw.length, nTrades: raw.length, closed: nClosed,
        peakUsd: Math.round(base),
        capitalDeployed: Math.round(capitalDeployed),
        returnPct, avgLev, tradesPerDay, copyScore,
        activeDays, tradesPerActiveDay, consistencyPct, avgHoldH, profile,
        deployedTotal: Math.round(openCollateral),
        roiPct: Math.round(realizedPnl * 100) / 100,
        winRatePct,
        recommendedMinUsd: Math.max(25, Math.min(2000, Math.round((10 * base * nClosed / Math.max(1, capitalDeployed)) / 25) * 25)),
        assets,
        curve: downsample(main.curve, 24),
      };
    }
    // TIER pagal aktyvuma (negali kopijuoti nemiegancio) + naudinguma:
    //  A: aktyvus (<=14d) + pelningas + atitinka filtra -> kas karta
    //  C: uzmiges (>45d) -> kas savaite (nerodom lentoj, bet tikrinam ar neatgijo)
    //  B: kita (aktyvus bet neirodes, arba pristabdes 14-45d) -> kas diena
    const prevTier = tierState[wallet] ? tierState[wallet].tier : null;
    let tier, interval;
    if (daysSince <= ACTIVE_DAYS) {                    // aktyvus (<=14d) - dar treidina
      tier = (realizedPnl > 0 && row) ? "A" : "B"; interval = tier === "A" ? 0 : DAY;
    } else if (realizedPnl > 0 && daysSince <= 45) {   // pelningas, tik pristabdes -> sansas
      tier = "B"; interval = DAY;
    } else {                                           // pralosęs+sustojes (>14d) ARBA uzmiges >45d -> mires
      tier = "C"; interval = 7 * DAY;
    }
    if (whitelist.has(wallet) && tier === "C") { tier = "B"; interval = DAY; } // whitelist niekad nemiršta
    if (forceTier[wallet]) { tier = forceTier[wallet]; interval = tier === "A" ? 0 : tier === "B" ? DAY : 7 * DAY; } // rankinis fiksavimas
    const revivedAt = (prevTier === "C" && tier !== "C") ? now : (tierState[wallet] ? tierState[wallet].revivedAt || 0 : 0);
    tierState[wallet] = { tier, nextScanAt: now + interval, net: Math.round(realizedPnl), lastTs, revivedAt };
    if (row) {
      row.tier = tier; row.lastTs = lastTs; row.daysLive = Math.round(spanDays); row.revived = revivedAt > 0 && (now - revivedAt) < 7 * DAY;
      row.simAmount = SIM_AMOUNT;
    }
    // C arba neatitinka filtro -> nerodom leaderboard'e
    if (row && tier !== "C") {
      cache[wallet] = row;
      try { fs.writeFileSync(path.join(HIST_DIR, wallet + ".json"), JSON.stringify(history.slice(0, 1000))); } catch (e) {} // pilna istorija dashboard'ui
    } else delete cache[wallet];
    if (++i % 20 === 0) { console.log(`  apdorota ${i}/${wallets.length}`); setScan({ running: true, startedAt: Date.now(), progress: i, total: wallets.length, watched: watch.size }); }
    await sleep(70);
  }

  // RIKIAVIMAS: forward $1000 demo grąža (gyvas track record); tiebreak - sandoriai, tada balas
  // RIKIAVIMAS: pagal kokybes bala (graza x win x imtis x aktyvumas) -> geriausi visapusiskai virsuje
  const rows = Object.values(cache).sort((a, b) => (b.copyScore || 0) - (a.copyScore || 0));
  saveJson(RANK_FILE, { generatedAt: new Date().toISOString(), source: "jupiter-perps", market: "SOL/BTC/ETH", simAmount: SIM_AMOUNT, tiers: TIERS, ranking: rows });
  saveJson(TIER_FILE, tierState);
  const tc = { A: 0, B: 0, C: 0 }; for (const w in tierState) tc[tierState[w].tier] = (tc[tierState[w].tier] || 0) + 1;
  console.log(`\nTier'ai: A=${tc.A} (kas karta) · B=${tc.B} (kas diena) · C=${tc.C} (kas savaite, mire)`);
  if (typeof skipped !== "undefined" && skipped) console.log(`Praleista del API klaidu: ${skipped}`);
  console.log(`Leaderboard'e: ${rows.length}`);
  console.log("rank  wallet      assets   pelnas$       graza%  dienu  sand.  win%   svertas  balas");
  rows.slice(0, 25).forEach((r, idx) => {
    console.log(
      String(idx + 1).padEnd(5), r.wallet.slice(0, 8).padEnd(12),
      String(r.assets).padEnd(8), ("$" + r.roiPct).padEnd(13),
      String(r.returnPct).padEnd(7), String(r.daysLive).padEnd(6), String(r.closed).padEnd(6),
      String(r.winRatePct).padEnd(6), (r.avgLev + "x").padEnd(8), r.copyScore
    );
  });
  console.log(`\nReitingas issaugotas: ${RANK_FILE}`);
  setScan({ running: false, finishedAt: Date.now(), total: wallets.length, board: rows.length, watched: watch.size, queued: leftover, nextRunMs: leftover > 0 ? DRAIN_MS : (CFG.pollIntervalSec * 1000) });
  if (leftover > 0) console.log(`Liko eileje: ${leftover} -> sekantis skenas po ${DRAIN_MS / 1000}s (drenuojam)`);
  return leftover;
}

const ONCE = process.argv.includes("once"); // serveris paleidzia "node perps-scanner.js once" vienkartiniam perskenavimui
if (!ONCE && CFG.pollIntervalSec > 0) {
  const loop = async () => {
    let leftover = 0;
    try { leftover = await run(); } catch (e) { console.error(e); }
    // jei backlog dar yra (virs limito) -> drenuojam greitai; kitaip laukiam pollInterval
    setTimeout(loop, leftover > DRAIN_MIN ? DRAIN_MS : CFG.pollIntervalSec * 1000);
  };
  loop();
} else {
  run().then(() => { if (ONCE) process.exit(0); }).catch((e) => { console.error(e); if (ONCE) process.exit(1); });
}
