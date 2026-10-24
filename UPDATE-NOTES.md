# Connection Manager – Update 2026-10-23 „Rack“

Dieses Paket enthält die geänderten/neuen Dateien 1:1 in der Ordnerstruktur
des Repos. Entpacken, über den Repo-Ordner kopieren, ein Skript ausführen,
testen, committen, in Portainer redeployen.

---

## 1. Was sich ändert

### Stabilität für den Mehrbenutzerbetrieb (Backend/Infra)

| Datei | Änderung | Warum |
|---|---|---|
| `database.py`, `config.py` | DB-Pool 10 + 20 Burst (vorher SQLAlchemy-Default 5 + 10), `pool_recycle` 30 min, `pool_timeout` 30 s, `connect_timeout` 10 s, `application_name` | 10 Kollegen gleichzeitig + Excel-Export + Live-Collaboration laufen nicht mehr in Pool-Erschöpfung; Requests warten sauber statt endlos zu hängen |
| `app.py` | Startup wartet bis zu 60 s auf die DB (statt sofort zu sterben) | DB-Container-Neustart im Betrieb bringt das Backend nicht mehr um |
| `app.py` | Einmal-Bereinigungen (PP-Präfixe) loggen jetzt Treffer und Fehler statt `except: pass` | Man sieht im Container-Log, was passiert ist |
| `app.py` | `/health` (Liveness) und `/health/ready` (DB-Check, 503 bei Problemen) **ohne Login** | Docker/Portainer-Healthchecks funktionieren; vorher brauchte `/health` ein JWT → Healthcheck unmöglich |
| `app.py` | GZip, Security-Header (`nosniff`, `SAMEORIGIN`, Referrer-Policy), `Cache-Control: no-cache` für `/frontend/*` | **Kein Strg+F5 mehr nach einem Redeploy** – der Browser revalidiert per ETag |
| `app.py` | Requests > 2 s werden als Warnung geloggt | Langsame Stellen werden sichtbar |
| `app.py` | Toter, nie erreichbarer zweiter `/`-Handler entfernt; API-Übersicht liegt unter `/api` | Aufräumen |
| `Dockerfile` | Multi-Stage, **InfoSec-Base-Image + Nexus-PyPI-Mirror**, gepinnt, non-root (UID 10001), kein gcc/apt mehr, Healthcheck ohne curl | Equinix-Registry-Vorgabe (vorher `python:3.11-slim` von Docker Hub + PyPI = Verstoß); kleineres, sichereres Image |
| `docker-compose.yml` | Images aus `appsec.docker.equinix.com` (vorher `postgres:17` von Docker Hub), Backend-Healthcheck, Memory-Limits, Log-Rotation, `stop_grace_period`, Postgres-Tuning, pgAdmin nur noch per Profil `tools` | Vorgabe + Stabilität. **Container-/Volume-/Netzwerk-Namen unverändert → Daten bleiben erhalten** |
| `requirements.txt`, `pip.conf` | `python-multipart` und `openpyxl` gepinnt; Nexus-Index dokumentiert | Reproduzierbare Builds |
| `.dockerignore`, `.env.example` | Aktualisiert | — |

`--workers 1` bleibt bewusst: Presence/Live-Cursor (`routers/collaboration.py`)
halten ihren Zustand im Prozess. Die Parallelität für ~10 Nutzer kommt aus dem
Threadpool (sync-Endpoints) und dem größeren DB-Pool. Wer später auf mehrere
Worker/Instanzen will, braucht Redis-Pub/Sub für die Collaboration – das ist
der nächste Ausbauschritt, nicht dieses Update.

### Oberfläche (Frontend)

