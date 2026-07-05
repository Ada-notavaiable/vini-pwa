// Vini PWA — backend Express + SQLite (via sql.js) + jimp per il resize delle foto.
// Mirroring del progetto `orto`, adattato ai vini. Pensato per Orange Pi.

const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const initSqlJs = require('sql.js');
const Jimp = require('jimp');
const ExifParser = require('exif-parser');
const AdmZip = require('adm-zip');

const PORT = process.env.PORT || 3000;
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'vini.db');
const PHOTO_DIR = process.env.PHOTO_DIR || path.join(__dirname, 'photos');

const PHOTO_MAX_DIM = 1024;       // px max lato lungo della foto ridimensionata
const PHOTO_JPEG_QUALITY = 80;    // qualità JPEG di output (jimp 0-100)

// ---------- bootstrap SQLite ----------

let db = null;
let dbSaveTimer = null;

async function initDb() {
  const SQL = await initSqlJs();
  if (fs.existsSync(DB_PATH)) {
    const file = fs.readFileSync(DB_PATH);
    db = new SQL.Database(file);
    console.log(`[db] Caricato DB esistente: ${DB_PATH} (${file.length} bytes)`);
  } else {
    db = new SQL.Database();
    console.log(`[db] Creo nuovo DB in: ${DB_PATH}`);
  }

  db.run(`
    CREATE TABLE IF NOT EXISTS stores (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS wines (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      store_id INTEGER,
      rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 10),
      note TEXT,
      photo_path TEXT,
      wine_type TEXT,
      price REAL,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (store_id) REFERENCES stores(id) ON DELETE SET NULL
    );
  `);
  db.run(`CREATE INDEX IF NOT EXISTS idx_wines_created_at ON wines(created_at DESC);`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_wines_rating ON wines(rating DESC);`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_wines_wine_type ON wines(wine_type);`);

  // Migrazione: aggiunge le colonne nuove ai DB creati prima dell'introduzione di wine_type/price.
  // PRAGMA table_info evita di mascherare errori veri con un try/catch sul ALTER TABLE.
  const wineCols = db.exec(`PRAGMA table_info(wines)`);
  if (wineCols.length) {
    const cols = wineCols[0].values.map(c => c[1]);
    if (!cols.includes('wine_type')) db.run(`ALTER TABLE wines ADD COLUMN wine_type TEXT`);
    if (!cols.includes('price')) db.run(`ALTER TABLE wines ADD COLUMN price REAL`);
  }

  saveDB(true);
}

function saveDB(immediate = false) {
  if (dbSaveTimer) clearTimeout(dbSaveTimer);
  const doSave = () => {
    try {
      const data = db.export();
      fs.writeFileSync(DB_PATH, Buffer.from(data));
    } catch (e) {
      console.error('[db] errore salvataggio:', e);
    }
  };
  if (immediate) doSave();
  else dbSaveTimer = setTimeout(doSave, 600);
}

process.on('SIGINT', () => { saveDB(true); process.exit(0); });
process.on('SIGTERM', () => { saveDB(true); process.exit(0); });

// ---------- helpers ----------

function rowsOf(result) {
  // sql.js ritorna { columns, values } — restituiamo un array di oggetti.
  const cols = result.columns;
  return result.values.map((row) => {
    const obj = {};
    cols.forEach((c, i) => { obj[c] = row[i]; });
    return obj;
  });
}

function getOne(sql, params = []) {
  const r = db.exec(sql, params);
  if (!r.length) return null;
  const rows = rowsOf(r[0]);
  return rows.length ? rows[0] : null;
}

function getAll(sql, params = []) {
  const r = db.exec(sql, params);
  if (!r.length) return [];
  return rowsOf(r[0]);
}

function runSql(sql, params = []) {
  db.run(sql, params);
  // restituisce l'ultimo id inserito (se AUTOINCREMENT presente)
  const idR = db.exec('SELECT last_insert_rowid() AS id');
  return idR.length ? idR[0].values[0][0] : null;
}

async function ensurePhotoDir() {
  if (!fs.existsSync(PHOTO_DIR)) {
    fs.mkdirSync(PHOTO_DIR, { recursive: true });
    console.log(`[photo] Creata directory ${PHOTO_DIR}`);
  }
}

// Parser CSV minimo: separatore `;`, supporta quoting ("..." con "" per il carattere "),
// gestisce BOM UTF-8 iniziale e \r\n / \n. Restituisce array di righe (array di stringhe).
function parseCsv(text) {
  if (!text) return [];
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1); // BOM
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else { inQuotes = false; }
      } else {
        field += c;
      }
    } else {
      if (c === '"') inQuotes = true;
      else if (c === ';') { row.push(field); field = ''; }
      else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
      else if (c === '\r') { /* ignore */ }
      else field += c;
    }
  }
  if (field !== '' || row.length > 0) { row.push(field); rows.push(row); }
  return rows;
}

