# routers/precabling.py - MIT PORT-SUCHE
from fastapi import APIRouter, Depends, HTTPException, status, Query
from sqlalchemy.orm import Session
from sqlalchemy.exc import IntegrityError
from typing import List, Optional
from pydantic import BaseModel, Field, ConfigDict

from database import get_db
from models import PreCabledLink

router = APIRouter(tags=["precabling"])


# ========================
# Pydantic Schemas
# ========================

class PreCabledLinkCreate(BaseModel):
    patchpanel_id: str = Field(..., min_length=1, max_length=50, example="PP:0102:1071190")
    patchpanel_port: str = Field(..., min_length=1, max_length=20, example="1B5")
    patchpanel_pair: Optional[str] = Field(None, max_length=10, example="21/22")
    room: str = Field(..., min_length=1, max_length=20, example="5.13S1")
    switch_name: str = Field(..., min_length=1, max_length=50, example="RFRA3211")
    switch_port: str = Field(..., min_length=1, max_length=20, example="ETH1/11")


class PreCabledLinkRead(BaseModel):
    id: int
    patchpanel_id: str
    patchpanel_port: str
    patchpanel_pair: Optional[str] = None
    room: str
    switch_name: str
    switch_port: str
    
    model_config = ConfigDict(from_attributes=True)


class PreCabledLinkUpdate(BaseModel):
    patchpanel_id: Optional[str] = Field(None, min_length=1, max_length=50)
    patchpanel_port: Optional[str] = Field(None, min_length=1, max_length=20)
    patchpanel_pair: Optional[str] = Field(None, max_length=10)
    room: Optional[str] = Field(None, min_length=1, max_length=20)
    switch_name: Optional[str] = Field(None, min_length=1, max_length=50)
    switch_port: Optional[str] = Field(None, min_length=1, max_length=20)


# ========================
# API Endpoints - MIT PORT-SUCHE
# ========================

@router.get("/links", response_model=List[PreCabledLinkRead])
def list_precabled_links(
    room: Optional[str] = Query(None, description="Filter nach Raum"),
    switch_name: Optional[str] = Query(None, description="Filter nach Switch-Name"),
    switch_port: Optional[str] = Query(None, description="Filter nach Switch-Port"),
    patchpanel_id: Optional[str] = Query(None, description="Filter nach Patchpanel-ID"),
    patchpanel_port: Optional[str] = Query(None, description="Filter nach Patchpanel-Port"),
    db: Session = Depends(get_db)
):
    """
    🔍 Suche Pre-Cabling Links mit verschiedenen Filtern
    
    Beispiele:
    - Alle Links in Raum 5.13S1: `?room=5.13S1`
    - Alle Ports auf Switch RFRA3211: `?switch_name=RFRA3211`
    - Spezifischer Switch-Port: `?switch_name=RFRA3211&switch_port=ETH1/11`
    - Suche nach Patchpanel: `?patchpanel_id=PP:0102:1071190`
    """
    
    query = db.query(PreCabledLink)
    
    # Filter anwenden
    if room:
        query = query.filter(PreCabledLink.room == room)
    if switch_name:
        query = query.filter(PreCabledLink.switch_name == switch_name)
    if switch_port:
        query = query.filter(PreCabledLink.switch_port == switch_port)
    if patchpanel_id:
        query = query.filter(PreCabledLink.patchpanel_id == patchpanel_id)
    if patchpanel_port:
        query = query.filter(PreCabledLink.patchpanel_port == patchpanel_port)
    
    return query.order_by(
        PreCabledLink.room,
        PreCabledLink.switch_name,
        PreCabledLink.switch_port
    ).all()