| Datei | Änderung |
|---|---|
| `frontend/theme.css` | **Neu.** Additiver Design-Layer, lädt nach `styles.css`. Leitet die bestehenden Variablen (`--border`, `--muted`, `--heading`, Radien) auf eine neue Palette um – dadurch übernehmen auch die seitenspezifischen Komponenten den Look. Topbar, Karten, Buttons, Eingaben, Tabellen, Modale, Toasts, Scrollbars, Fokus-Ringe. Dark + Light-Mode. `prefers-reduced-motion` respektiert. |
| `frontend/theme.js` | **Neu.** Markiert die aktive Seite in der Navigation, zeigt eine **Backend-Status-LED** (grün/gelb/rot, pollt `/health/ready` alle 30 s, pausiert im Hintergrund-Tab), **Strg+K** oder **/** springt ins Suchfeld. Greift nicht in `nav-auth.js`/`config.js` ein, patcht kein `fetch`. |
| `scripts/apply_theme.py` | **Neu.** Hängt beide Dateien in alle `frontend/*.html` ein (außer `login.html`, die komplett inline gestylt ist). Idempotent. |
| `tests/theme-layer.test.js` | **Neu.** Läuft im bestehenden `node --test tests` mit; schlägt fehl, wenn eine Seite den Layer nicht lädt. |

Gestaltungsidee: Die Navigation unten ist jetzt ein „Patchpanel“ – jeder
Eintrag ein beschrifteter Port mit LED, die aktive Seite leuchtet, daneben
die Status-LED des Backends. Klare Panel-Linien statt weichgezeichneter
Schatten, DIN-artige Schrift (Bahnschrift, auf Windows vorinstalliert) für
Titel und Kennzahlen mit tabellarischen Ziffern, damit Zähler nicht springen.
Keine externen Fonts, keine CDNs – alles läuft im Firmennetz.

---

## 2. Vor dem Push unbedingt prüfen (kann ich von hier nicht)

1. **Image-Pfade in der InfoSec-Registry.** Die Defaults in `docker-compose.yml`
   und `.env.example` sind Platzhalter-Beispiele:
   - `BASE_IMAGE` → Python 3.11 aus `appsec.docker.equinix.com` (gepinnter Tag!)
   - `POSTGRES_IMAGE` → PostgreSQL **17** (Major-Version muss zum bestehenden
     Datenvolume passen, sonst startet Postgres nicht)
   - `PGADMIN_IMAGE` → nur wenn du pgAdmin brauchst
   In Portainer als Stack-Umgebungsvariablen setzen. Fehlt ein Image im
   Katalog: **nicht** auf Docker Hub ausweichen, sondern Waiver-Prozess
   bzw. CI-CD-Team (e3cicd@equinix.com).
2. **GitHub Actions** (`.github/workflows/*`, habe ich nicht gesehen): Wenn dort
   `pip install` läuft, `PIP_INDEX_URL=https://nexus.equinix.com/repository/pypi-mirror/simple/`
   setzen. Auf GitHub-gehosteten Runnern ist Nexus vermutlich nicht erreichbar →
   Self-hosted Runner oder Waiver.
3. `Dockerfile.pgadmin` wird nicht mehr verwendet (pgAdmin nutzt direkt ein
   Registry-Image) → kann gelöscht werden.
4. Hinweis für später: `python-jose==3.3.0` hat bekannte CVEs (2024-33663/-33664).
   Migration auf `PyJWT` ist sinnvoll, betrifft aber `security.py` – habe ich
   bewusst nicht blind angefasst.

---

## 3. Einspielen

```bash
# im Repo-Root
unzip -o connection-manager-update-2026-10-23.zip -d .
python scripts/apply_theme.py          # verdrahtet theme.css/theme.js in alle Seiten
python scripts/apply_theme.py --check  # muss "alles verdrahtet" melden
node --test tests                      # alle Tests inkl. theme-layer.test.js
python -m unittest discover -s tests -p "test_*.py"
```

Lokal anschauen (wie in der README):

```bash
pip install -r requirements.txt --index-url https://nexus.equinix.com/repository/pypi-mirror/simple/
uvicorn app:app --reload --host 0.0.0.0 --port 8000
# http://127.0.0.1:8000/frontend/login.html
# http://127.0.0.1:8000/health/ready   -> {"status":"ok","database":"ok",...}
```

Changelog-Eintrag aus Abschnitt 6 oben in `CHANGELOG.md` einfügen, dann:

```bash
git checkout -b update/rack-2026-10
git add -A
git commit -m "Rack: Design-Layer, Equinix-Registry, Mehrbenutzer-Stabilität, Healthchecks"
git push -u origin update/rack-2026-10
# PR nach main, mergen
```

---

## 4. Portainer

1. **DB-Backup** (`docker exec cm_postgres pg_dump -U deviceapp -Fc devicedb > devicedb_$(date +%Y%m%d).dump`).
2. Stack → Environment Variables ergänzen: `BASE_IMAGE`, `POSTGRES_IMAGE`,
   optional `APP_VERSION=2026.10.23`, `PIP_INDEX_URL`. `PROXY_NETWORK` wie bisher.
3. **Pull and redeploy** mit Neu-Build des Backend-Images.
4. Prüfen:
   - `cm_backend` → Health **healthy** (nutzt jetzt `/health/ready`)
   - `cm_backend` → Connected Networks: `cm_net` **und** Proxy-Netz
   - Logs von `cm_backend`: Zeile `DB-Pool konfiguriert …`, `Connection Manager 2026.10.23 gestartet …`
   - `http://<VM-IP>:8082/health/ready` und `https://tocry.corp.equinix.com/health/ready`
5. Frontend öffnen – **kein Strg+F5 nötig**; die LED unten neben „Connection
   Manager“ muss grün sein.
6. pgAdmin nur bei Bedarf: Stack-Variable `COMPOSE_PROFILES=tools` + eigenes
   `PGADMIN_PASSWORD`, dann Update the stack.

---

## 5. 10-Nutzer-Test (so prüfst du, dass nichts kaputt geht)

- 10 Kollegen gleichzeitig: Login, Cross-Connects suchen/blättern, Patchpanel
  öffnen, Excel-Export, Kassette sperren/freigeben, KW-Planung.
- Parallel im Blick: `docker stats cm_backend cm_postgres` (Memory-Limits
  768m/1g) und `docker logs -f cm_backend` (Warnungen „Langsamer Request“?).
- DB-Verbindungen: `docker exec cm_postgres psql -U deviceapp devicedb -c "select count(*), state from pg_stat_activity where application_name like 'connection-manager%' group by state;"`
  – darf unter 30 bleiben.
- Störfall simulieren: `docker restart cm_postgres` → LED im Frontend springt
  auf gelb/rot, Backend bleibt am Leben, LED wird nach wenigen Sekunden
  wieder grün (Pool `pre_ping` + Startup-Retry).

---

## 6. CHANGELOG-Eintrag (oben in `CHANGELOG.md` einfügen)

```markdown
## 2026-10-23 - Design-Layer "Rack", Equinix-Registry, Mehrbenutzer-Stabilitaet

### Oberflaeche
- Neuer additiver Design-Layer `frontend/theme.css` + `frontend/theme.js`, wird
  nach `styles.css` geladen. Bestehende Variablen werden auf eine neue Palette
  umgeleitet; seitenspezifische Komponenten bleiben funktional unveraendert.
- Navigation als "Patchpanel": aktive Seite leuchtet als LED, daneben eine
  Status-LED des Backends (prueft `/health/ready` alle 30 Sekunden).
- Strg+K oder "/" springt in das Suchfeld der aktuellen Seite.
- Kein Strg+F5 mehr nach Updates: `/frontend/*` wird mit `Cache-Control:
  no-cache` ausgeliefert und per ETag revalidiert.
- `scripts/apply_theme.py` verdrahtet den Layer in alle Seiten (ausser
  `login.html`); `tests/theme-layer.test.js` prueft das in CI.

### Backend und Betrieb
- DB-Pool fuer ~10 gleichzeitige Nutzer: 10 feste + 20 Burst-Verbindungen,
  Recycle nach 30 Min., 30 s Wartezeit statt Haengen (`DB_POOL_*` in ENV).
- Startup wartet bis zu 60 s auf die Datenbank; PP-Praefix-Bereinigungen
  werden geloggt statt verschluckt.
- `/health` (Liveness) und `/health/ready` (DB-Check) ohne Login fuer
  Docker-/Portainer-Healthchecks. GZip, Security-Header, Logging langsamer
  Requests (> 2 s). Doppelter `/`-Handler entfernt, Uebersicht unter `/api`.
- Dockerfile: InfoSec-Base-Image und Nexus-PyPI-Mirror (Equinix-Vorgabe),
  Multi-Stage, non-root, ohne gcc/apt. Compose: Registry-Images per ENV,
  Backend-Healthcheck, Memory-Limits, Log-Rotation, pgAdmin nur mit Profil
  `tools`. Container-, Volume- und Netzwerknamen unveraendert.
- `python-multipart` und `openpyxl` gepinnt.

### Update ausprobieren
1. Datenbank-Backup erstellen.
2. In Portainer `BASE_IMAGE` und `POSTGRES_IMAGE` auf Images aus
   `appsec.docker.equinix.com` setzen, dann Pull and redeploy mit Neu-Build.
3. `cm_backend` muss `healthy` werden; LED unten im Frontend gruen.
4. Mit mehreren Kollegen gleichzeitig Suche, Export und Sperren testen.

Keine SQL-Migration noetig. Keine Volumes loeschen.
```
