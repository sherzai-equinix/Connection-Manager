# Connection Manager

FastAPI-Backend + Vanilla-JS-Frontend zur Verwaltung von Netzwerkverbindungen, Patchpanels, Cross-Connects und KW-Planung.

Aktuelle Aenderungen und Hinweise zum Testen: [CHANGELOG.md](CHANGELOG.md).

---

## Services

| Service     | Image / Build       | Interner Port | Default Host-Port |
|-------------|---------------------|---------------|--------------------|
| **backend** | Build aus `Dockerfile` | 8000          | 8082               |
| **db**      | `postgres:17`       | 5432          | `127.0.0.1:5433`  |
| **pgadmin** | Build aus `Dockerfile.pgadmin` | 8080 | 5051             |

---

## Environment Variables

Alle Variablen stehen in `.env.example`.
In Portainer werden sie unter **Environment Variables** beim Stack-Setup eingetragen.

| Variable            | Pflicht | Default         | Beschreibung                          |
|---------------------|---------|-----------------|---------------------------------------|
| `POSTGRES_DB`       |         | `devicedb`      | Name der PostgreSQL-Datenbank         |
| `POSTGRES_USER`     |         | `deviceapp`     | DB-Benutzer                           |
| `POSTGRES_PASSWORD` | ja      | –               | DB-Passwort                           |
| `JWT_SECRET`        | ja      | –               | Geheimer Schluessel fuer JWT-Tokens   |
| `JWT_EXPIRE_HOURS`  |         | `8`             | Token-Gueltigkeitsdauer in Stunden    |
| `CORS_ORIGINS`      |         | `*`             | Erlaubte Origins (komma-separiert)    |
| `API_PREFIX`        |         | `/api/v1`       | Fuer das mitgelieferte Frontend auf `/api/v1` belassen |
| `BACKEND_PORT`      |         | `8082`          | Host-Port fuer das Backend            |
| `DB_PORT`           |         | `127.0.0.1:5433` | Host-Adresse und Port fuer PostgreSQL |
| `PGADMIN_EMAIL`     |         | `admin@local.dev` | pgAdmin Login-Email                |
| `PGADMIN_PASSWORD`  |         | `admin`         | pgAdmin Login-Passwort                |
| `PGADMIN_PORT`      |         | `5051`          | Host-Port fuer pgAdmin                |

---

## Deployment mit Portainer

### Voraussetzungen
- Portainer laeuft auf der Ziel-VM
- Docker und Docker Compose sind installiert
- Das GitHub-Repository ist erreichbar (ggf. Access Token fuer private Repos)
- Falls der Zugriff ueber eine Domain erfolgen soll, muss der Nginx Proxy Manager den Backend-Host unter seinem veroeffentlichten Port (`BACKEND_PORT`, standardmaessig `8082`) erreichen koennen.

### Schritt fuer Schritt

1. **Portainer** oeffnen → **Stacks** → **Add Stack**
2. **Repository** auswaehlen
3. GitHub-URL eintragen: `https://github.com/sherzai-equinix/Connection-Manager`
4. Branch: `main`
5. Compose-Pfad: `docker-compose.yml` (Default)
6. **Environment Variables** setzen (mindestens `POSTGRES_PASSWORD` und `JWT_SECRET`)
7. **Deploy the stack** klicken

Portainer baut das Backend-Image direkt aus dem Repo und startet alle Services.

Das Backend bleibt im Netzwerk `cm_net` und ist am Host-Port `8082` erreichbar.
Im Nginx Proxy Manager den Proxy Host fuer `tocry.corp.equinix.com` auf
**Scheme `http`**, **Forward Hostname `fr2lxcops01.corp.equinix.com`**
und **Forward Port `8082`** stellen, sofern dieser Host *vom Proxy-Container
aus* erreichbar ist. Der Proxy muss dafuer nicht auf demselben Docker-Host
laufen. Das Hinzufuegen eines externen Docker-Netzes auf dem Backend-Host
verbindet nicht zwei verschiedene Docker-Hosts miteinander.