async function processPhoto(inputPath, originalName) {
  // jimp 0.22 legge i pixel "così come sono" senza applicare EXIF Orientation,
  // quindi se una foto iPhone è registrata in landscape ma va mostrata vertical
  // (EXIF Orientation = 6), dobbiamo ruotare manualmente il bitmap.
  const orientation = getJpegExifOrientation(inputPath);

  const img = await Jimp.read(inputPath);
  applyExifOrientation(img, orientation);
  const w0 = img.bitmap.width;
  const h0 = img.bitmap.height;
  const longest = Math.max(w0, h0);
  if (longest > PHOTO_MAX_DIM) {
    if (w0 >= h0) img.resize(PHOTO_MAX_DIM, Jimp.AUTO);
    else img.resize(Jimp.AUTO, PHOTO_MAX_DIM);
  }
  img.quality(PHOTO_JPEG_QUALITY);
  const ext = '.jpg';
  const base = path.parse(originalName).name
    .replace(/[^a-zA-Z0-9_-]+/g, '_')
    .slice(0, 40) || 'wine';
  const filename = `${Date.now()}_${base}${ext}`;
  const outPath = path.join(PHOTO_DIR, filename);
  await img.writeAsync(outPath);
  try { fs.unlinkSync(inputPath); } catch (_) { /* ignore */ }
  return { filename, width: img.bitmap.width, height: img.bitmap.height };
}

// Restituisce il valore numerico del tag EXIF Orientation (1..8) presente nel JPEG,
// cercando solo nei primi 64 KB dove risiede l'APP1/EXIF. Nessuna corrispondenza → 1.
function getJpegExifOrientation(filePath) {
  let fd = null;
  try {
    fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(65536);
    fs.readSync(fd, buf, 0, 65536, 0);
    const result = ExifParser.create(buf).parse();
    const o = result && result.tags && Number(result.tags.Orientation);
    return Number.isInteger(o) && o >= 1 && o <= 8 ? o : 1;
  } catch (_) {
    return 1;
  } finally {
    if (fd != null) { try { fs.closeSync(fd); } catch (_) { /* ignore */ } }
  }
}

// Applica la rotazione/mirror che "annulla" il tag EXIF Orientation sul bitmap.
// jimp 0.22.x: img.rotate(deg) è orario (clockwise positive).
//   O=3 → 180°     (foto capovolta)
//   O=6 → +90° CW  (iPhone portrait: i pixel sono salvati ruotati di 90° CCW; serve CW per raddrizzarli)
//   O=8 → 270° CW  (viceversa)
//   2/4/5/7 → specchi + combinazioni (rari dalle foto utente)
function applyExifOrientation(img, orientation) {
  if (!orientation || orientation === 1) return;
  switch (orientation) {
    case 1: break;
    case 2: img.flip(false, true); break;        // mirror orizzontale
    case 3: img.rotate(180); break;
    case 4: img.flip(true, false); break;        // mirror verticale
    case 5: img.rotate(270).flip(false, true); break;
    case 6: img.rotate(90); break;
    case 7: img.rotate(90).flip(false, true); break;
    case 8: img.rotate(270); break;
    default: break;
  }
}

// ---------- express setup ----------

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

// servir foto da PHOTO_DIR al path /photos/<file>
app.use('/photos', express.static(PHOTO_DIR, { maxAge: '7d', fallthrough: true }));

// upload multer in memoria + file temporaneo su disco.
// Su Orange Pi con 256 MB di RAM, jimp carica l'immagine intera in memoria:
// teniamoci bassi per evitare OOM sui device più piccoli.
const upload = multer({
  dest: path.join(require('os').tmpdir(), 'vinipwa-uploads'),
  limits: { fileSize: 8 * 1024 * 1024 }, // 8 MB di input → basta e avanza per 1024px JPEG
});

// ---------- API: stores ----------

app.get('/api/stores', (req, res) => {
  const rows = getAll(`SELECT id, name, created_at FROM stores ORDER BY name COLLATE NOCASE ASC`);
  res.json(rows);
});

app.post('/api/stores', (req, res) => {
  const name = (req.body?.name || '').trim();
  if (!name) return res.status(400).json({ error: 'nome negozio obbligatorio' });
  const existing = getOne(`SELECT id FROM stores WHERE LOWER(name)=LOWER(?)`, [name]);
  if (existing) return res.status(409).json({ error: 'negozio già esistente', id: existing.id });
  try {
    const id = runSql(`INSERT INTO stores (name) VALUES (?)`, [name]);
    saveDB();
    res.json({ id, name });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.put('/api/stores/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const name = (req.body?.name || '').trim();
  if (!name) return res.status(400).json({ error: 'nome negozio obbligatorio' });
  const exists = getOne(`SELECT id FROM stores WHERE id=?`, [id]);
  if (!exists) return res.status(404).json({ error: 'negozio non trovato' });
  const dup = getOne(`SELECT id FROM stores WHERE LOWER(name)=LOWER(?) AND id<>?`, [name, id]);
  if (dup) return res.status(409).json({ error: 'nome già usato da un altro negozio' });
  runSql(`UPDATE stores SET name=? WHERE id=?`, [name, id]);
  saveDB();
  res.json({ ok: true });
});

app.delete('/api/stores/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  // Le righe wine con questo store_id avranno store_id=NULL via ON DELETE SET NULL.
  runSql(`DELETE FROM stores WHERE id=?`, [id]);
  saveDB();
  res.json({ ok: true });
});

// ---------- API: wines ----------

app.get('/api/wines', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 200, 1000);
  // created_at esiste sia in wines che in stores → va sempre qualificato w.x.
  const sort = req.query.sort === 'rating' ? 'w.rating DESC, w.created_at DESC' : 'w.created_at DESC';
  const rows = getAll(
    `SELECT w.id, w.name, w.store_id, w.rating, w.note, w.photo_path, w.wine_type, w.price, w.created_at,
            s.name AS store_name
       FROM wines w LEFT JOIN stores s ON s.id = w.store_id
       ORDER BY ${sort}
       LIMIT ?`,
    [limit]
  );
  res.json(rows);
});

