// ═══════════════════════════════════════════════════════
//  TBlaugranaTurf — Proxy + Bot de surveillance serveur
//  Les alertes Telegram tournent ICI, sans onglet ouvert
// ═══════════════════════════════════════════════════════

const express = require('express');
const path    = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── CONFIG ─────────────────────────────────────────────
const CFG = {
  tgToken:       '8961502220:AAGlpLomYVMXRQgrJsPp5M4m-omFPJPBKoU',
  tgChatIds:     ['625118343', '8288460384'],
  tgMaxCote:     10,      // cote finale max pour déclencher l'alerte Telegram
  dropPct:       20,      // chute minimale en % pour alerter
  snapSecs:      30,      // snapshot N secondes avant le départ
  loopMs:        800,     // intervalle entre deux fetch de cotes (ms)
  progRefreshMs: 120_000, // rafraîchissement du programme (ms)
  fetchTimeout:  5000,    // timeout requête PMU (ms)
};

const PMU_PROG  = 'https://online.turfinfo.api.pmu.fr/rest/client/61';
const PMU_PARTS = 'https://online.turfinfo.api.pmu.fr/rest/client/62';

// ── UTILS ───────────────────────────────────────────────
const pad = n => String(n).padStart(2, '0');

function dateStr(d) {
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
}

// YYYYMMDD → DDMMYYYY
function datePmu(s) {
  return s.slice(6, 8) + s.slice(4, 6) + s.slice(0, 4);
}

function timeNow() {
  const n = new Date();
  return `${pad(n.getHours())}:${pad(n.getMinutes())}:${pad(n.getSeconds())}`;
}

async function fetchTimeout(url, opts = {}, ms = CFG.fetchTimeout) {
  const ctrl = new AbortController();
  const id   = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(url, { ...opts, signal: ctrl.signal });
    clearTimeout(id);
    return r;
  } catch (e) {
    clearTimeout(id);
    throw e;
  }
}

// ── LOG ─────────────────────────────────────────────────
function log(msg) {
  console.log(`[${timeNow()}] ${msg}`);
}

// ── ÉTAT BOT ────────────────────────────────────────────
let bot = {
  today:       '',
  programme:   [],     // [{reunion, course, depart, libelle, hip, disc}]
  curRaceIdx:  -1,     // index de la course surveillée
  participants: [],
  snapCotes:   {},     // { numPmu -> cote au snapshot }
  snapDone:    false,
  alertedDrop: new Set(),
  lastProgMs:  0,
};

// ── TELEGRAM ─────────────────────────────────────────────
async function sendTelegram(horse, snap, cur, dropPct, race, secsLeft) {
  const apiBase  = `https://api.telegram.org/bot${CFG.tgToken}/sendMessage`;
  const raceLabel = `R${race.reunion}C${race.course}`;
  const hip       = race.hip ? `${race.hip} — ` : '';
  const secsStr   = secsLeft > 0 ? `⏱ ${secsLeft}s avant départ` : '🚨 DÉPART IMMINENT';
  const text =
    `🚨 *ALERTE ${raceLabel}* 🚨\n` +
    `🐎 ${horse.numPmu} — *${horse.nom}*\n` +
    `${snap} ➡️ ${cur} (−${dropPct.toFixed(0)}%)\n` +
    `${hip}${race.libelle}\n` +
    `${secsStr}`;

  log(`📤 Telegram → ${horse.nom} (${snap}→${cur} -${dropPct.toFixed(0)}%)`);

  for (const chatId of CFG.tgChatIds) {
    try {
      const r    = await fetch(apiBase, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown' }),
      });
      const json = await r.json();
      if (r.ok && json.ok) {
        log(`✅ Telegram OK → chat ${chatId}`);
      } else {
        log(`❌ Telegram ÉCHEC chat ${chatId} : ${json.description || r.status}`);
      }
    } catch (e) {
      log(`❌ Telegram EXCEPTION chat ${chatId} : ${e.message}`);
    }
  }
}

