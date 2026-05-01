# routers/connections.py
from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session
from sqlalchemy.exc import IntegrityError

from database import get_db
from models import Device, Connection, ConnectionCreate, ConnectionRead

router = APIRouter(tags=["connections"])


@router.get("/connections", response_model=list[ConnectionRead])
def list_connections(db: Session = Depends(get_db)):
    return db.query(Connection).order_by(Connection.id).all()


@router.get("/connections/{connection_id}", response_model=ConnectionRead)
def get_connection(connection_id: int, db: Session = Depends(get_db)):
    conn = db.query(Connection).filter(Connection.id == connection_id).first()
    if not conn:
        raise HTTPException(status_code=404, detail="Connection nicht gefunden")
    return conn


@router.post("/connections", response_model=ConnectionRead, status_code=status.HTTP_201_CREATED)
def create_connection(payload: ConnectionCreate, db: Session = Depends(get_db)):
    # 1) self-link blocken
    if payload.source_id == payload.target_id:
        raise HTTPException(status_code=400, detail="source_id und target_id dürfen nicht gleich sein")

    # 2) Devices müssen existieren
    src_exists = db.query(Device.id).filter(Device.id == payload.source_id).first()
    tgt_exists = db.query(Device.id).filter(Device.id == payload.target_id).first()
    if not src_exists:
        raise HTTPException(status_code=404, detail="source_id Device nicht gefunden")
    if not tgt_exists:
        raise HTTPException(status_code=404, detail="target_id Device nicht gefunden")

    # 3) Optional: Duplicate-Check auf API-Level (zusätzlich zur DB)
    dup = db.query(Connection.id).filter(
        Connection.source_id == payload.source_id,
        Connection.target_id == payload.target_id,
        Connection.link_type == payload.link_type
    ).first()
    if dup:
        raise HTTPException(status_code=409, detail="Connection existiert bereits")

    conn = Connection(**payload.model_dump())
    db.add(conn)

    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        # falls UniqueConstraint greift oder FK verletzt wird
        raise HTTPException(status_code=409, detail="Connection kollidiert (Duplicate oder Constraint)")

    db.refresh(conn)
    return conn


@router.delete("/connections/{connection_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_connection(connection_id: int, db: Session = Depends(get_db)):
    conn = db.query(Connection).filter(Connection.id == connection_id).first()
    if not conn:
        raise HTTPException(status_code=404, detail="Connection nicht gefunden")

    db.delete(conn)
    db.commit()
    