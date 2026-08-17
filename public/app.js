// Vini PWA — controller della pagina principale.
// Gestisce: lista, form aggiunta/modifica, upload foto, dropdown negozi, PWA install.

(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);

  // ---------- helpers ----------

  function toast(msg, kind = '') {
    const div = document.createElement('div');
    div.className = 'toast' + (kind ? ' ' + kind : '');
    div.textContent = msg;
    $('toast-container').appendChild(div);
    setTimeout(() => div.remove(), 3000);
  }

  async function api(path, opts = {}) {
    const r = await fetch(path, {
      headers: { 'Content-Type': 'application/json' },
      ...opts,
    });
    let body = null;
    try { body = await r.json(); } catch (_) { /* not json */ }
    if (!r.ok) {
      throw new Error((body && body.error) || ('HTTP ' + r.status));
    }
    return body;
  }

  // GET dettaglio vino (incluso photos[]). Usato da beginEdit per caricare la
  // galleria delle foto esistenti nella form. Non solleva errore se fallisce:
  // il chiamante decide come degradare (es. mostra solo la primary photo_path).
  async function fetchWineFull(id) {
    return api('/api/wines/' + id);
  }

  function fmtStarsReadonly(rating) {
    // mini-stelle per la card
    let html = '<div class="stars stars-readonly compact" aria-label="voto ' + rating + ' su 10">';
    for (let i = 10; i >= 1; i--) {
      html += '<input type="radio" disabled' + (i <= Number(rating) ? ' checked' : '') + '><label>★</label>';
    }
    html += '</div>';
    return html;
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function fmtPrice(p) {
    if (p == null || !Number.isFinite(Number(p))) return '';
    try {
      return new Intl.NumberFormat('it-IT', { style: 'currency', currency: 'EUR' }).format(Number(p));
    } catch (_) {
      return '€' + Number(p).toFixed(2);
    }
  }

  function wineTypeBadge(wt) {
    if (wt === 'bianco') return '<span class="wine-type-badge bianco" title="Vino bianco">🍾 Bianco</span>';
    if (wt === 'rosso')  return '<span class="wine-type-badge rosso"  title="Vino rosso">🍷 Rosso</span>';
    return '';
  }

  // ---------- stato ----------

  let editingId = null;
  // Dichiarazioni foto (pendingPhotoFiles, existingPhotos, pendingRemovals,
  // pendingPhotoUrls, pendingPhotoFile/Url legacy, currentPhotoPath) sono definite
  // più sotto nella sezione "galleria foto (multi-foto per vino)".
  let deferredInstallPrompt = null;

  // Soglie per il resize lato client PRIMA dell'upload.
  // Il server accetta fino a 8 MB (multer limits.fileSize) ma su Orange Pi con
  // mem_limit 256 MB e --max-old-space-size=128, Jimp che decodifica in V8 rischia
  // OOM e/o timeout del reverse proxy davanti al container su foto > ~1600 px lato
  // lungo. Per evitare OOM/502 ridimensioniamo sul dispositivo a max 1600 px JPEG
  // qualità 85 quando l'immagine è > 1600 px OPPURE > 1.2 MB.
  const PHOTO_CLIENT_MAX_DIM = 1600;
  const PHOTO_CLIENT_JPEG_QUALITY = 0.85;
  const PHOTO_CLIENT_SIZE_TRIGGER_BYTES = 1.2 * 1024 * 1024;

  // ---------- confirm modal (riusato da elimina vino ed eventuali altri) ----------
  let pendingConfirmCallback = null;
  let lastConfirmTrigger = null;

  function openConfirmModal(title, message, onOk, trigger) {
    $('confirm-modal-title').textContent = title;
    $('confirm-modal-message').textContent = message;
    pendingConfirmCallback = onOk;
    lastConfirmTrigger = trigger || null;
    $('confirm-modal').classList.add('open');
    $('confirm-modal').setAttribute('aria-hidden', 'false');
    const cancel = $('confirm-modal-cancel');
    try { cancel.focus({ preventScroll: true }); } catch (_) { cancel.focus(); }
  }

  function closeConfirmModal() {
    const wasOpen = $('confirm-modal').classList.contains('open');
    $('confirm-modal').classList.remove('open');
    $('confirm-modal').setAttribute('aria-hidden', 'true');
    if (wasOpen && lastConfirmTrigger && typeof lastConfirmTrigger.focus === 'function') {
      try { lastConfirmTrigger.focus({ preventScroll: true }); } catch (_) { lastConfirmTrigger.focus(); }
    }
    pendingConfirmCallback = null;
    lastConfirmTrigger = null;
  }

  // ---------- online status ----------

  function setOnline() {
    const pill = $('status-pill');
    if (!pill) return;
    if (navigator.onLine) {
      pill.textContent = 'online';
      pill.classList.add('online'); pill.classList.remove('offline');
    } else {
      pill.textContent = 'offline';
      pill.classList.add('offline'); pill.classList.remove('online');
    }
  }
  window.addEventListener('online', setOnline);
  window.addEventListener('offline', setOnline);
  setOnline();

  // ---------- stores dropdown ----------

  async function loadStores(selectId = null) {
    try {
      const stores = await api('/api/stores');
      const sel = $(selectId || 'wine-store');
      const previous = sel.value;
      sel.innerHTML = '<option value="">— non specificato —</option>';
      for (const s of stores) {
        const opt = document.createElement('option');
        opt.value = s.id;
        opt.textContent = s.name;
        sel.appendChild(opt);
      }
      if (previous) sel.value = previous;
      return stores;
    } catch (e) {
      console.warn('loadStores:', e);
      return [];
    }
  }

  // ---------- wines list ----------

  async function loadWines() {
    try {
      const wines = await api('/api/wines?limit=300');
      renderWines(wines);
      $('count-wines').textContent = wines.length;
    } catch (e) {
      if (!navigator.onLine) {
        toast('Offline — riprova quando torni online.', 'error');
      } else {
        toast('Errore caricamento: ' + e.message, 'error');
      }
    }
  }

  function renderWines(wines) {
    const wrap = $('wines-list');
    wrap.innerHTML = '';
    if (!wines.length) { $('empty-state').hidden = false; return; }
    $('empty-state').hidden = true;
    for (const w of wines) {
      const card = document.createElement('div');
      card.className = 'wine-card';
      card.dataset.id = w.id;

      const thumbH = w.photo_path
        ? '<img src="/photos/' + encodeURIComponent(w.photo_path) + '" alt="" loading="lazy" />'
        : '🍷';
      // Badge "📷 N" se il vino ha più di 1 foto (galleria scorrevole nel lightbox)
      const badgeH = (Number(w.photo_count) > 1)
        ? '<div class="thumb-photo-counter" aria-label="' + w.photo_count + ' foto">' +
            '<span aria-hidden="true">📷</span>' + w.photo_count + '</div>'
        : '';

      card.innerHTML = `
        <button type="button" class="wine-delete-btn" aria-label="Elimina vino" title="Elimina">🗑</button>
        <div class="thumb">${thumbH}${badgeH}</div>
        <div class="meta">
          <div class="name">${escapeHtml(w.name)}${wineTypeBadge(w.wine_type)}</div>
          <div class="store">${escapeHtml(w.store_name || '— senza negozio —')}</div>
          ${w.note ? `<div class="note-preview">${escapeHtml(w.note)}</div>` : ''}
          ${w.price != null && Number.isFinite(Number(w.price)) ? `<div class="price">${fmtPrice(w.price)}</div>` : ''}
        </div>
        <div class="right">
          ${fmtStarsReadonly(w.rating)}
          <div class="date">${(w.created_at || '').slice(0, 10)}</div>
        </div>
      `;
      card.addEventListener('click', () => beginEdit(w));
      const delBtn = card.querySelector('.wine-delete-btn');
      if (delBtn) {
        // Conferma prima di cancellare; il bottone in card on evita di aprire il form di modifica.
        delBtn.addEventListener('click', (ev) => {
          ev.stopPropagation();
          ev.preventDefault();
          const wineName = (w.name && String(w.name)) || 'questo vino';
          openConfirmModal(
            'Elimina vino',
            `Vuoi eliminare “${wineName}”? L’operazione è irreversibile.`,
            async () => {
              try {
                await api('/api/wines/' + w.id, { method: 'DELETE' });
                toast('Vino eliminato', 'success');
                if (editingId === w.id) resetForm();
                loadWines();
              } catch (e) {
                toast('Errore: ' + e.message, 'error');
              }
            },
            delBtn
          );
        });
      }
      wrap.appendChild(card);
    }
  }

  // ---------- form logic ----------
  // clearPendingPhoto() è ridefinito nella sezione "galleria foto" come wrapper
  // attorno a clearPhotoGallery() per la retrocompatibilità del codice legacy.

  function resetForm() {
    editingId = null;
    currentPhotoPath = null;
    $('wine-id').value = '';
    $('wine-name').value = '';
    $('wine-note').value = '';
    $('wine-store').value = '';
    document.querySelectorAll('input[name="rating"]').forEach(r => r.checked = false);
    // Tipo: nessuna selezione (N/D selezionato di default in HTML).
    document.querySelectorAll('input[name="wine_type"]').forEach(r => { r.checked = (r.value === ''); });
    $('wine-price').value = '';
    $('form-title').textContent = 'Aggiungi vino';
    $('save-btn').textContent = 'Salva';
    $('cancel-edit-btn').hidden = true;
    clearPendingPhoto();
    // Sincronizza la classe .is-checked per il fallback Safari <15.4 (radio.checked non triggera 'change').
    syncRadioPills && syncRadioPills('wine_type');
  }

  function beginEdit(w) {
    editingId = w.id;
    currentPhotoPath = w.photo_path || null;
    $('wine-id').value = w.id;
    $('wine-name').value = w.name || '';
    $('wine-note').value = w.note || '';
    $('wine-store').value = w.store_id || '';
    const r = parseInt(w.rating, 10);
    const radio = document.getElementById('r' + r);
    if (radio) radio.checked = true;
    // Tipo: ripristina il valore salvato, o N/D se null/unknown.
    const wT = (w.wine_type === 'bianco' || w.wine_type === 'rosso') ? w.wine_type : '';
    document.querySelectorAll('input[name="wine_type"]').forEach(r => { r.checked = (r.value === wT); });
    $('wine-price').value = (w.price != null && Number.isFinite(Number(w.price))) ? String(w.price) : '';
    // Pulisci la galleria pending e poi carica le foto esistenti del vino.
    pendingPhotoFiles = [];
    revokePendingPhotoUrls();
    pendingRemovals = [];
    existingPhotos = [];
    pendingPhotoFile = null;
    pendingPhotoUrl = null;
    // Fetch i dettagli completi (incluso photos[]) per la galleria form.
    fetchWineFull(w.id).then(full => {
      existingPhotos = (full.photos || []).slice();
      currentPhotoPath = full.photo_path || null;
      renderPhotoGallery();
    }).catch(() => {
      // fallback: se il fetch fallisce, usa il photo_path minimo che abbiamo già nella card
      renderPhotoGallery();
    });
    renderPhotoGallery();
    $('form-title').textContent = 'Modifica: ' + (w.name || '');
    $('save-btn').textContent = 'Aggiorna';
    $('cancel-edit-btn').hidden = false;
    window.scrollTo({ top: 0, behavior: 'smooth' });
    // Sincronizza la classe .is-checked per il fallback Safari <15.4 (radio.checked non triggera 'change').
    syncRadioPills && syncRadioPills('wine_type');
  }

  // ---------- galleria foto (multi-foto per vino) ----------
  // Stato della galleria del form:
  //   pendingPhotoFiles: File[] locale, non ancora uploadato al server (per "Aggiungi")
  //   existingPhotos:    array di foto già salvate lato server (per "Modifica"):
  //                       [{ id, photo_path, url, position }]. Rimosse tramite
  //                       pendingRemovals[] per poter annullare l'edit prima del save.
  //   pendingRemovals:   photoId[] delle foto esistenti che l'utente ha chiesto di
  //                       cancellare; verranno inviate via DELETE al save.
  // NB: pendingPhotoFile e currentPhotoPath erano i nomi legacy (singola foto).
  //     Rimangono come alias locali (currentPhotoPath, pendingPhotoFile) ma il resto
  //     del codice usa le strutture nuove. clearPendingPhoto() è il solo riferimento
  //     residuo e lo lasciamo come wrapper a clearPhotoGallery().
  let pendingPhotoFiles = [];
  let existingPhotos = [];
  let pendingRemovals = [];
  let pendingPhotoUrls = [];  // blob URL delle pendingPhotoFiles; revocati al reset/replace
  // legacy aliases (per retrofit minimo con codice esistente)
  let pendingPhotoFile = null;
  let pendingPhotoUrl = null;
  let currentPhotoPath = null;

  function revokePendingPhotoUrls() {
    for (const u of pendingPhotoUrls) { try { URL.revokeObjectURL(u); } catch (_) {} }
    pendingPhotoUrls = [];
  }
  function clearPhotoGallery() {
    revokePendingPhotoUrls();
    pendingPhotoFiles = [];
    pendingPhotoFile = null;
    pendingPhotoUrl = null;
    existingPhotos = [];
    pendingRemovals = [];
    currentPhotoPath = null;
    renderPhotoGallery();
  }
  // legacy alias usato dal codice esistente (resetForm, beginEdit, getStartedForm)
  function clearPendingPhoto() { clearPhotoGallery(); }

  function pendingPreviewUrl(file) {
    const u = URL.createObjectURL(file);
    pendingPhotoUrls.push(u);
    return u;
  }

  function visiblePhotos() {
    // photos mostrate nella galleria: existingPhotos - pendingRemovals + pendingPhotoFiles
    const existing = existingPhotos.filter(p => !pendingRemovals.includes(p.id));
    return { existing, pending: pendingPhotoFiles.slice() };
  }

  function renderPhotoGallery() {
    const root = $('photo-gallery');
    const counter = $('photo-counter');
    const list = $('photo-gallery-list');
    if (!root || !counter || !list) return;
    const { existing, pending } = visiblePhotos();
    const total = existing.length + pending.length;
    if (total === 0) {
      root.hidden = true;
      counter.textContent = '';
      list.innerHTML = '';
      // bottone "Rimuovi tutte" visibile solo in edit e solo se ci sono foto già caricate
      const rmBtn = $('remove-photo-btn');
      if (rmBtn) rmBtn.hidden = !(editingId && existingPhotos.length > 0);
      return;
    }
    root.hidden = false;
    counter.innerHTML = `<span aria-hidden="true">📷</span> <strong>${total}</strong> foto`;
    const rmBtn = $('remove-photo-btn');
    if (rmBtn) rmBtn.hidden = !(editingId && existingPhotos.length > 0);

    let html = '';
    // pending PRIMA (in alto): con badge "nuova" così l'utente vede cosa sta per caricare
    pending.forEach((f, idx) => {
      const url = pendingPreviewUrl(f);
      html += `<div class="photo-thumb" data-pending-idx="${idx}">
        <img src="${escapeHtml(url)}" alt="" />
        <span class="photo-thumb-badge">nuova</span>
        <button type="button" class="photo-thumb-remove" data-action="remove-pending" data-idx="${idx}" aria-label="Rimuovi foto">✕</button>
      </div>`;
    });
    existing.forEach((p) => {
      // p.url è già /photos/<file>; usiamo escapehtml sul filename-encoded
      const url = p.url || ('/photos/' + encodeURIComponent(p.photo_path));
      html += `<div class="photo-thumb" data-existing-id="${p.id}">
        <img src="${escapeHtml(url)}" alt="" loading="lazy" />
        ${pendingRemovals.includes(p.id) ? '<span class="photo-thumb-badge" style="background:rgba(185,77,77,0.85)">rimossa</span>' : ''}
        <button type="button" class="photo-thumb-remove" data-action="remove-existing" data-id="${p.id}" aria-label="Rimuovi foto dal server">✕</button>
      </div>`;
    });
    list.innerHTML = html;
  }

  async function addPendingFiles(files) {
    const arr = Array.from(files || []);
    if (!arr.length) return;
    // push nuovi pending
    for (const f of arr) {
      if (!f || !f.type || !f.type.startsWith('image/')) continue;
      pendingPhotoFiles.push(f);
      // resize client-side simile al flusso esistente; se fallisce, tiene l'originale
      try {
        const r = await maybeResizeImage(f);
        if (r.resized) {
          // sostituisci l'ultimo aggiunto con la versione ridotta
          pendingPhotoFiles[pendingPhotoFiles.length - 1] = r.file;
        }
      } catch (e) { console.warn('resize client foto:', e); }
    }
    renderPhotoGallery();
  }

  function removePendingPhotoAt(idx) {
    if (idx < 0 || idx >= pendingPhotoFiles.length) return;
    pendingPhotoFiles.splice(idx, 1);
    renderPhotoGallery();
  }
  function markExistingPhotoRemoved(id) {
    if (!pendingRemovals.includes(id)) pendingRemovals.push(id);
    renderPhotoGallery();
  }
  function unmarkExistingPhotoRemoved(id) {
    pendingRemovals = pendingRemovals.filter(x => x !== id);
    renderPhotoGallery();
  }

  // foto-galleria: handlers dei bottoni ✕ dentro la lista
  document.addEventListener('click', (ev) => {
    const t = ev.target.closest('[data-action]');
    if (!t) return;
    const a = t.getAttribute('data-action');
    if (a === 'remove-pending') {
      ev.preventDefault();
      removePendingPhotoAt(parseInt(t.getAttribute('data-idx'), 10));
    } else if (a === 'remove-existing') {
      ev.preventDefault();
      const id = parseInt(t.getAttribute('data-id'), 10);
      if (pendingRemovals.includes(id)) unmarkExistingPhotoRemoved(id);
      else markExistingPhotoRemoved(id);
    }
  });

  // Helper: prova a decodificare la foto e a ricodificarla a JPEG max 1600 px q=85
  // per alleggerire l'upload. Restituisce { file, resized, ... }.
  //   - resized=false → mantieni il File originale (già piccolo o decode non riuscito)
  //   - resized=true  → `file` è il File JPEG ricodificato
  // Usa createImageBitmap (decodifica fuori dal DOM, rilascia il bitmap con .close())
  // e l'opzione `imageOrientation: 'from-image'` per applicare EXIF Orientation
  // automaticamente (Chrome 81+, Safari 13.1+, recenti Firefox). Se decode fallisce
  // (es. HEIC su vecchi iOS, file corrotti), fallback al File originale e il server
  // multer rifiuterà eventualmente con 413 leggibile.
  async function maybeResizeImage(file) {
    if (!file || !file.type || !file.type.startsWith('image/')) {
      return { file, resized: false, reason: 'not-an-image' };
    }
    let bitmap;
    try {
      bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
    } catch (e) {
      console.warn('createImageBitmap fallita, uso file originale:', e);
      return { file, resized: false, reason: 'decode-failed' };
    }
    try {
      const w0 = bitmap.width, h0 = bitmap.height;
      const longest = Math.max(w0, h0);
      // Soglia: lascia com'è se sia dimensione sia peso sono sotto i limiti.
      if (file.size <= PHOTO_CLIENT_SIZE_TRIGGER_BYTES && longest <= PHOTO_CLIENT_MAX_DIM) {
        return { file, resized: false, reason: 'already-small', width: w0, height: h0 };
      }
      const scale = longest > PHOTO_CLIENT_MAX_DIM ? PHOTO_CLIENT_MAX_DIM / longest : 1;
      const w1 = Math.max(1, Math.round(w0 * scale));
      const h1 = Math.max(1, Math.round(h0 * scale));
      const canvas = document.createElement('canvas');
      canvas.width = w1;
      canvas.height = h1;
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        return { file, resized: false, reason: 'no-2d-context' };
      }
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(bitmap, 0, 0, w1, h1);

      const blob = await new Promise((resolve, reject) => {
        canvas.toBlob(
          (b) => (b ? resolve(b) : reject(new Error('toBlob vuoto'))),
          'image/jpeg',
          PHOTO_CLIENT_JPEG_QUALITY
        );
      });

      // Conserva il basename del File originale ma forza .jpg (lo accettiamo sempre
      // e l'utente vede l'estensione coerente nel toast).
      const baseName = (file.name || 'wine').replace(/\.[^.]+$/, '') || 'wine';
      const newName = baseName + '.jpg';
      const resizedFile = new File([blob], newName, {
        type: 'image/jpeg',
        lastModified: Date.now(),
      });
      return {
        file: resizedFile,
        resized: true,
        width: w1,
        height: h1,
        fromBytes: file.size,
        toBytes: blob.size,
      };
    } finally {
      // Libera il bitmap decoded; senza questo la memoria GraphicsBuffer può restare
      // allocata fino a GC, fastidioso su device mobili di fascia bassa.
      if (bitmap && typeof bitmap.close === 'function') bitmap.close();
    }
  }

  function fmtBytes(n) {
    return n < 1024 * 1024
      ? Math.round(n / 1024) + ' KB'
      : (n / 1024 / 1024).toFixed(2) + ' MB';
  }

  // Bind photo input (galleria multi-foto): può accettare più file in una volta
  // (l'input è `multiple`). Reset value PRIMA dell'await per permettere di
  // riscegliere gli stessi file. Il resize client-side viene applicato per ogni foto
  // individualmente da addPendingFiles().
  function bindPhotoFileInput(input) {
    input.addEventListener('change', async () => {
      const fs = input.files ? Array.from(input.files) : [];
      input.value = '';
      if (!fs.length) return;
      await addPendingFiles(fs);
    });
  }
  bindPhotoFileInput($('photo-input-gallery'));
  bindPhotoFileInput($('photo-input-camera'));

  $('btn-choose-photo').addEventListener('click', () => $('photo-input-gallery').click());
  $('btn-take-photo').addEventListener('click', () => $('photo-input-camera').click());

  // Upload multi-foto: una sola POST multipart con tutti i File. Il server accetta
  // fino a 8 foto/richiesta (upload.array('photos', 8)). Le nuove foto vengono
  // accodate in coda alle esistenti.
  async function uploadPhotosMulti(wineId, files) {
    const fd = new FormData();
    for (const f of files) fd.append('photos', f, f.name);
    const r = await fetch('/api/wines/' + wineId + '/photos', { method: 'POST', body: fd });
    let body = null;
    try { body = await r.json(); } catch (_) { /* ignore */ }
    if (!r.ok) throw new Error((body && body.error) || ('HTTP ' + r.status));
    return body;
  }

  // Elimina una o più foto esistenti via DELETE /api/wines/:id/photos/:photoId.
  // errors[] per photo: best-effort, ignora singoli 404 e continua.
  async function deletePhotosMulti(wineId, photoIds) {
    const errors = [];
    for (const id of photoIds) {
      try {
        await api('/api/wines/' + wineId + '/photos/' + id, { method: 'DELETE' });
      } catch (e) {
        errors.push({ id, error: String(e.message || e) });
      }
    }
    return errors;
  }

  // Bottone "Rimuovi tutte" (visibile solo in edit): le foto existing esistenti
  // vengono marcate per rimozione; l'azione DELETE avviene al save successivo.
  // Però per dare feedback immediato all'utente che qualcosa è cambiato, le
  // marchiamo subito come pendingRemovals.
  $('remove-photo-btn').addEventListener('click', () => {
    if (!editingId || !existingPhotos.length) return;
    for (const p of existingPhotos) {
      if (!pendingRemovals.includes(p.id)) pendingRemovals.push(p.id);
    }
    renderPhotoGallery();
  });

  $('cancel-edit-btn').addEventListener('click', resetForm);

  $('wine-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const name = $('wine-name').value.trim();
    const note = $('wine-note').value.trim();
    const storeId = $('wine-store').value;
    const ratingEl = document.querySelector('input[name="rating"]:checked');
    if (!name) { toast('Inserisci il nome del vino', 'error'); return; }
    if (!ratingEl) { toast('Scegli un voto da 1 a 10', 'error'); return; }
    const rating = parseInt(ratingEl.value, 10);
    const wineTypeEl = document.querySelector('input[name="wine_type"]:checked');
    const wine_type = wineTypeEl ? wineTypeEl.value : '';
    const priceRaw = $('wine-price').value.trim();
    const payload = {
      name,
      store_id: storeId || null,
      rating,
      note,
      wine_type: wine_type || null,
      price: priceRaw === '' ? null : priceRaw,
    };

    $('save-btn').disabled = true;
    try {
      let wineId;
      if (editingId) {
        await api('/api/wines/' + editingId, { method: 'PUT', body: JSON.stringify(payload) });
        wineId = editingId;
      } else {
        const out = await api('/api/wines', { method: 'POST', body: JSON.stringify(payload) });
        wineId = out.id;
      }
      // 1. Cancella le foto esistenti marcate per rimozione (prima di uploadare le nuove)
      let deleteErrors = 0;
      if (editingId && pendingRemovals.length) {
        const errs = await deletePhotosMulti(wineId, pendingRemovals.slice());
        deleteErrors = errs.length;
      }
      // 2. Upload delle nuove pendingPhotoFiles (in blocco, fino a 8 per volta)
      let uploadErrors = 0;
      if (pendingPhotoFiles.length) {
        try {
          // upload.array ha limite 8 per richiesta; chunkiamo se necessario.
          const chunks = [];
          for (let i = 0; i < pendingPhotoFiles.length; i += 8) {
            chunks.push(pendingPhotoFiles.slice(i, i + 8));
          }
          let totalInserted = 0;
          for (const ch of chunks) {
            const r = await uploadPhotosMulti(wineId, ch);
            totalInserted += (r.inserted || []).length;
            uploadErrors += (r.errors || []).length;
          }
          if (uploadErrors > 0) {
            toast(
              `${editingId ? 'Vino aggiornato' : 'Vino aggiunto'}; ${totalInserted} foto OK, ${uploadErrors} non caricate`,
              'error'
            );
          } else if (deleteErrors > 0) {
            toast(
              `${editingId ? 'Vino aggiornato' : 'Vino aggiunto'}; ${deleteErrors} foto non rimosse`,
              'error'
            );
          } else {
            const n = pendingPhotoFiles.length;
            toast(
              `${editingId ? 'Vino aggiornato' : 'Vino aggiunto'}; ${n} foto caricate`,
              'success'
            );
          }
        } catch (e) {
          toast(
            `${editingId ? 'Vino aggiornato' : 'Vino aggiunto'}, ma foto non caricate: ${e.message}`,
            'error'
          );
        }
      } else if (deleteErrors > 0) {
        toast(`Vino aggiornato; ${deleteErrors} foto non rimosse`, 'error');
      } else {
        toast(editingId ? 'Vino aggiornato' : 'Vino aggiunto', 'success');
      }
      resetForm();
      loadWines();
    } catch (e) {
      toast('Errore: ' + e.message, 'error');
    } finally {
      $('save-btn').disabled = false;
    }
  });

  // ---------- buttons ----------

  $('refresh-btn').addEventListener('click', () => { loadWines(); toast('Aggiornato'); });

  // ---------- import CSV ----------
  $('import-csv-btn').addEventListener('click', () => $('csv-input').click());
  $('csv-input').addEventListener('change', () => {
    const f = $('csv-input').files && $('csv-input').files[0];
    $('csv-input').value = ''; // permette di re-importare lo stesso file
    if (!f) return;
    const fd = new FormData();
    fd.append('csv', f, f.name);
    toast('Import in corso…');
    fetch('/api/wines/import-csv', { method: 'POST', body: fd })
      .then(async (r) => {
        const body = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error((body && body.error) || ('HTTP ' + r.status));
        const parts = [`Importati ${body.imported || 0}`];
        if (body.skipped) parts.push(`${body.skipped} saltati`);
        if (body.total_errors) parts.push(`${body.total_errors} errori`);
        toast(parts.join(' · '), body.total_errors ? 'error' : 'success');
        if (Array.isArray(body.errors) && body.errors.length) {
          console.warn('CSV import errors:', body.errors);
        }
        loadWines();
      })
      .catch((e) => toast('Errore import: ' + e.message, 'error'));
  });

  // ---------- backup completo (ZIP) ----------
  // Il bottone è un <a href="/api/backup">; il browser gestisce il download da solo.
  // Aggiungo solo un toast per dare feedback durante la creazione dello ZIP lato server.
  const backupBtn = $('backup-zip-btn');
  if (backupBtn) {
    backupBtn.addEventListener('click', () => {
      toast('Preparazione backup in corso…');
      // Il <a> vera navigazione parte lo stesso: l'utente scaricherà il file.
      // Il toast si auto-rimuove dopo 3s, normalmente il download è già partito.
    });
  }

  // ---------- ripristino backup ZIP ----------
  const restoreBtn = $('restore-zip-btn');
  const backupInput = $('backup-input');
  if (restoreBtn && backupInput) {
    restoreBtn.addEventListener('click', () => {
      openConfirmModal(
        'Ripristina backup',
        'Tutti i vini, negozi e foto ATTUALI verranno cancellati e sostituiti con quelli del file ZIP. L\u2019operazione è irreversibile. Continuare?',
        () => backupInput.click(),
        restoreBtn
      );
    });
    backupInput.addEventListener('change', async () => {
      const f = backupInput.files && backupInput.files[0];
      backupInput.value = ''; // permette di re-importare lo stesso file
      if (!f) return;
      const fd = new FormData();
      fd.append('backup', f, f.name);
      toast('Ripristino in corso…');
      restoreBtn.disabled = true;
      try {
        const r = await fetch('/api/restore', { method: 'POST', body: fd });
        const body = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error((body && body.error) || ('HTTP ' + r.status));
        const parts = [`Ripristinati ${body.wines || 0} vini`];
        if (body.photos_written) parts.push(`${body.photos_written} foto`);
        if (body.errors) parts.push(`${body.errors} errori`);
        if (body.photos_skipped) parts.push(`${body.photos_skipped} foto scartate`);
        toast(parts.join(' · '), body.errors ? 'error' : 'success');
        await loadStores('wine-store');
        loadWines();
        toast('Fai un hard-refresh (Ctrl+Shift+R) per vedere tutte le foto', 'success');
      } catch (e) {
        toast('Errore ripristino: ' + e.message, 'error');
      } finally {
        restoreBtn.disabled = false;
      }
    });
  }

  // ---------- wiring modal di conferma (elimina vino) ----------
  $('confirm-modal-cancel').addEventListener('click', closeConfirmModal);
  $('confirm-modal-ok').addEventListener('click', async () => {
    const cb = pendingConfirmCallback;
    closeConfirmModal();
    if (typeof cb === 'function') {
      try { await cb(); } catch (e) { console.error(e); }
    }
  });
  $('confirm-modal').addEventListener('click', (ev) => {
    if (ev.target === $('confirm-modal')) closeConfirmModal();
  });
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && $('confirm-modal').classList.contains('open')) {
      closeConfirmModal();
    }
  });

  $('update-app-btn').addEventListener('click', async () => {
    if (!('serviceWorker' in navigator)) { toast('Service worker non supportato', 'error'); return; }
    const reg = await navigator.serviceWorker.getRegistration();
    if (reg) {
      reg.update();
      reg.waiting && reg.waiting.postMessage('SKIP_WAITING');
      toast('App aggiornata — ricarica la pagina', 'success');
      setTimeout(() => location.reload(), 800);
    } else {
      toast('Service worker non registrato', 'error');
    }
  });

  // ---------- PWA install prompt ----------

  function mountInstallBtn() {
    if (!deferredInstallPrompt) return;
    if (document.getElementById('install-btn')) return;
    const btn = document.createElement('button');
    btn.id = 'install-btn';
    btn.className = 'tab';
    btn.textContent = '⬇️ Installa';
    btn.type = 'button';
    btn.addEventListener('click', async () => {
      deferredInstallPrompt.prompt();
      const choice = await deferredInstallPrompt.userChoice;
      if (choice.outcome === 'accepted') toast('Installazione avviata', 'success');
      deferredInstallPrompt = null;
      btn.remove();
    });
    $('nav-tabs').appendChild(btn);
  }

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredInstallPrompt = e;
    mountInstallBtn();
  });

  // ---------- avvio ----------

  const here = location.pathname;
  document.querySelectorAll('.tab').forEach(t => {
    if (t.getAttribute('href') === here) t.classList.add('active');
    else t.classList.remove('active');
  });

  // Sincronizza la classe .is-checked sui radio-pill ad ogni cambio utente.
  // Fallback per browser che non supportano :has() (Safari < 15.4) —
  // senza questo, la pillola di sfondo non si accende quando selezionata.
  function syncRadioPills(name) {
    document.querySelectorAll('input[name="' + name + '"]').forEach(r => {
      const label = r.closest('.radio-pill');
      if (label) label.classList.toggle('is-checked', r.checked);
    });
  }
  document.addEventListener('change', (ev) => {
    const t = ev.target;
    if (t && t.matches && t.matches('input[name="wine_type"]')) syncRadioPills('wine_type');
  });

  // Stato iniziale coerente con il DOM (radio checked di default = .is-checked).
  syncRadioPills('wine_type');

  loadStores('wine-store');
  loadWines();
})();
