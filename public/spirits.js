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
  let currentPhotoPath = null;
  let pendingPhotoFile = null;
  let pendingPhotoUrl = null;
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

      const abvHtml = fmtAbv(s.abv);
      card.innerHTML = `
        <button type="button" class="wine-delete-btn" aria-label="Elimina alcolico" title="Elimina">🗑</button>
        <div class="thumb">${thumbH}</div>
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

  function clearPendingPhoto() {
    if (pendingPhotoUrl) { URL.revokeObjectURL(pendingPhotoUrl); pendingPhotoUrl = null; }
    pendingPhotoFile = null;
    $('photo-preview').hidden = true;
    $('photo-preview-img').src = '';
  }

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
    if (s.photo_path) {
      $('photo-preview').hidden = false;
      $('photo-preview-img').src = '/photos/' + encodeURIComponent(s.photo_path);
      $('btn-remove-photo').hidden = false;
    } else {
      clearPendingPhoto();
      $('btn-remove-photo').hidden = true;
    }
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

  function bindPhotoFileInput(input) {
    input.addEventListener('change', async (ev) => {
      const file = input.files && input.files[0];
      if (!file) return;
      // reset SUBITO per consentire la riselezione dello stesso file (iOS altrimenti blocca)
      input.value = '';
      // preview immediato del file originale (così l'utente vede già qualcosa anche
      // durante il resize)
      if (pendingPhotoUrl) { URL.revokeObjectURL(pendingPhotoUrl); }
      pendingPhotoFile = file;
      pendingPhotoUrl = URL.createObjectURL(file);
      $('photo-preview').hidden = false;
      $('photo-preview-img').src = pendingPhotoUrl;

      // resize asincrono, in background
      try {
        const r = await maybeResizeImage(file);
        if (r.resized && r.file) {
          pendingPhotoFile = r.file;
          if (pendingPhotoUrl) { URL.revokeObjectURL(pendingPhotoUrl); }
          pendingPhotoUrl = URL.createObjectURL(r.file);
          $('photo-preview-img').src = pendingPhotoUrl;
          toast('📦 foto ridotta: ' + fmtBytes(r.origBytes) + ' → ' + fmtBytes(r.newBytes) + ' (' + r.width + '×' + r.height + ')', 'success');
        }
      } catch (e) {
        console.warn('resize fallito:', e);
      }
    });
  }

  function uploadPhoto(spiritId, file) {
    return new Promise((resolve, reject) => {
      const fd = new FormData();
      fd.append('photo', file, file.name || 'photo.jpg');
      const xhr = new XMLHttpRequest();
      xhr.open('POST', '/api/spirits/' + spiritId + '/photo');
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          try { resolve(JSON.parse(xhr.responseText)); }
          catch (e) { resolve({ ok: true }); }
        } else {
          let msg = 'HTTP ' + xhr.status;
          try { const o = JSON.parse(xhr.responseText); if (o && o.error) msg = o.error; } catch (_) {}
          reject(new Error(msg));
        }
      };
      xhr.onerror = () => reject(new Error('network error'));
      xhr.send(fd);
    });
  }

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

    try {
      let id = editingId;
      if (id) {
        await api('/api/spirits/' + id, { method: 'PUT', body: JSON.stringify(payload) });
        toast('Aggiornato', 'success');
      } else {
        const out = await api('/api/spirits', { method: 'POST', body: JSON.stringify(payload) });
        id = out.id;
        toast('Alcolico salvato', 'success');
      }
      if (pendingPhotoFile) {
        try {
          await uploadPhoto(id, pendingPhotoFile);
          toast('Foto caricata', 'success');
        } catch (e) {
          toast('Alcolico salvato, ma foto non caricata: ' + e.message, 'error');
        }
      }
      resetForm();
      loadSpirits();
      loadStores();
    } catch (e) {
      toast('Errore: ' + e.message, 'error');
    }
  });

  $('cancel-edit-btn').addEventListener('click', () => resetForm());
  $('refresh-btn').addEventListener('click', () => { loadSpirits(); toast('Aggiornato'); });

  // elimina la foto attuale (solo quando editing di un alcolico che già ha foto)
  $('btn-remove-photo').addEventListener('click', async () => {
    if (!editingId || !currentPhotoPath) return;
    const btn = $('btn-remove-photo');
    const sp = document.createElement('span');
    sp.style.flexBasis = '100%'; sp.style.height = '0';
    openConfirmModal(
      'Rimuovi foto',
      'Vuoi eliminare la foto attuale di questo alcolico? L’operazione è irreversibile.',
      async () => {
        try {
          await api('/api/spirits/' + editingId + '/photo', { method: 'DELETE' });
          currentPhotoPath = null;
          clearPendingPhoto();
          $('btn-remove-photo').hidden = true;
          toast('Foto rimossa', 'success');
          loadSpirits();
        } catch (e) { toast('Errore: ' + e.message, 'error'); }
      },
      btn
    );
  });

  // ---------- lightbox foto ----------

  let lastImgTrigger = null;
  function openImageLightbox(src, alt, trigger) {
    lastImgTrigger = trigger || null;
    const lb = $('image-lightbox');
    const img = $('image-lightbox-img');
    img.src = src; img.alt = alt || '';
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
    setTimeout(() => { try { img.src = ''; img.alt = ''; } catch (_) {} }, 200);
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
  // Click sulla thumb di una card → lightbox
  document.addEventListener('click', (ev) => {
    const img = ev.target.closest('.thumb img');
    if (!img) return;
    const card = img.closest('[data-id]');
    if (!card) return;
    ev.preventDefault(); ev.stopPropagation();
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
  $('clear-pending-photo').addEventListener('click', clearPendingPhoto);

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
