// ═══════════════════════════════════════════════════════
//  TBlaugranaTurf — Proxy Serveur Node.js
//  Contourne le CORS en faisant les appels PMU côté serveur
// ═══════════════════════════════════════════════════════

const express = require('express');
const path    = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Servir les fichiers statiques (HTML, CSS, JS) ──────
app.use(express.static(path.join(__dirname, 'public')));

// ── Proxy générique pour l'API PMU ───────────────────
// Toutes les requêtes vers /api/pmu/* sont relayées à
// l'API PMU correspondante côté serveur (pas de CORS).
//
// Exemples :
//   GET /api/pmu/prog/programme/03062026?specialisation=OFFLINE
//     → https://online.turfinfo.api.pmu.fr/rest/client/61/programme/03062026?specialisation=OFFLINE
//
//   GET /api/pmu/parts/programme/03062026/R1/C3/participants?specialisation=OFFLINE
//     → https://online.turfinfo.api.pmu.fr/rest/client/62/programme/03062026/R1/C3/participants?specialisation=OFFLINE

const PMU_PROG  = 'https://online.turfinfo.api.pmu.fr/rest/client/61';
const PMU_PARTS = 'https://online.turfinfo.api.pmu.fr/rest/client/62';

// Cache ETag côté serveur pour éviter les requêtes redondantes vers PMU
const serverEtags = {};

async function proxyPmu(targetBase, reqPath, reqQuery, res) {
  const qs  = reqQuery ? `?${reqQuery}` : '';
  const url = `${targetBase}${reqPath}${qs}`;

  const headers = {
    'Accept': 'application/json',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  };

  // Transmet l'ETag mémorisé pour profiter du 304
  if (serverEtags[url]) {
    headers['If-None-Match'] = serverEtags[url];
  }

  try {
    const ctrl   = new AbortController();
    const timerId = setTimeout(() => ctrl.abort(), 5000);

    const upstream = await fetch(url, { headers, signal: ctrl.signal });
    clearTimeout(timerId);

    // Mémorise le nouvel ETag si présent
    const etag = upstream.headers.get('etag');
    if (etag) serverEtags[url] = etag;

    // Transmet les headers importants au client
    res.set('Content-Type', upstream.headers.get('content-type') || 'application/json');
    if (etag) res.set('ETag', etag);

    res.status(upstream.status);

    if (upstream.status === 304) {
      return res.end();
    }

    const body = await upstream.text();
    res.send(body);

  } catch (err) {
    if (err.name === 'AbortError') {
      return res.status(504).json({ error: 'Timeout PMU API' });
    }
    console.error('[PMU Proxy Error]', err.message);
    res.status(502).json({ error: 'PMU API unreachable', detail: err.message });
  }
}

// Route : programme
app.get('/api/pmu/prog/*', (req, res) => {
  const subPath = req.path.replace('/api/pmu/prog', '');
  proxyPmu(PMU_PROG, subPath, req.query ? new URLSearchParams(req.query).toString() : '', res);
});

// Route : participants / cotes
app.get('/api/pmu/parts/*', (req, res) => {
  const subPath = req.path.replace('/api/pmu/parts', '');
  proxyPmu(PMU_PARTS, subPath, req.query ? new URLSearchParams(req.query).toString() : '', res);
});

// Health check pour Render
app.get('/health', (_, res) => res.json({ status: 'ok', ts: new Date().toISOString() }));

app.listen(PORT, () => {
  console.log(`TBlaugranaTurf Proxy — port ${PORT}`);
});