app.get('/api/wines/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const w = getOne(
    `SELECT w.*, s.name AS store_name
       FROM wines w LEFT JOIN stores s ON s.id = w.store_id
       WHERE w.id=?`,
    [id]
  );
  if (!w) return res.status(404).json({ error: 'vino non trovato' });
  res.json(w);
});

app.post('/api/wines', (req, res) => {
  const name = (req.body?.name || '').trim();
  const rating = parseInt(req.body?.rating, 10);
  const note = (req.body?.note || '').trim() || null;
  const storeIdRaw = req.body?.store_id;
  const storeId = (storeIdRaw === '' || storeIdRaw == null) ? null : parseInt(storeIdRaw, 10);

  if (!name) return res.status(400).json({ error: 'nome vino obbligatorio' });
  if (!Number.isInteger(rating) || rating < 1 || rating > 10) {
    return res.status(400).json({ error: 'rating deve essere un intero tra 1 e 10' });
  }
  if (storeId !== null && !getOne(`SELECT id FROM stores WHERE id=?`, [storeId])) {
    return res.status(400).json({ error: 'store_id non valido' });
  }

  const wT = req.body?.wine_type;
  if (wT != null && wT !== '' && !['bianco','rosso'].includes(String(wT))) {
    return res.status(400).json({ error: 'wine_type non valido (ammessi: bianco, rosso o null)' });
  }
  const wineType = (wT == null || wT === '') ? null : String(wT);

  const p = req.body?.price;
  const priceNum = (p == null || p === '') ? null : Number(String(p).replace(',', '.'));
  if (priceNum != null && (!Number.isFinite(priceNum) || priceNum < 0)) {
    return res.status(400).json({ error: 'price non valido (serve numero >= 0)' });
  }
  const price = priceNum != null ? Math.round(priceNum * 100) / 100 : null;

  const id = runSql(
    `INSERT INTO wines (name, store_id, rating, note, wine_type, price) VALUES (?, ?, ?, ?, ?, ?)`,
    [name, storeId, rating, note, wineType, price]
  );
  saveDB();
  res.json({ id });
});

app.put('/api/wines/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const exists = getOne(`SELECT id FROM wines WHERE id=?`, [id]);
  if (!exists) return res.status(404).json({ error: 'vino non trovato' });

  const name = (req.body?.name || '').trim();
  const rating = parseInt(req.body?.rating, 10);
  const note = (req.body?.note || '').trim() || null;
  const storeIdRaw = req.body?.store_id;
  const storeId = (storeIdRaw === '' || storeIdRaw == null) ? null : parseInt(storeIdRaw, 10);

  if (!name) return res.status(400).json({ error: 'nome vino obbligatorio' });
  if (!Number.isInteger(rating) || rating < 1 || rating > 10) {
    return res.status(400).json({ error: 'rating deve essere un intero tra 1 e 10' });
  }
  if (storeId !== null && !getOne(`SELECT id FROM stores WHERE id=?`, [storeId])) {
    return res.status(400).json({ error: 'store_id non valido' });
  }

  const wT = req.body?.wine_type;
  if (wT != null && wT !== '' && !['bianco','rosso'].includes(String(wT))) {
    return res.status(400).json({ error: 'wine_type non valido (ammessi: bianco, rosso o null)' });
  }
  const wineType = (wT == null || wT === '') ? null : String(wT);

  const p = req.body?.price;
  const priceNum = (p == null || p === '') ? null : Number(String(p).replace(',', '.'));
  if (priceNum != null && (!Number.isFinite(priceNum) || priceNum < 0)) {
    return res.status(400).json({ error: 'price non valido (serve numero >= 0)' });
  }
  const price = priceNum != null ? Math.round(priceNum * 100) / 100 : null;

  runSql(
    `UPDATE wines SET name=?, store_id=?, rating=?, note=?, wine_type=?, price=? WHERE id=?`,
    [name, storeId, rating, note, wineType, price, id]
  );
  saveDB();
  res.json({ ok: true });
});

app.delete('/api/wines/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const w = getOne(`SELECT photo_path FROM wines WHERE id=?`, [id]);
  if (w && w.photo_path) {
    const p = path.join(PHOTO_DIR, w.photo_path);
    fs.unlink(p, () => { /* ignore */ });
  }
  runSql(`DELETE FROM wines WHERE id=?`, [id]);
  saveDB();
  res.json({ ok: true });
});

