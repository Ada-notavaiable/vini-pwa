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
const yazl = require('yazl'); // writer ZIP in streaming per /api/backup (vedi sotto)

const PORT = process.env.PORT || 3000;
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'vini.db');
const PHOTO_DIR = process.env.PHOTO_DIR || path.join(__dirname, 'photos');

const PHOTO_MAX_DIM = 1024;       // px max lato lungo della foto ridimensionata
const PHOTO_JPEG_QUALITY = 80;    // qualità JPEG di output (jimp 0-100)

// ---------- bootstrap SQLite ----------

let db = null;
let dbSaveTimer = null;

// Stato di salute dell'app: lo leggono /api/health e il watchdog in fondo al file.
// Serve per capire DA REMOTO perché un container è unhealthy senza dover stare a casa.
const STARTED_AT = Date.now();
let lastError = null;      // ultimo errore 5xx servito a un client ({at, where, message})
let lastSaveError = null;  // ultimo errore di salvataggio del DB su disco
let recentErrors = [];     // timestamp degli ultimi 5xx (finestra scorrevole di 60s)

// Soglie del watchdog (vedi fine file): con 256 MB di RAM un picco può lasciare il
// DB in avaria; il watchdog lo scopre da solo e riavvia il processo invece di
// lasciare l'app a rispondere 500 finché qualcuno non ricarica la stack a mano.
// Le env var servono per testare/ritoccare le soglie senza toccare il codice.
function envNum(name, def) {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v >= 0 ? v : def;
}
const WATCHDOG_INTERVAL_MS = envNum('WATCHDOG_INTERVAL_MS', 15000);      // quanto spesso controlla
const WATCHDOG_MIN_UPTIME_MS = envNum('WATCHDOG_MIN_UPTIME_MS', 60000);  // non decidere subito dopo il boot
const WATCHDOG_ERROR_WINDOW_MS = envNum('WATCHDOG_ERROR_WINDOW_MS', 60000); // finestra di conteggio dei 5xx
const WATCHDOG_MAX_ERRORS = envNum('WATCHDOG_MAX_ERRORS', 10);           // 5xx in finestra → stato non sano

function noteError(where, err) {
  const message = String((err && err.message) || err);
  lastError = { at: new Date().toISOString(), where, message };
  recentErrors.push(Date.now());
  if (recentErrors.length > 200) recentErrors = recentErrors.slice(-200);
}

// Probe minimale del DB: usata dal watchdog e da /api/health (SELECT 1, niente
// caricamento del DB intero come fa /api/stats).
function dbProbeOk() {
  try { getOne('SELECT 1 AS ok'); return true; } catch (_) { return false; }
}

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

  // Abilita i vincoli FK: senza questo `ON DELETE SET NULL` viene SILENZIOSAMENTE
  // ignorato da SQLite (default = OFF), quindi cancellando un negozio le righe wines/
  // spirits resterebbero orfane con un store_id che non esiste più. Migliora la
  // integrità referenziale a costo di un leggero rallentamento in scrittura (accettabile).
  db.run('PRAGMA foreign_keys = ON;');

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

  // Tabella superalcolici (grappa/rum/whisky/gin/…): analoga a wines ma con
  //   spirit_type (anziché rosso/bianco) e abv (graduazione alcolica %).
  // foto riusa il PHOTO_DIR comune: nessuna collisione perché i nomi file includono timestamp.
  db.run(`
    CREATE TABLE IF NOT EXISTS spirits (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      store_id INTEGER,
      rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 10),
      note TEXT,
      photo_path TEXT,
      spirit_type TEXT,
      abv REAL,
      price REAL,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (store_id) REFERENCES stores(id) ON DELETE SET NULL
    );
  `);
  db.run(`CREATE INDEX IF NOT EXISTS idx_spirits_created_at ON spirits(created_at DESC);`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_spirits_rating ON spirits(rating DESC);`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_spirits_spirit_type ON spirits(spirit_type);`);

  // Tabella foto multi-per-vino: posizione ordinata per swipe orizzontale, ON DELETE CASCADE
  // così cancellando un vino sparisce anche ogni sua foto (no orfane).
  // UNIQUE(wine_id, position) impedisce due foto nella stessa posizione per lo stesso vino.
  db.run(`
    CREATE TABLE IF NOT EXISTS wine_photos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      wine_id INTEGER NOT NULL,
      photo_path TEXT NOT NULL,
      position INTEGER NOT NULL DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (wine_id) REFERENCES wines(id) ON DELETE CASCADE
    );
  `);
  db.run(`CREATE INDEX IF NOT EXISTS idx_wine_photos_wine ON wine_photos(wine_id, position);`);
  db.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_wine_photos_unique_pos ON wine_photos(wine_id, position);`);

  db.run(`
    CREATE TABLE IF NOT EXISTS spirit_photos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      spirit_id INTEGER NOT NULL,
      photo_path TEXT NOT NULL,
      position INTEGER NOT NULL DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (spirit_id) REFERENCES spirits(id) ON DELETE CASCADE
    );
  `);
  db.run(`CREATE INDEX IF NOT EXISTS idx_spirit_photos_spirit ON spirit_photos(spirit_id, position);`);
  db.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_spirit_photos_unique_pos ON spirit_photos(spirit_id, position);`);

  // Migrazione record pre-multi-photo: chi ha wines.photo_path valorizzato ma
  // nessuna riga corrispondente in wine_photos riceve una entry in posizione 0.
  // Lo stesso per gli spirits. Idempotente (usa INSERT OR IGNORE + NOT EXISTS).
  // colonne photo_path nel parent restano come cache denormalizzata: la prima foto
  // (position = 0) viene rispecchiata in wines.photo_path / spirits.photo_path via
  // syncPrimaryPhoto() ogni volta che la galleria cambia.
  db.run(`
    INSERT OR IGNORE INTO wine_photos (wine_id, photo_path, position, created_at)
    SELECT w.id, w.photo_path, 0, COALESCE(w.created_at, datetime('now'))
      FROM wines w
     WHERE w.photo_path IS NOT NULL AND w.photo_path <> ''
       AND NOT EXISTS (SELECT 1 FROM wine_photos wp
                        WHERE wp.wine_id = w.id AND wp.photo_path = w.photo_path);
  `);
  db.run(`
    INSERT OR IGNORE INTO spirit_photos (spirit_id, photo_path, position, created_at)
    SELECT s.id, s.photo_path, 0, COALESCE(s.created_at, datetime('now'))
      FROM spirits s
     WHERE s.photo_path IS NOT NULL AND s.photo_path <> ''
       AND NOT EXISTS (SELECT 1 FROM spirit_photos sp
                        WHERE sp.spirit_id = s.id AND sp.photo_path = s.photo_path);
  `);

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

// ---------- salvataggio del DB ----------
// ATTENZIONE: db.export() di sql.js NON è un'operazione innocua: fa
//   sqlite3_close_v2() → legge il file → sqlite3_open()
// quindi CHIUDE e RIAPRE la connessione SQLite a ogni salvataggio. Due conseguenze:
//   1. il PRAGMA foreign_keys (per-connessione, NON persistente) va perduto ogni volta
//      → senza riapplicarlo, `ON DELETE SET NULL` viene ignorato e i vini restano con
//        un store_id orfano (spariscono dalle statistiche);
//   2. se export() fallisce a metà (tipicamente picco di memoria sulla board), il handle
//      resta CHIUSO e da lì in poi OGNI query lancia errore → tutte le API rispondono
//      500 per sempre, finché qualcuno non riavvia il container.
// Per questo il flush è prudente, atomico su disco e se resta senza handle fa subìto
// emergenza (vedi watchdog).
const SAVE_DEBOUNCE_MS = 2000; // era 600ms: meno export = meno picchi di RAM e meno close/reopen

function noteSaveError(e, where) {
  lastSaveError = { at: new Date().toISOString(), where, message: String((e && e.message) || e) };
  console.error(`[db] ${where}:`, e);
}

function flushDb() {
  let data;
  try {
    data = db.export();
  } catch (e) {
    noteSaveError(e, 'export fallito (handle DB forse chiuso a metà)');
    if (!dbProbeOk()) {
      // Handle morto: ogni richiesta da qui in avanti restituirebbe 500. Meglio morire
      // ora: la policy `restart: unless-stopped` riavvia il container in pochi ms.
      console.error('[db] connessione DB non recuperabile dopo il fallito export → exit(1)');
      process.exit(1);
    }
    return; // DB ancora vivo: il prossimo save riproverà (i dati restano in RAM)
  }
  // export() ha riaperto la connessione: il pragma va riapplicato subito.
  try { db.run('PRAGMA foreign_keys = ON;'); } catch (_) { /* ignore */ }

  // Scrittura ATOMICA (tmp + rename): se il processo muore o il volume si riempie
  // a metà, /data/vini.db resta il file precedente e integro invece di un file troncato
  // (che al prossimo boot farebbe crashare l'app in loop).
  const tmpPath = DB_PATH + '.tmp';
  try {
    fs.writeFileSync(tmpPath, Buffer.from(data));
    fs.renameSync(tmpPath, DB_PATH);
    lastSaveError = null;
  } catch (e) {
    noteSaveError(e, 'scrittura su disco fallita');
    try { fs.unlinkSync(tmpPath); } catch (_) { /* ignore */ }
  }
}

