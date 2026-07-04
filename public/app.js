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

  // ---------- stato ----------

  let editingId = null;
  let currentPhotoPath = null;
  let pendingPhotoFile = null;     // File scelto/scattato ma non ancora uploadato
  let pendingPhotoUrl = null;      // ObjectURL associato al File (per revocarlo)
  let deferredInstallPrompt = null;

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
        <div class="thumb">${thumbH}</div>
        <div class="meta">
          <div class="name">${escapeHtml(w.name)}</div>
          <div class="store">${escapeHtml(w.store_name || '— senza negozio —')}</div>
          ${w.note ? `<div class="note-preview">${escapeHtml(w.note)}</div>` : ''}
        </div>
        <div class="right">
          ${fmtStarsReadonly(w.rating)}
          <div class="date">${(w.created_at || '').slice(0, 10)}</div>
        </div>
      `;
      card.addEventListener('click', () => beginEdit(w));
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
    $('form-title').textContent = 'Aggiungi vino';
    $('save-btn').textContent = 'Salva';
    $('cancel-edit-btn').hidden = true;
    clearPendingPhoto();
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
    const payload = { name, store_id: storeId || null, rating, note };

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

  loadStores('wine-store');
  loadWines();
})();
