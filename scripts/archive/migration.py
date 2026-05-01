# migration.py
from database import engine
from sqlalchemy import text

def add_peer_instance_column():
    """Fügt peer_instance_id Spalte zur Tabelle hinzu"""
    
    with engine.connect() as conn:
        try:
            # 1. Spalte hinzufügen
            conn.execute(text("""
                ALTER TABLE patchpanel_instances 
                ADD COLUMN IF NOT EXISTS peer_instance_id VARCHAR(100);
            """))
            
            # 2. Index erstellen
            conn.execute(text("""
                CREATE INDEX IF NOT EXISTS ix_patchpanel_instances_peer_instance_id 
                ON patchpanel_instances(peer_instance_id);
            """))
            
            conn.commit()
            print("✅ Spalte peer_instance_id erfolgreich hinzugefügt!")
            
            # 3. Daten aus CSV Spalte übernehmen (falls vorhanden)
            # Hier könntest du die peer Daten aus der CSV importieren
            
        except Exception as e:
            print(f"❌ Fehler: {e}")
            conn.rollback()

if __name__ == "__main__":
    add_peer_instance_column()