@router.get("/search/switch-port", response_model=List[PreCabledLinkRead])
def search_by_switch_port(
    switch_name: str = Query(..., description="Switch-Name (z.B. RFRA3211)"),
    switch_port: str = Query(..., description="Switch-Port (z.B. ETH1/11)"),
    db: Session = Depends(get_db)
):
    """
    🔎 Suche spezifischen Switch-Port
    
    Findet welcher Patchpanel-Port mit einem bestimmten Switch-Port verbunden ist.
    
    Beispiel: Welcher Patchpanel ist mit RFRA3211 Port ETH1/11 verbunden?
    """
    
    links = db.query(PreCabledLink).filter(
        PreCabledLink.switch_name == switch_name,
        PreCabledLink.switch_port == switch_port
    ).all()
    
    if not links:
        raise HTTPException(
            status_code=404,
            detail=f"Switch-Port {switch_port} auf {switch_name} nicht gefunden"
        )
    
    return links


@router.get("/search/patchpanel", response_model=List[PreCabledLinkRead])
def search_by_patchpanel(
    patchpanel_id: str = Query(..., description="Patchpanel-ID (z.B. PP:0102:1071190)"),
    patchpanel_port: Optional[str] = Query(None, description="Patchpanel-Port (z.B. 1B5)"),
    db: Session = Depends(get_db)
):
    """
    🔎 Suche Patchpanel-Verbindungen
    
    Findet welche Switch-Ports mit einem Patchpanel verbunden sind.
    """
    
    query = db.query(PreCabledLink).filter(
        PreCabledLink.patchpanel_id == patchpanel_id
    )
    
    if patchpanel_port:
        query = query.filter(PreCabledLink.patchpanel_port == patchpanel_port)
    
    links = query.all()
    
    if not links:
        if patchpanel_port:
            raise HTTPException(
                status_code=404,
                detail=f"Patchpanel-Port {patchpanel_port} auf {patchpanel_id} nicht gefunden"
            )
        else:
            raise HTTPException(
                status_code=404,
                detail=f"Patchpanel {patchpanel_id} nicht gefunden"
            )
    
    return links


@router.get("/search/room", response_model=List[PreCabledLinkRead])
def search_by_room(
    room: str = Query(..., description="Raum (z.B. 5.13S1)"),
    db: Session = Depends(get_db)
):
    """
    🏢 Alle Pre-Cabling Links in einem Raum
    
    Zeigt alle Switch ↔ Patchpanel Verbindungen in einem bestimmten Raum.
    """
    
    links = db.query(PreCabledLink).filter(
        PreCabledLink.room == room
    ).order_by(
        PreCabledLink.switch_name,
        PreCabledLink.switch_port
    ).all()
    
    if not links:
        raise HTTPException(
            status_code=404,
            detail=f"Keine Pre-Cabling Links in Raum {room} gefunden"
        )
    
    return links


@router.get("/search/switch", response_model=List[PreCabledLinkRead])
def search_by_switch(
    switch_name: str = Query(..., description="Switch-Name (z.B. RFRA3211)"),
    db: Session = Depends(get_db)
):
    """
    🔌 Alle Ports eines Switches
    
    Zeigt alle Patchpanel-Verbindungen für einen bestimmten Switch.
    """
    
    links = db.query(PreCabledLink).filter(
        PreCabledLink.switch_name == switch_name
    ).order_by(
        PreCabledLink.switch_port
    ).all()
    
    if not links:
        raise HTTPException(
            status_code=404,
            detail=f"Keine Pre-Cabling Links für Switch {switch_name} gefunden"
        )
    
    return links


@router.get("/stats/room/{room}", response_model=dict)
def get_room_stats(room: str, db: Session = Depends(get_db)):
    """
    📊 Statistiken für einen Raum
    
    Zeigt wie viele Verbindungen pro Switch im Raum existieren.
    """
    
    from sqlalchemy import func
    
    stats = db.query(
        PreCabledLink.switch_name,
        func.count(PreCabledLink.id).label('port_count')
    ).filter(
        PreCabledLink.room == room
    ).group_by(
        PreCabledLink.switch_name
    ).all()
    
    if not stats:
        raise HTTPException(
            status_code=404,
            detail=f"Keine Daten für Raum {room} gefunden"
        )
    
    total_ports = sum(stat.port_count for stat in stats)
    
    return {
        "room": room,
        "total_ports": total_ports,
        "switches": [
            {
                "switch_name": stat.switch_name,
                "port_count": stat.port_count
            }
            for stat in stats
        ]
    }