### pgAdmin

Der aktuelle Compose-Stack startet pgAdmin mit. Wenn du es nicht benoetigst,
kannst du den Container in Portainer stoppen. Setze vor dem Deployment ein eigenes
`PGADMIN_PASSWORD`, wenn pgAdmin erreichbar ist.

### Updates deployen

1. Aenderungen auf `main` committen und nach GitHub pushen
2. In Portainer pruefen, dass der Repository-Branch des Stacks `main` ist
3. **Pull and redeploy** / **Update the stack** ausfuehren und das Backend-Image neu bauen lassen; ein GitHub-Merge allein aktualisiert den laufenden Container nicht

Die Datenbank bleibt dabei erhalten (persistentes Volume `cm_pgdata`).
Keine Volumes loeschen und vor einem Update ein aktuelles Backup erstellen.

### HTTPS-Zugriff pruefen

Falls `https://tocry.corp.equinix.com/frontend/login.html` nicht antwortet:

1. Zuerst `http://<VM-IP>:8082/frontend/login.html` vom passenden Netzwerk aus
   pruefen. Wenn das nicht antwortet, im Portainer-Stack den Branch `main`,
   den letzten Redeploy und die Logs von `cm_backend` und `cm_postgres` pruefen.
2. Wenn der direkte Zugriff funktioniert, den Proxy Host in Nginx Proxy Manager
   pruefen: Domain `tocry.corp.equinix.com`, Scheme `http`, Forward Hostname
   `fr2lxcops01.corp.equinix.com`, Port `8082`.
3. **Vom Proxy-Container aus** DNS-Aufloesung und HTTP-Zugriff auf
   `http://fr2lxcops01.corp.equinix.com:8082/frontend/login.html` pruefen.
   Ein erfolgreicher Aufruf vom eigenen Rechner beweist nicht, dass der
   Proxy-Container denselben Host erreichen kann. Ausserdem die Proxy-Host-
   Logs und die TLS-/Access-Einstellungen im Nginx Proxy Manager pruefen.
   Ein HTTPS-Timeout ohne HTTP-Status trotz erfolgreichem TLS-Handshake
   beweist nicht, dass das Frontend selbst defekt ist.

---

## Ports

| Dienst   | URL nach Deployment                  |
|----------|--------------------------------------|
| Backend  | `http://<VM-IP>:8082`                |
| API Docs | `http://<VM-IP>:8082/docs`           |
| Frontend | `http://<VM-IP>:8082/frontend/login.html` |
| pgAdmin  | `http://<VM-IP>:5051` (wenn aktiv)   |

---

## Datenbank

- PostgreSQL laeuft als eigener Container mit persistentem Docker-Volume (`cm_pgdata`)
- Bei Redeploy / Update bleibt die DB bestehen
- Kein automatischer Datenbank-Reset oder Import. Beim Start werden fehlende ORM-Tabellen angelegt und bekannte doppelte PP-Praefixe bereinigt
- SQL-Migrationsskripte liegen in `migrations/` und muessen bei Bedarf manuell ausgefuehrt werden
- Vor der Erstmigration: bestehendes DB-Backup einspielen

### DB-Backup manuell erstellen

```bash
docker exec cm_postgres pg_dump -U deviceapp devicedb > backup_$(date +%Y%m%d).sql
```

### DB-Backup einspielen

```bash
cat backup.sql | docker exec -i cm_postgres psql -U deviceapp devicedb
```

---

## Lokale Entwicklung

```bash
python -m venv .venv
source .venv/bin/activate   # Windows: .venv\Scripts\Activate.ps1
pip install -r requirements.txt
cp .env.example .env        # Werte anpassen
uvicorn app:app --reload --host 0.0.0.0 --port 8000
```

