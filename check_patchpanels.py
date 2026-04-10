# check_patchpanels.py
from database import SessionLocal
from models import PatchPanelInstance

db = SessionLocal()

try:
    # Gesamtzahl
    count = db.query(PatchPanelInstance).count()
    print(f"✅ {count} PatchPanel Instanzen in Datenbank")
    
    if count > 0:
        # Zeige die ersten 5
        print("\n📋 Erste 5 PatchPanels:")
        panels = db.query(PatchPanelInstance).limit(5).all()
        for panel in panels:
            print(f"  • {panel.instance_id} | Raum: {panel.room} | RU: {panel.rack_unit}")
        
        # Zeige Statistiken
        print("\n📊 Statistiken:")
        rooms = db.query(PatchPanelInstance.room).distinct().all()
        print(f"  Räume: {[r[0] for r in rooms]}")
        
        # Durchschnittliche RU pro Raum
        from sqlalchemy import func
        avg_ru = db.query(func.avg(PatchPanelInstance.rack_unit)).scalar()
        print(f"  Durchschnittliche RU: {avg_ru:.1f}")
        
        # Höchste RU
        max_ru = db.query(func.max(PatchPanelInstance.rack_unit)).scalar()
        print(f"  Höchste RU: {max_ru}")
        
    else:
        print("😕 Keine PatchPanels gefunden")
        
except Exception as e:
    print(f"❌ Fehler: {e}")
    import traceback
    traceback.print_exc()
finally:
    db.close()