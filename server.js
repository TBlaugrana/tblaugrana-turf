// ═══════════════════════════════════════════════════════════════
//  TBlaugranaTurf — Serveur Node.js v5
//  FIXES v4 :
//  • Self-ping anti-veille Render (toutes les 10 min)
//  • Watcher loop indestructible avec restart automatique
//  • Protection si watcher.today vide au moment du poll
//  • Telegram : retry x3 si échec réseau
//  • /api/health retourne 200 même si programme vide (évite restart Render)
//  • Logs horodatés pour debug Render
//  FIXES v5 :
//  • afterSecs passé à 180s (3 min) pour couvrir les faux départs
//  • Rechargement programme toutes les 2 min (capte les décalages horaires)
//  • Log explicite quand un décalage est détecté sur une course
// ═══════════════════════════════════════════════════════════════

const express = require('express');
const path    = require('path');

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
  windowSecs: 120,    // 2 min avant départ
  afterSecs:  180,    // v5 : 3 min après départ (couvre les faux départs)
  pollMs:     5000,   // poll toutes les 5s
  selfPingMs: 10 * 60 * 1000, // self-ping anti-veille toutes les 10 min
  progReloadMs: 2 * 60 * 1000, // v5 : recharge programme toutes les 2 min
};

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

// FIX : retry x3 avec délai exponentiel
async function sendTelegram(text, attempt = 1) {
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
        throw new Error(`HTTP ${r.status}`);
      } catch(e) {
        log('TG', `Tentative ${i}/3 chat ${chatId} échouée:`, e.message);
        if (i < 3) await new Promise(r => setTimeout(r, 1000 * i));
      }
    }
    if (!sent) log('TG', `ÉCHEC définitif chat ${chatId}`);
  }
}

function pushAlert(type, icon, msg) {
  const alert = { ts: new Date().toISOString(), type, icon, msg };
  watcher.lastAlerts.unshift(alert);
  if (watcher.lastAlerts.length > 50) watcher.lastAlerts.pop();
  log('ALERT', `[${type}] ${icon} ${msg}`);
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
  // FIX : protection si today pas encore chargé
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

  const curCotes = {};
  for (const p of parts) {
    if (p.statut === 'PARTANT' && p.dernierRapportDirect?.rapport) {
      curCotes[p.numPmu] = { cote: p.dernierRapportDirect.rapport, nom: p.nom };
    }
  }

  const hasPrev = Object.keys(state.prevCotes).length > 0;

  if (hasPrev) {
    for (const [numPmu, cur] of Object.entries(curCotes)) {
      const prev = state.prevCotes[numPmu];
      if (!prev) continue;

      const prevCote = prev.cote;
      const curCote  = cur.cote;
      if (!prevCote || !curCote || curCote >= prevCote) continue;

      const drop = (prevCote - curCote) / prevCote * 100;
      if (drop < CFG.dropPct) continue;

      state.alertCount[numPmu] = (state.alertCount[numPmu] || 0) + 1;
      const alertN  = state.alertCount[numPmu];
      const secsStr = secsLeft > 0 ? `⏱ ${secsLeft}s avant départ` : `🏁 Départ passé (${Math.abs(secsLeft)}s)`;

      // FIX : format du message cohérent avec le regex front (→ ASCII)
      const msg = `[${key}] #${numPmu} ${cur.nom} chute ${prevCote}→${curCote} (−${drop.toFixed(1)}%) — alerte #${alertN}`;
      pushAlert('drop', '🔥', msg);

      if (curCote <= CFG.tgMaxCote) {
        const tgTxt =
          `🚨 *CHUTE ${key}* 🚨\n` +
          `🐎 ${numPmu} — *${cur.nom}*\n` +
          `${prevCote} ➡️ ${curCote} (−${drop.toFixed(1)}%)\n` +
          `${secsStr}`;
        sendTelegram(tgTxt).catch(e => log('TG ERR', e.message));
      }
    }
  } else {
    log(`WATCH/${key}`, `1er poll — ${Object.keys(curCotes).length} partants (secsLeft=${secsLeft}s)`);
  }

  state.prevCotes = {};
  for (const [numPmu, cur] of Object.entries(curCotes)) {
    state.prevCotes[numPmu] = { cote: cur.cote, nom: cur.nom };
  }
}

// FIX : fenêtre étendue de -windowSecs à +afterSecs
function activeRaces() {
  const now = Date.now();
  return watcher.programme.filter(r => {
    const ms = r.depart - now;
    return ms <= CFG.windowSecs * 1000
        && ms >= -(CFG.afterSecs * 1000);  // v5: continue 3 min après départ (faux départs)
  });
}

// ── BOUCLE PRINCIPALE INDESTRUCTIBLE ───────────────────────────
async function watcherLoop() {
  let lastProgLoad = 0;

  while (true) {
    try {
      const now = Date.now();

      // Recharge le programme toutes les 2 min ou si vide
      if (watcher.programme.length === 0 || now - lastProgLoad > CFG.progReloadMs) {
        const oldDeparts = Object.fromEntries(
          watcher.programme.map(r => [raceKey(r), r.depart])
        );
        const ok = await loadProgramme();
        if (ok) {
          // Détection décalages : log si une heure de départ a changé
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
      // FIX : on logue le crash mais on NE sort PAS de la boucle
      log('WATCHER ERR', 'Erreur dans la boucle (continue quand même):', e.message);
    }

    await new Promise(r => setTimeout(r, CFG.pollMs));
  }
}

// ── SELF-PING ANTI-VEILLE RENDER ────────────────────────────────
// FIX: évite que Render (plan free) mette le service en veille
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
  res.json(watcher.lastAlerts.slice(0, 20));
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

// FIX : health retourne toujours 200 (sinon Render peut redémarrer le service)
app.get('/health', (_, res) => res.status(200).json({
  status:  'ok',
  ts:      new Date().toISOString(),
  today:   watcher.today,
  races:   watcher.programme.length,
  active:  activeRaces().length,
  uptime:  Math.round(process.uptime()) + 's',
}));

// ── DÉMARRAGE ────────────────────────────────────────────────────
app.listen(PORT, () => {
  log('START', `TBlaugranaTurf v4 — port ${PORT}`);
  log('START', `Surveillance : ${CFG.windowSecs}s avant départ + ${CFG.afterSecs}s après`);
  log('START', `Poll         : toutes les ${CFG.pollMs/1000}s`);
  log('START', `Seuil chute  : ≥ ${CFG.dropPct}% vs poll précédent`);
  log('START', `Alerte TG si : cote ≤ ${CFG.tgMaxCote}`);
  log('START', `Chats TG     : ${CFG.tgChatIds.join(', ')}`);

  // Self-ping anti-veille
  startSelfPing();

  // Lancement du watcher — jamais arrêté
  watcherLoop().catch(e => {
    log('WATCHER', 'Crash inattendu hors boucle — relance dans 5s:', e.message);
    setTimeout(() => watcherLoop().catch(e2 => log('WATCHER', 'Double crash:', e2.message)), 5000);
  });
});
