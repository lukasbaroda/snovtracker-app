// Valdymo serveris: aptarnauja admin.html + API (blacklist/whitelist/settier/rescan).
// Paleidimas:  node server.js   (numatytas portas 8080, keisk PORT env)
// PASTABA: laikyk privačiai (firewall/SSH tunelis) - be autentifikacijos.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { spawn, exec } from "node:child_process";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";
import { fetchTraderTrades, computePaper, labelHistory } from "./paper.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(__dirname, "data"); try { fs.mkdirSync(DATA, { recursive: true }); } catch (e) {}
const CFG = (() => { try { return JSON.parse(fs.readFileSync(path.join(__dirname, "config.json"), "utf8")); } catch { return {}; } })();
const SERVICE = CFG.scannerService || "solperps"; // systemd serviso pavadinimas
const PORT = process.env.PORT || 8080;
const OVERRIDES = path.join(DATA, "overrides.json");
const HISTDIR = path.join(DATA, "history");
const RANKF = path.join(DATA, "ranking.json");
const WALLF = path.join(DATA, "perps-wallets.json");
const TIERF = path.join(DATA, "perps-tiers.json");
const jload = (f, d) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return d; } };
const sh = (cmd) => new Promise((res) => exec(cmd, { timeout: 12000 }, (e, out) => res(((out || "") + "").trim() || (e ? "klaida" : ""))));
let SVC_CACHE = "active"; // skanerio statusas, atnaujinamas fone (kad /api/status nekabotų)
async function refreshSvc() { try { SVC_CACHE = await sh(`timeout 3 systemctl is-active ${CFG.scannerService || "solperps"} 2>/dev/null`) || "?"; } catch { SVC_CACHE = "?"; } }
setInterval(refreshSvc, 30000); refreshSvc();
const PAPER = path.join(DATA, "paper-accounts.json");
const loadPaper = () => { try { return JSON.parse(fs.readFileSync(PAPER, "utf8")); } catch { return {}; } };
const savePaper = (o) => fs.writeFileSync(PAPER, JSON.stringify(o, null, 2));

const TYPES = { ".html": "text/html; charset=utf-8", ".json": "application/json; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".txt": "text/plain; charset=utf-8" };
const loadOv = () => { try { return JSON.parse(fs.readFileSync(OVERRIDES, "utf8")); } catch { return {}; } };
const saveOv = (o) => fs.writeFileSync(OVERRIDES, JSON.stringify(o, null, 2));
const norm = (o) => ({ blacklist: o.blacklist || [], whitelist: o.whitelist || [], forceTier: o.forceTier || {}, copyAmounts: o.copyAmounts || {}, copyStart: o.copyStart || {} });
let RANK_CACHE = null, RANK_MTIME = 0; // ranking.json kešas (kad neparsintume didelio failo kas užklausimą)
const FCACHE = {};
function jloadCached(f, d) { try { const m = fs.statSync(f).mtimeMs; const c = FCACHE[f]; if (c && c.m === m) return c.v; const v = JSON.parse(fs.readFileSync(f, "utf8")); FCACHE[f] = { m, v }; return v; } catch (e) { return (FCACHE[f] && FCACHE[f].v) || d; } }
function getRank() { try { const m = fs.statSync(RANKF).mtimeMs; if (m !== RANK_MTIME) { RANK_CACHE = JSON.parse(fs.readFileSync(RANKF, "utf8")); RANK_MTIME = m; } } catch (e) { if (!RANK_CACHE) RANK_CACHE = { ranking: [], generatedAt: null }; } return RANK_CACHE; }

function readBody(req) {
  return new Promise((res) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => { try { res(JSON.parse(b || "{}")); } catch { res({}); } }); });
}

