/**
 * ☕ Kawiarnie — API Backend
 *
 * Endpointy:
 *   GET  /health                  — status serwera
 *   GET  /api/data                — dane kawiarni (dashboard)
 *   POST /api/ingest/daily        — raport dzienny (JSON)
 *   POST /api/ingest/inventory    — inwentaryzacja (JSON)
 *   POST /api/ingest/csv          — upload CSV (multipart)
 *   POST /api/ingest/hours        — ewidencja godzin (JSON lub CSV)
 *   GET  /api/hours               — wszystkie rekordy godzin
 *
 * Autoryzacja: nagłówek x-api-key lub ?key=
 */

const express = require('express');
const cors    = require('cors');
const multer  = require('multer');
const fs      = require('fs');
const path    = require('path');

const app     = express();
const PORT    = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY || 'zmien-ten-klucz-na-swoj';

// ── Storage ───────────────────────────────────────────────────────────────────
const DATA_DIR    = path.join(__dirname, 'data');
const DATA_FILE   = path.join(DATA_DIR, 'reports.json');
const HOURS_FILE  = path.join(DATA_DIR, 'hours.json');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const DEFAULT_LOCATIONS = [
  "Szóstka","Liceum nr 1 Piastów","Budowlanka","Szesnastka",
  "Samochodówka","Trzysnatka","WSB","Bistro","Kawiarnia Zdroje","Kawiarnia Arkońska"
];