function saveDB(immediate = false) {
  if (dbSaveTimer) { clearTimeout(dbSaveTimer); dbSaveTimer = null; }
  if (immediate) { flushDb(); return; }
  dbSaveTimer = setTimeout(() => { dbSaveTimer = null; flushDb(); }, SAVE_DEBOUNCE_MS);
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

// Risincronizza wines.photo_path (denormalized cache) dopo ogni cambio alla galleria:
// prende la riga wine_photos con position minima (e id minima come tie-breaker) e la
// copia in wines.photo_path; se la galleria è vuota, la colonna torna NULL. Stessa cosa
// per spirits. Non usa trigger (sql.js non li supporta in modo affidabile) ma è chiamato
// da ogni endpoint che modifica wine_photos / spirit_photos, quindi la cache è sempre
// coerente. NB: usare INSERT/DELETE sulla tabella figlio è sufficiente per invalidarla;
// non serve toccare la cache "a mano" dal chiamante.
function syncPrimaryPhoto(parentId, kind) {
  if (kind === 'wine') {
    const r = getOne(
      `SELECT photo_path FROM wine_photos WHERE wine_id=? ORDER BY position ASC, id ASC LIMIT 1`,
      [parentId]
    );
    runSql(`UPDATE wines SET photo_path=? WHERE id=?`, [r ? r.photo_path : null, parentId]);
  } else if (kind === 'spirit') {
    const r = getOne(
      `SELECT photo_path FROM spirit_photos WHERE spirit_id=? ORDER BY position ASC, id ASC LIMIT 1`,
      [parentId]
    );
    runSql(`UPDATE spirits SET photo_path=? WHERE id=?`, [r ? r.photo_path : null, parentId]);
  }
}

// Conta attuale delle foto per un dato parent (usato in endpoints GET per allegare il counter).
function countPhotos(parentId, kind) {
  if (kind === 'wine') {
    const r = getOne(`SELECT COUNT(*) AS n FROM wine_photos WHERE wine_id=?`, [parentId]);
    return r ? r.n : 0;
  }
  const r = getOne(`SELECT COUNT(*) AS n FROM spirit_photos WHERE spirit_id=?`, [parentId]);
  return r ? r.n : 0;
}

// Cancella un file temporaneo di multer (path FUORI da PHOTO_DIR, quindi niente
// i controlli di safeUnlinkPhoto). Finora si passava basename(f.path) a
// safeUnlinkPhoto, che di fatto cercava il file dentro PHOTO_DIR (dove non c'era):
// ogni upload fallito lasciava un file da 8 MB in /tmp dentro il layer del container.
function safeUnlinkTemp(filePath) {
  if (!filePath) return;
  try { fs.unlink(filePath, () => { /* ignore */ }); } catch (_) { /* ignore */ }
}

// Cancella in sicurezza un file da PHOTO_DIR (mai lanciare eccezione al chiamante).
function safeUnlinkPhoto(filename) {
  if (!filename) return;
  // basename-only check: niente traversal "../../etc/passwd"
  if (filename.includes('/') || filename.includes('\\') || filename.startsWith('.')) return;
  try { fs.unlink(path.join(PHOTO_DIR, filename), () => { /* ignore */ }); } catch (_) { /* ignore */ }
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

// Osserva TUTTE le risposte con status >= 500. Serve perché molti handler rispondono
// con res.status(500).json(...) senza passare dall'error middleware: senza questo hook
// quegli errori non finivano nè in last_error nè nel contatore del watchdog.
app.use((req, res, next) => {
  res.on('finish', () => {
    if (res.statusCode >= 500) {
      noteError(`${req.method} ${req.originalUrl}`, res.locals.errMessage || `HTTP ${res.statusCode}`);
    }
  });
  next();
});

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
  // photo_count = numero di foto associate al vino (compresa la primary).
  // photo_path resta il path della foto primaria (position=0), denormalizzato per leggere
  // la thumb della lista senza un JOIN per ogni riga.
  const rows = getAll(
    `SELECT w.id, w.name, w.store_id, w.rating, w.note, w.photo_path, w.wine_type, w.price, w.created_at,
            s.name AS store_name,
            (SELECT COUNT(*) FROM wine_photos wp WHERE wp.wine_id = w.id) AS photo_count
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
  // Allega la lista completa delle foto al record vino per la lightbox multi-foto.
  const photos = getAll(
    `SELECT id, photo_path, position, created_at FROM wine_photos WHERE wine_id=? ORDER BY position ASC, id ASC`,
    [id]
  );
  w.photos = photos.map(p => ({
    id: p.id, position: p.position, photo_path: p.photo_path,
    url: `/photos/${p.photo_path}`, created_at: p.created_at,
  }));
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
  // wine_photos ha ON DELETE CASCADE → le righe figlio spariscono atomicamente.
  // Dobbiamo però recuperare i photo_path PRIMA del DELETE per poter cancellare i file
  // fisici in PHOTO_DIR (la CASCADE non tocca il disco).
  const photos = getAll(`SELECT photo_path FROM wine_photos WHERE wine_id=?`, [id]);
  runSql(`DELETE FROM wines WHERE id=?`, [id]);
  for (const p of photos) safeUnlinkPhoto(p.photo_path);
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
    // Pulizia dei file temporanei di multer in caso di errore:
    // senza questo ogni upload fallito lasciava un file da 8 MB in /tmp.
    if (req.file) safeUnlinkTemp(req.file.path);
    if (req.files) for (const f of req.files) safeUnlinkTemp(f.path);
    res.locals.errMessage = 'errore elaborazione foto: ' + (e.message || e); // per /api/health e watchdog
    res.status(500).json({ error: 'errore elaborazione foto: ' + (e.message || e) });
  }
});

app.delete('/api/wines/:id/photo', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const w = getOne(`SELECT photo_path FROM wines WHERE id=?`, [id]);
  if (!w) return res.status(404).json({ error: 'vino non trovato' });
  if (w.photo_path) {
    safeUnlinkPhoto(w.photo_path);
    // Retrocompat: cancella anche ogni entry in wine_photos che punta a questo path,
    // così la cache wines.photo_path torna NULL coerentemente.
    runSql(`DELETE FROM wine_photos WHERE wine_id=? AND photo_path=?`, [id, w.photo_path]);
    runSql(`UPDATE wines SET photo_path=NULL WHERE id=?`, [id]);
    saveDB();
  }
  res.json({ ok: true });
});

// ---------- API vini: galleria multi-foto ----------
// upload.array accetta fino a 8 file per chiamata (campo "photos"); ogni file passa per
// processPhoto (resize lato server). Le foto vengono accodate in posizioni successive
// (max position corrente + 1). L'upload è best-effort: un file fallito non rovina gli
// altri, ma tutti i filename riusciti vengono inseriti e la cache viene sincronizzata.
app.post('/api/wines/:id/photos', upload.array('photos', 8), async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'id non valido' });
  const exists = getOne(`SELECT id FROM wines WHERE id=?`, [id]);
  if (!exists) return res.status(404).json({ error: 'vino non trovato' });
  if (!req.files || !req.files.length) return res.status(400).json({ error: 'file mancanti (campo "photos")' });
  try {
    await ensurePhotoDir();
    const maxRow = getOne(`SELECT COALESCE(MAX(position), -1) AS m FROM wine_photos WHERE wine_id=?`, [id]);
    let nextPos = (maxRow && maxRow.m != null) ? maxRow.m + 1 : 0;
    const inserted = [];
    const errors = [];
    for (const f of req.files) {
      try {
        const { filename, width, height } = await processPhoto(f.path, f.originalname);
        // INSERT può collidere con un position già usato se il client ha inserito
        // buchi manualmente; usiamo INSERT con retry su +1 in caso di conflit UNIQUE.
        let attempts = 0;
        while (attempts < 16) {
          try {
            const photoId = runSql(
              `INSERT INTO wine_photos (wine_id, photo_path, position) VALUES (?, ?, ?)`,
              [id, filename, nextPos]
            );
            inserted.push({ id: photoId, filename, position: nextPos, width, height, url: `/photos/${filename}` });
            nextPos++;
            break;
          } catch (e) {
            if (/UNIQUE/i.test(String(e.message || e))) { nextPos++; attempts++; continue; }
            throw e;
          }
        }
      } catch (e) {
        errors.push({ originalname: f.originalname, error: String(e.message || e) });
        safeUnlinkTemp(f.path);
      }
    }
    syncPrimaryPhoto(id, 'wine');
    saveDB();
    res.json({ ok: true, inserted, errors });
  } catch (e) {
    // Pulizia dei file temporanei di multer in caso di errore:
    // senza questo ogni upload fallito lasciava un file da 8 MB in /tmp.
    if (req.file) safeUnlinkTemp(req.file.path);
    if (req.files) for (const f of req.files) safeUnlinkTemp(f.path);
    res.locals.errMessage = 'errore elaborazione foto: ' + (e.message || e); // per /api/health e watchdog
    res.status(500).json({ error: 'errore elaborazione foto: ' + (e.message || e) });
  }
});

app.delete('/api/wines/:id/photos/:photoId', (req, res) => {
  const parentId = parseInt(req.params.id, 10);
  const photoId = parseInt(req.params.photoId, 10);
  if (!Number.isInteger(parentId) || !Number.isInteger(photoId)) return res.status(400).json({ error: 'id non valido' });
  const photo = getOne(`SELECT id, photo_path FROM wine_photos WHERE id=? AND wine_id=?`, [photoId, parentId]);
  if (!photo) return res.status(404).json({ error: 'foto non trovata' });
  runSql(`DELETE FROM wine_photos WHERE id=?`, [photoId]);
  syncPrimaryPhoto(parentId, 'wine');
  safeUnlinkPhoto(photo.photo_path);
  saveDB();
  res.json({ ok: true });
});

// Setta una foto come "primary" (position = 0). Le altre scivolano in pos+1.
// NB: per evitare conflitti UNIQUE, prima spostiamo tutte le +1 in una transazione
// concettuale (sql.js non ha BEGIN espliciti ma ogni db.run è atomico, quindi iteriamo).
app.post('/api/wines/:id/photos/:photoId/primary', (req, res) => {
  const parentId = parseInt(req.params.id, 10);
  const photoId = parseInt(req.params.photoId, 10);
  if (!Number.isInteger(parentId) || !Number.isInteger(photoId)) return res.status(400).json({ error: 'id non valido' });
  const photo = getOne(`SELECT id, position FROM wine_photos WHERE id=? AND wine_id=?`, [photoId, parentId]);
  if (!photo) return res.status(404).json({ error: 'foto non trovata' });
  // Sposta tutti in pos+1 per liberare lo slot 0
  const all = getAll(`SELECT id FROM wine_photos WHERE wine_id=? AND id<>? ORDER BY position DESC, id DESC`, [parentId, photoId]);
  for (const r of all) {
    runSql(`UPDATE wine_photos SET position = position + 1 WHERE id=?`, [r.id]);
  }
  runSql(`UPDATE wine_photos SET position=0 WHERE id=?`, [photoId]);
  syncPrimaryPhoto(parentId, 'wine');
  saveDB();
  res.json({ ok: true });
});

// Reorder atomico: body = [{ id, position }, ...]. Riassegna position evitando i conflitti
// UNIQUE facendo due passate (prima tutti a pos negative, poi tutti a pos finali).
app.post('/api/wines/:id/photos/reorder', (req, res) => {
  const parentId = parseInt(req.params.id, 10);
  const order = Array.isArray(req.body && req.body.order) ? req.body.order : null;
  if (!order) return res.status(400).json({ error: 'body.order[] richiesto' });
  const existing = getAll(`SELECT id FROM wine_photos WHERE wine_id=?`, [parentId]).map(r => r.id);
  const incomingIds = order.map(o => parseInt(o.id, 10)).filter(Number.isInteger);
  if (incomingIds.length !== order.length) return res.status(400).json({ error: 'id non validi in order[]' });
  if (incomingIds.some(id => !existing.includes(id))) return res.status(400).json({ error: 'id non appartenenti al vino' });
  if (incomingIds.length !== new Set(incomingIds).size) return res.status(400).json({ error: 'id duplicati in order[]' });
  // Passata 1: posizioni negative temporanee per evitare collisioni UNIQUE
  for (let i = 0; i < incomingIds.length; i++) {
    runSql(`UPDATE wine_photos SET position=? WHERE id=?`, [-1 - i, incomingIds[i]]);
  }
  // Passata 2: posizioni finali 0..N
  for (let i = 0; i < incomingIds.length; i++) {
    runSql(`UPDATE wine_photos SET position=? WHERE id=?`, [i, incomingIds[i]]);
  }
  syncPrimaryPhoto(parentId, 'wine');
  saveDB();
  res.json({ ok: true });
});

// ---------- API: spirits (superalcolici) ----------
// Stesse convenzioni di /api/wines dove possibile:
//   - spirit_type: stringa libera normalizzata (lowercase + trim); nessun enum fisso
//     così l'utente può aggiungere categorie nuove senza patch al server.
//   - abv: numero 0..100 (percentuale alcolica), opzionale.
//   - prezzo e rating come per i vini.
// Le foto vengono ridimensionate e scritte nella stessa PHOTO_DIR dei vini:
// i filename includono timestamp + basename quindi non collidono.

const SPIRIT_TYPES = new Set([
  'grappa','whisky','rum','brandy','cognac','gin','vodka','tequila','amaro','liquore','altro',
]);

function normalizeSpiritType(raw) {
  if (raw == null) return null;
  const s = String(raw).trim().toLowerCase();
  if (!s) return null;
  return s.slice(0, 40); // hard cap difensivo
}

app.get('/api/spirits', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 200, 1000);
  const sort = req.query.sort === 'rating' ? 's.rating DESC, s.created_at DESC' : 's.created_at DESC';
  const rows = getAll(
    `SELECT s.id, s.name, s.store_id, s.rating, s.note, s.photo_path, s.spirit_type, s.abv, s.price, s.created_at,
            st.name AS store_name,
            (SELECT COUNT(*) FROM spirit_photos sp WHERE sp.spirit_id = s.id) AS photo_count
       FROM spirits s LEFT JOIN stores st ON st.id = s.store_id
       ORDER BY ${sort}
       LIMIT ?`,
    [limit]
  );
  res.json(rows);
});

app.get('/api/spirits/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const s = getOne(
    `SELECT s.*, st.name AS store_name
       FROM spirits s LEFT JOIN stores st ON st.id = s.store_id
       WHERE s.id=?`,
    [id]
  );
  if (!s) return res.status(404).json({ error: 'superalcolico non trovato' });
  const photos = getAll(
    `SELECT id, photo_path, position, created_at FROM spirit_photos WHERE spirit_id=? ORDER BY position ASC, id ASC`,
    [id]
  );
  s.photos = photos.map(p => ({
    id: p.id, position: p.position, photo_path: p.photo_path,
    url: `/photos/${p.photo_path}`, created_at: p.created_at,
  }));
  res.json(s);
});

function validateSpiritBody(body) {
  const name = (body?.name || '').trim();
  const rating = parseInt(body?.rating, 10);
  const note = (body?.note || '').trim() || null;
  const storeIdRaw = body?.store_id;
  const storeId = (storeIdRaw === '' || storeIdRaw == null) ? null : parseInt(storeIdRaw, 10);

  if (!name) return { error: 'nome superalcolico obbligatorio' };
  if (!Number.isInteger(rating) || rating < 1 || rating > 10) {
    return { error: 'rating deve essere un intero tra 1 e 10' };
  }
  if (storeId !== null && !getOne(`SELECT id FROM stores WHERE id=?`, [storeId])) {
    return { error: 'store_id non valido' };
  }

  const spiritType = normalizeSpiritType(body?.spirit_type);

  const abvRaw = body?.abv;
  let abv = null;
  if (abvRaw !== '' && abvRaw != null) {
    const n = Number(String(abvRaw).replace(',', '.'));
    if (!Number.isFinite(n) || n < 0 || n > 100) {
      return { error: 'abv non valido (serve numero 0..100)' };
    }
    abv = Math.round(n * 10) / 10;
  }

  const priceRaw = body?.price;
  let price = null;
  if (priceRaw !== '' && priceRaw != null) {
    const n = Number(String(priceRaw).replace(',', '.'));
    if (!Number.isFinite(n) || n < 0) {
      return { error: 'price non valido (serve numero >= 0)' };
    }
    price = Math.round(n * 100) / 100;
  }

  return { name, rating, note, storeId, spiritType, abv, price };
}

app.post('/api/spirits', (req, res) => {
  const v = validateSpiritBody(req.body);
  if (v.error) return res.status(400).json({ error: v.error });

  const id = runSql(
    `INSERT INTO spirits (name, store_id, rating, note, spirit_type, abv, price) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [v.name, v.storeId, v.rating, v.note, v.spiritType, v.abv, v.price]
  );
  saveDB();
  res.json({ id });
});

