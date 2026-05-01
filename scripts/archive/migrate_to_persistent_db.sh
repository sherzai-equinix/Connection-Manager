#!/usr/bin/env bash
# =============================================================================
# migrate_to_persistent_db.sh
#
# Einmalige Migration: Daten von restoredb (cm_postgres_restore) in die
# persistente Datenbank (cm_postgres) mit Named Volume übertragen.
#
# Voraussetzung: Beide Container müssen laufen (alter Stack noch aktiv).
#
# Ablauf:
#   1. Dump aus restoredb (devicedb_restore17) erstellen
#   2. Ziel-DB in cm_postgres anlegen (falls nötig)
#   3. Dump in cm_postgres/devicedb einspielen
#   4. Tabellen-Check
#
# Nutzung:
#   Auf dem Docker-Host (Server) ausführen:
#     bash scripts/migrate_to_persistent_db.sh
#
#   Oder in Portainer unter "Container > cm_postgres_restore > Console":
#     Die Schritte manuell nacheinander ausführen (siehe unten).
# =============================================================================
set -euo pipefail

RESTORE_CONTAINER="cm_postgres_restore"
TARGET_CONTAINER="cm_postgres"
SOURCE_DB="devicedb_restore17"
TARGET_DB="devicedb"
DB_USER="deviceapp"
DUMP_FILE="/tmp/migration_dump.sql"

echo "============================================="
echo "  Migration: restoredb -> persistente DB"
echo "============================================="

# --- Schritt 1: Dump aus restoredb erstellen ---
echo ""
echo "[1/4] Erstelle Dump aus ${RESTORE_CONTAINER}/${SOURCE_DB}..."
docker exec "${RESTORE_CONTAINER}" pg_dump \
  -U "${DB_USER}" \
  -d "${SOURCE_DB}" \
  --no-owner \
  --no-privileges \
  -F p \
  -f "${DUMP_FILE}"

echo "     Dump erstellt: ${DUMP_FILE} im Container ${RESTORE_CONTAINER}"

# --- Schritt 2: Dump aus Restore-Container auf Host kopieren ---
echo ""
echo "[2/4] Kopiere Dump auf den Host und in den Ziel-Container..."
docker cp "${RESTORE_CONTAINER}:${DUMP_FILE}" "./migration_dump.sql"
docker cp "./migration_dump.sql" "${TARGET_CONTAINER}:${DUMP_FILE}"

# --- Schritt 3: Ziel-DB anlegen (falls nötig) und Dump einspielen ---
echo ""
echo "[3/4] Spiele Dump in ${TARGET_CONTAINER}/${TARGET_DB} ein..."

# Prüfe ob die Ziel-DB existiert, wenn nicht -> anlegen
docker exec "${TARGET_CONTAINER}" psql -U "${DB_USER}" -d postgres -tc \
  "SELECT 1 FROM pg_database WHERE datname='${TARGET_DB}'" | grep -q 1 || \
  docker exec "${TARGET_CONTAINER}" psql -U "${DB_USER}" -d postgres -c \
  "CREATE DATABASE ${TARGET_DB} OWNER ${DB_USER};"

# Dump einspielen
docker exec "${TARGET_CONTAINER}" psql \
  -U "${DB_USER}" \
  -d "${TARGET_DB}" \
  -f "${DUMP_FILE}" \
  --set ON_ERROR_STOP=off

echo "     Dump eingespielt."

# --- Schritt 4: Tabellen prüfen ---
echo ""
echo "[4/4] Tabellen-Check in ${TARGET_CONTAINER}/${TARGET_DB}:"
docker exec "${TARGET_CONTAINER}" psql -U "${DB_USER}" -d "${TARGET_DB}" -c \
  "SELECT schemaname, tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename;"

echo ""
echo "     Zeilen pro Tabelle:"
docker exec "${TARGET_CONTAINER}" psql -U "${DB_USER}" -d "${TARGET_DB}" -c \
  "SELECT relname AS tabelle, n_live_tup AS zeilen FROM pg_stat_user_tables ORDER BY relname;"

# --- Aufräumen ---
rm -f "./migration_dump.sql"
docker exec "${RESTORE_CONTAINER}" rm -f "${DUMP_FILE}" 2>/dev/null || true
docker exec "${TARGET_CONTAINER}" rm -f "${DUMP_FILE}" 2>/dev/null || true

echo ""
echo "============================================="
echo "  Migration abgeschlossen!"
echo ""
echo "  Nächste Schritte:"
echo "  1. Prüfe die Tabellen und Daten oben."
echo "  2. Wenn alles korrekt: neuen docker-compose.yml deployen"
echo "     (ohne restoredb, Backend zeigt auf db:5432/devicedb)"
echo "  3. Stack in Portainer neu deployen."
echo "  4. restoredb-Container kann dann gelöscht werden."
echo "============================================="
