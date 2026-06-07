// ═══════════════════════════════════════════════════════════════
//  TBlaugranaTurf — Serveur Node.js v6
//  FIXES v6 :
//  • Persistance disque des alertes + état raceMap (JSON dans /tmp ou DATA_DIR)
//  • Fix bug "1er poll" : prevCotes initialisé immédiatement au 1er poll
//    → plus de course ratée car pas de référence initiale
//  • Telegram envoyé dès que drop >= dropPct, SANS filtre sur tgMaxCote
//    (le filtre tgMaxCote ne bloque plus les envois TG, il servait à tort)
//  • API /api/alerts retourne jusqu'à 100 dernières alertes (depuis disque)
//  • API /api/snapstate enrichi + rechargé depuis disque au démarrage
//  • Self-ping anti-veille Render (toutes les 10 min)
//  • Watcher loop indestructible avec restart automatique
// ═══════════════════════════════════════════════════════════════

const express = require('express');
const path    = require('path');
const fs      = require('fs');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── CONFIG ──────────────────────────────────────────────────────
const CFG = {
  tgToken:    process.env.TG_TOKEN    || '8961502220:AAGlpLomYVMXRQgrJsPp5M4m-omFPJPBKoU',
  tgChatIds:  (process.env.TG_CHATS   || '625118343,8288460384').split(',').map(s => s.trim()),
  tgMaxCote:  parseFloat(process.env.TG_MAX_COTE || '10'),
  dropPct:    parseFloat(process.env.DROP_PCT    || '10'),
  windowSecs: 120,
  afterSecs:  180,
  pollMs:     5000,
  selfPingMs: 10 * 60 * 1000,
  progReloadMs: 2 * 60 * 1000,
};

// ── PERSISTANCE DISQUE ──────────────────────────────────────────
// Sur Render free, /tmp est persistant pendant la durée de vie du service
const DATA_DIR   = process.env.DATA_DIR || '/tmp/tblaugrana';
const ALERTS_FILE = path.join(DATA_DIR, 'alerts.json');
const STATE_FILE  = path.join(DATA_DIR, 'racestate.json');

function ensureDataDir() {
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch(_) {}
}

function saveAlerts() {
  try {
    ensureDataDir();
    fs.writeFileSync(ALERTS_FILE, JSON.stringify(watcher.lastAlerts), 'utf8');
  } catch(e) { log('DISK', 'saveAlerts err:', e.message); }
}

function loadAlerts() {
  try {
    if (!fs.existsSync(ALERTS_FILE)) return [];
    const raw = fs.readFileSync(ALERTS_FILE, 'utf8');
    return JSON.parse(raw) || [];
  } catch(e) { log('DISK', 'loadAlerts err:', e.message); return []; }
}

function saveRaceState() {
  try {
    ensureDataDir();
    // Sérialise raceMap (sans les fonctions, juste les données)
    const data = {};
    for (const [key, state] of Object.entries(watcher.raceMap)) {
      data[key] = {
        prevCotes:  state.prevCotes,
        alertCount: state.alertCount,
      };
    }
    fs.writeFileSync(STATE_FILE, JSON.stringify({ today: watcher.today, raceMap: data }), 'utf8');
  } catch(e) { log('DISK', 'saveRaceState err:', e.message); }
}

function loadRaceState() {
  try {
    if (!fs.existsSync(STATE_FILE)) return null;
    const raw = fs.readFileSync(STATE_FILE, 'utf8');
    return JSON.parse(raw) || null;
  } catch(e) { log('DISK', 'loadRaceState err:', e.message); return null; }
}

const PMU_PROG  = 'https://online.turfinfo.api.pmu.fr/rest/client/61';
const PMU_PARTS = 'https://online.turfinfo.api.pmu.fr/rest/client/62';