Empfohlen: Frontend direkt ueber `http://127.0.0.1:8000/frontend/login.html` oeffnen.
Es verwendet automatisch den Server, von dem es ausgeliefert wird; dies gilt auch
fuer Test-VMs, andere Ports und HTTPS.

Live Server unter `localhost` / `127.0.0.1` auf Port 5500 oder 5501 sowie `file://`
verwenden fuer die API `http://127.0.0.1:8000`. Fuer getrennte Frontend-/Backend-Hosts
kann `window.API_ORIGIN` in einem Script **vor** `config.js` gesetzt werden; der
Backend-Server muss dann die Frontend-Origin per `CORS_ORIGINS` erlauben.

### Automatisierte Regressionstests

```bash
pip install -r requirements-dev.txt
node --test tests
python -m unittest discover -s tests -p "test_*.py"
```

Die Tests verwenden synthetische Daten und keine produktive Datenbank.
GitHub Actions fuehrt sie bei Pushes und Pull Requests aus.

---

## Projektstruktur

```
app.py                  # FastAPI Entry Point
config.py               # Zentrale Konfiguration (ENV-basiert)
database.py             # SQLAlchemy Engine + Session
models.py               # ORM Models
security.py             # JWT Auth + RBAC
audit.py                # Audit-Logging
crud.py                 # CRUD-Hilfsfunktionen
routers/                # API-Router (auth, devices, connections, ...)
frontend/               # Vanilla JS + HTML Frontend
migrations/             # SQL-Migrationsskripte
scripts/                # Hilfs-/Importskripte
Dockerfile              # Backend-Image Build
docker-compose.yml      # Stack-Definition fuer Portainer
.env.example            # Template fuer Environment Variables
requirements.txt        # Python-Abhaengigkeiten
```

---

## Erster Start – Checkliste

1. DB-Backup auf der VM bereithalten
2. Stack in Portainer deployen (siehe oben)
3. Warten bis `cm_postgres` healthy ist
4. DB-Backup einspielen (siehe DB-Backup einspielen)
5. Ggf. Migrationen ausfuehren (`migrations/*.sql`)
6. Frontend oeffnen unter `http://<VM-IP>:8082/frontend/login.html`

---

## Test-Migration: Schritt fuer Schritt

Diese Anleitung beschreibt, wie du den bestehenden Datenstand auf eine **neue, separate Test-Umgebung** uebertraegst, ohne die produktive Umgebung zu veraendern.

**Wichtig:** Verwende mit dieser Compose-Datei einen **separaten Docker-Host / eine
separate VM**. Container, Netzwerk und Volumes haben feste Namen; ein zweiter Stack
auf demselben Host ist deshalb nicht automatisch isoliert und kann auf dieselben
Datenbank-Volumes zugreifen. Restore-Befehle ausschliesslich auf dem Test-Host
ausfuehren und das Ziel vorher kontrollieren.

### 1. Backup auf der aktuellen Umgebung erstellen

Auf dem Server / PC, wo die aktuelle Datenbank laeuft:

```bash
# Falls DB in Docker laeuft:
docker exec cm_postgres pg_dump -U deviceapp -Fc devicedb > devicedb_backup.dump

# Falls DB direkt auf dem Host laeuft:
pg_dump -U deviceapp -Fc devicedb > devicedb_backup.dump
```

> `-Fc` erzeugt ein komprimiertes Custom-Format (empfohlen).
> Alternativ als Plain SQL: `-Fp` statt `-Fc`, dann Dateiendung `.sql`.

### 2. Backup auf den Firmen-PC / Test-Server uebertragen

Die Datei `devicedb_backup.dump` per SCP, USB, Netzlaufwerk o.ae. auf den Zielrechner kopieren.

### 3. Test-Stack in Portainer starten

