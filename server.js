// ═══════════════════════════════════════════════════════════════
//  TBlaugranaTurf — Serveur Node.js v2.1
//  • Proxy PMU (contourne CORS)
//  • Moteur de surveillance H24 côté serveur
//    → snapshot auto à 15s du départ
//    → détection chute de cote ≥ 15%
//    → alertes Telegram même onglet fermé
//  OPTIMISATIONS v2.1 :
//    → Boucle indépendante par course (pas de blocage inter-courses)
//    → ETag côté fetchJson interne (évite de parser si données inchangées)
//    → Timeout réduit 4000ms + 1 seul retry
//    → Polling 300ms zone critique (<90s), 400ms zone hot (<30s)
//    → Seuil alerte abaissé à 15%
// ═══════════════════════════════════════════════════════════════

const express = require('express');
const path    = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── CONFIG ──────────────────────────────────────────────────────
const CFG = {
  tgToken:      process.env.TG_TOKEN   || '8961502220:AAGlpLomYVMXRQgrJsPp5M4m-omFPJPBKoU',
  tgChatIds:    (process.env.TG_CHATS  || '625118343,8288460384').split(',').map(s => s.trim()),
  tgMaxCote:    parseFloat(process.env.TG_MAX_COTE  || '10'),
  dropPct:      parseFloat(process.env.DROP_PCT     || '15'),   // ← 15% (était 20%)
  snapSecs:     15,               // snapshot à 15s du départ
  postDepartMs: 3 * 60 * 1000,   // continue 3min après le départ
  pollMs:       700,              // hors zone critique
  pollCritMs:   300,              // < 90s du départ → ~3 req/s
  pollHotMs:    200,              // < 30s du départ → ~5 req/s
};

const PMU_PROG  = 'https://online.turfinfo.api.pmu.fr/rest/client/61';
const PMU_PARTS = 'https://online.turfinfo.api.pmu.fr/rest/client/62';

// ── PROXY PMU ───────────────────────────────────────────────────
const serverEtags = {};

async function proxyPmu(targetBase, reqPath, reqQuery, res) {
  const qs  = reqQuery ? `?${reqQuery}` : '';
  const url = `${targetBase}${reqPath}${qs}`;
  const headers = {
    'Accept':     'application/json',
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
    res.send(await upstream.text());
  } catch (err) {
    if (err.name === 'AbortError') return res.status(504).json({ error: 'Timeout PMU API' });
    console.error('[PMU Proxy Error]', err.message);
    res.status(502).json({ error: 'PMU API unreachable', detail: err.message });
  }
}

app.get('/api/pmu/prog/*',  (req, res) => {
  proxyPmu(PMU_PROG,  req.path.replace('/api/pmu/prog', ''),
    req.query ? new URLSearchParams(req.query).toString() : '', res);
});
app.get('/api/pmu/parts/*', (req, res) => {
  proxyPmu(PMU_PARTS, req.path.replace('/api/pmu/parts', ''),
    req.query ? new URLSearchParams(req.query).toString() : '', res);
});

// ── ÉTAT SERVEUR ────────────────────────────────────────────────
const watcher = {
  programme:    [],    // [{reunion,course,depart,libelle,hip,disc}]
  today:        '',
  snapMap:      {},    // { "R1C3": { cotes:{numPmu:snap}, done:true, alertedSet:Set } }
  lastAlerts:   [],    // 50 dernières alertes pour le front
  activeLoops:  new Set(), // clés des courses avec boucle déjà lancée
};

// ── UTILITAIRES ────────────────────────────────────────────────
const pad = n => String(n).padStart(2, '0');
function dateStr(d) { return `${d.getFullYear()}${pad(d.getMonth()+1)}${pad(d.getDate())}`; }
function datePmu(s) { return s.slice(6,8)+s.slice(4,6)+s.slice(0,4); }

// Cache ETag pour les appels internes serveur→PMU
const fetchEtags = {};

// fetchJson optimisé : ETag interne + timeout 4000ms + 1 seul retry
async function fetchJson(url, timeoutMs = 4000, retries = 1) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctrl    = new AbortController();
    const id      = setTimeout(() => ctrl.abort(), timeoutMs);
    const headers = { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0' };
    if (fetchEtags[url]) headers['If-None-Match'] = fetchEtags[url];

    try {
      const r = await fetch(url, { signal: ctrl.signal, headers });
      clearTimeout(id);

      const etag = r.headers.get('etag');
      if (etag) fetchEtags[url] = etag;

      // 304 = données inchangées → retourne null pour skip le traitement
      if (r.status === 304) return null;
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.json();
    } catch(e) {
      clearTimeout(id);
      lastErr = e;
      // Retry uniquement sur timeout/réseau, pas sur 4xx
      if (attempt < retries && e.name !== 'AbortError') {
        await new Promise(r => setTimeout(r, 150));
      }
    }
  }
  throw lastErr;
}

