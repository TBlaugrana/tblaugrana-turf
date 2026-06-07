// ═══════════════════════════════════════════════════════════════
//  TBlaugranaTurf — Serveur Node.js v3
//  • Proxy PMU (contourne CORS)
//  • Moteur de surveillance H24 côté serveur
//    → surveillance dans les 2 dernières minutes avant départ
//    → poll toutes les 5 secondes
//    → référence GLISSANTE : cote du poll précédent
//    → alerte si chute ≥ 10% par rapport au poll d'avant
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
  tgToken:      process.env.TG_TOKEN    || '8961502220:AAGlpLomYVMXRQgrJsPp5M4m-omFPJPBKoU',
  tgChatIds:    (process.env.TG_CHATS   || '625118343,8288460384').split(',').map(s => s.trim()),
  tgMaxCote:    parseFloat(process.env.TG_MAX_COTE || '10'),
  dropPct:      parseFloat(process.env.DROP_PCT    || '10'),   // seuil chute glissant (%)
  windowSecs:   120,   // fenêtre de surveillance : 2 min avant le départ
  pollMs:       5000,  // poll toutes les 5 secondes (fixe)
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
  programme:    [],    // [{reunion, course, depart, libelle, hip, disc}]
  today:        '',
  // raceMap : { "R1C3": { prevCotes: {numPmu: cote}, alertCount: {numPmu: n} } }
  raceMap:      {},
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

// ── MOTEUR DE SURVEILLANCE GLISSANT ───────────────────────────
// Pour chaque course dans la fenêtre [−windowSecs, 0] :
//   • On récupère les cotes actuelles
//   • Si on a déjà des cotes précédentes (poll d'avant) :
//       → On compare : chute ≥ DROP_PCT% → alerte
//   • On ÉCRASE les cotes précédentes par les cotes actuelles
//   → La référence est toujours le poll précédent, jamais un snapshot fixe

function raceKey(r) { return `R${r.reunion}C${r.course}`; }

function getOrCreateRaceState(race) {
  const k = raceKey(race);
  if (!watcher.raceMap[k]) {
    watcher.raceMap[k] = {
      prevCotes:   {},   // { numPmu: cote } — cotes du poll précédent
      alertCount:  {},   // { numPmu: n }    — nb d'alertes envoyées par cheval
    };
  }
  return watcher.raceMap[k];
}

async function watchRace(race) {
  const key      = raceKey(race);
  const state    = getOrCreateRaceState(race);
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

  // ── Cotes actuelles du poll ────────────────────────────────
  const curCotes = {};
  for (const p of parts) {
    if (p.statut === 'PARTANT' && p.dernierRapportDirect?.rapport) {
      curCotes[p.numPmu] = { cote: p.dernierRapportDirect.rapport, nom: p.nom };
    }
  }

  const hasPrev = Object.keys(state.prevCotes).length > 0;

  if (hasPrev) {
    // ── Détection chutes glissantes ──────────────────────────
    for (const [numPmu, cur] of Object.entries(curCotes)) {
      const prev = state.prevCotes[numPmu];
      if (!prev) continue;  // nouveau partant, pas de référence

      const prevCote = prev.cote;
      const curCote  = cur.cote;
      if (!prevCote || !curCote || curCote >= prevCote) continue;  // pas de chute

      const drop = (prevCote - curCote) / prevCote * 100;
      if (drop < CFG.dropPct) continue;

      // ── Alerte ──────────────────────────────────────────────
      state.alertCount[numPmu] = (state.alertCount[numPmu] || 0) + 1;
      const alertN  = state.alertCount[numPmu];
      const secsStr = secsLeft > 0 ? `⏱ ${secsLeft}s avant départ` : `🏁 Départ passé`;
      const msg     = `[${key}] #${numPmu} ${cur.nom} ${prevCote}→${curCote} (−${drop.toFixed(1)}%) — alerte #${alertN}`;
      pushAlert('drop', '🔥', msg);

      // Telegram si cote ≤ tgMaxCote
      if (curCote <= CFG.tgMaxCote) {
        const tgTxt =
          `🚨 *CHUTE ${key}* 🚨\n` +
          `🐎 ${numPmu} — *${cur.nom}*\n` +
          `${prevCote} ➡️ ${curCote} (−${drop.toFixed(1)}%)\n` +
          `${secsStr}`;
        sendTelegram(tgTxt).catch(e => console.error('[TG]', e.message));
      }
    }
  } else {
    // Premier poll de cette course : on initialise sans alerte
    console.log(`[WATCH][${key}] 1er poll — ${Object.keys(curCotes).length} partants enregistrés (secsLeft=${secsLeft}s)`);
  }

  // ── Écrase la référence par les cotes actuelles ────────────
  state.prevCotes = {};
  for (const [numPmu, cur] of Object.entries(curCotes)) {
    state.prevCotes[numPmu] = { cote: cur.cote, nom: cur.nom };
  }
}

// Courses dans la fenêtre de surveillance (2 min avant départ → départ)
function activeRaces() {
  const now = Date.now();
  return watcher.programme.filter(r => {
    const ms = r.depart - now;
    return ms <= CFG.windowSecs * 1000   // pas encore passé les windowSecs avant
        && ms >= 0;                       // pas encore parti (on s'arrête au départ)
  });
}

// Boucle principale — poll fixe toutes les 5s
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

    const races = activeRaces();

    if (races.length > 0) {
      await Promise.allSettled(races.map(r => watchRace(r)));
    }

    // Toujours attendre 5s, qu'il y ait des courses actives ou non
    await new Promise(r => setTimeout(r, CFG.pollMs));
  }
}

// ── API STATE (pour le front) ───────────────────────────────────
app.get('/api/alerts', (_, res) => {
  res.json(watcher.lastAlerts.slice(0, 20));
});

app.get('/api/snapstate', (req, res) => {
  const { key } = req.query;
  if (!key) return res.json({});
  const state = watcher.raceMap[key];
  if (!state) return res.json({ done: false, cotes: {}, alerted: [] });

  // Compatibilité front : on expose les prevCotes comme "cotes" de snapshot
  // et les chevaux ayant eu ≥1 alerte comme "alerted"
  const cotes   = {};
  for (const [numPmu, v] of Object.entries(state.prevCotes)) {
    cotes[numPmu] = v.cote;
  }
  const alerted = Object.entries(state.alertCount)
    .filter(([, n]) => n > 0)
    .map(([numPmu]) => numPmu);

  res.json({
    done:       Object.keys(cotes).length > 0,
    cotes,
    alerted,
    // champs natifs v3 (pour debug ou évolution future)
    prevCotes:  state.prevCotes,
    alertCount: state.alertCount,
  });
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
  console.log(`TBlaugranaTurf v3 — port ${PORT}`);
  console.log(`  Surveillance : ${CFG.windowSecs}s avant départ`);
  console.log(`  Poll         : toutes les ${CFG.pollMs/1000}s`);
  console.log(`  Seuil chute  : ≥ ${CFG.dropPct}% vs poll précédent`);
  console.log(`  Alerte TG si : cote ≤ ${CFG.tgMaxCote}`);
  watcherLoop().catch(e => {
    console.error('[WATCHER] Crash inattendu — relance dans 10s:', e);
    setTimeout(() => watcherLoop().catch(console.error), 10_000);
  });
});
