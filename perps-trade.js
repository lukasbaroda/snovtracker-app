// perps-trade.js — TIKRAS Jupiter Perps vykdymas (atskira serverio piniginė).
// SVARBU: on-chain instrukcija statoma per @solana/web3.js + @coral-xyz/anchor + Perps IDL.
// Kol IDL/instrukcija neįdiegta, openPosition/closePosition meta aiškią klaidą -> variklis lieka saugus (nieko nedaro).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CFG = (() => { try { return JSON.parse(fs.readFileSync(path.join(__dirname, "config.json"), "utf8")); } catch { return {}; } })();
const RPC = CFG.copyRpc || (CFG.heliusApiKey ? `https://mainnet.helius-rpc.com/?api-key=${CFG.heliusApiKey}` : "");

// Tingus (lazy) bibliotekų užkrovimas — kad sistema neluztu jei dar neidiegta npm
async function deps() {
  try {
    const web3 = await import("@solana/web3.js");
    const anchor = await import("@coral-xyz/anchor");
    return { web3, anchor };
  } catch (e) {
    throw new Error("NEĮDIEGTA: serveryje reikia `npm i @solana/web3.js @coral-xyz/anchor` (perps-exec kataloge) ir Perps IDL.");
  }
}

// Piniginė iš config.copyWalletSecret (base58). Raktas lieka serveryje, niekur nesiunčiamas.
async function loadWallet() {
  const { web3, anchor } = await deps();
  const sec = CFG.copyWalletSecret;
  if (!sec) throw new Error("NĖRA RAKTO: įdėk atskiros piniginės privatų raktą į config.copyWalletSecret (base58).");
  let bytes;
  try { bytes = anchor.utils.bytes.bs58.decode(sec); } catch { throw new Error("Blogas copyWalletSecret formatas (turi būti base58)."); }
  return web3.Keypair.fromSecretKey(bytes);
}

// === TIKRAS POZICIJOS ATIDARYMAS ===
// params: { asset:"SOL"|"ETH"|"BTC", side:"long"|"short", collateralUsd, leverage, simulateOnly:true }
export async function openPosition(params) {
  const { web3, anchor } = await deps();
  const kp = await loadWallet();
  const conn = new web3.Connection(RPC, "confirmed");
  // ----------------------------------------------------------------------------
  // ČIA įstatoma Perps PositionRequest instrukcija (pagal create-market-trade-request.ts):
  //   - perpetuals / pool / custody / collateralCustody PDA
  //   - position + positionRequest PDA (generate-position-and-position-request-pda.ts)
  //   - fundingAccount = piniginės USDC ATA, oracle (doves) accounts (remaining-accounts.ts)
  //   - program.methods.createIncreasePositionMarketRequest({...}).accounts({...}).remainingAccounts(...)
  //   - simulateOnly ? conn.simulateTransaction(tx) : sendAndConfirm(tx, [kp])
  // ----------------------------------------------------------------------------
  throw new Error("INSTRUKCIJA_NEĮDIEGTA: reikia create-market-trade-request.ts pavyzdžio (žr. instrukciją). Atidarymas dar nesukonfigūruotas.");
}

// === TIKRAS POZICIJOS UŽDARYMAS === (pagal close-position-request.ts)
export async function closePosition(params) {
  const { web3, anchor } = await deps();
  const kp = await loadWallet();
  const conn = new web3.Connection(RPC, "confirmed");
  throw new Error("INSTRUKCIJA_NEĮDIEGTA: reikia close-position-request.ts pavyzdžio. Uždarymas dar nesukonfigūruotas.");
}

export function rpcUrl() { return RPC; }
