# Connection Manager (FastAPI + Vanilla Frontend)

## GitHub Update + Backup

Das Projekt hat jetzt einen eingebauten GitHub-Workflow fuer schnelle Updates mit Backup.

### Ein-Klick Update nach GitHub

In VS Code kannst du ueber `Terminal -> Run Task` den Task `GitHub: Backup and Publish` starten.

Der Task macht automatisch:

1. lokales Backup von `.env` und `connection_manager.db` nach `backups/local/<timestamp>/`
2. Git-Backup-Tag vom letzten Stand vor dem neuen Commit
3. Commit aller aktuellen Aenderungen
4. Push nach GitHub auf `main`
5. Push des Backup-Tags nach GitHub

Wenn keine Commit-Message angegeben wird, erzeugt das Script automatisch eine mit Zeitstempel.

### Letzte Code-Version wiederherstellen

Task: `GitHub: Restore Latest Code Backup`

Dieser Task holt das letzte Backup-Tag und erstellt daraus einen neuen Branch wie `restore/20260408-...`.
So kannst du die alte Version sicher pruefen oder wieder uebernehmen, ohne sofort `main` zu zerstoeren.

### Letzte lokale Dateien wiederherstellen

Task: `GitHub: Restore Latest Local Backup`

Dieser Task stellt `.env` und `connection_manager.db` aus dem neuesten lokalen Backup wieder her.

### Wichtig

GitHub sichert hier deinen Code und die versionierten Projektdateien.
Lokale sensible Dateien und DB-Dateien bleiben absichtlich ausserhalb von Git und werden nur unter `backups/` lokal gesichert.

## Start (Backend)

```bash
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt

# optional: ENV setzen
cp .env.example .env

uvicorn app:app --reload --host 0.0.0.0 --port 8000
```

Docs: `http://127.0.0.1:8000/docs`

## Start (Frontend)

Frontend liegt in `frontend/`.
Empfehlung: Live Server, z.B. `http://localhost:5500/frontend/login.html`.

Standardseite nach Login ist `cross-connects.html`.

## API URL anpassen

Default ist `http://127.0.0.1:8000`.

Optional vor dem Laden setzen:

```js
window.API_ORIGIN = "http://<dein-host>:8000";
```

## Refactor Scope

Folgende Seiten/Workflows sind aktiv:

- Dashboard (neu)
- Cross Connects (Hauptseite)
- KW Planung (neu)
- Patchpanels (neu)
- Migration Audit (bestehender Flow)
- Login + Admin/Benutzerverwaltung

Folgende Bereiche wurden aus der sichtbaren Navigation entfernt:

- Verbindungen / Connections
- Rack View
- Import/Export / Excel-Automation
- Alter KW-Job Bereich

## Neue Endpoints (KW Planung)

- `POST /api/v1/kw-plans`
  - erstellt einen Plan `{year, kw}` oder liefert vorhandenen Plan (idempotent), Status bei Neuanlage: `active`
- `GET /api/v1/kw-plans?status=active|completed|archived&year=YYYY&kw=WW`
  - listet Plaene (Status-Filter auch comma-separated moeglich, z.B. `completed,archived`)
- `GET /api/v1/kw-plans/{plan_id}`
  - Plan + Task-Liste
- `POST /api/v1/kw-plans/{plan_id}/tasks`
  - erstellt Task (`install | deinstall | move | path_move`)
- `PATCH /api/v1/kw-plans/{plan_id}/tasks/{task_id}`
  - Task-Status/Payload bearbeiten
- `DELETE /api/v1/kw-plans/{plan_id}/tasks/{task_id}`
  - Task entfernen
- `POST /api/v1/kw-plans/{plan_id}/complete`
  - setzt Plan auf `completed` und sperrt Bearbeitung (read-only)
- `POST /api/v1/kw-plans/{plan_id}/archive`
  - setzt Plan auf `archived` (read-only)
- `POST /api/v1/kw-tasks/{task_id}/done`
  - setzt Task auf `done` (inkl. Install-Create mit Serial)
- `GET /api/v1/lines/by-serial/{serial}`
  - Serial-Lookup fuer Deinstall/Move/Path-Move

## Neue Endpoints (Dashboard / Patchpanels)

- `GET /api/v1/dashboard/stats`
  - KPI-Counters fuer Dashboard (active + pending Typen + aktuelle KW)
- `GET /api/v1/patchpanels`
  - Liste aller Patchpanels (Name/Location/ports_total), optional room-filter: `?room=<ROOM>`
- `GET /api/v1/patchpanels/rooms`
  - Distinct-Room-Liste fuer room-first UI
- `GET /api/v1/patchpanels/{pp_id}/ports`
  - Portdaten inkl. Occupancy (serial/customer/side), kompatibel fuer Migration Audit

## KW Planung Workflow (kurz)

1. KW (Jahr + Kalenderwoche) speichern/oeffnen.
2. Tasks manuell im Accordion erfassen:
   - Installation
   - Deinstallation (Serial Lookup + Preview)
   - Line Move (Serial Lookup + neue Z-Seite)
   - Path Move (2x Serial Lookup, BB IN/OUT Swap)
3. Tasks erscheinen direkt in der KW-Liste und koennen bearbeitet, entfernt oder auf `done` gesetzt werden.
4. `deinstall/move/path_move` markieren die Leitung sofort als pending im Workflow-Readmodell.
5. `install` erzeugt die Leitung erst bei `done` mit eingegebener Serial.
6. Plaene haben Lifecycle-Status: `active -> completed -> archived`.
7. Completed/Archived Plaene sind read-only (keine Add/Remove/Done/Patch fuer Tasks).

Hinweis: In Umgebungen ohne DB-Owner-Rechte auf `cross_connects` wird der Pending-Status
ueber die KW-Tasks sauber ueberlagert (Readmodell), auch wenn die DB-Constraint selbst
keine neuen Statuswerte auf der Tabelle erlaubt.

## Migration Audit / RBAC

Migration Audit bleibt unveraendert nutzbar.
Login, Rollen und Admin-RBAC bleiben aktiv.

## SQL Migration

Neue SQL-Datei:

- `migrations/007_add_kw_planning.sql`
- `migrations/008_kw_plans_lifecycle.sql`

## Fix-Round v4 (Layout + UX)

- Fullscreen-Layout ohne Sidebar-Reserve:
  - Seiten laufen auf voller Breite/Hoehe
  - keine zentrierten max-width Wrapper fuer Hauptinhalt
- Navigation als Bottom Dock (Windows-11 Stil) auf allen Hauptseiten:
  - Dashboard
  - Cross Connects
  - Patchpanels
  - Migration Audit
  - Admin (nur Admin-Rolle)
  - Logout
- KW Planung ist **nicht** im Dock enthalten und wird nur ueber den Button in Cross Connects geoeffnet.
- Patchpanels zeigen Cassette-Labels im Format `1A1..4D6` statt nur numerischer Ports.
- Migration Audit Tabelle:
  - Scroll nur im Tabellenbereich
  - Action-Spalte rechts sticky, damit Aktionen sichtbar bleiben
  - dunkle, lesbare Farbwerte ohne schwarzen Text in der Audit-Ansicht