// ── PROGRAMME ────────────────────────────────────────────
async function loadProgramme() {
  bot.today = dateStr(new Date());
  const url = `${PMU_PROG}/programme/${datePmu(bot.today)}?specialisation=OFFLINE`;
  try {
    const r = await fetchTimeout(url, { headers: { 'Accept': 'application/json' } });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json();
    const races = [];
    for (const ru of (data?.programme?.reunions || [])) {
      const hip = ru.hippodrome?.libelleCourt || ru.hippodrome?.libelleLong || `R${ru.numOfficiel}`;
      for (const co of (ru.courses || [])) {
        races.push({
          reunion: ru.numOfficiel,
          course:  co.numOrdre,
          depart:  co.heureDepart,
          libelle: co.libelle || co.libelleCourt || `Course ${co.numOrdre}`,
          hip,
          disc: co.discipline || co.specialite || '',
        });
      }
    }
    bot.programme = races.sort((a, b) => a.depart - b.depart);
    bot.lastProgMs = Date.now();
    log(`📋 Programme chargé : ${races.length} courses`);
  } catch (e) {
    log(`⚠️ Programme ERREUR : ${e.message}`);
  }
}

// ── TROUVER LA PROCHAINE COURSE ─────────────────────────
function findNextRace() {
  const now = Date.now();
  for (let i = 0; i < bot.programme.length; i++) {
    if (bot.programme[i].depart >= now - 300_000) return i;
  }
  return Math.max(0, bot.programme.length - 1);
}

// ── SNAPSHOT ─────────────────────────────────────────────
function doSnapshot() {
  if (bot.snapDone) return;
  bot.snapDone = true;
  bot.snapCotes = {};
  for (const p of bot.participants) {
    if (p.statut === 'PARTANT' && p.dernierRapportDirect)
      bot.snapCotes[p.numPmu] = p.dernierRapportDirect.rapport;
  }
  bot.alertedDrop.clear();
  log(`📸 SNAPSHOT — ${Object.keys(bot.snapCotes).length} chevaux`);
}

// ── DÉTECTION DES CHUTES ─────────────────────────────────
function checkDrops(race, secsLeft) {
  if (!bot.snapDone) return;
  if (secsLeft > CFG.snapSecs) return;
  if (secsLeft < -120) return;

  for (const p of bot.participants) {
    if (p.statut !== 'PARTANT' || !p.dernierRapportDirect) continue;
    const snap = bot.snapCotes[p.numPmu];
    const cur  = p.dernierRapportDirect.rapport;
    if (!snap || bot.alertedDrop.has(p.numPmu)) continue;

    const drop = (snap - cur) / snap * 100;
    if (drop < CFG.dropPct) continue;
    if (cur > CFG.tgMaxCote) continue;

    bot.alertedDrop.add(p.numPmu);
    log(`🔥 CHUTE ${p.nom} : ${snap} → ${cur} (−${drop.toFixed(0)}%)`);
    sendTelegram(p, snap, cur, drop, race, secsLeft);
  }
}

