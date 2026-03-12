/**
 * ☕ Kawiarnie — API Backend
 * Przyjmuje dane z aplikacji Base44 i udostępnia je dla dashboardu.
 *
 * Endpointy:
 *   GET  /health                — status serwera
 *   GET  /api/data              — wszystkie dane (dla dashboardu)
 *   POST /api/ingest/daily      — raport dzienny z Base44 (JSON)
 *   POST /api/ingest/inventory  — inwentaryzacja z Base44 (JSON)
 *   POST /api/ingest/csv        — upload pliku CSV (multipart)
 *   DELETE /api/data/:type/:key — usunięcie rekordu
 *
 * Autoryzacja: nagłówek  x-api-key: <API_KEY>
 *              lub query  ?key=<API_KEY>
 */

const express  = require('express');
const cors     = require('cors');
const multer   = require('multer');
const fs       = require('fs');
const path     = require('path');

const app    = express();
const PORT   = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY || 'zmien-ten-klucz-na-swoj';

// ── Storage ───────────────────────────────────────────────────────────────────
const DATA_DIR  = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'reports.json');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const DEFAULT_LOCATIONS = [
  "Szóstka","Liceum nr 1 Piastów","Budowlanka","Szesnastka",
  "Samochodówka","Trzysnatka","WSB","Bistro","Kawiarnia Zdroje","Kawiarnia Arkońska"
];