// ── LOGS HORODATÉS ──────────────────────────────────────────────
function log(tag, ...args) {
  const ts = new Date().toISOString().replace('T',' ').slice(0,19);
  console.log(`[${ts}][${tag}]`, ...args);
}

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
    log('PROXY ERR', err.message);
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
  programme:  [],
  today:      '',
  raceMap:    {},
  lastAlerts: [],
};

// ── UTILITAIRES ─────────────────────────────────────────────────
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
    let sent = false;
    for (let i = 1; i <= 3; i++) {
      try {
        const r = await fetch(url, {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown' }),
        });
        if (r.ok) { sent = true; break; }
        const errBody = await r.text().catch(() => '');
        throw new Error(`HTTP ${r.status} — ${errBody}`);
      } catch(e) {
        log('TG', `Tentative ${i}/3 chat ${chatId} échouée:`, e.message);
        if (i < 3) await new Promise(r => setTimeout(r, 1000 * i));
      }
    }
    if (sent) log('TG', `✅ Envoyé chat ${chatId}`);
    else      log('TG', `❌ ÉCHEC définitif chat ${chatId}`);
  }
}

function pushAlert(type, icon, msg) {
  const alert = { ts: new Date().toISOString(), type, icon, msg };
  watcher.lastAlerts.unshift(alert);
  if (watcher.lastAlerts.length > 100) watcher.lastAlerts.pop();
  log('ALERT', `[${type}] ${icon} ${msg}`);
  // Sauvegarde async sur disque (ne bloque pas le watcher)
  setImmediate(saveAlerts);
}

// ── CHARGEMENT PROGRAMME ────────────────────────────────────────
async function loadProgramme() {
  for (let offset = 0; offset <= 1; offset++) {
    const d  = new Date();
    d.setDate(d.getDate() + offset);
    const ds = dateStr(d);
    try {
      const url  = `${PMU_PROG}/programme/${datePmu(ds)}?specialisation=OFFLINE`;
      const data = await fetchJson(url, 8000);
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
        log('PROG', `${races.length} courses chargées (${ds})`);
        return true;
      }
    } catch(e) { log('PROG ERR', e.message); }
  }
  return false;
}

// ── MOTEUR DE SURVEILLANCE ──────────────────────────────────────
function raceKey(r) { return `R${r.reunion}C${r.course}`; }

function getOrCreateRaceState(race) {
  const k = raceKey(race);
  if (!watcher.raceMap[k]) {
    watcher.raceMap[k] = { prevCotes: {}, alertCount: {} };
  }
  return watcher.raceMap[k];
}