function loadStore() {
  try {
    if (!fs.existsSync(DATA_FILE)) return { locations: DEFAULT_LOCATIONS, daily: {}, inventory: {} };
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch { return { locations: DEFAULT_LOCATIONS, daily: {}, inventory: {} }; }
}
function saveStore(data) { fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf8'); }

function loadHours() {
  try {
    if (!fs.existsSync(HOURS_FILE)) return [];
    return JSON.parse(fs.readFileSync(HOURS_FILE, 'utf8'));
  } catch { return []; }
}
function saveHours(records) { fs.writeFileSync(HOURS_FILE, JSON.stringify(records, null, 2), 'utf8'); }

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '10mb' }));
app.use(express.text({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

app.use((req, _res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

function auth(req, res, next) {
  const key = req.headers['x-api-key'] || req.query.key;
  if (!key || key !== API_KEY) return res.status(401).json({ error: 'Brak autoryzacji.' });
  next();
}

// ── CSV Helpers ───────────────────────────────────────────────────────────────
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

// "3:15" → 3.25
function parseHoursStr(str) {
  const s = String(str || '').trim();
  if (s.includes(':')) {
    const [h, m] = s.split(':').map(Number);
    return (isNaN(h) ? 0 : h) + (isNaN(m) ? 0 : m) / 60;
  }
  const n = parseFloat(s.replace(',', '.'));
  return isNaN(n) ? 0 : n;
}

function today() { return new Date().toISOString().slice(0, 10); }

// Parser CSV godzin: Pracownik,Data,Godziny
function parseHoursCSV(text, fallbackDate) {
  const lines = text.split(/\r?\n/);
  const records = [];
  let headerIdx = { name: -1, date: -1, hours: -1 };
  let headerFound = false;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    const cols = parseCSVLine(line).map(c => clean(c));

    if (!headerFound) {
      const lower = cols.map(c => c.toLowerCase());
      const ni = lower.findIndex(c => c.includes('pracownik') || c.includes('imię') || c.includes('imie') || c.includes('name'));
      const di = lower.findIndex(c => c.includes('data') || c.includes('date'));
      const hi = lower.findIndex(c => c.includes('godzin') || c.includes('czas') || c.includes('hour') || c.includes('time'));
      if (ni !== -1 && hi !== -1) { headerIdx = { name: ni, date: di, hours: hi }; headerFound = true; }
      continue;
    }

    if (cols.length < 2) continue;
    const name  = cols[headerIdx.name] || '';
    const date  = (headerIdx.date >= 0 ? cols[headerIdx.date] : null) || fallbackDate || today();
    const hours = cols[headerIdx.hours] || '0';
    if (!name) continue;
    records.push({ name, date, hoursStr: hours, hoursDecimal: parseHoursStr(hours) });
  }
  return records;
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
    if (line === '') continue;
    if (section === 'product') {
      if (!prodHeader && line.startsWith('Product')) { prodHeader = true; continue; }
      if (prodHeader) {
        const c = parseCSVLine(line);
        if (c.length >= 7) products.push({ name: clean(c[0]), startStock: toNum(c[1]), delivery: toNum(c[2]), return_: toNum(c[3]), loss: toNum(c[4]), endStock: toNum(c[5]), sold: toNum(c[6]) });
      }
    } else if (section === 'finance') {
      if (!finHeader && line.startsWith('Gotówka')) { finHeader = true; continue; }
      if (finHeader && !finance) {
        const c = parseCSVLine(line);
        if (c.length >= 6) finance = { cashClose: parseFloat(clean(c[0]))||0, creditCard: parseFloat(clean(c[1]))||0, cashOut: parseFloat(clean(c[2]))||0, cashMorning: parseFloat(clean(c[3]))||0, revenue: parseFloat(clean(c[4]))||0, registerPrint: parseFloat(clean(c[5]))||0 };
      }
    } else if (section === 'notes') { notesArr.push(clean(line)); }
  }
  return { products, finance: finance || { cashClose:0,creditCard:0,cashOut:0,cashMorning:0,revenue:0,registerPrint:0 }, notes: notesArr.filter(Boolean).join('\n') };
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
    if (c.length >= 2) { const name = clean(c[0]); const qty = toNum(c[1]); if (name) items.push({ name, qty }); }
  }
  return { items };
}

function detectCSVType(text) {
  if (text.includes('PRODUCT REPORT') || text.includes('FINANCE REPORT')) return 'daily';
  const firstLine = (text.split(/\r?\n/).find(l => l.trim()) || '').toLowerCase();
  if (firstLine.includes('quantity') || firstLine.includes('qty')) return 'inventory';
  if (firstLine.includes('godzin') || firstLine.includes('hour') || firstLine.includes('czas')) return 'hours';
  return 'daily';
}

function ensureLocation(store, location) {
  if (location && !store.locations.includes(location)) store.locations.push(location);
}

// ── Routes ────────────────────────────────────────────────────────────────────

app.get('/health', (_req, res) => res.json({ ok: true, time: new Date().toISOString(), service: 'kawiarnie-api' }));

// GET wszystkie dane kawiarni
app.get('/api/data', auth, (_req, res) => res.json(loadStore()));

// GET godziny pracowników
app.get('/api/hours', auth, (_req, res) => res.json(loadHours()));

// POST raport dzienny (JSON)
app.post('/api/ingest/daily', auth, (req, res) => {
  const { location, date, products, finance, notes } = req.body;
  if (!location || !date) return res.status(400).json({ error: 'Wymagane: location, date' });
  const store = loadStore();
  const key = `${location}__${date}`;
  store.daily[key] = { kind:'daily', key, location, date, uploadedAt: new Date().toISOString(), source:'api', products: products||[], finance: finance||{}, notes: notes||'' };
  ensureLocation(store, location);
  saveStore(store);
  console.log(`✓ Raport dzienny: ${location} / ${date}`);
  res.json({ ok: true, key });
});

// POST inwentaryzacja (JSON)
app.post('/api/ingest/inventory', auth, (req, res) => {
  const { location, date, items } = req.body;
  if (!location || !date) return res.status(400).json({ error: 'Wymagane: location, date' });
  const store = loadStore();
  const key = `${location}__${date}`;
  store.inventory[key] = { kind:'inventory', key, location, date, uploadedAt: new Date().toISOString(), source:'api', items: items||[] };
  ensureLocation(store, location);
  saveStore(store);
  console.log(`✓ Inwentaryzacja: ${location} / ${date}`);
  res.json({ ok: true, key });
});

// POST ewidencja godzin (JSON)
// Body: { date: "2026-03-12", records: [{ name: "Jan Kowalski", hoursStr: "3:15", hoursDecimal: 3.25 }] }
app.post('/api/ingest/hours', auth, (req, res) => {
  const { date, records } = req.body;
  if (!records || !Array.isArray(records)) return res.status(400).json({ error: 'Wymagane: records[] z polami name, hoursStr, hoursDecimal' });

  const d = date || today();
  const incoming = records.map(r => ({
    name:         String(r.name || '').trim(),
    date:         r.date || d,
    hoursStr:     String(r.hoursStr || r.hours || '0'),
    hoursDecimal: typeof r.hoursDecimal === 'number' ? r.hoursDecimal : parseHoursStr(r.hoursStr || r.hours || '0'),
  })).filter(r => r.name);

  if (incoming.length === 0) return res.status(400).json({ error: 'Brak prawidłowych rekordów.' });

  const existing = loadHours();
  // Deduplikacja: usuń stare rekordy tej samej daty+pracownika, dodaj nowe
  const filtered = existing.filter(r => !incoming.some(n => n.name === r.name && n.date === r.date));
  const next = [...filtered, ...incoming];
  saveHours(next);

  console.log(`✓ Godziny: ${incoming.length} rekordów, data ${d}`);
  res.json({ ok: true, count: incoming.length, date: d });
});

// POST upload CSV (multipart lub raw text) — auto-detect type
app.post('/api/ingest/csv', auth, upload.single('file'), (req, res) => {
  let csvText = '';
  let location = req.body?.location || req.query.location || '';
  let date     = req.body?.date     || req.query.date     || today();

  if (req.file) {
    csvText  = req.file.buffer.toString('utf8');
    if (!location) location = req.file.originalname.replace(/\.csv$/i,'').split(/[-_]/)[0].trim();
  } else if (typeof req.body === 'string' && req.body.trim()) {
    csvText = req.body;
  }

  if (!csvText.trim()) return res.status(400).json({ error: 'Brak danych CSV.' });

  const type  = detectCSVType(csvText);
  const store = loadStore();

  if (type === 'hours') {
    const parsed = parseHoursCSV(csvText, date);
    if (parsed.length === 0) return res.status(400).json({ error: 'Nie znaleziono rekordów godzin w pliku.' });
    const existing = loadHours();
    const filtered = existing.filter(r => !parsed.some(n => n.name === r.name && n.date === r.date));
    saveHours([...filtered, ...parsed]);
    console.log(`✓ CSV godziny: ${parsed.length} rekordów`);
    return res.json({ ok: true, type: 'hours', count: parsed.length });
  }

  if (!location) return res.status(400).json({ error: 'Brak nazwy punktu (pole "location").' });
  const key = `${location}__${date}`;

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
  res.json({ ok: true, type, key });
});

// 404
app.use((req, res) => res.status(404).json({
  error: 'Endpoint nie istnieje.',
  available: ['GET /health','GET /api/data','GET /api/hours','POST /api/ingest/daily','POST /api/ingest/inventory','POST /api/ingest/csv','POST /api/ingest/hours']
}));

app.listen(PORT, () => {
  console.log(`\n☕ Kawiarnie API na porcie ${PORT}`);
  console.log(`   Health: http://localhost:${PORT}/health\n`);
});
