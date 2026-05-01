#!/bin/bash
# =============================================================================
# upgrade_pg15_to_pg17.sh
#
# Upgrade PostgreSQL 15 -> 17 mit Datenerhalt.
#
# Ablauf:
#   1. Dump aller Daten aus PG15 (cm_postgres) als Plain SQL
#   2. Container und Volume stoppen/löschen
#   3. Neuen PG17-Container starten (neues Volume)
#   4. Dump in PG17 einspielen
#
# Voraussetzung: cm_postgres Container muss laufen.
#
# ACHTUNG: Dieses Script löscht das alte Volume!
#          Die Daten werden vorher als SQL-Dump gesichert.
# =============================================================================
set -euo pipefail

CONTAINER="cm_postgres"
DB_NAME="devicedb"
DB_USER="deviceapp"
DUMP_FILE="/tmp/pg15_full_dump.sql"

echo "============================================="
echo "  PostgreSQL 15 -> 17 Upgrade"
echo "============================================="

echo ""
echo "[1/5] Erstelle vollständigen Dump aus PG15..."
docker exec "${CONTAINER}" pg_dumpall -U "${DB_USER}" --clean --if-exists -f "${DUMP_FILE}"
docker cp "${CONTAINER}:${DUMP_FILE}" "./pg15_full_dump.sql"
echo "     Dump gesichert: ./pg15_full_dump.sql"

echo ""
echo "[2/5] Stoppe Container..."
docker stop "${CONTAINER}" || true

echo ""
echo "[3/5] Lösche altes Volume (PG15 Format)..."
docker rm "${CONTAINER}" || true
docker volume rm connection_manager_postgres_data || docker volume rm cm_pgdata || true

echo ""
echo "[4/5] Starte neuen PG17-Container..."
echo "     (Mache docker compose up -d db in deinem Stack)"
echo "     WARTE: Du musst jetzt den Stack in Portainer redeployen!"
echo ""
echo "     Danach manuell:"
echo "       docker cp ./pg15_full_dump.sql cm_postgres:/tmp/dump.sql"
echo "       docker exec cm_postgres psql -U deviceapp -d postgres -f /tmp/dump.sql"
echo ""
echo "     Und dann den PG17-Dump für Patchpanels einspielen:"
echo "       (über pgAdmin Restore)"
echo ""
echo "============================================="
