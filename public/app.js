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
  let currentPhotoPath = null;
  let pendingPhotoFile = null;     // File scelto/scattato ma non ancora uploadato
  let pendingPhotoUrl = null;      // ObjectURL associato al File (per revocarlo)
  let deferredInstallPrompt = null;

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

      card.innerHTML = `
        <button type="button" class="wine-delete-btn" aria-label="Elimina vino" title="Elimina">🗑</button>
        <div class="thumb">${thumbH}</div>
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

  function clearPendingPhoto() {
    if (pendingPhotoUrl) { URL.revokeObjectURL(pendingPhotoUrl); pendingPhotoUrl = null; }
    pendingPhotoFile = null;
    $('photo-preview').hidden = true;
    $('photo-preview-img').src = '';
  }

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
    if (w.photo_path) {
      $('photo-preview').hidden = false;
      $('photo-preview-img').src = '/photos/' + encodeURIComponent(w.photo_path);
    } else {
      clearPendingPhoto();
    }
    $('form-title').textContent = 'Modifica: ' + (w.name || '');
    $('save-btn').textContent = 'Aggiorna';
    $('cancel-edit-btn').hidden = false;
    window.scrollTo({ top: 0, behavior: 'smooth' });
    // Sincronizza la classe .is-checked per il fallback Safari <15.4 (radio.checked non triggera 'change').
    syncRadioPills && syncRadioPills('wine_type');
  }

  // ---------- photo input (Scegli foto + Scatta foto) ----------

  function bindPhotoFileInput(input) {
    input.addEventListener('change', () => {
      const f = input.files && input.files[0];
      if (f) {
        clearPendingPhoto();
        pendingPhotoFile = f;
        pendingPhotoUrl = URL.createObjectURL(f);
        $('photo-preview-img').src = pendingPhotoUrl;
        $('photo-preview').hidden = false;
      }
      // reset per permettere di scegliere lo stesso file di nuovo
      input.value = '';
    });
  }
  bindPhotoFileInput($('photo-input-gallery'));
  bindPhotoFileInput($('photo-input-camera'));

  $('btn-choose-photo').addEventListener('click', () => $('photo-input-gallery').click());
  $('btn-take-photo').addEventListener('click', () => $('photo-input-camera').click());

  async function uploadPhoto(wineId, file) {
    const fd = new FormData();
    fd.append('photo', file, file.name);
    const r = await fetch('/api/wines/' + wineId + '/photo', { method: 'POST', body: fd });
    let body = null;
    try { body = await r.json(); } catch (_) { /* ignore */ }
    if (!r.ok) throw new Error((body && body.error) || ('HTTP ' + r.status));
    return body;
  }

  async function removePhoto(wineId) {
    await api('/api/wines/' + wineId + '/photo', { method: 'DELETE' });
  }

  $('remove-photo-btn').addEventListener('click', async () => {
    if (!editingId) {
      // in fase di creazione: la foto era solo locale, basta scartarla
      clearPendingPhoto();
    } else {
      try {
        await removePhoto(editingId);
        currentPhotoPath = null;
        clearPendingPhoto();
        toast('Foto rimossa', 'success');
        loadWines();
      } catch (e) {
        toast('Errore: ' + e.message, 'error');
      }
    }
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
      if (pendingPhotoFile) {
        try {
          await uploadPhoto(wineId, pendingPhotoFile);
          toast(editingId ? 'Vino aggiornato e foto caricata' : 'Vino aggiunto e foto caricata', 'success');
        } catch (e) {
          toast('Vino salvato, ma foto non caricata: ' + e.message, 'error');
        }
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