app.put('/api/spirits/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const exists = getOne(`SELECT id FROM spirits WHERE id=?`, [id]);
  if (!exists) return res.status(404).json({ error: 'superalcolico non trovato' });

  const v = validateSpiritBody(req.body);
  if (v.error) return res.status(400).json({ error: v.error });

  runSql(
    `UPDATE spirits SET name=?, store_id=?, rating=?, note=?, spirit_type=?, abv=?, price=? WHERE id=?`,
    [v.name, v.storeId, v.rating, v.note, v.spiritType, v.abv, v.price, id]
  );
  saveDB();
  res.json({ ok: true });
});

app.delete('/api/spirits/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const photos = getAll(`SELECT photo_path FROM spirit_photos WHERE spirit_id=?`, [id]);
  runSql(`DELETE FROM spirits WHERE id=?`, [id]);
  for (const p of photos) safeUnlinkPhoto(p.photo_path);
  saveDB();
  res.json({ ok: true });
});

// upload foto spirito: stesso processo di ridimensionamento dei vini (multer + jimp).
app.post('/api/spirits/:id/photo', upload.single('photo'), async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'id non valido' });
  const exists = getOne(`SELECT id, photo_path FROM spirits WHERE id=?`, [id]);
  if (!exists) return res.status(404).json({ error: 'superalcolico non trovato' });
  if (!req.file) return res.status(400).json({ error: 'file mancante' });
  try {
    await ensurePhotoDir();
    const { filename, width, height } = await processPhoto(req.file.path, req.file.originalname);
    if (exists.photo_path) {
      const old = path.join(PHOTO_DIR, exists.photo_path);
      fs.unlink(old, () => { /* ignore */ });
    }
    runSql(`UPDATE spirits SET photo_path=? WHERE id=?`, [filename, id]);
    saveDB();
    res.json({ filename, width, height, url: `/photos/${filename}` });
  } catch (e) {
    // Pulizia dei file temporanei di multer in caso di errore:
    // senza questo ogni upload fallito lasciava un file da 8 MB in /tmp.
    if (req.file) safeUnlinkTemp(req.file.path);
    if (req.files) for (const f of req.files) safeUnlinkTemp(f.path);
    res.locals.errMessage = 'errore elaborazione foto: ' + (e.message || e); // per /api/health e watchdog
    res.status(500).json({ error: 'errore elaborazione foto: ' + (e.message || e) });
  }
});