function loadStore() {
  try {
    if (!fs.existsSync(DATA_FILE)) {
      return { locations: DEFAULT_LOCATIONS, daily: {}, inventory: {} };
    }
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch (e) {
    console.error('Błąd odczytu danych:', e.message);
    return { locations: DEFAULT_LOCATIONS, daily: {}, inventory: {} };
  }
}

function saveStore(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf8');
}

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '10mb' }));
app.use(express.text({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

// Logowanie requestów
app.use((req, _res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

// Autoryzacja
function auth(req, res, next) {
  const key = req.headers['x-api-key'] || req.query.key;
  if (!key || key !== API_KEY) {
    return res.status(401).json({ error: 'Brak autoryzacji. Podaj x-api-key.' });
  }
  next();
}

// ── CSV Parser (spójny z dashboardem) ────────────────────────────────────────
function parseCSVLine(line) {
  const result = []; let cur = ''; let inQ = false;
  for (const c of line) {
    if (c === '"') { inQ = !inQ; }
    else if (c === ',' && !inQ) { result.push(cur); cur = ''; }
    else { cur += c; }
  }
  result.push(cur);
  return result;
}

function clean(s) { return String(s ?? '').replace(/^"|"$/g, '').trim(); }

function toNum(val) {
  const s = clean(val);
  if (s === '' || s === '-') return 0;
  const n = parseFloat(s.replace(',', '.'));
  return isNaN(n) ? s : n;
}

function parseDailyCSV(text) {
  const lines = text.split(/\r?\n/);
  let section = null, prodHeader = false, finHeader = false;
  const products = []; let finance = null; const notesArr = [];

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line === 'PRODUCT REPORT')  { section = 'product'; continue; }
    if (line === 'FINANCE REPORT')  { section = 'finance'; continue; }
    if (line === 'NOTES')           { section = 'notes';   continue; }
    if (line === '')                { continue; }

    if (section === 'product') {
      if (!prodHeader && line.startsWith('Product')) { prodHeader = true; continue; }
      if (prodHeader) {
        const c = parseCSVLine(line);
        if (c.length >= 7) {
          products.push({
            name:       clean(c[0]),
            startStock: toNum(c[1]),
            delivery:   toNum(c[2]),
            return_:    toNum(c[3]),
            loss:       toNum(c[4]),
            endStock:   toNum(c[5]),
            sold:       toNum(c[6]),
          });
        }
      }
    } else if (section === 'finance') {
      if (!finHeader && line.startsWith('Gotówka')) { finHeader = true; continue; }
      if (finHeader && !finance) {
        const c = parseCSVLine(line);
        if (c.length >= 6) {
          finance = {
            cashClose:     parseFloat(clean(c[0])) || 0,
            creditCard:    parseFloat(clean(c[1])) || 0,
            cashOut:       parseFloat(clean(c[2])) || 0,
            cashMorning:   parseFloat(clean(c[3])) || 0,
            revenue:       parseFloat(clean(c[4])) || 0,
            registerPrint: parseFloat(clean(c[5])) || 0,
          };
        }
      }
    } else if (section === 'notes') {
      notesArr.push(clean(line));
    }
  }
  return {
    products,
    finance: finance || { cashClose:0,creditCard:0,cashOut:0,cashMorning:0,revenue:0,registerPrint:0 },
    notes: notesArr.filter(Boolean).join('\n'),
  };
}

function parseInventoryCSV(text) {
  const lines = text.split(/\r?\n/);
  const items = []; let headerSeen = false;
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    if (!headerSeen && line.toLowerCase().startsWith('product')) { headerSeen = true; continue; }
    if (!headerSeen) continue;
    const c = parseCSVLine(line);
    if (c.length >= 2) {
      const name = clean(c[0]);
      const qty  = toNum(c[1]);
      if (name) items.push({ name, qty });
    }
  }
  return { items };
}

function detectCSVType(text) {
  if (text.includes('PRODUCT REPORT') || text.includes('FINANCE REPORT')) return 'daily';
  const first = (text.split(/\r?\n/).find(l => l.trim()) || '').toLowerCase();
  if (first.includes('quantity') || first.includes('qty')) return 'inventory';
  return 'daily';
}

function ensureLocation(store, location) {
  if (location && !store.locations.includes(location)) {
    store.locations.push(location);
  }
}

// ── Routes ────────────────────────────────────────────────────────────────────

// Health check (bez autoryzacji — Render.com go używa)
app.get('/health', (_req, res) => {
  res.json({ ok: true, time: new Date().toISOString(), service: 'kawiarnie-api' });
});

// ── GET /api/data — pełne dane dla dashboardu ────────────────────────────────
app.get('/api/data', auth, (req, res) => {
  const store = loadStore();
  res.json(store);
});

// ── POST /api/ingest/daily — raport dzienny (JSON z Base44) ──────────────────
//
// Przykładowe body z Base44 backend function:
// {
//   "location": "Szóstka",
//   "date": "2026-03-12",
//   "products": [
//     { "name": "KANAPKA (szt.)", "startStock": 0, "delivery": 10,
//       "return_": 0, "loss": 0, "endStock": 0, "sold": 10 }
//   ],
//   "finance": {
//     "cashClose": 158, "creditCard": 781, "cashOut": 978,
//     "cashMorning": 905, "revenue": 1012, "registerPrint": 1011
//   },
//   "notes": "Młynek rano: 7047\nMłynek koniec: 7056"
// }
app.post('/api/ingest/daily', auth, (req, res) => {
  const { location, date, products, finance, notes } = req.body;

  if (!location || !date) {
    return res.status(400).json({ error: 'Wymagane pola: location, date' });
  }

  const store = loadStore();
  const key   = `${location}__${date}`;

  store.daily[key] = {
    kind:       'daily',
    key,
    location,
    date,
    uploadedAt: new Date().toISOString(),
    source:     'api',
    products:   products || [],
    finance:    finance  || { cashClose:0,creditCard:0,cashOut:0,cashMorning:0,revenue:0,registerPrint:0 },
    notes:      notes    || '',
  };

  ensureLocation(store, location);
  saveStore(store);

  console.log(`✓ Raport dzienny: ${location} / ${date} (${products?.length ?? 0} produktów)`);
  res.json({ ok: true, key, message: `Raport dla ${location} z ${date} zapisany.` });
});

// ── POST /api/ingest/inventory — inwentaryzacja (JSON z Base44) ──────────────
//
// Body:
// {
//   "location": "Liceum nr 1 Piastów",
//   "date": "2026-01-30",
//   "items": [
//     { "name": "KUBEK ESPRESSO", "qty": 31 },
//     { "name": "MLEKO", "qty": 13 }
//   ]
// }
app.post('/api/ingest/inventory', auth, (req, res) => {
  const { location, date, items } = req.body;

  if (!location || !date) {
    return res.status(400).json({ error: 'Wymagane pola: location, date' });
  }

  const store = loadStore();
  const key   = `${location}__${date}`;

  store.inventory[key] = {
    kind:       'inventory',
    key,
    location,
    date,
    uploadedAt: new Date().toISOString(),
    source:     'api',
    items:      items || [],
  };

  ensureLocation(store, location);
  saveStore(store);

  console.log(`✓ Inwentaryzacja: ${location} / ${date} (${items?.length ?? 0} pozycji)`);
  res.json({ ok: true, key, message: `Inwentaryzacja dla ${location} z ${date} zapisana.` });
});

// ── POST /api/ingest/csv — upload CSV (multipart lub raw text) ───────────────
// Można używać zamiast JSON gdy Base44 wysyła surowy plik CSV.
// Pola formularza:  file (CSV), location, date (opcjonalne — wykrywane z nazwy pliku)
app.post('/api/ingest/csv', auth, upload.single('file'), (req, res) => {
  let csvText = '';
  let location = req.body?.location || req.query.location || '';
  let date     = req.body?.date     || req.query.date     || '';

  // Multipart upload
  if (req.file) {
    csvText  = req.file.buffer.toString('utf8');
    location = location || req.file.originalname.replace(/\.csv$/i, '').split('-')[0].replace(/_/g,' ').trim();
  }
  // Raw text body (Content-Type: text/csv lub text/plain)
  else if (typeof req.body === 'string' && req.body.trim()) {
    csvText = req.body;
  }

  if (!csvText.trim()) {
    return res.status(400).json({ error: 'Brak danych CSV. Wyślij plik jako multipart (pole "file") lub surowy tekst CSV.' });
  }
  if (!location) {
    return res.status(400).json({ error: 'Brak nazwy punktu (pole "location").' });
  }
  if (!date) {
    date = new Date().toISOString().slice(0, 10);
  }

  const type  = detectCSVType(csvText);
  const store = loadStore();
  const key   = `${location}__${date}`;

  if (type === 'daily') {
    const parsed = parseDailyCSV(csvText);
    store.daily[key] = { kind:'daily', key, location, date, uploadedAt: new Date().toISOString(), source:'csv', ...parsed };
  } else {
    const parsed = parseInventoryCSV(csvText);
    store.inventory[key] = { kind:'inventory', key, location, date, uploadedAt: new Date().toISOString(), source:'csv', ...parsed };
  }

  ensureLocation(store, location);
  saveStore(store);

  console.log(`✓ CSV (${type}): ${location} / ${date}`);
  res.json({ ok: true, key, type, message: `CSV (${type}) dla ${location} z ${date} zapisany.` });
});

// ── DELETE /api/data/:type/:key ──────────────────────────────────────────────
app.delete('/api/data/:type/:key', auth, (req, res) => {
  const { type, key } = req.params;
  if (!['daily','inventory'].includes(type)) {
    return res.status(400).json({ error: 'Typ musi być "daily" lub "inventory".' });
  }
  const store = loadStore();
  const decodedKey = decodeURIComponent(key);
  if (!store[type][decodedKey]) {
    return res.status(404).json({ error: 'Rekord nie istnieje.' });
  }
  delete store[type][decodedKey];
  saveStore(store);
  res.json({ ok: true, message: `Usunięto ${type}/${decodedKey}` });
});

// ── 404 handler ──────────────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({
    error: 'Endpoint nie istnieje.',
    available: ['GET /health','GET /api/data','POST /api/ingest/daily','POST /api/ingest/inventory','POST /api/ingest/csv']
  });
});

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n☕ Kawiarnie API uruchomione na porcie ${PORT}`);
  console.log(`   Health: http://localhost:${PORT}/health`);
  console.log(`   Dane:   http://localhost:${PORT}/api/data?key=${API_KEY}\n`);
});