// upload foto vino: ridimensiona e salva nel PHOTO_DIR.
app.post('/api/wines/:id/photo', upload.single('photo'), async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'id non valido' });
  const exists = getOne(`SELECT id, photo_path FROM wines WHERE id=?`, [id]);
  if (!exists) return res.status(404).json({ error: 'vino non trovato' });
  if (!req.file) return res.status(400).json({ error: 'file mancante' });
  try {
    await ensurePhotoDir();
    const { filename, width, height } = await processPhoto(req.file.path, req.file.originalname);
    // cancella la vecchia foto, se presente
    if (exists.photo_path) {
      const old = path.join(PHOTO_DIR, exists.photo_path);
      fs.unlink(old, () => { /* ignore */ });
    }
    runSql(`UPDATE wines SET photo_path=? WHERE id=?`, [filename, id]);
    saveDB();
    res.json({ filename, width, height, url: `/photos/${filename}` });
  } catch (e) {
    res.status(500).json({ error: 'errore elaborazione foto: ' + (e.message || e) });
  }
});

app.delete('/api/wines/:id/photo', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const w = getOne(`SELECT photo_path FROM wines WHERE id=?`, [id]);
  if (!w) return res.status(404).json({ error: 'vino non trovato' });
  if (w.photo_path) {
    const p = path.join(PHOTO_DIR, w.photo_path);
    fs.unlink(p, () => { /* ignore */ });
    runSql(`UPDATE wines SET photo_path=NULL WHERE id=?`, [id]);
    saveDB();
  }
  res.json({ ok: true });
});

// ---------- API: storage (foto, DB, disco) ----------

