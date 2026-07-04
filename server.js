// Vini PWA — backend Express + SQLite (via sql.js) + jimp per il resize delle foto.
// Mirroring del progetto `orto`, adattato ai vini. Pensato per Orange Pi.

const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const initSqlJs = require('sql.js');
const Jimp = require('jimp');

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
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (store_id) REFERENCES stores(id) ON DELETE SET NULL
    );
  `);
  db.run(`CREATE INDEX IF NOT EXISTS idx_wines_created_at ON wines(created_at DESC);`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_wines_rating ON wines(rating DESC);`);

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

async function processPhoto(inputPath, originalName) {
  // legge, ridimensiona, ricompatta in JPEG e scrive su PHOTO_DIR.
  const img = await Jimp.read(inputPath);
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
    `SELECT w.id, w.name, w.store_id, w.rating, w.note, w.photo_path, w.created_at,
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
  const id = runSql(
    `INSERT INTO wines (name, store_id, rating, note) VALUES (?, ?, ?, ?)`,
    [name, storeId, rating, note]
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

  runSql(
    `UPDATE wines SET name=?, store_id=?, rating=?, note=? WHERE id=?`,
    [name, storeId, rating, note, id]
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
  const byStore = getAll(
    `SELECT s.id, s.name, COUNT(w.id) AS count, ROUND(AVG(w.rating), 2) AS avg_rating
       FROM stores s LEFT JOIN wines w ON w.store_id = s.id
       GROUP BY s.id, s.name
       ORDER BY count DESC, s.name ASC`
  );
  const byMonth = getAll(
    `SELECT substr(created_at, 1, 7) AS month, COUNT(*) AS count
       FROM wines
       GROUP BY substr(created_at, 1, 7)
       ORDER BY month DESC
       LIMIT 12`
  );
  const recent = getAll(
    `SELECT w.id, w.name, w.rating, w.created_at, w.photo_path, s.name AS store_name
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

// ---------- API: export CSV ----------

function csvEscape(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  if (/[",\n;]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

app.get('/api/export/wines.csv', (req, res) => {
  const rows = getAll(
    `SELECT w.id, w.name, s.name AS store, w.rating, w.note, w.photo_path, w.created_at
       FROM wines w LEFT JOIN stores s ON s.id = w.store_id
       ORDER BY w.created_at DESC`
  );
  const lines = ['id;name;store;rating;note;photo;created_at'];
  for (const r of rows) {
    lines.push([r.id, r.name, r.store || '', r.rating, r.note || '', r.photo_path || '', r.created_at].map(csvEscape).join(';'));
  }
  // BOM UTF-8 → Excel su Windows apre correttamente gli accenti italiani.
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="wines.csv"');
  res.send('\ufeff' + lines.join('\n'));
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
