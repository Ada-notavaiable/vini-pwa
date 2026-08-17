// public/spirits.js — controller della pagina Alcolici.
// Stessa struttura di public/app.js ma sul dominio spirits:
//   - endpoint /api/spirits[/:id[/photo]]
//   - campi: name, store_id, rating, note, spirit_type, abv, price, photo_path
//   - nessun toggle rosso/bianco → usa invece una mappa tipo→emoji per la card.
// Riusa le stesse soglie di resize client-side (PHOTO_CLIENT_MAX_DIM=1600) e lo stesso
// pattern del confirm-modal di app.js.

(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);

  // ---------- helpers condivisi ----------

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
    if (!r.ok) throw new Error((body && body.error) || ('HTTP ' + r.status));
    return body;
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

  function fmtBytes(n) {
    if (n == null) return '—';
    if (n === 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0, v = Number(n);
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
    return v.toFixed(v >= 100 || i === 0 ? 0 : v >= 10 ? 1 : 2) + ' ' + units[i];
  }

  // Mappa per visualizzare i tipi in modo leggibile: emoji + label italiana.
  // type: stringa libera normalizzata (lowercase). Cade su 🏷️ per tipi fuori mappa.
  const SPIRIT_TYPES = {
    grappa:  { emoji: '🥃', label: 'Grappa' },
    whisky:  { emoji: '🥃', label: 'Whisky' },
    rum:     { emoji: '🥃', label: 'Rum' },
    brandy:  { emoji: '🥃', label: 'Brandy' },
    cognac:  { emoji: '🥃', label: 'Cognac' },
    gin:     { emoji: '🍸', label: 'Gin' },
    vodka:   { emoji: '🍸', label: 'Vodka' },
    tequila: { emoji: '🌵', label: 'Tequila' },
    amaro:   { emoji: '🍵', label: 'Amaro' },
    liquore: { emoji: '🍯', label: 'Liquore' },
  };
  function spiritTypeBadge(st) {
    if (!st) return '';
    const meta = SPIRIT_TYPES[String(st).toLowerCase().trim()] || { emoji: '🏷️', label: st };
    const key = String(st).toLowerCase().trim();
    return '<span class="spirit-type-badge ' + escapeHtml(key) + '" title="' + escapeHtml(meta.label) + '">' + meta.emoji + ' ' + escapeHtml(meta.label) + '</span>';
  }
  function spiritTypeKey(st) {
    return (st && String(st).trim()) ? String(st).trim().toLowerCase() : 'nd';
  }
  function spiritTypeLabel(st) {
    if (!st) return 'Senza tipo';
    const meta = SPIRIT_TYPES[String(st).toLowerCase().trim()];
    return meta ? meta.label : st;
  }

  function fmtStarsReadonly(rating) {
    let html = '<div class="stars stars-readonly compact" aria-label="voto ' + rating + ' su 10">';
    for (let i = 10; i >= 1; i--) {
      html += '<input type="radio" disabled' + (i <= Number(rating) ? ' checked' : '') + '><label>★</label>';
    }
    html += '</div>';
    return html;
  }

  function fmtAbv(abv) {
    if (abv == null || !Number.isFinite(Number(abv))) return '';
    const n = Number(abv);
    // Mostra con 1 decimale solo se necessario (es. 40 vs 38.5)
    const txt = Number.isInteger(n) ? String(n) : n.toFixed(1);
    return '<span class="abv-badge" title="Gradazione alcolica">🧪 ' + txt + '°</span>';
  }

  // ---------- stato ----------

  let editingId = null;
  // Dichiarazioni foto (pendingPhotoFiles, existingPhotos, pendingRemovals,
  // pendingPhotoUrls, pendingPhotoFile/Url legacy, currentPhotoPath) sono definite
  // più sotto nella sezione "galleria foto (multi-foto per spirito)".
  let deferredInstallPrompt = null;

  const PHOTO_CLIENT_MAX_DIM = 1600;
  const PHOTO_CLIENT_JPEG_QUALITY = 0.85;
  const PHOTO_CLIENT_SIZE_TRIGGER_BYTES = 1.2 * 1024 * 1024;

  // ---------- confirm modal ----------

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

  async function loadStores() {
    try {
      const stores = await api('/api/stores');
      const sel = $('spirit-store');
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

  // ---------- spirits list ----------

  async function loadSpirits() {
    try {
      const spirits = await api('/api/spirits?limit=300');
      renderSpirits(spirits);
      $('count-spirits').textContent = spirits.length;
    } catch (e) {
      if (!navigator.onLine) {
        toast('Offline — riprova quando torni online.', 'error');
      } else {
        toast('Errore caricamento: ' + e.message, 'error');
      }
    }
  }

  function renderSpirits(spirits) {
    const wrap = $('spirits-list');
    wrap.innerHTML = '';
    if (!spirits.length) { $('empty-state').hidden = false; return; }
    $('empty-state').hidden = true;
    for (const s of spirits) {
      const card = document.createElement('div');
      card.className = 'wine-card spirit-card';
      card.dataset.id = s.id;

      const thumbH = s.photo_path
        ? '<img src="/photos/' + encodeURIComponent(s.photo_path) + '" alt="" loading="lazy" />'
        : '🥃';
      // Badge "📷 N" se il spirito ha più di 1 foto (galleria scorrevole nel lightbox)
      const badgeH = (Number(s.photo_count) > 1)
        ? '<div class="thumb-photo-counter" aria-label="' + s.photo_count + ' foto">' +
            '<span aria-hidden="true">📷</span>' + s.photo_count + '</div>'
        : '';

      const abvHtml = fmtAbv(s.abv);
      card.innerHTML = `
        <button type="button" class="wine-delete-btn" aria-label="Elimina alcolico" title="Elimina">🗑</button>
        <div class="thumb">${thumbH}${badgeH}</div>
        <div class="meta">
          <div class="name">${escapeHtml(s.name)}${spiritTypeBadge(s.spirit_type)}</div>
          <div class="store">${escapeHtml(s.store_name || '— senza negozio —')}</div>
          ${s.note ? `<div class="note-preview">${escapeHtml(s.note)}</div>` : ''}
          ${(s.price != null && Number.isFinite(Number(s.price))) || abvHtml ? `<div class="meta-extras">${s.price != null && Number.isFinite(Number(s.price)) ? `<span class="price">${fmtPrice(s.price)}</span>` : ''}${abvHtml}</div>` : ''}
        </div>
        <div class="right">
          ${fmtStarsReadonly(s.rating)}
          <div class="date">${(s.created_at || '').slice(0, 10)}</div>
        </div>
      `;
      card.addEventListener('click', () => beginEdit(s));

      const delBtn = card.querySelector('.wine-delete-btn');
      if (delBtn) {
        delBtn.addEventListener('click', (ev) => {
          ev.stopPropagation(); ev.preventDefault();
          const name = (s.name && String(s.name)) || 'questo alcolico';
          openConfirmModal(
            'Elimina alcolico',
            'Vuoi eliminare “' + name + '”? L’operazione è irreversibile.',
            async () => {
              try {
                await api('/api/spirits/' + s.id, { method: 'DELETE' });
                toast('Alcolico eliminato', 'success');
                if (editingId === s.id) resetForm();
                loadSpirits();
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
  // clearPendingPhoto() è ridefinito nella sezione galleria foto come wrapper
  // attorno a clearPhotoGallery() per retrocompatibilità del codice legacy.

  function resetForm() {
    editingId = null;
    currentPhotoPath = null;
    $('spirit-id').value = '';
    $('spirit-name').value = '';
    $('spirit-note').value = '';
    $('spirit-store').value = '';
    $('spirit-abv').value = '';
    $('spirit-price').value = '';
    document.querySelectorAll('input[name="rating"]').forEach(r => r.checked = false);
    document.querySelectorAll('input[name="spirit_type"]').forEach(r => { r.checked = (r.value === ''); });
    $('form-title').textContent = 'Aggiungi alcolico';
    $('save-btn').textContent = 'Salva';
    $('cancel-edit-btn').hidden = true;
    $('btn-remove-photo').hidden = true;
    clearPendingPhoto();
    syncRadioPills('spirit_type');
  }

  function beginEdit(s) {
    editingId = s.id;
    currentPhotoPath = s.photo_path || null;
    $('spirit-id').value = s.id;
    $('spirit-name').value = s.name || '';
    $('spirit-note').value = s.note || '';
    $('spirit-store').value = s.store_id || '';
    $('spirit-abv').value = (s.abv != null && Number.isFinite(Number(s.abv))) ? String(s.abv) : '';
    $('spirit-price').value = (s.price != null && Number.isFinite(Number(s.price))) ? String(s.price) : '';
    const r = parseInt(s.rating, 10);
    const radio = document.getElementById('r' + r);
    if (radio) radio.checked = true;
    const sT = (s.spirit_type && SPIRIT_TYPES[String(s.spirit_type).toLowerCase()]) ? String(s.spirit_type).toLowerCase() : '';
    document.querySelectorAll('input[name="spirit_type"]').forEach(r => { r.checked = (r.value === sT); });
    // Pulisci la galleria pending e carica quella esistente via GET /api/spirits/:id.
    pendingPhotoFiles = [];
    revokePendingPhotoUrls();
    pendingRemovals = [];
    existingPhotos = [];
    pendingPhotoFile = null;
    pendingPhotoUrl = null;
    fetchSpiritFull(s.id).then(full => {
      existingPhotos = (full.photos || []).slice();
      currentPhotoPath = full.photo_path || null;
      renderPhotoGallery();
    }).catch(() => { renderPhotoGallery(); });
    renderPhotoGallery();
    $('form-title').textContent = 'Modifica: ' + (s.name || '');
    $('save-btn').textContent = 'Aggiorna';
    $('cancel-edit-btn').hidden = false;
    window.scrollTo({ top: 0, behavior: 'smooth' });
    syncRadioPills('spirit_type');
  }

  // ---------- resize client-side foto (stessa logica del vino) ----------

  async function maybeResizeImage(file) {
    if (!file || !file.type || !file.type.startsWith('image/')) {
      return { file, resized: false, reason: 'not-an-image' };
    }
    let bitmap;
    try {
      bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
    } catch (e) {
      console.warn('createImageBitmap failed:', e);
      return { file, resized: false, reason: 'decode-failed' };
    }
    try {
      const w0 = bitmap.width, h0 = bitmap.height;
      const longest = Math.max(w0, h0);
      const shouldResize = longest > PHOTO_CLIENT_MAX_DIM || file.size > PHOTO_CLIENT_SIZE_TRIGGER_BYTES;
      if (!shouldResize) {
        return { file, resized: false, reason: 'already-small', width: w0, height: h0, origBytes: file.size };
      }
      const scale = longest > PHOTO_CLIENT_MAX_DIM ? (PHOTO_CLIENT_MAX_DIM / longest) : 1;
      const tw = Math.max(1, Math.round(w0 * scale));
      const th = Math.max(1, Math.round(h0 * scale));
      const canvas = document.createElement('canvas');
      canvas.width = tw; canvas.height = th;
      const ctx = canvas.getContext('2d');
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(bitmap, 0, 0, tw, th);

      const blob = await new Promise((resolve, reject) => {
        canvas.toBlob(b => b ? resolve(b) : reject(new Error('toBlob null')), 'image/jpeg', PHOTO_CLIENT_JPEG_QUALITY);
      });
      const base = (file.name || 'spirit').replace(/\.[^.]+$/, '');
      const newName = base.replace(/[^a-zA-Z0-9_-]+/g, '_').slice(0, 40) + '.jpg';
      const newFile = new File([blob], newName || 'spirit.jpg', { type: 'image/jpeg', lastModified: Date.now() });
      return {
        file: newFile, resized: true,
        width: tw, height: th,
        origBytes: file.size, newBytes: blob.size,
      };
    } finally {
      try { bitmap.close(); } catch (_) { /* ignore */ }
    }
  }

  // ---------- bind photo inputs ----------

  // ---------- galleria foto (multi-foto per spirito) ----------
  // NB: il flusso single-photo legacy è stato sostituito. pendingPhotoFile e
  //     l'endpoint /api/spirits/:id/photo restano disponibili sul server (retrocompat)
  //     ma il form ora gestisce n-foto via galleria, con uploadPhotosMulti.
  // Stato della galleria:
  //   pendingPhotoFiles: File[] locale, non ancora uploadato al server
  //   existingPhotos:    array di foto già salvate lato server (per "Modifica")
  //   pendingRemovals:   photoId[] delle foto esistenti marcate per rimozione
  let pendingPhotoFiles = [];
  let existingPhotos = [];
  let pendingRemovals = [];
  let pendingPhotoUrls = [];
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
  function clearPendingPhoto() { clearPhotoGallery(); }

  function visiblePhotos() {
    const existing = existingPhotos.filter(p => !pendingRemovals.includes(p.id));
    return { existing, pending: pendingPhotoFiles.slice() };
  }

  function pendingPreviewUrl(file) {
    const u = URL.createObjectURL(file);
    pendingPhotoUrls.push(u);
    return u;
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
      const rmBtn = $('btn-remove-photo');
      if (rmBtn) rmBtn.hidden = !(editingId && existingPhotos.length > 0);
      return;
    }
    root.hidden = false;
    counter.innerHTML = '<span aria-hidden="true">📷</span> <strong>' + total + '</strong> foto';
    const rmBtn = $('btn-remove-photo');
    if (rmBtn) rmBtn.hidden = !(editingId && existingPhotos.length > 0);

    let html = '';
    pending.forEach((f, idx) => {
      const url = pendingPreviewUrl(f);
      html += '<div class="photo-thumb" data-pending-idx="' + idx + '">' +
              '<img src="' + url + '" alt="" />' +
              '<span class="photo-thumb-badge">nuova</span>' +
              '<button type="button" class="photo-thumb-remove" data-action="remove-pending" data-idx="' + idx + '" aria-label="Rimuovi foto">✕</button>' +
              '</div>';
    });
    existing.forEach((p) => {
      const url = p.url || ('/photos/' + encodeURIComponent(p.photo_path));
      const removedBadge = pendingRemovals.includes(p.id)
        ? '<span class="photo-thumb-badge" style="background:rgba(185,77,77,0.85)">rimossa</span>'
        : '';
      html += '<div class="photo-thumb" data-existing-id="' + p.id + '">' +
              '<img src="' + url + '" alt="" loading="lazy" />' + removedBadge +
              '<button type="button" class="photo-thumb-remove" data-action="remove-existing" data-id="' + p.id + '" aria-label="Rimuovi foto dal server">✕</button>' +
              '</div>';
    });
    list.innerHTML = html;
  }

  async function addPendingFiles(files) {
    const arr = Array.from(files || []);
    if (!arr.length) return;
    for (const f of arr) {
      if (!f || !f.type || !f.type.startsWith('image/')) continue;
      pendingPhotoFiles.push(f);
      try {
        const r = await maybeResizeImage(f);
        if (r.resized) {
          pendingPhotoFiles[pendingPhotoFiles.length - 1] = r.file;
        }
      } catch (e) { console.warn('resize client spirito:', e); }
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

  async function fetchSpiritFull(id) { return api('/api/spirits/' + id); }

  function bindPhotoFileInput(input) {
    input.addEventListener('change', async () => {
      const fs = input.files ? Array.from(input.files) : [];
      input.value = '';
      if (!fs.length) return;
      await addPendingFiles(fs);
    });
  }

  async function uploadPhotosMulti(spiritId, files) {
    const fd = new FormData();
    for (const f of files) fd.append('photos', f, f.name || 'photo.jpg');
    const r = await fetch('/api/spirits/' + spiritId + '/photos', { method: 'POST', body: fd });
    let body = null;
    try { body = await r.json(); } catch (_) { /* ignore */ }
    if (!r.ok) throw new Error((body && body.error) || ('HTTP ' + r.status));
    return body;
  }

  async function deletePhotosMulti(spiritId, photoIds) {
    const errors = [];
    for (const id of photoIds) {
      try {
        await api('/api/spirits/' + spiritId + '/photos/' + id, { method: 'DELETE' });
      } catch (e) {
        errors.push({ id, error: String(e.message || e) });
      }
    }
    return errors;
  }

  // Bottone "Rimuovi tutte" (visibile solo in edit con foto esistenti): marca
  // existingPhotos per rimozione; il DELETE avviene al save successivo.
  $('btn-remove-photo').addEventListener('click', () => {
    if (!editingId || !existingPhotos.length) return;
    for (const p of existingPhotos) {
      if (!pendingRemovals.includes(p.id)) pendingRemovals.push(p.id);
    }
    renderPhotoGallery();
  });

  // ---------- form submit ----------

  $('spirit-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const name = $('spirit-name').value.trim();
    const rating = (() => {
      const r = document.querySelector('input[name="rating"]:checked');
      return r ? parseInt(r.value, 10) : NaN;
    })();
    if (!name) { toast('Nome obbligatorio', 'error'); return; }
    if (!Number.isInteger(rating) || rating < 1 || rating > 10) { toast('Voto obbligatorio (1–10)', 'error'); return; }

    const payload = {
      name,
      store_id: $('spirit-store').value,
      rating,
      note: $('spirit-note').value,
      spirit_type: (() => { const t = document.querySelector('input[name="spirit_type"]:checked'); return t ? t.value : ''; })(),
      abv: $('spirit-abv').value,
      price: $('spirit-price').value,
    };

    $('save-btn').disabled = true;
    try {
      let id = editingId;
      if (id) {
        await api('/api/spirits/' + id, { method: 'PUT', body: JSON.stringify(payload) });
      } else {
        const out = await api('/api/spirits', { method: 'POST', body: JSON.stringify(payload) });
        id = out.id;
      }
      // 1. Cancella le foto esistenti marcate per rimozione
      let deleteErrors = 0;
      if (editingId && pendingRemovals.length) {
        const errs = await deletePhotosMulti(id, pendingRemovals.slice());
        deleteErrors = errs.length;
      }
      // 2. Upload delle nuove pendingPhotoFiles (chunk da 8 per via del limits multer)
      let uploadErrors = 0;
      if (pendingPhotoFiles.length) {
        try {
          const chunks = [];
          for (let i = 0; i < pendingPhotoFiles.length; i += 8) chunks.push(pendingPhotoFiles.slice(i, i + 8));
          let totalInserted = 0;
          for (const ch of chunks) {
            const r = await uploadPhotosMulti(id, ch);
            totalInserted += (r.inserted || []).length;
            uploadErrors += (r.errors || []).length;
          }
          if (uploadErrors > 0) {
            toast((editingId ? 'Aggiornato' : 'Salvato') + '; ' + totalInserted + ' foto OK, ' + uploadErrors + ' non caricate', 'error');
          } else if (deleteErrors > 0) {
            toast((editingId ? 'Aggiornato' : 'Salvato') + '; ' + deleteErrors + ' foto non rimosse', 'error');
          } else {
            toast((editingId ? 'Aggiornato' : 'Salvato') + '; ' + pendingPhotoFiles.length + ' foto caricate', 'success');
          }
        } catch (e) {
          toast((editingId ? 'Aggiornato' : 'Salvato') + ', ma foto non caricate: ' + e.message, 'error');
        }
      } else if (deleteErrors > 0) {
        toast((editingId ? 'Aggiornato' : 'Salvato') + '; ' + deleteErrors + ' foto non rimosse', 'error');
      } else {
        toast(editingId ? 'Aggiornato' : 'Alcolico salvato', 'success');
      }
      resetForm();
      loadSpirits();
      loadStores();
    } catch (e) {
      toast('Errore: ' + e.message, 'error');
    } finally {
      $('save-btn').disabled = false;
    }
  });

  $('cancel-edit-btn').addEventListener('click', () => resetForm());
  $('refresh-btn').addEventListener('click', () => { loadSpirits(); toast('Aggiornato'); });

  // ---------- lightbox foto (singola + carousel multi-foto) ----------

  let lastImgTrigger = null;

  function renderCarouselInLightbox(photos) {
    const lb = $('image-lightbox');
    lb.querySelectorAll('.photo-carousel, .photo-carousel-prev, .photo-carousel-next, .photo-carousel-dots, .photo-carousel-caption').forEach(n => n.remove());
    const img = $('image-lightbox-img');
    if (photos.length === 1) {
      img.src = photos[0].url; img.alt = photos[0].alt || ''; img.style.display = '';
      return;
    }
    img.style.display = 'none';
    const carousel = document.createElement('div');
    carousel.className = 'photo-carousel';
    const track = document.createElement('div');
    track.className = 'photo-carousel-track';
    photos.forEach((p, i) => {
      const slide = document.createElement('div');
      slide.className = 'photo-carousel-slide';
      const im = document.createElement('img');
      im.src = p.url; im.alt = (p.alt || '') + ' (' + (i + 1) + '/' + photos.length + ')';
      im.draggable = false;
      slide.appendChild(im); track.appendChild(slide);
    });
    carousel.appendChild(track);
    const prev = document.createElement('button');
    prev.type = 'button'; prev.className = 'photo-carousel-prev';
    prev.setAttribute('aria-label', 'Foto precedente'); prev.textContent = '‹';
    const next = document.createElement('button');
    next.type = 'button'; next.className = 'photo-carousel-next';
    next.setAttribute('aria-label', 'Foto successiva'); next.textContent = '›';
    const dots = document.createElement('div');
    dots.className = 'photo-carousel-dots';
    const dotsBtns = photos.map((_, i) => {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'photo-carousel-dot' + (i === 0 ? ' active' : '');
      b.setAttribute('aria-label', 'Vai alla foto ' + (i + 1));
      b.dataset.idx = String(i);
      dots.appendChild(b);
      return b;
    });
    const cap = document.createElement('div');
    cap.className = 'photo-carousel-caption';
    cap.textContent = '1 / ' + photos.length;
    carousel.appendChild(prev); carousel.appendChild(next); carousel.appendChild(dots);
    lb.appendChild(carousel); lb.appendChild(cap);

    let idx = 0;
    function setIdx(n) {
      idx = Math.max(0, Math.min(photos.length - 1, n));
      track.scrollTo({ left: idx * track.clientWidth, behavior: 'smooth' });
      dotsBtns.forEach((b, i) => b.classList.toggle('active', i === idx));
      cap.textContent = (idx + 1) + ' / ' + photos.length;
    }
    prev.addEventListener('click', () => setIdx(idx - 1));
    next.addEventListener('click', () => setIdx(idx + 1));
    dotsBtns.forEach(b => b.addEventListener('click', () => setIdx(parseInt(b.dataset.idx, 10))));
    lb.addEventListener('keydown', lbKeyHandler);
    let touchStartX = null;
    track.addEventListener('touchstart', (ev) => {
      touchStartX = (ev.changedTouches && ev.changedTouches[0] && ev.changedTouches[0].clientX) || null;
    }, { passive: true });
    track.addEventListener('touchend', (ev) => {
      if (touchStartX == null) return;
      const x = (ev.changedTouches && ev.changedTouches[0] && ev.changedTouches[0].clientX) || touchStartX;
      const dx = x - touchStartX;
      if (Math.abs(dx) > 40) setIdx(idx + (dx < 0 ? 1 : -1));
      touchStartX = null;
    });
    let scrollTimeout = null;
    track.addEventListener('scroll', () => {
      if (scrollTimeout) clearTimeout(scrollTimeout);
      scrollTimeout = setTimeout(() => {
        const w = track.clientWidth || 1;
        const newIdx = Math.round(track.scrollLeft / w);
        if (newIdx !== idx) {
          idx = newIdx;
          dotsBtns.forEach((b, i) => b.classList.toggle('active', i === idx));
          cap.textContent = (idx + 1) + ' / ' + photos.length;
        }
      }, 80);
    });
    setIdx(0);
  }

  let lbKeyHandler = (ev) => {
    if (!$('image-lightbox').classList.contains('open')) return;
    const carousel = $('image-lightbox').querySelector('.photo-carousel');
    if (!carousel) return;
    if (ev.key === 'ArrowLeft')  { ev.preventDefault(); carousel.querySelector('.photo-carousel-prev').click(); }
    if (ev.key === 'ArrowRight') { ev.preventDefault(); carousel.querySelector('.photo-carousel-next').click(); }
  };

  function openImageLightbox(src, alt, trigger) { openImageLightboxMulti([{ url: src, alt: alt || '' }], trigger); }
  function openImageLightboxMulti(photos, trigger) {
    if (!photos || !photos.length) return;
    const lb = $('image-lightbox');
    lastImgTrigger = trigger || null;
    renderCarouselInLightbox(photos);
    lb.classList.add('open');
    lb.setAttribute('aria-hidden', 'false');
    document.body.style.overflow = 'hidden';
    try { $('image-lightbox-close').focus({ preventScroll: true }); } catch (_) { /* ignore */ }
  }
  function closeImageLightbox() {
    const lb = $('image-lightbox');
    const img = $('image-lightbox-img');
    lb.classList.remove('open');
    lb.setAttribute('aria-hidden', 'true');
    lb.querySelectorAll('.photo-carousel, .photo-carousel-prev, .photo-carousel-next, .photo-carousel-dots, .photo-carousel-caption').forEach(n => n.remove());
    setTimeout(() => { try { img.src = ''; img.alt = ''; img.style.display = ''; } catch (_) {} }, 200);
    document.body.style.overflow = '';
    if (lastImgTrigger && typeof lastImgTrigger.focus === 'function') {
      try { lastImgTrigger.focus({ preventScroll: true }); } catch (_) { lastImgTrigger.focus(); }
    }
    lastImgTrigger = null;
  }
  $('image-lightbox-close').addEventListener('click', closeImageLightbox);
  $('image-lightbox').addEventListener('click', (ev) => {
    if (ev.target === $('image-lightbox')) closeImageLightbox();
  });
  document.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Escape') return;
    if ($('image-lightbox').classList.contains('open')) closeImageLightbox();
    else if ($('confirm-modal').classList.contains('open')) closeConfirmModal();
  });
  // Click sulla thumb di una card → lightbox (carousel se photo_count > 1)
  document.addEventListener('click', async (ev) => {
    const img = ev.target.closest('.thumb img');
    if (!img) return;
    const card = img.closest('[data-id]');
    if (!card) return;
    const id = parseInt(card.dataset.id, 10);
    if (!Number.isInteger(id)) return;
    ev.preventDefault(); ev.stopPropagation();
    const pc = Number((card.__wineData && card.__wineData.wine && card.__wineData.wine.photo_count) ||
                      (card.__spiritData && card.__spiritData.spirit && card.__spiritData.spirit.photo_count) || 0);
    if (pc > 1) {
      try {
        const r = await fetch('/api/spirits/' + id);
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const full = await r.json();
        const photos = (full.photos || []).slice().sort((a, b) => a.position - b.position).map((p, i, arr) => ({
          url: p.url, alt: (full.name || '') + ' (' + (i + 1) + '/' + arr.length + ')',
        }));
        if (photos.length) { openImageLightboxMulti(photos, img); return; }
      } catch (_) { /* fallback sotto */ }
    }
    openImageLightbox(img.src, card.dataset.id, img);
  });

  // ---------- confirm modal wiring ----------

  $('confirm-modal-cancel').addEventListener('click', closeConfirmModal);
  $('confirm-modal-ok').addEventListener('click', async () => {
    const cb = pendingConfirmCallback;
    closeConfirmModal();
    if (cb) { try { await cb(); } catch (e) { toast('Errore: ' + e.message, 'error'); } }
  });
  $('confirm-modal').addEventListener('click', (ev) => {
    if (ev.target === $('confirm-modal')) closeConfirmModal();
  });

  // ---------- tab attivo ----------
  const here = location.pathname;
  document.querySelectorAll('.tab').forEach(t => {
    if (t.getAttribute('href') === here) t.classList.add('active');
    else t.classList.remove('active');
  });

  // ---------- sync radio pills (classe CSS .is-checked su Safari <15.4) ----------

  function syncRadioPills(name) {
    document.querySelectorAll('input[name="' + name + '"]').forEach(inp => {
      const label = inp.closest('label.radio-pill');
      if (label) label.classList.toggle('is-checked', !!inp.checked);
    });
  }
  document.querySelectorAll('input[name="spirit_type"]').forEach(inp => {
    inp.addEventListener('change', () => syncRadioPills('spirit_type'));
  });
  syncRadioPills('spirit_type');

  // ---------- photo buttons + bind ----------

  $('btn-choose-photo').addEventListener('click', () => $('photo-input-gallery').click());
  $('btn-take-photo').addEventListener('click', () => $('photo-input-camera').click());
  bindPhotoFileInput($('photo-input-gallery'));
  bindPhotoFileInput($('photo-input-camera'));
  // $('clear-pending-photo') rimosso: la galleria multi-foto gestisce la rimozione
  // delle pending via pulsante ✕ su ogni thumbnail.

  // ---------- service worker: aggiorna app ----------

  if ('serviceWorker' in navigator) {
    $('update-app-btn').addEventListener('click', async () => {
      try {
        const reg = await navigator.serviceWorker.getRegistration();
        if (!reg) { toast('Service worker non registrato', 'error'); return; }
        await reg.update();
        if (reg.waiting) {
          reg.waiting.postMessage({ type: 'SKIP_WAITING' });
          toast('Aggiornamento in corso…', 'success');
          setTimeout(() => location.reload(), 800);
        } else {
          toast('Nessun aggiornamento disponibile', '');
        }
      } catch (e) { toast('Errore: ' + e.message, 'error'); }
    });
  } else {
    $('update-app-btn').hidden = true;
  }

  if (window.deferredInstallPrompt !== undefined) {
    deferredInstallPrompt = window.deferredInstallPrompt;
  } else {
    window.addEventListener('beforeinstallprompt', (ev) => {
      ev.preventDefault();
      deferredInstallPrompt = ev;
    });
  }

  // ---------- init ----------

  loadStores();
  loadSpirits();
})();
