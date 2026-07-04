# Vini PWA

PWA per registrare i **vini** che bevi: nome, foto (ridimensionata automaticamente per occupare poco spazio), negozio (da una lista a tendina gestibile), voto da **1 a 10** e nota libera.

Ispirata al progetto `orto` (stesso stack, stesse scelte di basso consumo).
Pensata per girare su un **Orange Pi** (o qualsiasi piccolo ARM) via **Docker + Portainer**.

## Stack

| Livello | Tecnologia |
| --- | --- |
| Frontend | HTML + CSS + JS vanilla, service worker offline-first |
| Backend | Node.js + Express |
| Database | SQLite (via `sql.js`, persistito su file) |
| Immagini | `jimp` — resize + JPEG per limitare l'occupazione su microSD |

## Funzionalità

- Lista vini con **stelle 1-10**, foto miniatura, negozio e nota.
- Aggiungi/modifica/cancella un vino.
- Carica una **foto** dal cellulare: viene **ridimensionata** (max 1024px lato lungo) e salvata come JPEG qualità ~80.
- **Lista negozi** a tendina, gestibile da pagina dedicata (aggiungi, rinomina, elimina).
- **Statistiche**: vini top-rated, vini per negozio, attività recente, vini per mese.
- **PWA installabile** sul cellulare (Add to Home Screen).
- **Esporta CSV** dei vini per backup.

---

## Deploy su Orange Pi tramite GitHub + Portainer Stack

È il modo consigliato per aggiornare l'app senza dover accedere via SSH ogni volta.

### 1. Prepara la repo GitHub

Sul tuo PC, dentro la cartella `vini/`:

```bash
# inizializza la repo (solo la prima volta)
git init
git add .
git commit -m "vini pwa: prima release"

# crea una repo vuota su GitHub (es. github.com/tuouser/vini-pwa), poi:
git branch -M main
git remote add origin https://github.com/<tuouser>/vini-pwa.git
git push -u origin main
```

> Se hai la 2FA attiva su GitHub, con HTTPS ti serve un **Personal Access Token** (Settings → Developer settings → PAT, scope `repo`) al posto della password; in alternativa configura una chiave SSH e usa `git@github.com:<tuouser>/vini-pwa.git` come remote.

> Il `.gitignore` esclude già `node_modules`, `vini.db`, le foto e `.env`, quindi la repo resta leggera. Il `package-lock.json` resta committato per build riproducibili.

### 2. Crea lo stack in Portainer

1. Accedi a Portainer (es. `http://orange-pi:9000`).
2. **Stacks → Add stack**.
3. Scegli **Repository**:
   - **Repository URL**: `https://github.com/<tuouser>/vini-pwa`
   - **Repository reference / branch**: `refs/heads/main`
   - **Compose path**: `docker-compose.yml`
4. Spunta **Automatic updates** se vuoi che Portainer ricontrolli la repo automaticamente (intervallo di default 5 minuti, configurabile per-stack).
5. Nella sezione **Environment variables** puoi sovrascrivere:
   - `HOST_PORT` — porta esposta sull'Orange Pi (default `3000`)
   - `TZ` — fuso orario, es. `Europe/Rome`
   - `NODE_ENV` — `production` di default
6. Clicca **Deploy the stack**.

Portainer clonerà la repo, builda l'immagine e avvia il container.

> **Requisiti Portainer**: i *webhook* sono disponibili da tutte le versioni CE moderne; l'**auto-update polling** richiede **Portainer CE ≥ 2.10** (e tutte le BE/EE moderne). Su Portainer molto vecchi il toggle *Automatic updates* potrebbe non comparire — in quel caso usa **Pull and redeploy** manualmente dopo ogni push, oppure il webhook.

### 3. Apri l'app

Dal browser del cellulare o del PC in LAN:

```
http://<ip-orange-pi>:3000
```

### 4. Aggiornare l'app

Basta fare `git push` delle modifiche. Se hai abilitato *Automatic updates*, Portainer ricontrolla la repo automaticamente (default ogni 5 min); altrimenti vai su **Stacks → vinipwa → Pull and redeploy**.

Dopo che Portainer ha riavviato il container, nel browser apri la PWA e tocca **"Aggiorna app"** per scaricare l'ultima versione del service worker (svuota la cache delle risorse statiche).

> Per forzare il refresh completo sui device già installati, cambia `CACHE_NAME` in `public/sw.js` da `vinipwa-v1` a `vinipwa-v2` e fai push.

### 5. Webhook manuale (opzionale)

Portainer espone un webhook che puoi chiamare per forzare il re-deploy (utile da GitHub Actions, cron, ecc.):

1. Nello stack → **Duplicate/Edit** → sezione **Webhooks**, copia l'URL del webhook.
2. Invocala con `curl -X POST <webhook-url>` per riavviare lo stack.

---

## Variabili d'ambiente

Tutte opzionali; i default funzionano su un'installazione standard.

| Variabile | Default | Descrizione |
| --- | --- | --- |
| `HOST_PORT` | `3000` | Porta TCP esposta sull'host (nel compose). |
| `TZ` | `Europe/Rome` | Fuso orario del container. |
| `NODE_ENV` | `production` | Modalità Node. |

Le altre variabili usate dal server (`PORT`, `DB_PATH`, `PHOTO_DIR`) sono cablate nel compose e di norma non vanno toccate.

Per un'installazione locale senza Portainer puoi copiare `.env.example` in `.env` e modificare i valori.

---

## Installazione locale senza Docker

```bash
npm install
DB_PATH=./vini.db PHOTO_DIR=./photos npm start
```

Apri `http://localhost:3000`.

## Installazione "manuale" con Docker (no Portainer)

```bash
docker compose up -d --build
docker compose logs -f vinipwa
```

---

## Manutenzione

### Backup

Il database è un singolo file SQLite nel volume `vinidata`. Estrazione manuale:

```bash
docker cp vinipwa:/data/vini.db ./vini-backup.db
docker cp vinipwa:/data/photos ./photos-backup
```

Per backup automatici giornalieri (cron) schedulalo sull'host. `docker cp` funziona anche se il container è fermo, ma fallisce se il container è stato rimosso (es. dopo `docker compose down`):

```cron
0 3 * * * docker cp vinipwa:/data/vini.db /percorso/backup/vini-$(date +\%F).db || logger -t vini-backup "fallito: container assente"
```

### Reset completo (cancella DB e foto)

```bash
docker compose down -v
docker compose up -d --build
```

### Pulizia immagini vecchie (consigliata dopo ogni aggiornamento)

Ogni `Pull and redeploy` lascia un'immagine `vinipwa:latest` "vecchia" (dangling). Periodicamente:

```bash
docker image prune -f
# oppure, solo quelle del progetto:
docker images vinipwa --filter "dangling=true" -q | xargs -r docker rmi
```

### Sicurezza

Pensata per **uso LAN casalingo**. Non c'è autenticazione: non esporla direttamente su internet senza reverse proxy con auth (es. Caddy + Authelia, tailscale, ecc.).

---

## Note

- Le icone PWA in `public/icon-*.png` sono placeholder ereditati dal progetto `orto`: sostituiscile se vuoi un marchio personalizzato.
- La cache del service worker è nominata `vinipwa-v1`: cambiala quando rilasci una release con modifiche strutturali per forzare il refresh sui dispositivi già installati.
- Limite massimo upload foto **8 MB** per evitare OOM sulle piccole board ARM.

## Licenza

Uso personale.
