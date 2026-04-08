# debug_ports.py
from database import SessionLocal
from sqlalchemy import inspect

db = SessionLocal()

try:
    # 1. Finde PatchPanel
    from models import PatchPanelInstance
    panel = db.query(PatchPanelInstance).filter_by(instance_id="5.4S6/RU1").first()
    
    if not panel:
        print("❌ PatchPanel nicht gefunden!")
        exit()
    
    print(f"✅ PatchPanel gefunden: {panel.instance_id} (ID: {panel.id})")
    
    # 2. Schau welche Spalten die patchpanel_ports Tabelle wirklich hat
    from sqlalchemy import text
    
    # Zeige Tabellen-Struktur
    print("\n📋 TABELLEN-STRUKTUR von patchpanel_ports:")
    result = db.execute(text("""
        SELECT column_name, data_type, is_nullable 
        FROM information_schema.columns 
        WHERE table_name = 'patchpanel_ports'
        ORDER BY ordinal_position
    """)).fetchall()
    
    for col in result:
        print(f"  • {col[0]} ({col[1]}, nullable: {col[2]})")
    
    # 3. Zeige echte Daten (erste 5 Zeilen)
    print("\n📊 ECHTE DATEN (erste 5 Zeilen):")
    rows = db.execute(text("""
        SELECT * FROM patchpanel_ports 
        WHERE patchpanel_id = :panel_id 
        ORDER BY id 
        LIMIT 5
    """), {"panel_id": panel.id}).fetchall()
    
    for i, row in enumerate(rows):
        print(f"\n  Zeile {i+1}:")
        for col_name, value in zip([col[0] for col in result], row):
            if value:  # Nur nicht-leere Werte zeigen
                print(f"    {col_name}: {value}")
    
    # 4. Gesamtzahl der Ports
    count = db.execute(text("""
        SELECT COUNT(*) FROM patchpanel_ports 
        WHERE patchpanel_id = :panel_id
    """), {"panel_id": panel.id}).fetchone()[0]
    
    print(f"\n📈 Gesamtzahl Ports für dieses Panel: {count}")
    
    # 5. Einzelne Spalten prüfen
    print("\n🔍 SPEZIFISCHE SPALTEN-CHECKS:")
    
    # Hat peer_instance_id Daten?
    peer_count = db.execute(text("""
        SELECT COUNT(*) FROM patchpanel_ports 
        WHERE patchpanel_id = :panel_id AND peer_instance_id IS NOT NULL
    """), {"panel_id": panel.id}).fetchone()[0]
    
    print(f"  • Ports mit peer_instance_id: {peer_count}/{count}")
    
    # Hat port_label Daten?
    port_label_count = db.execute(text("""
        SELECT COUNT(*) FROM patchpanel_ports 
        WHERE patchpanel_id = :panel_id AND port_label IS NOT NULL
    """), {"panel_id": panel.id}).fetchone()[0]
    
    print(f"  • Ports mit port_label: {port_label_count}/{count}")
    
finally:
    db.close()