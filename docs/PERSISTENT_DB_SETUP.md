# Persistente Datenbank – Docker Volume Setup

## Übersicht

Die PostgreSQL-Datenbank läuft jetzt mit einem **dauerhaften Named Volume**, sodass Daten bei Container-Restarts, Updates oder Redeployments erhalten bleiben.

---

## Volume-Konfiguration

| Service   | Volume-Name                        | Mount-Pfad im Container        |
|-----------|------------------------------------|--------------------------------|
| **db**    | `connection_manager_postgres_data` | `/var/lib/postgresql/data`     |
| **pgadmin** | `connection_manager_pgadmin_data` | `/var/lib/pgadmin`            |

### Prüfen, ob die Volumes existieren:

```bash
docker volume ls | grep connection_manager
```

Erwartete Ausgabe:
```
local   connection_manager_postgres_data
local   connection_manager_pgadmin_data
```

---

## Stack-Struktur (Ziel-Zustand)

```
services:
  db          – PostgreSQL 15 mit persistentem Volume
  backend     – FastAPI App, verbindet sich zu db:5432/devicedb
  pgadmin     – pgAdmin 4 mit persistentem Volume
```

- **Kein `restoredb`-Service** mehr im produktiven Setup.
- **Kein manueller Dump/Restore** mehr nötig nach Redeploy.

---

## Migrationsprozess (einmalig)

### Voraussetzung
Alter Stack mit `restoredb` (cm_postgres_restore) muss noch laufen.

### Schritte

1. **Migrationsscript auf dem Docker-Host ausführen:**

   ```bash
   bash scripts/migrate_to_persistent_db.sh
   ```

   Das Script:
   - Erstellt einen Dump aus `cm_postgres_restore` / `devicedb_restore17`
   - Kopiert den Dump in den `cm_postgres`-Container
   - Spielt den Dump in `devicedb` ein
   - Zeigt alle Tabellen und Zeilenzahlen zur Prüfung an

2. **Daten prüfen:**
   - Alle erwarteten Tabellen vorhanden?
   - Zeilenzahlen plausibel?
   - Stichproben über pgAdmin oder psql machen.

3. **Neuen Stack deployen (ohne restoredb):**
   - Den aktualisierten `docker-compose.yml` in Portainer deployen.
   - Der Backend-Service verbindet sich jetzt zu `db:5432/devicedb`.

4. **App testen:**
   - Login prüfen
   - Connections, Cross-Connects, KW-Jobs etc. prüfen
   - Alles muss wie vorher funktionieren.

5. **Alten restoredb-Container entfernen:**
   ```bash
   docker stop cm_postgres_restore
   docker rm cm_postgres_restore
   ```

### Manuelle Migration (Alternative)

Falls das Bash-Script nicht nutzbar ist (z. B. auf Windows-Host), können die Schritte auch manuell ausgeführt werden:

```bash
# 1. Dump erstellen (im restoredb-Container)
docker exec cm_postgres_restore pg_dump -U deviceapp -d devicedb_restore17 --no-owner --no-privileges -f /tmp/dump.sql

# 2. Dump kopieren
docker cp cm_postgres_restore:/tmp/dump.sql ./dump.sql
docker cp ./dump.sql cm_postgres:/tmp/dump.sql

# 3. In persistente DB einspielen
docker exec cm_postgres psql -U deviceapp -d devicedb -f /tmp/dump.sql

# 4. Tabellen prüfen
docker exec cm_postgres psql -U deviceapp -d devicedb -c "\dt"
docker exec cm_postgres psql -U deviceapp -d devicedb -c "SELECT relname, n_live_tup FROM pg_stat_user_tables ORDER BY relname;"
```

---

## Nachweisen, dass die DB persistent ist

```bash
# 1. Container neu starten
docker restart cm_postgres

# 2. Daten prüfen – müssen noch da sein
docker exec cm_postgres psql -U deviceapp -d devicedb -c "SELECT count(*) FROM cross_connects;"

# 3. Container komplett löschen und neu erstellen
docker stop cm_postgres && docker rm cm_postgres
docker compose up -d db

# 4. Daten prüfen – müssen immer noch da sein!
docker exec cm_postgres psql -U deviceapp -d devicedb -c "SELECT count(*) FROM cross_connects;"
```

Solange das Volume `connection_manager_postgres_data` existiert, bleiben die Daten erhalten.

---

## Änderungen an docker-compose.yml

| Was                              | Vorher                                          | Nachher                                         |
|----------------------------------|------------------------------------------------|------------------------------------------------|
| **Backend DATABASE_URL**         | `restoredb:5432/devicedb_restore17`            | `db:5432/devicedb` (dynamisch via ENV)          |
| **restoredb Service**            | Vorhanden (postgres:17, kein Volume)           | **Entfernt**                                    |
| **pgAdmin Volume**               | Deklariert aber nicht gemountet                | Gemountet auf `/var/lib/pgadmin`                |
| **DB Volume Name**               | `cm_pgdata`                                    | `connection_manager_postgres_data`              |
| **pgAdmin Volume Name**          | `cm_pgadmin_data`                              | `connection_manager_pgadmin_data`               |

---

## Wichtiger Hinweis für Portainer

Beim Redeployment in Portainer:
- **"Pull and redeploy"** behält die Volumes.
- **"Remove stack"** und **"Deploy new stack"** behält die Volumes ebenfalls (solange "Remove volumes" NICHT angehakt wird).
- **Volumes niemals manuell löschen**, es sei denn, ein kompletter Daten-Reset ist gewünscht.