app.delete('/api/spirits/:id/photo', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const s = getOne(`SELECT photo_path FROM spirits WHERE id=?`, [id]);
  if (!s) return res.status(404).json({ error: 'superalcolico non trovato' });
  if (s.photo_path) {
    safeUnlinkPhoto(s.photo_path);
    runSql(`DELETE FROM spirit_photos WHERE spirit_id=? AND photo_path=?`, [id, s.photo_path]);
    runSql(`UPDATE spirits SET photo_path=NULL WHERE id=?`, [id]);
    saveDB();
  }
  res.json({ ok: true });
});

// ---------- API spirits: galleria multi-foto ----------
// Stesse convenzioni dei vini: upload multiplo (max 8/richiesta), delete singolo, primary
// swap, reorder atomico in due passate (posizioni negative → posizioni finali) per
// evitare conflitti UNIQUE. La cache spirits.photo_path viene risincronizzata ogni volta.
app.post('/api/spirits/:id/photos', upload.array('photos', 8), async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'id non valido' });
  const exists = getOne(`SELECT id FROM spirits WHERE id=?`, [id]);
  if (!exists) return res.status(404).json({ error: 'superalcolico non trovato' });
  if (!req.files || !req.files.length) return res.status(400).json({ error: 'file mancanti (campo "photos")' });
  try {
    await ensurePhotoDir();
    const maxRow = getOne(`SELECT COALESCE(MAX(position), -1) AS m FROM spirit_photos WHERE spirit_id=?`, [id]);
    let nextPos = (maxRow && maxRow.m != null) ? maxRow.m + 1 : 0;
    const inserted = [];
    const errors = [];
    for (const f of req.files) {
      try {
        const { filename, width, height } = await processPhoto(f.path, f.originalname);
        let attempts = 0;
        while (attempts < 16) {
          try {
            const photoId = runSql(
              `INSERT INTO spirit_photos (spirit_id, photo_path, position) VALUES (?, ?, ?)`,
              [id, filename, nextPos]
            );
            inserted.push({ id: photoId, filename, position: nextPos, width, height, url: `/photos/${filename}` });
            nextPos++;
            break;
          } catch (e) {
            if (/UNIQUE/i.test(String(e.message || e))) { nextPos++; attempts++; continue; }
            throw e;
          }
        }
      } catch (e) {
        errors.push({ originalname: f.originalname, error: String(e.message || e) });
        safeUnlinkTemp(f.path);
      }
    }
    syncPrimaryPhoto(id, 'spirit');
    saveDB();
    res.json({ ok: true, inserted, errors });
  } catch (e) {
    // Pulizia dei file temporanei di multer in caso di errore:
    // senza questo ogni upload fallito lasciava un file da 8 MB in /tmp.
    if (req.file) safeUnlinkTemp(req.file.path);
    if (req.files) for (const f of req.files) safeUnlinkTemp(f.path);
    res.locals.errMessage = 'errore elaborazione foto: ' + (e.message || e); // per /api/health e watchdog
    res.status(500).json({ error: 'errore elaborazione foto: ' + (e.message || e) });
  }
});

app.delete('/api/spirits/:id/photos/:photoId', (req, res) => {
  const parentId = parseInt(req.params.id, 10);
  const photoId = parseInt(req.params.photoId, 10);
  if (!Number.isInteger(parentId) || !Number.isInteger(photoId)) return res.status(400).json({ error: 'id non valido' });
  const photo = getOne(`SELECT id, photo_path FROM spirit_photos WHERE id=? AND spirit_id=?`, [photoId, parentId]);
  if (!photo) return res.status(404).json({ error: 'foto non trovata' });
  runSql(`DELETE FROM spirit_photos WHERE id=?`, [photoId]);
  syncPrimaryPhoto(parentId, 'spirit');
  safeUnlinkPhoto(photo.photo_path);
  saveDB();
  res.json({ ok: true });
});

app.post('/api/spirits/:id/photos/:photoId/primary', (req, res) => {
  const parentId = parseInt(req.params.id, 10);
  const photoId = parseInt(req.params.photoId, 10);
  if (!Number.isInteger(parentId) || !Number.isInteger(photoId)) return res.status(400).json({ error: 'id non valido' });
  const photo = getOne(`SELECT id, position FROM spirit_photos WHERE id=? AND spirit_id=?`, [photoId, parentId]);
  if (!photo) return res.status(404).json({ error: 'foto non trovata' });
  const all = getAll(`SELECT id FROM spirit_photos WHERE spirit_id=? AND id<>? ORDER BY position DESC, id DESC`, [parentId, photoId]);
  for (const r of all) {
    runSql(`UPDATE spirit_photos SET position = position + 1 WHERE id=?`, [r.id]);
  }
  runSql(`UPDATE spirit_photos SET position=0 WHERE id=?`, [photoId]);
  syncPrimaryPhoto(parentId, 'spirit');
  saveDB();
  res.json({ ok: true });
});

app.post('/api/spirits/:id/photos/reorder', (req, res) => {
  const parentId = parseInt(req.params.id, 10);
  const order = Array.isArray(req.body && req.body.order) ? req.body.order : null;
  if (!order) return res.status(400).json({ error: 'body.order[] richiesto' });
  const existing = getAll(`SELECT id FROM spirit_photos WHERE spirit_id=?`, [parentId]).map(r => r.id);
  const incomingIds = order.map(o => parseInt(o.id, 10)).filter(Number.isInteger);
  if (incomingIds.length !== order.length) return res.status(400).json({ error: 'id non validi in order[]' });
  if (incomingIds.some(id => !existing.includes(id))) return res.status(400).json({ error: 'id non appartenenti al superalcolico' });
  if (incomingIds.length !== new Set(incomingIds).size) return res.status(400).json({ error: 'id duplicati in order[]' });
  for (let i = 0; i < incomingIds.length; i++) {
    runSql(`UPDATE spirit_photos SET position=? WHERE id=?`, [-1 - i, incomingIds[i]]);
  }
  for (let i = 0; i < incomingIds.length; i++) {
    runSql(`UPDATE spirit_photos SET position=? WHERE id=?`, [i, incomingIds[i]]);
  }
  syncPrimaryPhoto(parentId, 'spirit');
  saveDB();
  res.json({ ok: true });
});