app.get('/api/storage', (req, res) => {
  try {
    // Conta e somma le dimensioni dei file nella PHOTO_DIR.
    let photoCount = 0;
    let photoBytes = 0;
    if (fs.existsSync(PHOTO_DIR)) {
      const files = fs.readdirSync(PHOTO_DIR);
      for (const f of files) {
        try {
          const st = fs.statSync(path.join(PHOTO_DIR, f));
          if (st.isFile()) { photoCount++; photoBytes += st.size; }
        } catch (_) { /* file in race → ignora */ }
      }
    }
    // Dimensione del DB SQLite.
    let dbBytes = 0;
    try {
      if (fs.existsSync(DB_PATH)) dbBytes = fs.statSync(DB_PATH).size;
    } catch (_) { /* ignore */ }

    // Spazio disco: fs.statfs richiede Node 18.15+ (node:20-alpine ok).
    let diskTotal = null, diskFree = null;
    try {
      const sf = fs.statfsSync ? fs.statfsSync(PHOTO_DIR) : fs.statfs(PHOTO_DIR);
      diskTotal = sf.blocks * sf.bsize;
      diskFree  = sf.bavail * sf.bsize;
    } catch (_) { /* vecchia Node o filesystem non supportato */ }

    res.json({
      photo_count: photoCount,
      photo_total_bytes: photoBytes,
      photo_avg_bytes: photoCount ? Math.round(photoBytes / photoCount) : 0,
      db_bytes: dbBytes,
      app_bytes: photoBytes + dbBytes,
      disk_total_bytes: diskTotal,
      disk_free_bytes: diskFree
    });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// ---------- API: stats ----------

app.get('/api/stats', (req, res) => {
  const totals = getOne(`SELECT COUNT(*) AS total_wines FROM wines`) || { total_wines: 0 };
  const storeCount = getOne(`SELECT COUNT(*) AS total_stores FROM stores`) || { total_stores: 0 };
  const avgRating = getOne(`SELECT AVG(rating) AS avg_rating FROM wines`) || { avg_rating: null };

  const topWines = getAll(
    `SELECT w.id, w.name, w.rating, s.name AS store_name
       FROM wines w LEFT JOIN stores s ON s.id = w.store_id
       ORDER BY w.rating DESC, w.created_at DESC
       LIMIT 5`
  );
  // Per la sezione "vini per negozio" raggruppati per tipo carico tutti i vini in un colpo solo
  // (sono in genere centinaia, non migliaia) e poi li partiziono in memoria. Restituisce un array
  // di negozi con conteggi per ciascun tipo e gli elenchi completi dei vini divisi per tipo,
  // così la pagina stats può renderizzare un blocco espandibile senza round-trip aggiuntivi.
  // Selezione completa dei campi vino necessari alla pagina stats: la lista "vini per negozio"
  // ora mostra le stesse wine-card della home (con foto, tipo, nota), quindi servono anche
  // photo_path, wine_type, note e created_at completo.
  const allWines = getAll(
    `SELECT w.id, w.name, w.store_id, w.rating, w.note, w.photo_path, w.wine_type, w.price,
            w.created_at
       FROM wines w
       ORDER BY w.created_at DESC`
  );
  // Carica tutti i negozi in un colpo solo: evita N+1 query nel loop di partizione.
  const storesById = new Map();
  for (const s of getAll(`SELECT id, name FROM stores`)) {
    storesById.set(Number(s.id), s.name);
  }
  const byStoreMap = new Map();
  for (const w of allWines) {
    if (w.store_id == null) continue;
    let s = byStoreMap.get(Number(w.store_id));
    if (!s) {
      const sName = storesById.get(Number(w.store_id));
      if (!sName) continue;
      s = {
        id: Number(w.store_id), name: sName,
        count: 0, avg_rating: null,
        count_bianco: 0, count_rosso: 0, count_null: 0,
        wines: { bianco: [], rosso: [], null_type: [] },
        _ratingsSum: 0, _ratingsN: 0,
      };
      byStoreMap.set(Number(w.store_id), s);
    }
    s.count++;
    if (Number.isInteger(w.rating)) { s._ratingsSum += w.rating; s._ratingsN++; }
    const slot = w.wine_type === 'bianco' ? 'bianco'
                : w.wine_type === 'rosso'  ? 'rosso'
                : 'null_type';
    if (slot === 'bianco') s.count_bianco++;
    else if (slot === 'rosso') s.count_rosso++;
    else s.count_null++;
    s.wines[slot].push({
      id: w.id,
      name: w.name,
      rating: w.rating,
      price: w.price,
      note: w.note,
      photo_path: w.photo_path,
      wine_type: w.wine_type,
      created_at: w.created_at,
    });
  }
  const byStore = Array.from(byStoreMap.values()).map(s => {
    const o = {
      id: s.id, name: s.name, count: s.count,
      avg_rating: s._ratingsN > 0 ? +(s._ratingsSum / s._ratingsN).toFixed(2) : null,
      count_bianco: s.count_bianco, count_rosso: s.count_rosso, count_null: s.count_null,
      wines: s.wines,
    };
    return o;
  }).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));

  const byMonth = getAll(
    `SELECT substr(created_at, 1, 7) AS month, COUNT(*) AS count
       FROM wines
       GROUP BY substr(created_at, 1, 7)
       ORDER BY month DESC
       LIMIT 12`
  );
  const recent = getAll(
    `SELECT w.id, w.name, w.rating, w.created_at, w.photo_path, w.wine_type, w.price,
            s.name AS store_name
       FROM wines w LEFT JOIN stores s ON s.id = w.store_id
       ORDER BY w.created_at DESC
       LIMIT 10`
  );

  res.json({
    total_wines: totals.total_wines,
    total_stores: storeCount.total_stores,
    avg_rating: avgRating.avg_rating,
    top_wines: topWines,
    by_store: byStore,
    by_month: byMonth,
    recent,
  });
});

// Import CSV: multipart upload (campo 'csv'), separatore ';', header atteso:
//   id;name;store;rating;note;photo;created_at
// Shop non trovati → store_id NULL (non creiamo negozi automaticamente).
// Foto in CSV vengono IGNORATE (non associabili a file reali via solo CSV).
app.post('/api/wines/import-csv', upload.single('csv'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'file CSV mancante' });
  let raw;
  try {
    raw = fs.readFileSync(req.file.path, 'utf8');
  } catch (e) {
    return res.status(500).json({ error: 'lettura file fallita: ' + (e.message || e) });
  }
  try {
    fs.unlinkSync(req.file.path);
  } catch (_) { /* ignore */ }

  const rows = parseCsv(raw).filter(r => r.some(c => (c || '').trim() !== ''));
  if (!rows.length) return res.status(400).json({ error: 'CSV vuoto' });

  // Header: lowercase + trim, mappa per nome indicizzata per posizione
  const header = (rows[0] || []).map(h => (h || '').toLowerCase().trim());
  const idx = {
    name: header.indexOf('name'),
    type: header.indexOf('type'),
    price: header.indexOf('price'),
    store: header.indexOf('store'),
    rating: header.indexOf('rating'),
    note: header.indexOf('note'),
    photo: header.indexOf('photo'),
    created_at: header.indexOf('created_at'),
  };
  if (idx.name < 0) return res.status(400).json({ error: 'colonna "name" mancante nell\'header' });
  if (idx.rating < 0) return res.status(400).json({ error: 'colonna "rating" mancante nell\'header' });

  // Mappa negozi: nome lowercase → id (per riconciliazione case-insensitive)
  const storesByName = new Map();
  for (const s of getAll('SELECT id, name FROM stores')) {
    storesByName.set(String(s.name).toLowerCase().trim(), s.id);
  }

  // Helper: normalizza la stringa del tipo di vino.
  // Accetta 'bianco','b','white'; 'rosso','r','red'; case-insensitive. Default null.
  const TYPE_ALIASES = new Map([
    ['bianco', 'bianco'], ['b', 'bianco'], ['white', 'bianco'],
    ['rosso', 'rosso'],   ['r', 'rosso'],  ['red', 'rosso'],
  ]);
  function parseType(raw) {
    if (raw == null) return null;
    const s = String(raw).trim().toLowerCase();
    if (!s) return null;
    return TYPE_ALIASES.get(s) || null;
  }
  // Helper: normalizza il prezzo. Accetta virgola come separatore, restituisce numero o null.
  function parsePrice(raw) {
    if (raw == null || raw === '') return null;
    const n = Number(String(raw).trim().replace(',', '.'));
    if (!Number.isFinite(n) || n < 0) return null;
    return Math.round(n * 100) / 100;
  }

  const errors = [];
  let imported = 0, skipped = 0;

  db.run('BEGIN');
  try {
    for (let i = 1; i < rows.length; i++) {
      const row = rows[i] || [];
      const lineNo = i + 1;
      const name = (row[idx.name] || '').trim();
      const rating = parseInt((row[idx.rating] || '').trim(), 10);
      if (!name) { errors.push(`riga ${lineNo}: nome vuoto`); skipped++; continue; }
      if (!Number.isInteger(rating) || rating < 1 || rating > 10) {
        errors.push(`riga ${lineNo}: rating non valido (serve 1-10)`);
        skipped++;
        continue;
      }
      let storeId = null;
      if (idx.store >= 0 && row[idx.store]) {
        const key = String(row[idx.store]).trim().toLowerCase();
        if (storesByName.has(key)) storeId = storesByName.get(key);
      }
      const note = (idx.note >= 0 && row[idx.note]) ? String(row[idx.note]) : null;
      const createdAtSrc = (idx.created_at >= 0 && row[idx.created_at]) ? String(row[idx.created_at]).trim() : '';
      const useCreatedAt = /^\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2}:\d{2})?$/.test(createdAtSrc);

      // type: segnala valori non riconoscibili per non perdere dati in silenzio
      const rawType = (idx.type >= 0 && row[idx.type] != null) ? String(row[idx.type]).trim() : '';
      let wineType = null;
      if (rawType !== '') {
        wineType = parseType(rawType);
        if (wineType == null) {
          errors.push(`riga ${lineNo}: type "${rawType}" non riconosciuto (accettati: bianco, b, white, rosso, r, red) — ignorato`);
        }
      }

      // price: idem, se il valore era presente ma non parsabile segnala
      const rawPrice = (idx.price >= 0 && row[idx.price] != null) ? String(row[idx.price]).trim() : '';
      let price = null;
      if (rawPrice !== '') {
        price = parsePrice(rawPrice);
        if (price == null) {
          errors.push(`riga ${lineNo}: price "${rawPrice}" non valido (serve numero >= 0) — ignorato`);
        }
      }

      try {
        if (useCreatedAt) {
          runSql(`INSERT INTO wines (name, store_id, rating, note, wine_type, price, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
                 [name, storeId, rating, note, wineType, price, createdAtSrc]);
        } else {
          runSql(`INSERT INTO wines (name, store_id, rating, note, wine_type, price) VALUES (?, ?, ?, ?, ?, ?)`,
                 [name, storeId, rating, note, wineType, price]);
        }
        imported++;
      } catch (e) {
        errors.push(`riga ${lineNo}: ${e.message || e}`);
        skipped++;
      }
    }
    db.run('COMMIT');
  } catch (e) {
    try { db.run('ROLLBACK'); } catch (_) {}
    return res.status(500).json({ error: 'import fallito a metà: ' + (e.message || e) });
  }
  saveDB();
  res.json({ imported, skipped, errors: errors.slice(0, 25), total_errors: errors.length });
});

// ---------- API: export CSV ----------

function csvEscape(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  if (/[",\n;]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

app.get('/api/export/wines.csv', (req, res) => {
  const rows = getAll(
    `SELECT w.id, w.name, w.wine_type, w.price, s.name AS store, w.rating, w.note, w.photo_path, w.created_at
       FROM wines w LEFT JOIN stores s ON s.id = w.store_id
       ORDER BY w.created_at DESC`
  );
  const lines = ['id;name;type;price;store;rating;note;photo;created_at'];
  for (const r of rows) {
    // price viene esportato con il punto come separatore decimale (formato Excel-en).
    const priceStr = r.price != null ? Number(r.price).toFixed(2).replace('.', ',') : '';
    lines.push([r.id, r.name, r.wine_type || '', priceStr, r.store || '', r.rating, r.note || '', r.photo_path || '', r.created_at].map(csvEscape).join(';'));
  }
  // BOM UTF-8 → Excel su Windows apre correttamente gli accenti italiani.
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="wines.csv"');
  res.send('\ufeff' + lines.join('\n'));
});

// ---------- API: backup completo (ZIP: wines.csv + photos/ + MANIFEST.json) ----------
// Restituisce un archivio ZIP unico che contiene TUTTO lo stato utente salvabile:
//   wines.csv             — stesso formato di /api/export/wines.csv (metadati testuali)
//   photos/&lt;filename&gt;     — una copia di ogni file in PHOTO_DIR (foto ridimensionate 1024px)
//   MANIFEST.json         — { schema_version, generated_at, wine_count, photo_count }
// Limiti pratici: bufferizzato interamente in memoria (Zip.toBuffer) → per centinaia di vini
// con foto è tipicamente 5-50 MB, ben sotto i 256 MB di mem_limit del container.
app.get('/api/backup', async (req, res) => {
  try {
    const rows = getAll(
      `SELECT w.id, w.name, w.wine_type, w.price, s.name AS store, w.rating, w.note, w.photo_path, w.created_at
         FROM wines w LEFT JOIN stores s ON s.id = w.store_id
         ORDER BY w.created_at ASC`
    );
    const lines = ['id;name;type;price;store;rating;note;photo;created_at'];
    for (const r of rows) {
      const priceStr = r.price != null ? Number(r.price).toFixed(2).replace('.', ',') : '';
      lines.push([r.id, r.name, r.wine_type || '', priceStr, r.store || '', r.rating, r.note || '', r.photo_path || '', r.created_at].map(csvEscape).join(';'));
    }
    const csvText = '\ufeff' + lines.join('\n');

    let photoCount = 0;
    const photoFiles = [];
    if (fs.existsSync(PHOTO_DIR)) {
      for (const f of fs.readdirSync(PHOTO_DIR)) {
        const full = path.join(PHOTO_DIR, f);
        try {
          if (fs.statSync(full).isFile()) { photoFiles.push(full); photoCount++; }
        } catch (_) { /* race o permessi → ignora */ }
      }
    }

    const manifest = {
      schema_version: 1,
      generated_at: new Date().toISOString(),
      app: 'vini-pwa',
      wine_count: rows.length,
      photo_count: photoCount,
    };

    const zip = new AdmZip();
    zip.addFile('MANIFEST.json', Buffer.from(JSON.stringify(manifest, null, 2), 'utf8'));
    zip.addFile('wines.csv', Buffer.from(csvText, 'utf8'));
    for (const fullPath of photoFiles) {
      // addLocalFile(preferDot:true)␤place at "photos/&lt;basename&gt;". Niente path traversal: il basename
      // proviene da fs.readdirSync della nostra directory di lavoro.
      zip.addLocalFile(fullPath, 'photos');
    }
    const buf = zip.toBuffer();

    const yyyymmdd = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="vini-backup-${yyyymmdd}.zip"`);
    res.setHeader('X-Wine-Count', String(rows.length));
    res.setHeader('X-Photo-Count', String(photoCount));
    res.send(buf);
  } catch (e) {
    console.error('[backup]', e);
    res.status(500).json({ error: 'backup fallito: ' + (e.message || e) });
  }
});