// ── BOUCLE PRINCIPALE ────────────────────────────────────
async function botLoop() {
  log('🚀 Bot démarré — surveillance en cours...');
  await loadProgramme();

  // Cherche les prochains jours si pas de courses aujourd'hui
  if (bot.programme.length === 0) {
    for (let offset = 1; offset <= 7; offset++) {
      const d  = new Date();
      d.setDate(d.getDate() + offset);
      const ds = dateStr(d);
      const url = `${PMU_PROG}/programme/${datePmu(ds)}?specialisation=OFFLINE`;
      try {
        const r = await fetchTimeout(url, { headers: { 'Accept': 'application/json' } });
        if (!r.ok) continue;
        const data = await r.json();
        const races = [];
        for (const ru of (data?.programme?.reunions || [])) {
          const hip = ru.hippodrome?.libelleCourt || ru.hippodrome?.libelleLong || `R${ru.numOfficiel}`;
          for (const co of (ru.courses || [])) {
            races.push({ reunion: ru.numOfficiel, course: co.numOrdre, depart: co.heureDepart,
              libelle: co.libelle || `Course ${co.numOrdre}`, hip, disc: co.discipline || '' });
          }
        }
        if (races.length) {
          bot.today = ds;
          bot.programme = races.sort((a, b) => a.depart - b.depart);
          log(`📅 Prochain programme trouvé : ${ds} (${races.length} courses)`);
          break;
        }
      } catch (_) {}
    }
  }

  let lastRaceKey = '';
  const etags = {};

  while (true) {
    // Rafraîchissement programme
    if (Date.now() - bot.lastProgMs > CFG.progRefreshMs) {
      await loadProgramme();
    }

    if (bot.programme.length === 0) {
      await new Promise(r => setTimeout(r, 5000));
      continue;
    }

    const idx  = findNextRace();
    const race = bot.programme[idx];
    const secsLeft = Math.round((race.depart - Date.now()) / 1000);
    const raceKey  = `R${race.reunion}C${race.course}`;

    // Changement de course → reset état
    if (raceKey !== lastRaceKey) {
      log(`🏇 Course surveillée : ${raceKey} — ${race.hip} — ${race.libelle} (départ dans ${secsLeft}s)`);
      lastRaceKey = raceKey;
      bot.snapDone = false;
      bot.snapCotes = {};
      bot.alertedDrop.clear();
      bot.participants = [];
    }

    // Fetch des cotes
    const url = `${PMU_PARTS}/programme/${datePmu(bot.today)}/R${race.reunion}/C${race.course}/participants?specialisation=OFFLINE`;
    const headers = { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0' };
    if (etags[url]) headers['If-None-Match'] = etags[url];

    try {
      const r = await fetchTimeout(url, { headers, cache: 'no-store' });
      const etag = r.headers.get('etag');
      if (etag) etags[url] = etag;

      if (r.status === 304) {
        // Rien de nouveau, on vérifie quand même les chutes avec les données actuelles
        if (secsLeft <= CFG.snapSecs && secsLeft > -120) checkDrops(race, secsLeft);
      } else if (r.ok) {
        const data = await r.json();
        bot.participants = data.participants || [];

        // Snapshot automatique
        if (secsLeft <= CFG.snapSecs && secsLeft > 0 && !bot.snapDone) doSnapshot();

        // Détection chutes
        checkDrops(race, secsLeft);
      }
    } catch (e) {
      log(`⚠️ Fetch cotes ERREUR : ${e.message}`);
    }

    await new Promise(r => setTimeout(r, CFG.loopMs));
  }
}

// ── SERVEUR EXPRESS ──────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));

// Cache ETag côté serveur pour le proxy
const serverEtags = {};

async function proxyPmu(targetBase, reqPath, reqQuery, res) {
  const qs  = reqQuery ? `?${reqQuery}` : '';
  const url = `${targetBase}${reqPath}${qs}`;
  const headers = {
    'Accept': 'application/json',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  };
  if (serverEtags[url]) headers['If-None-Match'] = serverEtags[url];

  try {
    const ctrl    = new AbortController();
    const timerId = setTimeout(() => ctrl.abort(), 5000);
    const upstream = await fetch(url, { headers, signal: ctrl.signal });
    clearTimeout(timerId);

    const etag = upstream.headers.get('etag');
    if (etag) serverEtags[url] = etag;

    res.set('Content-Type', upstream.headers.get('content-type') || 'application/json');
    if (etag) res.set('ETag', etag);
    res.status(upstream.status);

    if (upstream.status === 304) return res.end();
    const body = await upstream.text();
    res.send(body);
  } catch (err) {
    if (err.name === 'AbortError') return res.status(504).json({ error: 'Timeout PMU API' });
    res.status(502).json({ error: 'PMU API unreachable', detail: err.message });
  }
}

app.get('/api/pmu/prog/*', (req, res) => {
  const subPath = req.path.replace('/api/pmu/prog', '');
  proxyPmu(PMU_PROG, subPath, req.query ? new URLSearchParams(req.query).toString() : '', res);
});

app.get('/api/pmu/parts/*', (req, res) => {
  const subPath = req.path.replace('/api/pmu/parts', '');
  proxyPmu(PMU_PARTS, subPath, req.query ? new URLSearchParams(req.query).toString() : '', res);
});

// Health check + état du bot
app.get('/health', (_, res) => res.json({
  status: 'ok',
  ts: new Date().toISOString(),
  bot: {
    today:     bot.today,
    courses:   bot.programme.length,
    course:    bot.curRaceIdx >= 0 ? `R${bot.programme[bot.curRaceIdx]?.reunion}C${bot.programme[bot.curRaceIdx]?.course}` : 'N/A',
    snapDone:  bot.snapDone,
    alertes:   bot.alertedDrop.size,
  }
}));

// ── DÉMARRAGE ────────────────────────────────────────────
app.listen(PORT, () => {
  log(`TBlaugranaTurf Proxy — port ${PORT}`);
  // Lance le bot de surveillance en arrière-plan
  botLoop().catch(e => log(`💥 Bot crash : ${e.message}`));
});
