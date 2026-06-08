// ═══════════════════════════════════════════════════════════════
//  TBlaugranaTurf — Serveur Node.js v2
//  • Proxy PMU (contourne CORS)
//  • Moteur de surveillance H24 côté serveur
//    → snapshot auto à 1min du départ
//    → détection chute de cote ≥ 20%
//    → alertes Telegram même onglet fermé
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
  dropPct:      parseFloat(process.env.DROP_PCT     || '20'),
  snapSecs:     15,    // snapshot à 15s du départ
  postDepartMs: 3 * 60 * 1000,  // continue 3min après le départ (retards de départ)
  pollMs:       500,   // intervalle de polling en dehors de la zone critique
  pollCritMs:   500,   // intervalle dans la zone critique (< 90s)
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

// ── ÉTAT SERVEUR (exposé au front via /api/state) ───────────────
// Le front peut interroger l'état du moteur sans reconstruire les données.
const watcher = {
  programme:    [],    // [{reunion,course,depart,libelle,hip,disc}]
  today:        '',
  snapMap:      {},    // { "R1C3": { cotes:{numPmu:snap}, done:true, alertedSet:Set } }
  lastAlerts:   [],    // 50 dernières alertes pour le front
};

// ── UTILITAIRES ────────────────────────────────────────────────
const pad = n => String(n).padStart(2, '0');
function dateStr(d) { return `${d.getFullYear()}${pad(d.getMonth()+1)}${pad(d.getDate())}`; }
function datePmu(s) { return s.slice(6,8)+s.slice(4,6)+s.slice(0,4); }

async function fetchJson(url, timeoutMs = 6000) {
  const ctrl = new AbortController();
  const id   = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      signal:  ctrl.signal,
      headers: { 'Accept':'application/json', 'User-Agent':'Mozilla/5.0' },
    });
    clearTimeout(id);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } catch(e) { clearTimeout(id); throw e; }
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
      const data = await fetchJson(url);
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
// Tourne en permanence côté serveur.
// Pour chaque course dans la fenêtre [−60s, +3min] :
//   1. Snapshot des cotes à T−60s (si pas encore fait)
//   2. Polling des cotes → détection chute ≥ DROP_PCT%
//   3. Envoi Telegram si cheval ≤ tgMaxCote et chute ≥ DROP_PCT%

function raceKey(r) { return `R${r.reunion}C${r.course}`; }

function getOrCreateSnap(race) {
  const k = raceKey(race);
  if (!watcher.snapMap[k]) {
    watcher.snapMap[k] = { cotes: {}, done: false, alertedSet: new Set() };
  }
  return watcher.snapMap[k];
}

async function watchRace(race) {
  const key      = raceKey(race);
  const snap     = getOrCreateSnap(race);
  const now      = Date.now();
  const secsLeft = Math.round((race.depart - now) / 1000);
  const url      = `${PMU_PARTS}/programme/${datePmu(watcher.today)}/R${race.reunion}/C${race.course}/participants?specialisation=OFFLINE`;

  let parts;
  try {
    const data = await fetchJson(url, 5000);
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
  if (!snap.done) return;  // snapshot pas encore pris

  for (const p of parts) {
    if (p.statut !== 'PARTANT' || !p.dernierRapportDirect) continue;
    if (snap.alertedSet.has(p.numPmu)) continue;  // déjà alerté ce cheval

    const snapCote = snap.cotes[p.numPmu];
    const curCote  = p.dernierRapportDirect.rapport;
    if (!snapCote || !curCote) continue;

    const drop = (snapCote - curCote) / snapCote * 100;
    if (drop < CFG.dropPct) continue;

    snap.alertedSet.add(p.numPmu);

    const secsStr = secsLeft > 0 ? `⏱ ${secsLeft}s avant départ` : `🏁 ${Math.abs(secsLeft)}s après départ`;
    const msg     = `[${key}] ${p.nom} chute ${snapCote}→${curCote} (−${drop.toFixed(0)}%)`;
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

// Courses actives : celles dont on est dans la fenêtre de surveillance
function activeRaces() {
  const now = Date.now();
  return watcher.programme.filter(r => {
    const ms = r.depart - now;
    return ms <= CFG.snapSecs * 1000 + 10000   // dans les snapSecs+10s avant
        && ms >= -CFG.postDepartMs;              // ou jusqu'à postDepartMs après
  });
}

// Boucle principale du moteur
async function watcherLoop() {
  let progLoaded = false;
  let lastProgLoad = 0;

  while (true) {
    const now = Date.now();

    // Recharge le programme toutes les 5 minutes ou si vide
    if (!progLoaded || watcher.programme.length === 0 || now - lastProgLoad > 5 * 60_000) {
      progLoaded  = await loadProgramme();
      lastProgLoad = now;
    }

    const races = activeRaces();

    if (races.length > 0) {
      // Surveille toutes les courses actives en parallèle
      await Promise.allSettled(races.map(r => watchRace(r)));
      // Zone critique → polling rapide
      const mostUrgent = races.reduce((best, r) =>
        Math.abs(r.depart - now) < Math.abs(best.depart - now) ? r : best
      );
      const secsLeft = Math.round((mostUrgent.depart - now) / 1000);
      const delay = (secsLeft > 0 && secsLeft <= 90) ? CFG.pollCritMs : CFG.pollMs;
      await new Promise(r => setTimeout(r, delay));
    } else {
      // Pas de course active → attendre 10s
      await new Promise(r => setTimeout(r, 10_000));
    }
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
  // Convertit le Set en tableau pour JSON
  res.json({ done: snap.done, cotes: snap.cotes, alerted: [...snap.alertedSet] });
});

// Health check
app.get('/health', (_, res) => res.json({
  status:    'ok',
  ts:        new Date().toISOString(),
  today:     watcher.today,
  races:     watcher.programme.length,
  active:    activeRaces().length,
}));

// ── DÉMARRAGE ───────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`TBlaugranaTurf v2 — port ${PORT}`);
  // Lance le moteur en arrière-plan (n'arrête PAS le serveur si erreur)
  watcherLoop().catch(e => {
    console.error('[WATCHER] Crash inattendu — relance dans 10s:', e);
    setTimeout(() => watcherLoop().catch(console.error), 10_000);
  });
});
