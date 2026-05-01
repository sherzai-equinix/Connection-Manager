# scripts/migrate_precabling.py
import sys
import os
sys.path.append(os.path.dirname(os.path.dirname(__file__)))

from database import SessionLocal
from models import PreCabledLink

def check_precabling_data():
    """Prüft ob PreCabling Daten vorhanden sind"""
    db = SessionLocal()
    try:
        count = db.query(PreCabledLink).count()
        print(f"📊 PreCabling Einträge in Datenbank: {count}")
        
        if count > 0:
            print("📋 Beispiele:")
            links = db.query(PreCabledLink).limit(3).all()
            for link in links:
                print(f"  • {link.room} | {link.switch_name}:{link.switch_port} → {link.patchpanel_id}:{link.patchpanel_port}")
        else:
            print("⚠️  Keine PreCabling Daten gefunden!")
            
        return count
    finally:
        db.close()

if __name__ == "__main__":
    print("🔍 PRECABLING DATEN-CHECK")
    print("=" * 40)
    check_precabling_data()