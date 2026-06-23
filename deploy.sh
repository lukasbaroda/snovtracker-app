#!/bin/bash
# Snovtracker diegimas. Paleisk serveryje:  bash /root/scanner/deploy.sh
cd /root/scanner || { echo "nėra /root/scanner"; exit 1; }

echo "== 0. duomenys į data/ (vienkartinis perkėlimas) =="
mkdir -p /root/scanner/data
for f in ranking.json perps-tiers.json perps-wallets.json overrides.json forward.json copy-log.json copy-state.json scan-status.json scanner.log copy-engine.log paper-accounts.json; do
  if [ -f "$f" ] && [ ! -f "data/$f" ]; then mv "$f" "data/$f" && echo "  perkelta: $f"; fi
done
if [ -d history ] && [ ! -d data/history ]; then mv history data/history && echo "  perkelta: history/"; fi

echo "== 1. valom seną python nuo porto 8000 =="
fuser -k 8000/tcp 2>/dev/null
pkill -f "http.server" 2>/dev/null
sleep 1

echo "== 2. solcopy servisas (jei dar nesukurtas) =="
if [ ! -f /etc/systemd/system/solcopy.service ] && [ -f /root/scanner/solcopy.service ]; then
  cp /root/scanner/solcopy.service /etc/systemd/system/ && echo "  solcopy.service įdiegtas"
fi
systemctl daemon-reload

echo "== 3. paleidžiam / perkraunam servisus =="
systemctl enable solserver solcopy solperps >/dev/null 2>&1
systemctl restart solserver
systemctl restart solcopy
systemctl start solperps
sleep 2

echo "== 4. patikra =="
echo -n "  solserver: "; systemctl is-active solserver
echo -n "  solcopy:   "; systemctl is-active solcopy
echo -n "  solperps:  "; systemctl is-active solperps
echo -n "  portas 8000: "; ss -ltnp 2>/dev/null | grep -q ":8000" && echo "užimtas (gerai)" || echo "TUŠČIAS (blogai!)"
echo -n "  API: "; curl -s -m5 localhost:8000/api/status | head -c 120; echo

echo "== 5. failų vientisumas (ar WinSCP nenukirpo) =="
for h in index.html admin.html; do
  if tail -c 20 /root/scanner/$h 2>/dev/null | grep -q "</html>"; then echo "  $h: OK (pilnas)"; else echo "  >>> $h APKARPYTAS! Įkelk jį iš naujo per WinSCP <<<"; fi
done
echo "== baigta =="
