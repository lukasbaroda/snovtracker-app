# Etapas 0 — Solana treiderių skeneris (read-only)

Pirmas žingsnis. Patikrina pagrindinę hipotezę: **ar galim aptikti sekamų walletų SWAP sandorius ir prasmingai juos reitinguoti.** Jokio vykdymo, jokių pinigų, jokios custody.

## Ką daro

1. Per Helius Enhanced Transactions API paima kiekvieno sekamo wallet'o SWAP sandorius.
2. Iš jų ištraukia: pirkimas/pardavimas, tokenas, USD suma (vertina SOL ir USDC kojas).
3. Saugo į `trades.json` (dedup pagal signature).
4. Skaičiuoja supaprastintą PnL per tokeną (cost vs proceeds) ir sudaro reitingą.
5. Atspausdina TOP treiderius ir išsaugo `ranking.json`.

## Ko reikia

- **Node 18+** (naudoja native `fetch`). Patikrink: `node -v`.
- **Helius API raktas** — nemokamas: susikurk paskyrą helius.dev → Dashboard → API key. Nemokamo tier'o testui pakanka.
- Jokių npm dependencijų. Jokios DB.

## Paleidimas

1. Nukopijuok konfigą:
   ```bash
   cp config.example.json config.json
   ```
2. `config.json`:
   - `heliusApiKey` — įrašyk savo raktą.
   - `wallets` — įklijuok 10–50 walletų adresų, kuriuos nori sekti (pradžiai gali rasti GMGN/Cielo/Birdeye „top traders" sąrašuose).
   - `whitelistMints` — palik kaip yra arba pridėk daugiau blue-chip mint'ų. Jei nori sekti VISKĄ (be filtro) — palik tuščią `{}`.
   - `pollIntervalSec` — `0` = paleisti vieną kartą; `300` = kartoti kas 5 min.
3. Paleisk:
   ```bash
   node scanner.js
   ```

## Rezultatas

Konsolėje pamatysi:

```
--- TOP treideriai (pagal ROI) ---
rank  wallet         trades  tokens   ROI%    PnL$     win%
1     Bonk7xKp       42      8        38.2    1240.5   71
2     9aQ2vF...      28      5        27.6    830.1    64
...
```

Plius `ranking.json` su pilnais duomenimis.

## Svarbu (v0 apribojimai)

- PnL yra **supaprastintas proxy** (vertina tik SOL ir USDC kojas; token-to-token be SOL/USDC kojos praleidžiamas). Tinka reitingavimo hipotezei patikrinti, NE galutiniam tikslumui.
- Tai **polling** versija (paima istoriją periodiškai) — tinka kelioms dešimtims walletų pigiam testui. Produkcijoje Tier 1 keisim į **streaming (geyser/gRPC)**, kaip aprašyta techniniame brief'e.
- Kitas žingsnis po šito: pridėti drawdown/laikymo laiko metrikas, daugiau walletų, ir entity-clustering (walletų rotacijos sekimą).

## Failai

- `scanner.js` — skeneris
- `config.example.json` — konfigo pavyzdys
- `trades.json` — sukauptų sandorių saugykla (sukuriama automatiškai)
- `ranking.json` — paskutinis reitingas (sukuriamas automatiškai)
