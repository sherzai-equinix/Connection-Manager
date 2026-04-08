# direct_debug.py - Direkte Fehlersuche
import sys
sys.path.append('.')

from database import SessionLocal
from sqlalchemy import text

db = SessionLocal()

try:
    print("🔍 DIREKTER DEBUG START...")
    
    # 1. Teste Datenbank-Verbindung
    print("1. Teste DB Connection...")
    result = db.execute(text("SELECT 1"))
    print(f"   ✅ DB Connection: OK")
    
    # 2. Teste PatchPanel Suche
    print("\n2. Teste PatchPanel Suche...")
    instance_id = "5.4S6/RU1"
    
    # Versuche verschiedene Queries
    queries = [
        # Query 1: Mit Filter
        ("SELECT id FROM patchpanel_instances WHERE instance_id = :id", 
         {"id": instance_id}),
        
        # Query 2: Case-insensitive  
        ("SELECT id FROM patchpanel_instances WHERE instance_id ILIKE :id",
         {"id": instance_id}),
         
        # Query 3: Alles anzeigen
        ("SELECT instance_id FROM patchpanel_instances LIMIT 5", {})
    ]
    
    for i, (query, params) in enumerate(queries):
        print(f"\n   Query {i+1}: {query[:50]}...")
        try:
            result = db.execute(text(query), params)
            rows = result.fetchall()
            print(f"      Ergebnis: {len(rows)} Zeilen")
            if rows:
                for row in rows:
                    print(f"        - {row}")
        except Exception as e:
            print(f"      ❌ Fehler: {e}")
    
    # 3. Teste Ports Query
    print("\n3. Teste Ports Query...")
    
    # Finde Panel ID zuerst
    panel_result = db.execute(
        text("SELECT id FROM patchpanel_instances WHERE instance_id = :id"),
        {"id": instance_id}
    )
    panel_row = panel_result.fetchone()
    
    if panel_row:
        panel_id = panel_row[0]
        print(f"   ✅ Panel gefunden: ID = {panel_id}")
        
        # Teste Ports Query
        ports_query = """
            SELECT port_label, status 
            FROM patchpanel_ports 
            WHERE patchpanel_id = :panel_id 
            LIMIT 5
        """
        
        ports_result = db.execute(text(ports_query), {"panel_id": panel_id})
        ports = ports_result.fetchall()
        
        print(f"   ✅ Ports gefunden: {len(ports)}")
        for port in ports:
            print(f"     - {port.port_label}: {port.status}")
    else:
        print(f"   ❌ Panel nicht gefunden!")
        
        # Zeige was da ist
        all_panels = db.execute(
            text("SELECT instance_id FROM patchpanel_instances LIMIT 10")
        ).fetchall()
        
        print(f"   Verfügbare Panels:")
        for panel in all_panels:
            print(f"     - '{panel.instance_id}'")
    
finally:
    db.close()
    print("\n🔍 DEBUG ENDE")