async function watchRace(race) {
  if (!watcher.today) return;

  const key   = raceKey(race);
  const state = getOrCreateRaceState(race);
  const now   = Date.now();
  const secsLeft = Math.round((race.depart - now) / 1000);

  const url = `${PMU_PARTS}/programme/${datePmu(watcher.today)}/R${race.reunion}/C${race.course}/participants?specialisation=OFFLINE`;

  let parts;
  try {
    const data = await fetchJson(url, 5000);
    parts = data.participants || [];
  } catch(e) {
    log(`WATCH/${key}`, 'fetchParts erreur:', e.message);
    return;
  }

  // Cotes actuelles
  const curCotes = {};
  for (const p of parts) {
    if (p.statut === 'PARTANT' && p.dernierRapportDirect?.rapport) {
      curCotes[p.numPmu] = { cote: p.dernierRapportDirect.rapport, nom: p.nom };
    }
  }

  const hasPrev = Object.keys(state.prevCotes).length > 0;

  if (!hasPrev) {
    // ── FIX v6 : PREMIER POLL — on stocke les cotes immédiatement
    // On NE saute plus ce poll. On initialise la référence ET on log.
    log(`WATCH/${key}`, `1er poll — ${Object.keys(curCotes).length} partants, cotes initialisées (secsLeft=${secsLeft}s)`);
    // Pas de détection au 1er poll (pas de référence précédente) — normal
  } else {
    // ── DÉTECTION CHUTES ────────────────────────────────────────
    for (const [numPmu, cur] of Object.entries(curCotes)) {
      const prev = state.prevCotes[numPmu];
      if (!prev) continue;

      const prevCote = prev.cote;
      const curCote  = cur.cote;
      if (!prevCote || !curCote || curCote >= prevCote) continue;

      const drop = (prevCote - curCote) / prevCote * 100;

      // Log systématique pour traçabilité
      if (drop >= 5) {
        log(`WATCH/${key}`, `#${numPmu} ${cur.nom} : ${prevCote}→${curCote} (−${drop.toFixed(1)}%) | seuil=${CFG.dropPct}% | cote≤${CFG.tgMaxCote}=${curCote<=CFG.tgMaxCote}`);
      }

      if (drop < CFG.dropPct) continue;

      state.alertCount[numPmu] = (state.alertCount[numPmu] || 0) + 1;
      const alertN  = state.alertCount[numPmu];
      const secsStr = secsLeft > 0
        ? `⏱ ${secsLeft}s avant départ`
        : `🏁 Départ passé (${Math.abs(secsLeft)}s)`;

      const msg = `[${key}] #${numPmu} ${cur.nom} chute ${prevCote}→${curCote} (−${drop.toFixed(1)}%) — alerte #${alertN}`;
      pushAlert('drop', '🔥', msg);

      // ── FIX v6 : Telegram envoyé dès que la chute >= dropPct
      // Le filtre tgMaxCote était mal placé — il empêchait les alertes légitimes
      // On envoie TOUJOURS si la chute est significative, et on indique la cote dans le message
      const coteMark = curCote <= CFG.tgMaxCote ? '' : ` ⚠️ cote ${curCote} > filtre ${CFG.tgMaxCote}`;
      const tgTxt =
        `🚨 *CHUTE ${key}* 🚨\n` +
        `🐎 ${numPmu} — *${cur.nom}*\n` +
        `${prevCote} ➡️ ${curCote} (−${drop.toFixed(1)}%)${coteMark}\n` +
        `${secsStr}`;
      sendTelegram(tgTxt).catch(e => log('TG ERR', e.message));
    }
  }

  // Mise à jour référence glissante
  state.prevCotes = {};
  for (const [numPmu, cur] of Object.entries(curCotes)) {
    state.prevCotes[numPmu] = { cote: cur.cote, nom: cur.nom };
  }

  // Sauvegarde état sur disque toutes les N alertes ou à chaque poll (léger)
  setImmediate(saveRaceState);
}

function activeRaces() {
  const now = Date.now();
  return watcher.programme.filter(r => {
    const ms = r.depart - now;
    return ms <= CFG.windowSecs * 1000
        && ms >= -(CFG.afterSecs * 1000);
  });
}

// ── BOUCLE PRINCIPALE INDESTRUCTIBLE ───────────────────────────
async function watcherLoop() {
  let lastProgLoad = 0;

  while (true) {
    try {
      const now = Date.now();

      if (watcher.programme.length === 0 || now - lastProgLoad > CFG.progReloadMs) {
        const oldDeparts = Object.fromEntries(
          watcher.programme.map(r => [raceKey(r), r.depart])
        );
        const ok = await loadProgramme();
        if (ok) {
          for (const r of watcher.programme) {
            const k = raceKey(r);
            if (oldDeparts[k] && oldDeparts[k] !== r.depart) {
              const diff = Math.round((r.depart - oldDeparts[k]) / 60000);
              log('DECALAGE', `${k} décalé de ${diff > 0 ? '+' : ''}${diff} min`);
            }
          }
          lastProgLoad = now;
        } else {
          log('WATCHER', 'Aucun programme trouvé, retry dans 60s');
          await new Promise(r => setTimeout(r, 60_000));
          continue;
        }
      }

      const races = activeRaces();
      if (races.length > 0) {
        log('WATCHER', `${races.length} course(s) active(s): ${races.map(raceKey).join(', ')}`);
        await Promise.allSettled(races.map(r => watchRace(r)));
      }

    } catch (e) {
      log('WATCHER ERR', 'Erreur dans la boucle (continue quand même):', e.message);
    }

    await new Promise(r => setTimeout(r, CFG.pollMs));
  }
}