// ---------- API: health ----------
// Endpoint usato dal healthcheck di Docker (prima puntava su /api/stats, che carica
// tutto il DB e serializza un JSON grosso: un check ogni 30s che di per sé causava
// picchi di memoria su una board con 256 MB). Qui bastano un SELECT 1 e lo stato
// raccolto in memoria, così il container si avara (o no) per motivi reali.
// Restituisce 503 quando il DB non risponde o ci sono stati 5xx ripetuti,
// ed espone l'ultimo errore: utile per diagnosticare da remoto con un semplice curl.
app.get('/api/health', (req, res) => {
  try {
    const now = Date.now();
    recentErrors = recentErrors.filter(t => now - t < 60000);
    const dbOk = dbProbeOk();
    const ok = dbOk && recentErrors.length < WATCHDOG_MAX_ERRORS;
    res.status(ok ? 200 : 503).json({
      ok,
      db_ok: dbOk,
      uptime_s: Math.round((now - STARTED_AT) / 1000),
      errors_last_60s: recentErrors.length,
      memory_mb: Math.round(process.memoryUsage().rss / 1048576),
      // picco di RSS dall'avvio: su 256 MB è la cosa da tenere d'occhio
      // (un backup o un upload che lo fa esplodere è il segnale di un regresso)
      peak_rss_mb: Math.round(process.resourceUsage().maxRSS / 1024),
      last_error: lastError,
      last_save_error: lastSaveError,
    });
  } catch (e) {
    res.status(503).json({ ok: false, error: String((e && e.message) || e) });
  }
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
    `SELECT w.id, w.name, w.rating, s.name AS store_name,
            (SELECT COUNT(*) FROM wine_photos wp WHERE wp.wine_id = w.id) AS photo_count
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
            w.created_at,
            (SELECT COUNT(*) FROM wine_photos wp WHERE wp.wine_id = w.id) AS photo_count
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
    // I vini SENZA negozio sono raggruppati in un blocco sintetico (id=null,
    // name='— Senza negozio —') in modo che la pagina stats li mostri nello stesso
    // stile delle sezioni per negozio (toggle 🍾/🍷, counter, card cliccabili).
    // È ancora il consumers JS a renderizzare — qui ci limitiamo a produrre la sezione.
    // NB: un vino con store_id orfano (negozio cancellato con FK disattivate) non va
    // più saltato con `continue` — finiva nel blocco "Senza negozio", altrimenti
    // spariva dalle statistiche pur essendo ancora nel DB.
    const isGrouped = w.store_id == null;
    const storeName = isGrouped ? '— Senza negozio —' : storesById.get(Number(w.store_id));
    const orphanStore = !isGrouped && !storeName; // negozio più esistente → trattalo come "senza negozio"
    const sId = (isGrouped || orphanStore) ? '__null_store__' : Number(w.store_id);
    let s = byStoreMap.get(sId);
    if (!s) {
      const sName = storeName || '— Senza negozio —';
      s = {
        id: (isGrouped || orphanStore) ? null : Number(w.store_id), name: sName,
        count: 0, avg_rating: null,
        count_bianco: 0, count_rosso: 0, count_null: 0,
        wines: { bianco: [], rosso: [], null_type: [] },
        _ratingsSum: 0, _ratingsN: 0,
      };
      byStoreMap.set(sId, s);
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
      photo_count: w.photo_count,
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
  }).sort((a, b) => {
    // "Senza negozio" sempre in fondo (nessun id reale): ordina per count decrescente,
    // poi per nome alfabetico. Il blocco sintetico va dopo tutti i negozi reali.
    if (a.id === null && b.id !== null) return 1;
    if (a.id !== null && b.id === null) return -1;
    return b.count - a.count || a.name.localeCompare(b.name);
  });

  const byMonth = getAll(
    `SELECT substr(created_at, 1, 7) AS month, COUNT(*) AS count
       FROM wines
       GROUP BY substr(created_at, 1, 7)
       ORDER BY month DESC
       LIMIT 12`
  );
  const recent = getAll(
    `SELECT w.id, w.name, w.rating, w.created_at, w.photo_path, w.wine_type, w.price,
            s.name AS store_name,
            (SELECT COUNT(*) FROM wine_photos wp WHERE wp.wine_id = w.id) AS photo_count
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

// ---------- API: stats alcolici ----------
// Ricalca la struttura del /api/stats ma sui superalcolici: totali + per negozio
// raggruppato per spirit_type. I "tipi" sono liberi (stringhe) quindi raggruppiamo
// dinamicamente in una mappa { type -> count, wines[], ... }.
// Non restituiamo un count_bianco/rosso (che non ha senso qui) ma un
// `by_type: [{ type, count, wines: [...] }]` parallelo al "Vini per negozio"
// della stats principale.

app.get('/api/spirits-stats', (req, res) => {
  const totals = getOne(`SELECT COUNT(*) AS total_spirits FROM spirits`) || { total_spirits: 0 };
  const storeCount = getOne(`SELECT COUNT(*) AS total_stores FROM stores`) || { total_stores: 0 };
  const avgRating = getOne(`SELECT AVG(rating) AS avg_rating FROM spirits`) || { avg_rating: null };

  const topSpirits = getAll(
    `SELECT s.id, s.name, s.rating, st.name AS store_name,
            (SELECT COUNT(*) FROM spirit_photos sp WHERE sp.spirit_id = s.id) AS photo_count
       FROM spirits s LEFT JOIN stores st ON st.id = s.store_id
       ORDER BY s.rating DESC, s.created_at DESC
       LIMIT 5`
  );

  const allSpirits = getAll(
    `SELECT s.id, s.name, s.store_id, s.rating, s.note, s.photo_path, s.spirit_type, s.abv, s.price,
            s.created_at,
            (SELECT COUNT(*) FROM spirit_photos sp WHERE sp.spirit_id = s.id) AS photo_count
       FROM spirits s
       ORDER BY s.created_at DESC`
  );
  const storesById = new Map();
  for (const st of getAll(`SELECT id, name FROM stores`)) {
    storesById.set(Number(st.id), st.name);
  }

  // Partiziona per negozio (con un blocco sintetico per i "senza negozio").
  // All'interno di ogni negozio partizioniamo per spirit_type in modo che la
  // pagina stats possa renderizzare tanti sottogruppi quanti sono i tipi.
  // typeMap è una mappa dinamica perché spirit_type non è un enum chiuso.
  const byStoreMap = new Map();
  for (const s of allSpirits) {
    // Stessa logica di /api/stats: store_id orfano → blocco "Senza negozio"
    // invece di saltare il record (che sparirebbe dalle statistiche).
    const isGrouped = s.store_id == null;
    const storeName = isGrouped ? '— Senza negozio —' : storesById.get(Number(s.store_id));
    const orphanStore = !isGrouped && !storeName;
    const sId = (isGrouped || orphanStore) ? '__null_store__' : Number(s.store_id);
    let entry = byStoreMap.get(sId);
    if (!entry) {
      const sName = storeName || '— Senza negozio —';
      entry = {
        id: (isGrouped || orphanStore) ? null : Number(s.store_id),
        name: sName,
        count: 0,
        avg_rating: null,
        _ratingsSum: 0, _ratingsN: 0,
        _types: new Map(),  // type → { type, count, wines: [] }
      };
      byStoreMap.set(sId, entry);
    }
    entry.count++;
    if (Number.isInteger(s.rating)) { entry._ratingsSum += s.rating; entry._ratingsN++; }
    // Spirit_type: normalizza ma mantieni la stringa originale per mostrarne l'etichetta
    // (badge con meta, vedi spirits.js). Quando è null/'' usiamo il bucket 'nd' che è
    // "non raggruppabile" ma comunque visibile nella pagina.
    const tkey = (s.spirit_type && String(s.spirit_type).trim()) ? String(s.spirit_type).trim().toLowerCase() : 'nd';
    let tt = entry._types.get(tkey);
    if (!tt) {
      tt = { type: tkey, label: s.spirit_type || 'Senza tipo', count: 0, wines: [] };
      entry._types.set(tkey, tt);
    }
    tt.count++;
    tt.wines.push({
      id: s.id, name: s.name, rating: s.rating, price: s.price, note: s.note,
      photo_path: s.photo_path, spirit_type: s.spirit_type, abv: s.abv,
      created_at: s.created_at, photo_count: s.photo_count,
    });
  }

  // Converti la mappa dei tipi in un array ordinato (più presenti prima, poi alfabetico).
  const byStore = Array.from(byStoreMap.values()).map(s => {
    const typesArr = Array.from(s._types.values())
      .sort((a, b) => b.count - a.count || a.type.localeCompare(b.type));
    return {
      id: s.id, name: s.name, count: s.count,
      avg_rating: s._ratingsN > 0 ? +(s._ratingsSum / s._ratingsN).toFixed(2) : null,
      types: typesArr,  // [{type, count, wines}]
    };
  }).sort((a, b) => {
    if (a.id === null && b.id !== null) return 1;
    if (a.id !== null && b.id === null) return -1;
    return b.count - a.count || a.name.localeCompare(b.name);
  });

  // Distribuzione per tipo (di tutto il catalogo, indipendentemente dal negozio) per il
  // eventuale "Sommario tipi" mostrato in pagina.
  const globalTypes = new Map();
  for (const s of allSpirits) {
    const tkey = (s.spirit_type && String(s.spirit_type).trim()) ? String(s.spirit_type).trim().toLowerCase() : 'nd';
    let entry = globalTypes.get(tkey);
    if (!entry) { entry = { type: tkey, label: s.spirit_type || 'Senza tipo', count: 0 }; globalTypes.set(tkey, entry); }
    entry.count++;
  }
  const byType = Array.from(globalTypes.values())
    .sort((a, b) => b.count - a.count || a.type.localeCompare(b.type));

  const byMonth = getAll(
    `SELECT substr(created_at, 1, 7) AS month, COUNT(*) AS count
       FROM spirits
       GROUP BY substr(created_at, 1, 7)
       ORDER BY month DESC
       LIMIT 12`
  );
  const recent = getAll(
    `SELECT s.id, s.name, s.rating, s.created_at, s.photo_path, s.spirit_type, s.abv, s.price,
            st.name AS store_name,
            (SELECT COUNT(*) FROM spirit_photos sp WHERE sp.spirit_id = s.id) AS photo_count
       FROM spirits s LEFT JOIN stores st ON st.id = s.store_id
       ORDER BY s.created_at DESC
       LIMIT 10`
  );

  res.json({
    total_spirits: totals.total_spirits,
    total_stores: storeCount.total_stores,
    avg_rating: avgRating.avg_rating,
    top_spirits: topSpirits,
    by_store: byStore,
    by_type: byType,
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

// ---------- API: backup completo (ZIP: wines.csv + spirits.csv + photos/ + MANIFEST.json) ----------
//   wines.csv       — vini (formato /api/export/wines.csv), separatore ';', BOM UTF-8
//   spirits.csv    — superalcolici, stesso layout ma con colonna `abv` aggiuntiva
//   photos/<basename> — uno per ogni file in PHOTO_DIR (ridimensionate 1024 px sul server)
//   MANIFEST.json   — { schema_version, generated_at, wine_count, spirit_count, photo_count }
// Schema versioni: 1 = solo vini (foto incluse, stesso PHOTO_DIR);
//                  2 = vini + alcolici (corrente). I backup v1 sono ancora leggibili al restore.
// Restituisce un archivio ZIP unico che contiene TUTTO lo stato utente salvabile:
//   wines.csv             — stesso formato di /api/export/wines.csv (metadati testuali)
//   photos/&lt;filename&gt;     — una copia di ogni file in PHOTO_DIR (foto ridimensionate 1024px)
//   MANIFEST.json         — { schema_version, generated_at, wine_count, photo_count }
// NOTA MEMORIA: in passato il ZIP veniva costruito interamente in RAM
// (AdmZip.toBuffer): tutte le foto in memoria + una copia del risultato, e con alcune
// centinaia di immagini si superavano i 256 MB di mem_limit (=> OOM / stato avario).
// Ora il backup è generato in streaming con yazl: si legge una foto alla volta da
// disco e la si scrive in pipe verso il client, la memoria resta ~costante.
const BACKUP_SCHEMA_VERSION = 3;

app.get('/api/backup', async (req, res) => {
  try {
    // ----- wines.csv -----
    const wineRows = getAll(
      `SELECT w.id, w.name, w.wine_type, w.price, s.name AS store, w.rating, w.note, w.photo_path, w.created_at
         FROM wines w LEFT JOIN stores s ON s.id = w.store_id
         ORDER BY w.created_at ASC`
    );
    const wineLines = ['id;name;type;price;store;rating;note;photo;created_at'];
    for (const r of wineRows) {
      const priceStr = r.price != null ? Number(r.price).toFixed(2).replace('.', ',') : '';
      wineLines.push([r.id, r.name, r.wine_type || '', priceStr, r.store || '', r.rating, r.note || '', r.photo_path || '', r.created_at].map(csvEscape).join(';'));
    }
    const wineCsvText = '\ufeff' + wineLines.join('\n');

    // ----- spirits.csv (formato analogo a wines.csv ma con colonna `abv`) -----
    const spiritRows = getAll(
      `SELECT s.id, s.name, s.spirit_type, s.abv, s.price, st.name AS store, s.rating, s.note, s.photo_path, s.created_at
         FROM spirits s LEFT JOIN stores st ON st.id = s.store_id
         ORDER BY s.created_at ASC`
    );
    const spiritLines = ['id;name;type;abv;price;store;rating;note;photo;created_at'];
    for (const r of spiritRows) {
      // abv: virgola come separatore (compatibile con Excel-IT);
      //   decimali utente preservati (38 vs 38.5 -> '38' vs '38,5').
      const abvStr = r.abv != null ? String(r.abv).replace('.', ',') : '';
      const priceStr = r.price != null ? Number(r.price).toFixed(2).replace('.', ',') : '';
      spiritLines.push([r.id, r.name, r.spirit_type || '', abvStr, priceStr, r.store || '', r.rating, r.note || '', r.photo_path || '', r.created_at].map(csvEscape).join(';'));
    }
    const spiritCsvText = '\ufeff' + spiritLines.join('\n');

    // ---- wine_photos.csv (galleria vini; id,wine_id,position,photo_path,created_at) ----
    const winePhotos = getAll(
      `SELECT id, wine_id, position, photo_path, created_at FROM wine_photos ORDER BY wine_id ASC, position ASC, id ASC`
    );
    const winePhotoLines = ['id;wine_id;position;photo_path;created_at'];
    for (const p of winePhotos) {
      winePhotoLines.push([p.id, p.wine_id, p.position, p.photo_path, p.created_at || ''].map(csvEscape).join(';'));
    }
    const winePhotosCsvText = '\ufeff' + winePhotoLines.join('\n');
    // ---- spirit_photos.csv (galleria spirits) ----
    const spiritPhotos = getAll(
      `SELECT id, spirit_id, position, photo_path, created_at FROM spirit_photos ORDER BY spirit_id ASC, position ASC, id ASC`
    );
    const spiritPhotoLines = ['id;spirit_id;position;photo_path;created_at'];
    for (const p of spiritPhotos) {
      spiritPhotoLines.push([p.id, p.spirit_id, p.position, p.photo_path, p.created_at || ''].map(csvEscape).join(';'));
    }
    const spiritPhotosCsvText = '\ufeff' + spiritPhotoLines.join('\n');

    let photoCount = 0;
    const photoFiles = [];
    if (fs.existsSync(PHOTO_DIR)) {
      for (const f of fs.readdirSync(PHOTO_DIR)) {
        const full = path.join(PHOTO_DIR, f);
        try {
          // isFile + leggibile: file illeggibili saltati QUI, così manifest, header
          // e contenuto del zip restano coerenti tra loro.
          if (fs.statSync(full).isFile()) {
            fs.accessSync(full, fs.constants.R_OK);
            photoFiles.push(full);
            photoCount++;
          }
        } catch (_) { /* race o permessi → ignora */ }
      }
    }

    const manifest = {
      schema_version: BACKUP_SCHEMA_VERSION,
      generated_at: new Date().toISOString(),
      app: 'vini-pwa',
      wine_count: wineRows.length,
      spirit_count: spiritRows.length,
      wine_photo_count: winePhotos.length,
      spirit_photo_count: spiritPhotos.length,
      photo_count: photoCount,
    };

    // ----- costruzione del ZIP in streaming -----
    // I CSV e il manifest sono minuscoli, restano in buffer; le foto vengono aggiunte
    // per percorso e yazl le apre una alla volta durante l'invio (backpressure di pipe).
    const zipfile = new yazl.ZipFile();
    zipfile.addBuffer(Buffer.from(JSON.stringify(manifest, null, 2), 'utf8'), 'MANIFEST.json');
    zipfile.addBuffer(Buffer.from(wineCsvText, 'utf8'), 'wines.csv');
    zipfile.addBuffer(Buffer.from(spiritCsvText, 'utf8'), 'spirits.csv');
    zipfile.addBuffer(Buffer.from(winePhotosCsvText, 'utf8'), 'wine_photos.csv');
    zipfile.addBuffer(Buffer.from(spiritPhotosCsvText, 'utf8'), 'spirit_photos.csv');
    for (const fullPath of photoFiles) {
      // Niente path traversal: il basename proviene da fs.readdirSync di PHOTO_DIR.
      // compress:false: le foto sono già JPEG, ridiflare sarebbe solo fatica per l'ARM.
      // Ancora non è stato scritto niente sul socket: se un file è sparito nel frattempo
      // possiamo permetterci un pulito 500 JSON invece di un download troncato.
      try { fs.accessSync(fullPath, fs.constants.R_OK); }
      catch (_) { throw new Error('foto non leggibile: ' + path.basename(fullPath)); }
      zipfile.addFile(fullPath, 'photos/' + path.basename(fullPath), { compress: false });
    }

    const yyyymmdd = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="vini-backup-${yyyymmdd}.zip"`);
    res.setHeader('X-Wine-Count', String(wineRows.length));
    res.setHeader('X-Spirit-Count', String(spiritRows.length));
    res.setHeader('X-Photo-Count', String(photoCount));

    // Da qui in poi i header sono partiti: un errore non può più diventare un 500 JSON,
    // ci limitiamo a loggarlo e a chiudere lo stream (il client vedrà un download fallito).
    const destroyStream = () => { if (!zipfile.outputStream.destroyed) zipfile.outputStream.destroy(); };
    res.on('close', destroyStream); // client disconnesso a metà → smette di leggere le foto
    zipfile.outputStream.on('error', (e) => { console.error('[backup] errore stream:', e); destroyStream(); });
    zipfile.outputStream.pipe(res);
    zipfile.end(); // tutti gli entry aggiunti: yazl può chiudere l'archivio
  } catch (e) {
    console.error('[backup]', e);
    if (res.headersSent) { res.destroy(); return; }
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

  // Validazione: MANIFEST.json deve esistere e avere schema_version=1, 2 oppure 3.
  //   1 = solo vini (legacy)
  //   2 = vini + alcolici (senza galleries separate)
  //   3 = corrente, include anche le galleries (wine_photos / spirit_photos)
  const manifestEntry = zip.getEntry('MANIFEST.json');
  if (!manifestEntry) return res.status(400).json({ error: 'MANIFEST.json mancante (non è un backup valido)' });
  let manifest;
  try {
    manifest = JSON.parse(manifestEntry.getData().toString('utf8'));
  } catch (e) {
    return res.status(400).json({ error: 'MANIFEST.json non parsabile' });
  }
  const schemaVer = Number(manifest.schema_version);
  if (schemaVer !== 1 && schemaVer !== 2 && schemaVer !== 3) {
    return res.status(400).json({ error: 'schema_version non supportato: ' + manifest.schema_version });
  }
  const includeSpirits = (schemaVer >= 2) && (zip.getEntry('spirits.csv') != null);

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

    // 1. Svuota DB. Ordine importante a causa dei vincoli FK:
    //    ultime le tabelle padre (wines, spirits, stores). Nota: ON DELETE CASCADE sulle
    //    tabelle figlio (wine_photos / spirit_photos) dovrebbe già svuotarle, ma le
    //    cancelliamo esplicitamente per chiarezza e per gestire anche backup v1/v2 dove
    //    queste tabelle sono vuote da subito.
    db.run('DELETE FROM wine_photos');
    db.run('DELETE FROM spirit_photos');
    db.run('DELETE FROM wines');
    db.run('DELETE FROM spirits');
    db.run('DELETE FROM stores');

    // 2. Svuota /photos (best-effort: ignora singoli file mancanti o locked).
    if (fs.existsSync(PHOTO_DIR)) {
      for (const f of fs.readdirSync(PHOTO_DIR)) {
        try { fs.unlinkSync(path.join(PHOTO_DIR, f)); } catch (_) { /* ignore */ }
      }
    }

    // 3. Ricostruisci stores case-insensitive, riusando la mappa all'interno della transazione.
    // Nota: NON ci fidiamo di last_insert_rowid() dopo INSERT in transazioni BEGIN/COMMIT di sql.js
    // (storicamente inaffidabile quando si mescolano insert con id esplicito). Usiamo invece
    // SELECT id FROM stores WHERE name = ? subito dopo l'INSERT: è deterministico e funziona
    // anche con vincoli UNIQUE violati (il fallimento dell'INSERT produce una exception visibile).
    const storesByName = new Map();
    function getOrCreateStore(name) {
      const safe = String(name).trim();
      const key = safe.toLowerCase();
      if (!key) return null;
      if (storesByName.has(key)) return storesByName.get(key);
      try {
        db.run(`INSERT INTO stores (name) VALUES (?)`, [safe]);
      } catch (e) {
        // Possibile UNIQUE collision se per qualunque motivo esiste già un record con questo
        // nome (in teoria impossibile dopo DELETE FROM stores, ma difesa in profondità).
        const existing = getOne(`SELECT id FROM stores WHERE LOWER(name)=LOWER(?)`, [safe]);
        if (existing) {
          const id = Number(existing.id);
          storesByName.set(key, id);
          return id;
        }
        throw e;
      }
      const sel = getOne(`SELECT id FROM stores WHERE name = ?`, [safe]);
      if (!sel) return null;
      const id = Number(sel.id);
      storesByName.set(key, id);
      return id;
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

    // 3b. (solo se backup v2 CON spirits.csv presente) Importa anche gli alcolici.
    //     spirits.csv ha lo stesso layout di wines.csv ma con una colonna `abv`
    //     aggiuntiva. spirit_type è una stringa libera qui, quindi niente whitelist:
    //     ogni valore non vuoto viene accettato (lowercase + trim + cap 40 char).
    let spiritsRestored = 0, spiritsErrors = 0;
    if (includeSpirits) {
      const spiritCsvEntry = zip.getEntry('spirits.csv');
      const spiritCsvText = spiritCsvEntry.getData().toString('utf8');
      const sRows = parseCsv(spiritCsvText).filter(r => r.some(c => (c || '').trim() !== ''));
      if (sRows.length > 1) {
        const sHeader = (sRows[0] || []).map(h => (h || '').toLowerCase().trim());
        const sIdx = {
          id: sHeader.indexOf('id'),
          name: sHeader.indexOf('name'),
          type: sHeader.indexOf('type'),
          abv: sHeader.indexOf('abv'),
          price: sHeader.indexOf('price'),
          store: sHeader.indexOf('store'),
          rating: sHeader.indexOf('rating'),
          note: sHeader.indexOf('note'),
          photo: sHeader.indexOf('photo'),
          created_at: sHeader.indexOf('created_at'),
        };
        if (sIdx.name < 0 || sIdx.rating < 0 || sIdx.id < 0) {
          db.run('ROLLBACK');
          return res.status(400).json({ error: 'colonne "id", "name" o "rating" mancanti nell\'header di spirits.csv' });
        }
        // Parser dedicati per spirit_type (permessivo) e abv (0..100, 1 decimale).
        // parsePrice è già definito sopra nell'handler.
        function parseSpiritTypeRestore(raw) {
          if (raw == null) return null;
          const s = String(raw).trim().toLowerCase();
          if (!s) return null;
          return s.slice(0, 40);
        }
        function parseAbvRestore(raw) {
          if (raw == null || raw === '') return null;
          const n = Number(String(raw).trim().replace(',', '.'));
          if (!Number.isFinite(n) || n < 0 || n > 100) return null;
          return Math.round(n * 10) / 10;
        }
        for (let i = 1; i < sRows.length; i++) {
          const row = sRows[i] || [];
          const id = parseInt((row[sIdx.id] || '').trim(), 10);
          if (!Number.isInteger(id) || id < 1) { spiritsErrors++; continue; }
          const name = (row[sIdx.name] || '').trim();
          const rating = parseInt((row[sIdx.rating] || '').trim(), 10);
          if (!name) { spiritsErrors++; continue; }
          if (!Number.isInteger(rating) || rating < 1 || rating > 10) { spiritsErrors++; continue; }
          const storeId = (sIdx.store >= 0 && row[sIdx.store]) ? getOrCreateStore(String(row[sIdx.store]).trim()) : null;
          const note = (sIdx.note >= 0 && row[sIdx.note] != null) ? String(row[sIdx.note]) : null;
          const spiritType = parseSpiritTypeRestore(sIdx.type >= 0 ? row[sIdx.type] : null);
          const abv = parseAbvRestore(sIdx.abv >= 0 ? row[sIdx.abv] : null);
          const price = parsePrice(sIdx.price >= 0 ? row[sIdx.price] : null);
          const createdAt = (sIdx.created_at >= 0 && row[sIdx.created_at]) ? String(row[sIdx.created_at]).trim() : null;
          const photoPath = (sIdx.photo >= 0 && row[sIdx.photo]) ? String(row[sIdx.photo]).trim() : null;
          try {
            runSql(
              `INSERT INTO spirits (id, name, store_id, rating, note, photo_path, spirit_type, abv, price, created_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              [id, name, storeId, rating, note, photoPath || null, spiritType, abv, price, createdAt]
            );
            spiritsRestored++;
            if (photoPath) photoSet.add(photoPath);  // accumula nel set già tracciato dai vini
          } catch (e) {
            spiritsErrors++;
          }
        }
      }
    }

    // 4. Scrivi le foto: solo quelle effettivamente referenziate dal CSV (evita di
    //    spargere file orfani che farebbero solo peso). Estrai ogni entries/photos/<file>.
    let photoWritten = 0, photoSkipped = 0;

    // 3c. (solo backup v3) Importa anche le galleries multi-foto. wine_photos.csv e
    //     spirit_photos.csv hanno lo stesso schema: id;parent_id;position;photo_path;created_at
    //     Ogni photo_path viene aggiunto al set per essere poi scritto su disco insieme
    //     alle foto "primary" (quelle referenziate anche dai wines.csv / spirits.csv).
    let winePhotosRestored = 0, winePhotoErrors = 0;
    if (schemaVer === 3 && zip.getEntry('wine_photos.csv')) {
      const wpcText = zip.getEntry('wine_photos.csv').getData().toString('utf8');
      const wpRows = parseCsv(wpcText).filter(r => r.some(c => (c || '').trim() !== ''));
      if (wpRows.length > 1) {
        const wpHeader = (wpRows[0] || []).map(h => (h || '').toLowerCase().trim());
        const wpIdx = {
          id: wpHeader.indexOf('id'),
          wine_id: wpHeader.indexOf('wine_id'),
          position: wpHeader.indexOf('position'),
          photo_path: wpHeader.indexOf('photo_path'),
          created_at: wpHeader.indexOf('created_at'),
        };
        if (wpIdx.wine_id < 0 || wpIdx.position < 0 || wpIdx.photo_path < 0) {
          db.run('ROLLBACK');
          return res.status(400).json({ error: 'colonne "wine_id"/"position"/"photo_path" mancanti in wine_photos.csv' });
        }
        for (let i = 1; i < wpRows.length; i++) {
          const row = wpRows[i] || [];
          const wineId = parseInt((row[wpIdx.wine_id] || '').trim(), 10);
          const position = parseInt((row[wpIdx.position] || '').trim(), 10);
          const photoPath = (row[wpIdx.photo_path] || '').trim();
          if (!Number.isInteger(wineId) || !Number.isInteger(position) || !photoPath) { winePhotoErrors++; continue; }
          try {
            db.run(
              `INSERT INTO wine_photos (wine_id, position, photo_path) VALUES (?, ?, ?)`,
              [wineId, position, photoPath]
            );
            photoSet.add(photoPath);
            winePhotosRestored++;
          } catch (e) {
            // tipicamente UNIQUE(wine_id, position) o vino inesistente. Skip morbido.
            winePhotoErrors++;
          }
        }
      }
    }
    let spiritPhotosRestored = 0, spiritPhotoErrors = 0;
    if (schemaVer === 3 && zip.getEntry('spirit_photos.csv')) {
      const spcText = zip.getEntry('spirit_photos.csv').getData().toString('utf8');
      const spRows = parseCsv(spcText).filter(r => r.some(c => (c || '').trim() !== ''));
      if (spRows.length > 1) {
        const spHeader = (spRows[0] || []).map(h => (h || '').toLowerCase().trim());
        const spIdx = {
          id: spHeader.indexOf('id'),
          spirit_id: spHeader.indexOf('spirit_id'),
          position: spHeader.indexOf('position'),
          photo_path: spHeader.indexOf('photo_path'),
          created_at: spHeader.indexOf('created_at'),
        };
        if (spIdx.spirit_id < 0 || spIdx.position < 0 || spIdx.photo_path < 0) {
          db.run('ROLLBACK');
          return res.status(400).json({ error: 'colonne "spirit_id"/"position"/"photo_path" mancanti in spirit_photos.csv' });
        }
        for (let i = 1; i < spRows.length; i++) {
          const row = spRows[i] || [];
          const spiritId = parseInt((row[spIdx.spirit_id] || '').trim(), 10);
          const position = parseInt((row[spIdx.position] || '').trim(), 10);
          const photoPath = (row[spIdx.photo_path] || '').trim();
          if (!Number.isInteger(spiritId) || !Number.isInteger(position) || !photoPath) { spiritPhotoErrors++; continue; }
          try {
            db.run(
              `INSERT INTO spirit_photos (spirit_id, position, photo_path) VALUES (?, ?, ?)`,
              [spiritId, position, photoPath]
            );
            photoSet.add(photoPath);
            spiritPhotosRestored++;
          } catch (e) {
            spiritPhotoErrors++;
          }
        }
      }
    }
    // Risincronizza la cache denormalized photo_path nei record parent: la foto "primary"
    // è quella con position minima. Se nessuna gallery è ripristinata (backup v1/v2),
    // la cache resta il photo_path dichiarato in wines.csv / spirits.csv.
    db.run(`
      UPDATE wines SET photo_path = COALESCE(
        (SELECT photo_path FROM wine_photos WHERE wine_id = wines.id ORDER BY position ASC, id ASC LIMIT 1),
        photo_path
      )
    `);
    db.run(`
      UPDATE spirits SET photo_path = COALESCE(
        (SELECT photo_path FROM spirit_photos WHERE spirit_id = spirits.id ORDER BY position ASC, id ASC LIMIT 1),
        photo_path
      )
    `);
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
      schema_version: schemaVer,
      wines: restored,
      spirits: spiritsRestored,
      wine_photos: winePhotosRestored,
      spirit_photos: spiritPhotosRestored,
      wine_errors: errors,
      spirit_errors: spiritsErrors,
      wine_photo_errors: winePhotoErrors,
      spirit_photo_errors: spiritPhotoErrors,
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
  // Registra l'errore prima di rispondere: è quello che /api/health e il watchdog
  // usano per capire se l'app è sana. I MulterError (413, colpa del client) sono
  // già stati gestiti sopra; idem gli errori con status 4xx esplicito (body JSON
  // malformato, payload troppo grande…): sono errori del client, non dell'app e
  // non devono né contare come malfunzionamento né innescare il watchdog.
  const status = (err && Number(err.status) >= 400 && Number(err.status) < 500) ? Number(err.status) : 500;
  if (status >= 500) res.locals.errMessage = String(err.message || err); // verrà contato dall'hook "finish"
  console.error('[err]', err);
  res.status(status).json({ error: String(err.message || err) });
});

// ---------- watchdog: auto-riparazione ----------
// Docker segnala "unhealthy" ma NON riavvia mai i container da solo: per questo
// finora l'unica via d'uscita era ricaricare la stack a mano da Portainer (e solo
// stando a casa). Qui dentro il processo se ne accorge da solo e muore con exit 1:
// la policy `restart: unless-stopped` lo riavvia in pochi millisecondi.
setInterval(() => {
  const now = Date.now();
  if (now - STARTED_AT < WATCHDOG_MIN_UPTIME_MS) return;
  recentErrors = recentErrors.filter(t => now - t < WATCHDOG_ERROR_WINDOW_MS);
  const probeOk = dbProbeOk();
  const n = recentErrors.length;
  if (probeOk && n < WATCHDOG_MAX_ERRORS) return;
  console.error('[watchdog] stato non recuperabile: ' +
    `db_ok=${probeOk}, errori5xx_60s=${n}, ` +
    `ultimo_errore=${lastError ? `${lastError.where}: ${lastError.message}` : 'n/a'}, ` +
    `ultimo_errore_salvataggio=${lastSaveError ? lastSaveError.message : 'n/a'} ` +
    '→ exit(1) per far ripartire il container.');
  if (probeOk) saveDB(true); // ultimo salvataggio best-effort dei dati ancora in RAM
  process.exit(1);
}, WATCHDOG_INTERVAL_MS);

// Un qualsiasi crash non deve lasciare un processo mezzo morto: logga, salva, muori.
// (Docker riavvierebbe comunque, qui rendiamo l'evento leggibile nei log.)
process.on('uncaughtException', (e) => {
  console.error('[fatal] uncaughtException:', e);
  try { saveDB(true); } catch (_) { /* ignore */ }
  process.exit(1);
});
process.on('unhandledRejection', (e) => {
  console.error('[fatal] unhandledRejection:', e);
  try { saveDB(true); } catch (_) { /* ignore */ }
  process.exit(1);
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