// ---------- API: ripristino da backup ZIP (wipe + reimport in transazione) ----------
// WIPE SEMANTICS: questa route CANCELLA wines + stores + foto esistenti e poi inserisce
// tutto quello che c'è nel backup. Confermato dal client con un confirm-modal. In caso di
// errore a metà strade, il DB viene ripristinato allo stato vuoto (rollback SQLite).
// Limite upload separato a 500 MB perché un backup con molte foto può essere grosso; il file
// temporaneo viene scritto su OS tmpdir (vinipwa-uploads, configurato sotto), poi unlinked.
const restoreUpload = multer({
  dest: path.join(require('os').tmpdir(), 'vinipwa-uploads'),
  limits: { fileSize: 500 * 1024 * 1024 }, // 500 MB
});

app.post('/api/restore', restoreUpload.single('backup'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'file ZIP mancante' });
  let zip;
  try {
    zip = new AdmZip(req.file.path);
  } catch (e) {
    try { fs.unlinkSync(req.file.path); } catch (_) {}
    return res.status(400).json({ error: 'file ZIP non valido: ' + (e.message || e) });
  }
  try { fs.unlinkSync(req.file.path); } catch (_) { /* best-effort cleanup */ }

  // Validazione: MANIFEST.json deve esistere e avere schema_version=1.
  const manifestEntry = zip.getEntry('MANIFEST.json');
  if (!manifestEntry) return res.status(400).json({ error: 'MANIFEST.json mancante (non è un backup valido)' });
  let manifest;
  try {
    manifest = JSON.parse(manifestEntry.getData().toString('utf8'));
  } catch (e) {
    return res.status(400).json({ error: 'MANIFEST.json non parsabile' });
  }
  if (Number(manifest.schema_version) !== 1) {
    return res.status(400).json({ error: 'schema_version non supportato: ' + manifest.schema_version });
  }

  const csvEntry = zip.getEntry('wines.csv');
  if (!csvEntry) return res.status(400).json({ error: 'wines.csv mancante nel backup' });
  const csvText = csvEntry.getData().toString('utf8');
  const rows = parseCsv(csvText).filter(r => r.some(c => (c || '').trim() !== ''));
  if (!rows.length) return res.status(400).json({ error: 'wines.csv vuoto' });

  const header = (rows[0] || []).map(h => (h || '').toLowerCase().trim());
  const idx = {
    id: header.indexOf('id'),
    name: header.indexOf('name'),
    type: header.indexOf('type'),
    price: header.indexOf('price'),
    store: header.indexOf('store'),
    rating: header.indexOf('rating'),
    note: header.indexOf('note'),
    photo: header.indexOf('photo'),
    created_at: header.indexOf('created_at'),
  };
  if (idx.name < 0 || idx.rating < 0 || idx.id < 0) {
    return res.status(400).json({ error: 'colonne "id", "name" o "rating" mancanti nell\'header' });
  }

  // WIPE + RESTORE in transazione SQLite (BEGIN/COMMIT/ROLLBACK).
  // Se qualcosa fallisce a metà, ROLLBACK ripristina uno stato coerente (vuoto).
  try {
    await ensurePhotoDir();
    db.run('BEGIN');

    // 1. Svuota DB.
    db.run('DELETE FROM wines');
    db.run('DELETE FROM stores');

    // 2. Svuota /photos (best-effort: ignora singoli file mancanti o locked).
    if (fs.existsSync(PHOTO_DIR)) {
      for (const f of fs.readdirSync(PHOTO_DIR)) {
        try { fs.unlinkSync(path.join(PHOTO_DIR, f)); } catch (_) { /* ignore */ }
      }
    }

    // 3. Ricostruisci stores case-insensitive, riusando la mappa all'interno della transazione.
    const storesByName = new Map();
    function getOrCreateStore(name) {
      const key = String(name).toLowerCase().trim();
      if (!key) return null;
      if (storesByName.has(key)) return storesByName.get(key);
      const id = runSql(`INSERT INTO stores (name) VALUES (?)`, [name]);
      storesByName.set(key, Number(id));
      return Number(id);
    }
    const TYPE_ALIASES = new Map([
      ['bianco', 'bianco'], ['b', 'bianco'], ['white', 'bianco'],
      ['rosso', 'rosso'],   ['r', 'rosso'],  ['red', 'rosso'],
    ]);
    function parseType(raw) {
      if (raw == null) return null;
      const s = String(raw).trim().toLowerCase();
      return TYPE_ALIASES.get(s) || null;
    }
    function parsePrice(raw) {
      if (raw == null || raw === '') return null;
      const n = Number(String(raw).trim().replace(',', '.'));
      if (!Number.isFinite(n) || n < 0) return null;
      return Math.round(n * 100) / 100;
    }

    let restored = 0, skippedPhotoMissing = 0, errors = 0;
    const photoSet = new Set();  // tracciamo quali photo_path sono effettivamente referenziati

    for (let i = 1; i < rows.length; i++) {
      const row = rows[i] || [];
      const id = parseInt((row[idx.id] || '').trim(), 10);
      if (!Number.isInteger(id) || id < 1) { errors++; continue; }
      const name = (row[idx.name] || '').trim();
      const rating = parseInt((row[idx.rating] || '').trim(), 10);
      if (!name) { errors++; continue; }
      if (!Number.isInteger(rating) || rating < 1 || rating > 10) { errors++; continue; }
      const storeId = (idx.store >= 0 && row[idx.store]) ? getOrCreateStore(String(row[idx.store]).trim()) : null;
      const note = (idx.note >= 0 && row[idx.note] != null) ? String(row[idx.note]) : null;
      const wineType = parseType(idx.type >= 0 ? row[idx.type] : null);
      const price = parsePrice(idx.price >= 0 ? row[idx.price] : null);
      const createdAt = (idx.created_at >= 0 && row[idx.created_at]) ? String(row[idx.created_at]).trim() : null;
      const photoPath = (idx.photo >= 0 && row[idx.photo]) ? String(row[idx.photo]).trim() : null;

      try {
        runSql(
          `INSERT INTO wines (id, name, store_id, rating, note, photo_path, wine_type, price, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [id, name, storeId, rating, note, photoPath || null, wineType, price, createdAt]
        );
        restored++;
        if (photoPath) photoSet.add(photoPath);
      } catch (e) {
        errors++;
      }
    }

    // 4. Scrivi le foto: solo quelle effettivamente referenziate dal CSV (evita di
    //    spargere file orfani che farebbero solo peso). Estrai ogni entries/photos/<file>.
    let photoWritten = 0, photoSkipped = 0;
    const photoEntries = zip.getEntries().filter(e =>
      e.entryName.startsWith('photos/') &&
      !e.isDirectory &&
      !e.entryName.includes('..')  // difesa contro path traversal improbabile in un backup locale
    );
    for (const e of photoEntries) {
      const basename = path.basename(e.entryName);
      // Mantien solo file "semplici" (no sottocartelle annidate).
      if (!basename || basename.indexOf('/') !== -1 || basename.indexOf('\\') !== -1) { photoSkipped++; continue; }
      if (!photoSet.has(basename)) { photoSkipped++; continue; } // foto orfana
      try {
        const out = path.join(PHOTO_DIR, basename);
        fs.writeFileSync(out, e.getData());
        photoWritten++;
      } catch (err) {
        photoSkipped++;
      }
    }

    db.run('COMMIT');
    saveDB(true);

    res.json({
      ok: true,
      wines: restored,
      errors: errors,
      photos_written: photoWritten,
      photos_skipped: photoSkipped,
    });
  } catch (e) {
    try { db.run('ROLLBACK'); } catch (_) { /* ignore */ }
    console.error('[restore]', e);
    res.status(500).json({ error: 'restore fallito a metà: ' + (e.message || e) });
  }
});

// SPA fallback: tutte le rotte non-API/non-photo vanno a index.html
app.get(/^(?!\/api\/|\/photos\/).*/, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ---------- Error middleware ----------
// In particolare cattura MulterError (file troppo grande) e restituisce
// un 413 con JSON, così il client mostra un messaggio leggibile invece
// di un default 500 HTML.

app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  if (err && err.name === 'MulterError') {
    const msg = err.code === 'LIMIT_FILE_SIZE'
      ? 'file troppo grande (max 8 MB)'
      : (err.message || 'errore upload');
    return res.status(413).json({ error: msg });
  }
  console.error('[err]', err);
  res.status(500).json({ error: String(err.message || err) });
});

// ---------- start ----------

(async () => {
  await initDb();
  await ensurePhotoDir();
  app.listen(PORT, () => {
    console.log(`[vini] Server in ascolto su http://0.0.0.0:${PORT}`);
  });
})().catch((e) => {
  console.error('[vini] errore di avvio:', e);
  process.exit(1);
});