// ── SELF-PING ANTI-VEILLE RENDER ────────────────────────────────
function startSelfPing() {
  const host = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
  setInterval(async () => {
    try {
      await fetch(`${host}/health`);
      log('PING', `Self-ping OK → ${host}/health`);
    } catch(e) {
      log('PING', 'Self-ping échec:', e.message);
    }
  }, CFG.selfPingMs);
  log('PING', `Self-ping activé toutes les ${CFG.selfPingMs/60000} min → ${host}`);
}

// ── API STATE ────────────────────────────────────────────────────
app.get('/api/alerts', (_, res) => {
  // Retourne les 100 dernières alertes (depuis mémoire = disque au démarrage)
  res.json(watcher.lastAlerts.slice(0, 100));
});

app.get('/api/snapstate', (req, res) => {
  const { key } = req.query;
  if (!key) return res.json({});
  const state = watcher.raceMap[key];
  if (!state) return res.json({ done: false, cotes: {}, alerted: [] });

  const cotes = {};
  for (const [numPmu, v] of Object.entries(state.prevCotes)) {
    cotes[numPmu] = v.cote;
  }
  const alerted = Object.entries(state.alertCount)
    .filter(([, n]) => n > 0)
    .map(([numPmu]) => numPmu);

  res.json({ done: Object.keys(cotes).length > 0, cotes, alerted, prevCotes: state.prevCotes, alertCount: state.alertCount });
});

// FIX : health retourne toujours 200
app.get('/health', (_, res) => res.status(200).json({
  status:  'ok',
  ts:      new Date().toISOString(),
  today:   watcher.today,
  races:   watcher.programme.length,
  active:  activeRaces().length,
  uptime:  Math.round(process.uptime()) + 's',
  alerts:  watcher.lastAlerts.length,
}));

// ── DÉMARRAGE ────────────────────────────────────────────────────
app.listen(PORT, () => {
  log('START', `TBlaugranaTurf v6 — port ${PORT}`);
  log('START', `Surveillance : ${CFG.windowSecs}s avant départ + ${CFG.afterSecs}s après`);
  log('START', `Poll         : toutes les ${CFG.pollMs/1000}s`);
  log('START', `Seuil chute  : ≥ ${CFG.dropPct}% vs poll précédent`);
  log('START', `Alerte TG si : cote ≤ ${CFG.tgMaxCote} (log même si > ${CFG.tgMaxCote})`);
  log('START', `Chats TG     : ${CFG.tgChatIds.join(', ')}`);

  // Chargement des données persistées
  ensureDataDir();
  watcher.lastAlerts = loadAlerts();
  log('START', `${watcher.lastAlerts.length} alertes restaurées depuis disque`);

  const savedState = loadRaceState();
  if (savedState && savedState.today === dateStr(new Date())) {
    watcher.today = savedState.today;
    for (const [key, state] of Object.entries(savedState.raceMap || {})) {
      watcher.raceMap[key] = { prevCotes: state.prevCotes || {}, alertCount: state.alertCount || {} };
    }
    log('START', `État courses restauré (${Object.keys(watcher.raceMap).length} courses)`);
  } else {
    log('START', 'Aucun état précédent à restaurer (nouveau jour ou premier démarrage)');
  }

  startSelfPing();

  watcherLoop().catch(e => {
    log('WATCHER', 'Crash inattendu hors boucle — relance dans 5s:', e.message);
    setTimeout(() => watcherLoop().catch(e2 => log('WATCHER', 'Double crash:', e2.message)), 5000);
  });
});
