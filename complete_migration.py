# complete_migration.py
from database import SessionLocal
from models import PatchPanelInstance, PatchPanelPort, PreCabledLink

# GLOBALE VARIABLEN (außerhalb der Funktion)
OLD_ROOM = "M5.04S6"
NEW_ROOM = "5.4S6"

def complete_migration(old_room, new_room):
    """Komplette Migration von old_room zu new_room in ALLEN Tabellen"""
    
    db = SessionLocal()
    
    try:
        print(f"📊 Starte komplette Migration: {old_room} → {new_room}")
        
        # 1. PATCHPANEL INSTANCES (room Spalte)
        print("\n1️⃣ PatchPanel Instanzen (room)...")
        pp_count = db.query(PatchPanelInstance).filter_by(room=old_room).count()
        if pp_count > 0:
            db.query(PatchPanelInstance).filter_by(room=old_room).update(
                {"room": new_room}
            )
            print(f"   ✅ {pp_count} PatchPanel Instanzen aktualisiert")
        else:
            print(f"   ℹ️  Keine PatchPanels mit room='{old_room}' gefunden")
        
        # 2. PATCHPANEL PORTS (peer_instance_id Spalte)
        print("\n2️⃣ PatchPanel Ports (peer_instance_id)...")
        # Finde alle Ports deren peer_instance_id mit old_room beginnt
        ports_to_update = db.query(PatchPanelPort).filter(
            PatchPanelPort.peer_instance_id.like(f'{old_room}/%')
        ).all()
        
        ports_count = len(ports_to_update)
        if ports_count > 0:
            for port in ports_to_update:
                if port.peer_instance_id:
                    # Ersetze old_room mit new_room
                    port.peer_instance_id = port.peer_instance_id.replace(
                        old_room, new_room
                    )
            print(f"   ✅ {ports_count} Port-Verbindungen aktualisiert")
        else:
            print(f"   ℹ️  Keine Ports mit peer_instance_id='{old_room}...' gefunden")
        
        # 3. PRECABLED LINKS (patchpanel_id Spalte)
        print("\n3️⃣ PreCabled Links (patchpanel_id)...")
        links_to_update = db.query(PreCabledLink).filter(
            PreCabledLink.patchpanel_id.like(f'{old_room}/%')
        ).all()
        
        links_count = len(links_to_update)
        if links_count > 0:
            for link in links_to_update:
                link.patchpanel_id = link.patchpanel_id.replace(old_room, new_room)
            print(f"   ✅ {links_count} PreCabled Links aktualisiert")
        else:
            print(f"   ℹ️  Keine PreCabled Links mit patchpanel_id='{old_room}...' gefunden")
        
        # 4. AUCH INSTANCE_ID IN PATCHPANEL_INSTANCES? (falls nötig)
        print("\n4️⃣ PatchPanel Instance IDs...")
        panels_with_old_id = db.query(PatchPanelInstance).filter(
            PatchPanelInstance.instance_id.like(f'{old_room}/%')
        ).all()
        
        panels_count = len(panels_with_old_id)
        if panels_count > 0:
            for panel in panels_with_old_id:
                panel.instance_id = panel.instance_id.replace(old_room, new_room)
            print(f"   ✅ {panels_count} PatchPanel Instance IDs aktualisiert")
        else:
            print(f"   ℹ️  Keine PatchPanels mit instance_id='{old_room}...' gefunden")
        
        db.commit()
        
        # ZUSAMMENFASSUNG
        print(f"\n🎉 MIGRATION ABGESCHLOSSEN!")
        print(f"   Insgesamt aktualisiert:")
        print(f"   • {pp_count} PatchPanel Instanzen (room)")
        print(f"   • {ports_count} Port-Verbindungen")
        print(f"   • {links_count} PreCabled Links")
        print(f"   • {panels_count} Instance IDs")
        
        # NACHWEIS
        print(f"\n📋 Nachweis - Suche nach '{new_room}':")
        
        # PatchPanels im neuen Raum
        new_pp = db.query(PatchPanelInstance).filter_by(room=new_room).count()
        print(f"   • PatchPanels in Raum '{new_room}': {new_pp}")
        
        # Test: Ein Beispiel anzeigen
        example = db.query(PatchPanelInstance).filter_by(room=new_room).first()
        if example:
            print(f"   • Beispiel: {example.instance_id}")
            
    except Exception as e:
        print(f"❌ Fehler bei Migration: {e}")
        db.rollback()
        import traceback
        traceback.print_exc()
    finally:
        db.close()

if __name__ == "__main__":
    print(f"⚠️  WICHTIG: Diese Migration ändert ALLE Vorkommen von")
    print(f"   '{OLD_ROOM}' zu '{NEW_ROOM}' in der gesamten Datenbank!")
    print(f"\nBetroffene Tabellen:")
    print(f"   • patchpanel_instances.room")
    print(f"   • patchpanel_instances.instance_id")
    print(f"   • patchpanel_ports.peer_instance_id")
    print(f"   • pre_cabled_links.patchpanel_id")
    
    confirm = input("\nFortfahren? (ja/nein): ")
    if confirm.lower() == 'ja':
        complete_migration(OLD_ROOM, NEW_ROOM)
    else:
        print("❌ Migration abgebrochen")