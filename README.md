# Connection Manager

FastAPI-Backend + Vanilla-JS-Frontend zur Verwaltung von Netzwerkverbindungen, Patchpanels, Cross-Connects und KW-Planung.

---

## Services

| Service     | Image / Build       | Interner Port | Default Host-Port |
|-------------|---------------------|---------------|--------------------|
| **backend** | Build aus `Dockerfile` | 8000          | 8082               |
| **db**      | `postgres:15`       | 5432          | (nur intern)       |
| **pgadmin** | `dpage/pgadmin4`    | 80            | 5051 (optional)    |

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
| `API_PREFIX`        |         | `/api/v1`       | URL-Prefix fuer alle API-Routen       |
| `BACKEND_PORT`      |         | `8082`          | Host-Port fuer das Backend            |
| `PGADMIN_EMAIL`     |         | `admin@local.dev` | pgAdmin Login-Email                |
| `PGADMIN_PASSWORD`  |         | `admin`         | pgAdmin Login-Passwort                |
| `PGADMIN_PORT`      |         | `5051`          | Host-Port fuer pgAdmin                |

---

## Deployment mit Portainer

### Voraussetzungen
- Portainer laeuft auf der Ziel-VM
- Docker und Docker Compose sind installiert
- Das GitHub-Repository ist erreichbar (ggf. Access Token fuer private Repos)

### Schritt fuer Schritt

1. **Portainer** oeffnen → **Stacks** → **Add Stack**
2. **Repository** auswaehlen
3. GitHub-URL eintragen: `https://github.com/sherzai-equinix/Connection-Manager`
4. Branch: `main`
5. Compose-Pfad: `docker-compose.yml` (Default)
6. **Environment Variables** setzen (mindestens `POSTGRES_PASSWORD` und `JWT_SECRET`)
7. **Deploy the stack** klicken

Portainer baut das Backend-Image direkt aus dem Repo und startet alle Services.

### pgAdmin aktivieren (optional)

pgAdmin laeuft im Compose-Profil `tools` und wird standardmaessig nicht gestartet.
Um pgAdmin mitzustarten, entweder:
- In Portainer den Service manuell starten, oder
- Auf der VM: `docker compose --profile tools up -d`

### Updates deployen

1. Aenderungen lokal committen und nach GitHub pushen
2. In Portainer: **Stacks** → Stack auswaehlen → **Editor** → **Update the stack** (mit "Re-pull image and redeploy" / "Force redeployment")
3. Portainer baut das Backend-Image neu und startet die Container

Die Datenbank bleibt dabei erhalten (persistentes Volume `cm_pgdata`).

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
- Kein automatischer Seed, Init oder Reset – produktive Daten sind sicher
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

Frontend ueber Live Server oeffnen: `http://localhost:5500/frontend/login.html`

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