@router.get("/links/{link_id}", response_model=PreCabledLinkRead)
def get_precabled_link(link_id: int, db: Session = Depends(get_db)):
    """Einzelnen Pre-Cabled Link abrufen"""
    link = db.query(PreCabledLink).filter(PreCabledLink.id == link_id).first()
    
    if not link:
        raise HTTPException(status_code=404, detail="Pre-cabled link nicht gefunden")
    return link


@router.post("/links", response_model=PreCabledLinkRead, status_code=status.HTTP_201_CREATED)
def create_precabled_link(payload: PreCabledLinkCreate, db: Session = Depends(get_db)):
    """Neuen Pre-Cabled Link erstellen"""
    
    # Prüfe auf Duplikate (gleicher Switch-Port)
    existing = db.query(PreCabledLink).filter(
        PreCabledLink.switch_name == payload.switch_name,
        PreCabledLink.switch_port == payload.switch_port
    ).first()
    
    if existing:
        raise HTTPException(
            status_code=409,
            detail=f"Switch-Port {payload.switch_port} auf {payload.switch_name} ist bereits belegt"
        )
    
    # Prüfe auf Duplikate (gleicher Patchpanel-Port)
    existing_patch = db.query(PreCabledLink).filter(
        PreCabledLink.patchpanel_id == payload.patchpanel_id,
        PreCabledLink.patchpanel_port == payload.patchpanel_port
    ).first()
    
    if existing_patch:
        raise HTTPException(
            status_code=409,
            detail=f"Patchpanel-Port {payload.patchpanel_port} auf {payload.patchpanel_id} ist bereits belegt"
        )
    
    # Erstelle neuen Link
    new_link = PreCabledLink(**payload.model_dump())
    db.add(new_link)
    
    try:
        db.commit()
        db.refresh(new_link)
        return new_link
    except IntegrityError as e:
        db.rollback()
        raise HTTPException(status_code=409, detail=f"Integrity Error: {str(e)}")


@router.put("/links/{link_id}", response_model=PreCabledLinkRead)
def update_precabled_link(
    link_id: int, 
    payload: PreCabledLinkUpdate,
    db: Session = Depends(get_db)
):
    """Pre-Cabled Link aktualisieren"""
    
    link = db.query(PreCabledLink).filter(PreCabledLink.id == link_id).first()
    
    if not link:
        raise HTTPException(status_code=404, detail="Link nicht gefunden")
    
    update_data = payload.model_dump(exclude_unset=True)
    if not update_data:
        raise HTTPException(status_code=400, detail="Keine Update-Daten angegeben")
    
    # Prüfe auf Duplikate NUR wenn switch_name oder switch_port geändert werden
    if "switch_name" in update_data or "switch_port" in update_data:
        new_switch = update_data.get("switch_name", link.switch_name)
        new_port = update_data.get("switch_port", link.switch_port)
        
        existing = db.query(PreCabledLink).filter(
            PreCabledLink.switch_name == new_switch,
            PreCabledLink.switch_port == new_port,
            PreCabledLink.id != link_id
        ).first()
        
        if existing:
            raise HTTPException(
                status_code=409,
                detail=f"Switch-Port {new_port} auf {new_switch} ist bereits belegt"
            )
    
    # Update durchführen
    for field, value in update_data.items():
        setattr(link, field, value)
    
    try:
        db.commit()
        db.refresh(link)
        return link
    except IntegrityError as e:
        db.rollback()
        raise HTTPException(status_code=409, detail=f"Integrity Error: {str(e)}")


@router.delete("/links/{link_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_precabled_link(link_id: int, db: Session = Depends(get_db)):
    """Pre-Cabled Link löschen"""
    link = db.query(PreCabledLink).filter(PreCabledLink.id == link_id).first()
    
    if not link:
        raise HTTPException(status_code=404, detail="Link nicht gefunden")
    
    db.delete(link)
    db.commit()