// --- AUTH (slaptazodis + TOTP 2FA) ---
const ADMIN_PW = CFG.adminPassword || "";
const TOTP_SECRET = CFG.totpSecret || "";
const SESSIONS = new Set();
function b32decode(s) { const A = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"; let bits = ""; for (const c of String(s).toUpperCase().replace(/[^A-Z2-7]/g, "")) bits += A.indexOf(c).toString(2).padStart(5, "0"); const out = []; for (let i = 0; i + 8 <= bits.length; i += 8) out.push(parseInt(bits.substr(i, 8), 2)); return Buffer.from(out); }
function totpAt(secret, tsec) { const key = b32decode(secret); const ctr = Math.floor(tsec / 30); const buf = Buffer.alloc(8); buf.writeUInt32BE(Math.floor(ctr / 4294967296), 0); buf.writeUInt32BE(ctr >>> 0, 4); const h = crypto.createHmac("sha1", key).update(buf).digest(); const o = h[19] & 0xf; const code = ((h[o] & 0x7f) << 24 | (h[o + 1] & 0xff) << 16 | (h[o + 2] & 0xff) << 8 | (h[o + 3] & 0xff)) % 1000000; return code.toString().padStart(6, "0"); }
function totpValid(code) { if (!TOTP_SECRET) return false; const now = Date.now() / 1000; code = String(code || "").trim(); for (const d of [-1, 0, 1]) if (totpAt(TOTP_SECRET, now + d * 30) === code) return true; return false; }
function getSid(req) { const m = (req.headers.cookie || "").match(/sid=([a-f0-9]+)/); return m ? m[1] : null; }
function authed(req) { const s = getSid(req); return s && SESSIONS.has(s); }
const LOGIN_HTML = '<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>Snovtracker — Admin</title><body style="margin:0;background:#0b0e14;color:#e6edf3;font:15px/1.5 system-ui;display:flex;min-height:100vh;align-items:center;justify-content:center"><form id=lf method=post action="/api/login" autocomplete=on onsubmit="return go(event)" style="background:#141925;border:1px solid #222a39;border-radius:14px;padding:26px;width:300px"><div style="font-weight:700;font-size:18px;margin-bottom:14px">❄ Snovtracker Admin</div><input id=u name=username autocomplete=username placeholder="Naudotojas" value="admin" style="width:100%;margin-bottom:10px;padding:10px;background:#0b0e14;border:1px solid #2a3650;border-radius:8px;color:#fff"><input id=p name=password type=password autocomplete=current-password placeholder="Slaptažodis" autofocus style="width:100%;margin-bottom:10px;padding:10px;background:#0b0e14;border:1px solid #2a3650;border-radius:8px;color:#fff"><input id=c name=otp inputmode=numeric autocomplete=one-time-code placeholder="2FA kodas (6 sk.)" style="width:100%;margin-bottom:14px;padding:10px;background:#0b0e14;border:1px solid #2a3650;border-radius:8px;color:#fff"><button type=submit style="width:100%;padding:11px;background:#6c8cff;border:none;border-radius:9px;color:#fff;font-weight:600;cursor:pointer">Prisijungti</button><div id=e style="color:#f0556b;font-size:13px;margin-top:10px"></div></form><script>async function go(ev){ev.preventDefault();var r=await fetch("/api/login",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({password:p.value,code:c.value})});if(r.ok){location.href="/admin.html";}else{e.textContent="Neteisingas slaptažodis arba kodas";}return false;}</script></body>';

const server = http.createServer(async (req, res) => {
  const send = (code, type, data) => { try { res.writeHead(code, { "Content-Type": type, "Cache-Control": "no-cache, no-store, must-revalidate", "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET,POST,OPTIONS", "Access-Control-Allow-Headers": "Content-Type" }); res.end(data); } catch (e) {} };
  try {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === "OPTIONS") return send(204, "text/plain", "");

  // --- LOGIN / LOGOUT (admin) ---
  if (url.pathname === "/api/login" && req.method === "POST") {
    const { password, code } = await readBody(req);
    if (ADMIN_PW && password === ADMIN_PW && totpValid(code)) {
      const tok = crypto.randomBytes(18).toString("hex"); SESSIONS.add(tok);
      res.writeHead(200, { "Content-Type": TYPES[".json"], "Set-Cookie": `sid=${tok}; HttpOnly; Path=/; Max-Age=86400; SameSite=Lax` });
      return res.end(JSON.stringify({ ok: true }));
    }
    return send(401, TYPES[".json"], JSON.stringify({ error: "bad" }));
  }
  if (url.pathname === "/api/logout" && req.method === "POST") { const s = getSid(req); if (s) SESSIONS.delete(s); return send(200, TYPES[".json"], "{}"); }

  // --- API ---
  if (url.pathname === "/api/overrides" && req.method === "GET") {
    return send(200, TYPES[".json"], JSON.stringify(norm(loadOv())));
  }
  if (url.pathname === "/api/override" && req.method === "POST") {
    if (!authed(req)) return send(401, TYPES[".json"], JSON.stringify({ error: "auth" }));
    const { action, wallet, tier, amount } = await readBody(req);
    if (!wallet && action !== "clear") return send(400, TYPES[".json"], JSON.stringify({ error: "no wallet" }));
    const ov = norm(loadOv());
    const rm = (arr, w) => arr.filter((x) => x !== w);
    if (action === "blacklist") { ov.blacklist = [...new Set([...rm(ov.blacklist, wallet), wallet])]; ov.whitelist = rm(ov.whitelist, wallet); delete ov.forceTier[wallet]; }
    else if (action === "whitelist") { ov.whitelist = [...new Set([...rm(ov.whitelist, wallet), wallet])]; ov.blacklist = rm(ov.blacklist, wallet); if (amount > 0) { ov.copyAmounts[wallet] = Math.round(amount); if (!ov.copyStart[wallet]) ov.copyStart[wallet] = Math.floor(Date.now() / 1000); } }
    else if (action === "settier") { if (["A", "B", "C"].includes(tier)) ov.forceTier[wallet] = tier; else delete ov.forceTier[wallet]; }
    else if (action === "reset") { ov.blacklist = rm(ov.blacklist, wallet); ov.whitelist = rm(ov.whitelist, wallet); delete ov.forceTier[wallet]; delete ov.copyAmounts[wallet]; delete ov.copyStart[wallet]; }
    else return send(400, TYPES[".json"], JSON.stringify({ error: "bad action" }));
    saveOv(ov);
    return send(200, TYPES[".json"], JSON.stringify({ ok: true, overrides: ov }));
  }
  // --- sistemos statusas ---
  if (url.pathname === "/api/status" && req.method === "GET") {
    const watched = (jloadCached(WALLF, [])).length;
    const tiers = jloadCached(TIERF, {});
    const scanned = Object.keys(tiers).length;
    const tc = { A: 0, B: 0, C: 0 }; for (const w in tiers) tc[tiers[w].tier] = (tc[tiers[w].tier] || 0) + 1;
    const rank = getRank();
    const board = (rank.ranking || []).length;
    const burned = (rank.ranking || []).filter((r) => r.fwdStatus === "burned").length;
    const svc = SVC_CACHE;
    const scan = jload(path.join(DATA, "scan-status.json"), {});
    const ov = norm(loadOv());
    const fresh = scan.finishedAt || scan.startedAt || 0;
    const interval = (CFG.pollIntervalSec || 3600) * 1000;
    const alive = svc === "active" || (Date.now() - fresh < interval * 2 && fresh > 0);
    return send(200, TYPES[".json"], JSON.stringify({
      serverUp: true, watched, scanned, unprocessed: Math.max(0, watched - scanned),
      board, tierA: tc.A, tierB: tc.B, tierC: tc.C,
      whitelist: ov.whitelist.length, blacklist: ov.blacklist.length, forced: Object.keys(ov.forceTier).length,
      lastScan: rank.generatedAt, maxWallets: CFG.maxWallets || null,
      pollIntervalSec: CFG.pollIntervalSec || null, service: SERVICE, serviceActive: svc,
      scannerAlive: alive, scanning: !!scan.running, scanProgress: scan.progress || 0, scanTotal: scan.total || 0,
      scanFinishedAt: scan.finishedAt || null, scanStartedAt: scan.startedAt || null,
      queued: scan.queued || 0, nextRunMs: scan.nextRunMs || interval, serverNow: Date.now(),
    }));
  }
  // --- realtime logai (journald arba scanner.log) ---
  if (url.pathname === "/api/logs" && req.method === "GET") {
    const n = Math.min(500, parseInt(url.searchParams.get("lines") || "200"));
    const out = await sh(`journalctl -u ${SERVICE} -n ${n} --no-pager 2>/dev/null || tail -n ${n} ${path.join(DATA, "scanner.log")} 2>/dev/null`);
    return send(200, TYPES[".txt"], out || "(nėra logų)");
  }
  // --- serviso valdymas (restart / start / stop) ---
  if (url.pathname === "/api/service" && req.method === "POST") {
    if (!authed(req)) return send(401, TYPES[".json"], JSON.stringify({ error: "auth" }));
    const { action } = await readBody(req);
    if (!["restart", "start", "stop"].includes(action)) return send(400, TYPES[".json"], JSON.stringify({ error: "bad action" }));
    const out = await sh(`systemctl ${action} ${SERVICE} 2>&1`);
    const svc = SVC_CACHE;
    return send(200, TYPES[".json"], JSON.stringify({ ok: true, action, serviceActive: svc, out }));
  }
  // --- pilna treiderio istorija (is failo; jei nera/sena - parsisiunciam ir uzkesinam) ---
  if (url.pathname === "/api/history" && req.method === "GET") {
    const w = url.searchParams.get("wallet");
    if (!w) return send(400, TYPES[".json"], JSON.stringify({ error: "no wallet" }));
    const f = path.join(HISTDIR, w + ".json");
    try { if (fs.existsSync(f) && (Date.now() - fs.statSync(f).mtimeMs < 6 * 3600 * 1000)) return send(200, TYPES[".json"], fs.readFileSync(f, "utf8")); } catch {}
    try {
      const trades = await fetchTraderTrades(w);
      const hist = labelHistory(trades).slice(0, 1000);
      if (!fs.existsSync(HISTDIR)) fs.mkdirSync(HISTDIR);
      fs.writeFileSync(f, JSON.stringify(hist));
      return send(200, TYPES[".json"], JSON.stringify(hist));
    } catch (e) { return send(500, TYPES[".json"], JSON.stringify({ error: String(e) })); }
  }
  // --- PAPER / DEMO copy ---
  if (url.pathname === "/api/paper/create" && req.method === "POST") {
    const { wallet, amount } = await readBody(req);
    if (!wallet || !(amount > 0)) return send(400, TYPES[".json"], JSON.stringify({ error: "wallet ir amount butini" }));
    const accs = loadPaper();
    const id = "p" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    accs[id] = { id, wallet, start: Math.round(amount), startTs: Math.floor(Date.now() / 1000), createdAt: new Date().toISOString() };
    savePaper(accs);
    return send(200, TYPES[".json"], JSON.stringify({ ok: true, id }));
  }
  if (url.pathname === "/api/paper/state" && req.method === "GET") {
    const id = url.searchParams.get("id");
    const acc = loadPaper()[id];
    if (!acc) return send(404, TYPES[".json"], JSON.stringify({ error: "nera tokios saskaitos" }));
    try {
      const trades = await fetchTraderTrades(acc.wallet);
      return send(200, TYPES[".json"], JSON.stringify({ ok: true, account: acc, state: computePaper(acc, trades) }));
    } catch (e) { return send(500, TYPES[".json"], JSON.stringify({ error: String(e) })); }
  }
  if (url.pathname === "/api/paper/list" && req.method === "GET") {
    return send(200, TYPES[".json"], JSON.stringify(Object.values(loadPaper())));
  }
  if (url.pathname === "/api/rescan" && req.method === "POST") {
    if (!authed(req)) return send(401, TYPES[".json"], JSON.stringify({ error: "auth" }));
    // vienkartinis pilnas perskenavimas fone
    const child = spawn("node", [path.join(__dirname, "perps-scanner.js"), "once"], { cwd: __dirname, detached: true, stdio: "ignore" });
    child.unref();
    return send(200, TYPES[".json"], JSON.stringify({ ok: true, started: true }));
  }

  // --- piniginės balansas (SOL + USDC) per Helius (raktas lieka serveryje) ---
  if (url.pathname === "/api/balance" && req.method === "GET") {
    const w = url.searchParams.get("wallet");
    if (!w || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(w)) return send(400, TYPES[".json"], JSON.stringify({ error: "blogas adresas" }));
    if (!CFG.heliusApiKey) return send(500, TYPES[".json"], JSON.stringify({ error: "no helius key" }));
    const RPC = `https://mainnet.helius-rpc.com/?api-key=${CFG.heliusApiKey}`;
    const rpc = async (method, params) => { const r = await fetch(RPC, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: AbortSignal.timeout(12000) }); const j = await r.json(); return j.result; };
    try {
      let sol = 0, usdc = 0;
      try { const b = await rpc("getBalance", [w]); sol = (b && b.value ? b.value : 0) / 1e9; } catch (e) {}
      try { const ta = await rpc("getTokenAccountsByOwner", [w, { mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" }, { encoding: "jsonParsed" }]); const accs = (ta && ta.value) || []; for (const a of accs) { const amt = (a.account && a.account.data && a.account.data.parsed && a.account.data.parsed.info && a.account.data.parsed.info.tokenAmount && a.account.data.parsed.info.tokenAmount.uiAmount) || 0; usdc += amt; } } catch (e) {}
      return send(200, TYPES[".json"], JSON.stringify({ ok: true, wallet: w, sol: Math.round(sol * 1e6) / 1e6, usdc: Math.round(usdc * 100) / 100 }));
    } catch (e) { return send(500, TYPES[".json"], JSON.stringify({ error: String(e.message || e) })); }
  }

  // --- leaderboard puslapiais (greitas landing) ---
  if (url.pathname === "/api/board" && req.method === "GET") {
    const sort = url.searchParams.get("sort") || "copyScore";
    const asset = url.searchParams.get("asset") || "Visi";
    const offset = Math.max(0, parseInt(url.searchParams.get("offset") || "0") || 0);
    const limit = Math.min(50, Math.max(1, parseInt(url.searchParams.get("limit") || "10") || 10));
    const rank = getRank();
    const all = rank.ranking || [];
    const plus = all.filter((r) => (r.roiPct || 0) > 0).length;
    const minus = all.filter((r) => (r.roiPct || 0) < 0).length;
    let rows = all.filter((r) => (r.roiPct || 0) > 0);
    if (asset !== "Visi") rows = rows.filter((r) => (r.assets || "").indexOf(asset) >= 0);
    const allow = ["copyScore", "returnPct", "roiPct", "winRatePct"];
    const k = allow.indexOf(sort) >= 0 ? sort : "copyScore";
    rows.sort((a, b) => (b[k] || 0) - (a[k] || 0));
    const total = rows.length;
    const page = rows.slice(offset, offset + limit);
    return send(200, TYPES[".json"], JSON.stringify({ ok: true, total, rows: page, stats: { traders: all.length, plus, minus }, generatedAt: rank.generatedAt }));
  }

  if (url.pathname === "/api/ranking" && req.method === "GET") {
    return send(200, TYPES[".json"], JSON.stringify(getRank()));
  }

  if (url.pathname === "/api/copyaccounts" && req.method === "GET") {
    const d = jload(path.join(DATA, "copy-accounts.json"), { accounts: [] });
    d.live = !!CFG.copyLive; d.stop = fs.existsSync(path.join(DATA, "copy-STOP"));
    return send(200, TYPES[".json"], JSON.stringify(d));
  }

  // --- DRY-RUN kopijavimo logas ---
  if (url.pathname === "/api/copylog" && req.method === "GET") {
    const log = jload(path.join(DATA, "copy-log.json"), []);
    const state = jload(path.join(DATA, "copy-state.json"), {});
    const live = !!CFG.copyLive;
    const stop = fs.existsSync(path.join(DATA, "copy-STOP"));
    const daily = state._daily || { usd: 0, count: 0 };
    const watching = Object.keys(state).filter((k) => k !== "_daily").length;
    return send(200, TYPES[".json"], JSON.stringify({ ok: true, watching, live, stop, mode: (live && !stop) ? "LIVE" : "DRY",
      caps: { maxPos: CFG.copyMaxPositionUsd || 25, maxLev: CFG.copyMaxLeverage || 10, dailyMax: CFG.copyDailyMaxUsd || 100 },
      daily, entries: (log || []).slice(0, 100) }));
  }

  // --- statiniai failai --- "/" -> VIEŠAS index.html (admin tik per /admin.html)
  let pn = url.pathname;
  if (pn === "/") pn = "/index.html";
  if (pn === "/admin") pn = "/admin.html";
  if (pn === "/admin.html" && !authed(req)) return send(200, TYPES[".html"], LOGIN_HTML); // 2FA apsauga
  let fp = path.join(__dirname, path.normalize(decodeURIComponent(pn)).replace(/^(\.\.[\/\\])+/, "")); // path traversal apsauga
  if (!fp.startsWith(__dirname)) return send(403, "text/plain", "forbidden");
  fs.readFile(fp, (err, data) => {
    if (err) return send(404, "text/plain", "not found");
    send(200, TYPES[path.extname(fp)] || "application/octet-stream", data);
  });
  } catch (e) { console.error("req err:", e.message); send(500, "text/plain", "error"); }
});
server.on("clientError", (err, socket) => { try { socket.destroy(); } catch (e) {} });
process.on("uncaughtException", (e) => console.error("uncaught:", e.message));
process.on("unhandledRejection", (e) => console.error("unhandled rejection:", (e && e.message) || e));
server.listen(PORT, () => console.log(`Snovtracker serveris klauso: http://localhost:${PORT}`));