async function sendTelegram(text) {
  const url = `https://api.telegram.org/bot${CFG.tgToken}/sendMessage`;
  for (const chatId of CFG.tgChatIds) {
    try {
      await fetch(url, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown' }),
      });
    } catch(e) {
      console.error(`[TG] Erreur chat ${chatId}:`, e.message);
    }
  }
}

function pushAlert(type, icon, msg) {
  const alert = { ts: new Date().toISOString(), type, icon, msg };
  watcher.lastAlerts.unshift(alert);
  if (watcher.lastAlerts.length > 50) watcher.lastAlerts.pop();
  console.log(`[ALERT][${type}] ${icon} ${msg}`);
}

// ── CHARGEMENT PROGRAMME ───────────────────────────────────────
async function loadProgramme() {
  for (let offset = 0; offset <= 1; offset++) {
    const d  = new Date();
    d.setDate(d.getDate() + offset);
    const ds = dateStr(d);
    try {
      const url  = `${PMU_PROG}/programme/${datePmu(ds)}?specialisation=OFFLINE`;
      const data = await fetchJson(url, 6000, 2);
      if (!data) continue; // 304
      const races = [];
      for (const ru of (data?.programme?.reunions || [])) {
        const hip = ru.hippodrome?.libelleCourt || ru.hippodrome?.libelleLong || `R${ru.numOfficiel}`;
        for (const co of (ru.courses || [])) {
          races.push({
            reunion: ru.numOfficiel,
            course:  co.numOrdre,
            depart:  co.heureDepart,
            libelle: co.libelle || co.libelleCourt || `Course ${co.numOrdre}`,
            hip, disc: co.discipline || co.specialite || '',
          });
        }
      }
      if (races.length > 0) {
        watcher.today     = ds;
        watcher.programme = races.sort((a,b) => a.depart - b.depart);
        console.log(`[PROG] ${races.length} courses chargées (${ds})`);
        return true;
      }
    } catch(e) { console.error('[PROG] Erreur:', e.message); }
  }
  return false;
}

// ── MOTEUR DE SURVEILLANCE ─────────────────────────────────────
function raceKey(r) { return `R${r.reunion}C${r.course}`; }

function getOrCreateSnap(race) {
  const k = raceKey(race);
  if (!watcher.snapMap[k]) {
    watcher.snapMap[k] = { cotes: {}, done: false, alertedSet: new Set() };
  }
  return watcher.snapMap[k];
}

// Retourne le délai de polling adapté au temps restant avant départ
function pollDelay(secsLeft) {
  if (secsLeft > 0 && secsLeft <= 30)  return CFG.pollHotMs;   // zone hot  : 200ms
  if (secsLeft > 0 && secsLeft <= 90)  return CFG.pollCritMs;  // zone crit : 300ms
  return CFG.pollMs;                                             // normal    : 700ms
}

// Vérifie si une course est encore dans la fenêtre de surveillance
function isRaceActive(race) {
  const ms = race.depart - Date.now();
  return ms <= (CFG.snapSecs * 1000 + 10000) && ms >= -CFG.postDepartMs;
}