1. Portainer oeffnen → **Stacks** → **Add Stack**
2. **Repository** auswaehlen
3. URL: `https://github.com/sherzai-equinix/Connection-Manager`
4. Branch: `main`
5. Environment Variables setzen:

| Variable            | Wert (Beispiel)                |
|---------------------|--------------------------------|
| `POSTGRES_DB`       | `devicedb`                     |
| `POSTGRES_USER`     | `deviceapp`                    |
| `POSTGRES_PASSWORD` | `MeinTestPasswort123`          |
| `JWT_SECRET`        | `test-geheimer-schluessel-xyz` |
| `CORS_ORIGINS`      | `*`                            |
| `BACKEND_PORT`      | `8082`                         |
| `DB_PORT`           | `127.0.0.1:5433`                |

6. **Deploy the stack**

Warten, bis alle Container laufen (Postgres muss healthy sein).

### 4. Backup in den Test-Postgres importieren

Auf dem Test-Server / Firmen-PC, wo Portainer und der Stack laufen:

**Option A – per `docker exec` (Backup-Datei auf dem Server):**

```bash
# Custom-Format (.dump):
docker exec -i cm_postgres pg_restore -U deviceapp -d devicedb --clean --if-exists < devicedb_backup.dump

# Falls Plain SQL (.sql):
cat devicedb_backup.sql | docker exec -i cm_postgres psql -U deviceapp devicedb
```

**Option B – per `psql` auf dem Test-Host (oder ueber einen SSH-Tunnel dorthin):**

`DB_PORT` bindet PostgreSQL standardmaessig nur an localhost des Docker-Hosts.

```bash
# Custom-Format:
pg_restore -h localhost -p 5433 -U deviceapp -d devicedb --clean --if-exists devicedb_backup.dump

# Plain SQL:
psql -h localhost -p 5433 -U deviceapp -d devicedb < devicedb_backup.sql
```

> `--clean --if-exists` loescht bestehende Objekte vor dem Restore, damit es sauber ueberschrieben wird.
> Das betrifft nur die Test-DB im neuen Stack – die Produktion bleibt unangetastet.

### 5. Test-App pruefen

- Frontend: `http://<TEST-VM-IP>:8082/frontend/login.html`
- API Docs: `http://<TEST-VM-IP>:8082/docs`
- pgAdmin: `http://<TEST-VM-IP>:5051` (Login: siehe PGADMIN_EMAIL / PGADMIN_PASSWORD)

Anmeldung mit den gleichen Benutzerdaten wie auf der produktiven Umgebung (kommen aus der importierten DB).

### 6. Bei Problemen zuruecksetzen

Falls nur der neue Code nicht passt, stelle in Portainer den vorherigen
Repository-Stand wieder ein und redeploye **ohne** Volume-Loeschung.

Nur wenn du auch die Testdaten zuruecksetzen willst: Ziel-Host und Datenbank
kontrollieren, Testdaten sichern und das Backup aus Schritt 4 erneut einspielen.
Kein `docker compose down -v` auf einem Host mit produktiven Volumes verwenden.

### 7. Spaeter: Umstellung auf Produktion

Wenn der Test erfolgreich war:

1. Finales Backup der Produktion erstellen
2. Stack auf dem Produktionsserver deployen (gleiche Schritte wie oben)
3. Backup importieren
4. Alten Stack / alte Umgebung abschalten

---

## GitHub Backup-Workflow (lokal)

Fuer lokale Entwicklung gibt es Hilfs-Skripte unter `scripts/`:

```powershell
# Aenderungen committen + nach GitHub pushen (mit Backup-Tag)
powershell -ExecutionPolicy Bypass -File scripts\publish_to_github.ps1

# Letzten Code-Stand wiederherstellen
powershell -ExecutionPolicy Bypass -File scripts\restore_latest_backup.ps1

# Lokale .env / DB-Datei wiederherstellen
powershell -ExecutionPolicy Bypass -File scripts\restore_latest_local_backup.ps1
```