async function watchRace(race) {
  const key      = raceKey(race);
  const snap     = getOrCreateSnap(race);
  const now      = Date.now();
  const secsLeft = Math.round((race.depart - now) / 1000);
  const url      = `${PMU_PARTS}/programme/${datePmu(watcher.today)}/R${race.reunion}/C${race.course}/participants?specialisation=OFFLINE`;

  let parts;
  try {
    const data = await fetchJson(url, 4000);
    if (data === null) return; // 304 → données inchangées, rien à faire
    parts = data.participants || [];
  } catch(e) {
    console.error(`[WATCH][${key}] fetchParts erreur:`, e.message);
    return;
  }

  // ── Snapshot auto à CFG.snapSecs avant le départ ──────────────
  if (!snap.done && secsLeft <= CFG.snapSecs && secsLeft >= -10) {
    for (const p of parts) {
      if (p.statut === 'PARTANT' && p.dernierRapportDirect) {
        snap.cotes[p.numPmu] = p.dernierRapportDirect.rapport;
      }
    }
    snap.done = true;
    const n = Object.keys(snap.cotes).length;
    pushAlert('snap', '📸', `[${key}] SNAPSHOT — ${n} chevaux (secsLeft=${secsLeft}s)`);
  }

  // ── Détection chutes ──────────────────────────────────────────
  if (!snap.done) return;

  for (const p of parts) {
    if (p.statut !== 'PARTANT' || !p.dernierRapportDirect) continue;
    if (snap.alertedSet.has(p.numPmu)) continue;

    const snapCote = snap.cotes[p.numPmu];
    const curCote  = p.dernierRapportDirect.rapport;
    if (!snapCote || !curCote) continue;

    const drop = (snapCote - curCote) / snapCote * 100;
    if (drop < CFG.dropPct) continue; // seuil 15%

    snap.alertedSet.add(p.numPmu);

    const secsStr = secsLeft > 0 ? `⏱ ${secsLeft}s avant départ` : `🏁 ${Math.abs(secsLeft)}s après départ`;
    const msg     = `[${key}] N°${p.numPmu} ${p.nom} chute ${snapCote}→${curCote} (−${drop.toFixed(0)}%)`;
    pushAlert('drop', '🔥', msg);

    // Telegram si cote finale ≤ tgMaxCote
    if (curCote <= CFG.tgMaxCote) {
      const tgTxt =
        `🚨 *ALERTE ${key}* 🚨\n` +
        `🐎 ${p.numPmu} — *${p.nom}*\n` +
        `${snapCote} ➡️ ${curCote} (−${drop.toFixed(0)}%)\n` +
        `${secsStr}`;
      sendTelegram(tgTxt).catch(e => console.error('[TG]', e.message));
    }
  }
}

// ── BOUCLE INDÉPENDANTE PAR COURSE ────────────────────────────
// Chaque course active tourne dans sa propre boucle async,
// sans bloquer les autres courses (même en cas de requête lente).
async function watchRaceLoop(race) {
  const key = raceKey(race);
  watcher.activeLoops.add(key);
  console.log(`[LOOP] Démarrage surveillance ${key}`);

  try {
    while (isRaceActive(race)) {
      const secsLeft = Math.round((race.depart - Date.now()) / 1000);
      await watchRace(race);
      const delay = pollDelay(secsLeft);
      await new Promise(r => setTimeout(r, delay));
    }
  } catch(e) {
    console.error(`[LOOP][${key}] Erreur inattendue:`, e.message);
  } finally {
    watcher.activeLoops.delete(key);
    console.log(`[LOOP] Fin surveillance ${key}`);
  }
}

// Boucle principale : gère le programme et lance les boucles par course
async function watcherLoop() {
  let progLoaded   = false;
  let lastProgLoad = 0;

  while (true) {
    const now = Date.now();

    // Recharge le programme toutes les 5 minutes ou si vide
    if (!progLoaded || watcher.programme.length === 0 || now - lastProgLoad > 5 * 60_000) {
      progLoaded   = await loadProgramme();
      lastProgLoad = now;
    }

    // Lance une boucle dédiée pour chaque nouvelle course active
    for (const race of watcher.programme) {
      const key = raceKey(race);
      if (isRaceActive(race) && !watcher.activeLoops.has(key)) {
        watchRaceLoop(race); // fire-and-forget : pas d'await
      }
    }

    // La boucle principale vérifie toutes les 5s s'il y a de nouvelles courses à lancer
    await new Promise(r => setTimeout(r, 5_000));
  }
}

// ── API STATE (pour le front) ───────────────────────────────────
app.get('/api/alerts', (_, res) => {
  res.json(watcher.lastAlerts.slice(0, 20));
});

app.get('/api/snapstate', (req, res) => {
  const { key } = req.query;
  if (!key) return res.json({});
  const snap = watcher.snapMap[key];
  if (!snap) return res.json({ done: false, cotes: {} });
  res.json({ done: snap.done, cotes: snap.cotes, alerted: [...snap.alertedSet] });
});

// Health check
app.get('/health', (_, res) => res.json({
  status:      'ok',
  ts:          new Date().toISOString(),
  today:       watcher.today,
  races:       watcher.programme.length,
  activeLoops: [...watcher.activeLoops],
}));

// ── DÉMARRAGE ───────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`TBlaugranaTurf v2.1 — port ${PORT}`);
  watcherLoop().catch(e => {
    console.error('[WATCHER] Crash inattendu — relance dans 10s:', e);
    setTimeout(() => watcherLoop().catch(console.error), 10_000);
  });
});
