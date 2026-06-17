# models.py - KOMPLETTE DATEI MIT ALLEN MODELS
from sqlalchemy import Column, Integer, String, ForeignKey, UniqueConstraint, Index, DateTime, func, Date, Text, JSON
from sqlalchemy.orm import relationship, Mapped, mapped_column
from pydantic import BaseModel, ConfigDict, Field
from typing import Optional, Any
from datetime import datetime
from pydantic import BaseModel
from database import Base


# ========================
# SQLAlchemy Models
# ========================

class Device(Base):
    __tablename__ = "devices"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    name: Mapped[str] = mapped_column(String, unique=True, index=True, nullable=False)
    ip: Mapped[Optional[str]] = mapped_column(String, unique=True, index=True, nullable=True)
    room: Mapped[Optional[str]] = mapped_column(String, index=True, nullable=True)
    type: Mapped[Optional[str]] = mapped_column(String, index=True, nullable=True)
    
    # Timestamps für Audit
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), onupdate=func.now())


class Connection(Base):
    __tablename__ = "connections"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    source_id: Mapped[int] = mapped_column(ForeignKey("devices.id"), nullable=False)
    target_id: Mapped[int] = mapped_column(ForeignKey("devices.id"), nullable=False)
    link_type: Mapped[str] = mapped_column(String, index=True, nullable=False)
    notes: Mapped[Optional[str]] = mapped_column(String, nullable=True)
    
    # Timestamps
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), onupdate=func.now())
    
    # Relationships
    source_device: Mapped["Device"] = relationship(
        "Device", 
        foreign_keys=[source_id],
        back_populates="outgoing_connections"
    )
    target_device: Mapped["Device"] = relationship(
        "Device", 
        foreign_keys=[target_id],
        back_populates="incoming_connections"
    )
    
    __table_args__ = (
        UniqueConstraint("source_id", "target_id", "link_type", 
                        name="uq_conn_src_tgt_type"),
        Index("ix_conn_src_tgt", "source_id", "target_id"),
        Index("ix_conn_link_type", "link_type"),
    )


class PreCabledLink(Base):
    __tablename__ = "pre_cabled_links"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    patchpanel_id: Mapped[str] = mapped_column(String, nullable=False, index=True)
    patchpanel_port: Mapped[str] = mapped_column(String, nullable=False, index=True)
    patchpanel_pair: Mapped[Optional[str]] = mapped_column(String, nullable=True)
    room: Mapped[str] = mapped_column(String, nullable=False, index=True)
    switch_name: Mapped[str] = mapped_column(String, nullable=False, index=True)
    switch_port: Mapped[str] = mapped_column(String, nullable=False, index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    
    __table_args__ = (
        # Verhindert doppelte Switch-Port Belegung
        UniqueConstraint("switch_name", "switch_port", name="uq_pcl_switch_port"),
        # Verhindert doppelte Patchpanel-Port Belegung
        UniqueConstraint("patchpanel_id", "patchpanel_port", name="uq_pcl_patchpanel_port"),
        # Composite Index für schnelle Abfragen
        Index("ix_pcl_room_switch", "room", "switch_name"),
        Index("ix_pcl_room_switch_port", "room", "switch_name", "switch_port"),
        Index("ix_pcl_patchpanel", "patchpanel_id", "patchpanel_port"),
    )


class PatchPanelInstance(Base):
    __tablename__ = "patchpanel_instances"
    
    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    instance_id: Mapped[str] = mapped_column(String(100), unique=True, index=True, nullable=False)  # "M1A2/RU5"
    room: Mapped[str] = mapped_column(String(50), nullable=False)  # "M1A2", "5.13S1", "5.04S6"
    rack_unit: Mapped[int] = mapped_column(Integer, nullable=False)  # 5, 17, 29, etc.
    peer_instance_id: Mapped[Optional[str]] = mapped_column(String(100), nullable=True, index=True)
    pp_number: Mapped[Optional[str]] = mapped_column(String(50), unique=True, index=True, nullable=True)
    
    # Zusätzliche Info
    panel_type: Mapped[Optional[str]] = mapped_column(String(50), default="CAT6A")
    total_ports: Mapped[int] = mapped_column(Integer, default=96)
    installation_date: Mapped[Optional[datetime]] = mapped_column(Date, nullable=True)
    notes: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    
    # Timestamps
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), onupdate=func.now())
    
    # Relationship
    ports: Mapped[list["PatchPanelPort"]] = relationship(
        "PatchPanelPort", 
        back_populates="patchpanel",
        cascade="all, delete-orphan"
    )


class PatchPanelPort(Base):
    __tablename__ = "patchpanel_ports"
    
    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    patchpanel_id: Mapped[int] = mapped_column(ForeignKey("patchpanel_instances.id"), nullable=False)
    
    # Port Position im Grid
    row_number: Mapped[int] = mapped_column(Integer)  # 1-4
    row_letter: Mapped[str] = mapped_column(String(1))  # A-D
    position: Mapped[int] = mapped_column(Integer)  # 1-6
    
    # Berechnetes Label
    port_label: Mapped[str] = mapped_column(String(10), index=True)  # "1A1", "2B3", "4D6"
    
    # Verbindung
    peer_instance_id: Mapped[Optional[str]] = mapped_column(String(100), nullable=True)  # "M5.13S1/RU3"
    peer_port_label: Mapped[Optional[str]] = mapped_column(String(10), nullable=True)  # "1A1"
    connected_to: Mapped[Optional[str]] = mapped_column(String(100), nullable=True)  # Switch Port z.B. "RFRA3231:eth1/1"
    status: Mapped[str] = mapped_column(String(20), default="available")  # connected, available, etc.
    
    # Timestamps
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), onupdate=func.now())
    
    # Relationship
    patchpanel: Mapped["PatchPanelInstance"] = relationship(
        "PatchPanelInstance", 
        back_populates="ports"
    )
    
    __table_args__ = (
        Index("ix_pp_port_label", "port_label"),
        Index("ix_pp_peer", "peer_instance_id", "peer_port_label"),
        UniqueConstraint("patchpanel_id", "port_label", name="uq_pp_port"),
    )


# Backrefs für Device (NACH der Connection Klasse!)
Device.outgoing_connections = relationship(
    "Connection",
    foreign_keys="Connection.source_id",
    back_populates="source_device",
    cascade="all, delete-orphan"
)
Device.incoming_connections = relationship(
    "Connection",
    foreign_keys="Connection.target_id",
    back_populates="target_device",
    cascade="all, delete-orphan"
)


# ========================
# Pydantic Schemas
# ========================

class DeviceCreate(BaseModel):
    name: str = Field(..., min_length=1, max_length=100, examples=["Switch-01"])
    ip: Optional[str] = Field(None, max_length=45, examples=["192.168.1.1"])
    room: Optional[str] = Field(None, max_length=50, examples=["5.13S1"])
    type: Optional[str] = Field(None, max_length=50, examples=["Switch", "Router"])


class DeviceRead(BaseModel):
    id: int
    name: str
    ip: Optional[str] = None
    room: Optional[str] = None
    type: Optional[str] = None
    created_at: datetime
    updated_at: Optional[datetime] = None
    
    model_config = ConfigDict(from_attributes=True)


class DeviceUpdate(BaseModel):
    name: Optional[str] = Field(None, min_length=1, max_length=100)
    ip: Optional[str] = Field(None, max_length=45)
    room: Optional[str] = Field(None, max_length=50)
    type: Optional[str] = Field(None, max_length=50)


class ConnectionCreate(BaseModel):
    source_id: int = Field(..., examples=[1])
    target_id: int = Field(..., examples=[2])
    link_type: str = Field(..., min_length=1, max_length=50, examples=["Ethernet", "Fiber"])
    notes: Optional[str] = Field(None, max_length=500, examples=["Primary connection"])


class ConnectionRead(BaseModel):
    id: int
    source_id: int
    target_id: int
    link_type: str
    notes: Optional[str] = None
    created_at: datetime
    updated_at: Optional[datetime] = None
    
    model_config = ConfigDict(from_attributes=True)


class ConnectionUpdate(BaseModel):
    link_type: Optional[str] = Field(None, min_length=1, max_length=50)
    notes: Optional[str] = Field(None, max_length=500)


class ConnectionDetail(ConnectionRead):
    source_device: Optional[DeviceRead] = None
    target_device: Optional[DeviceRead] = None


class PreCabledLinkCreate(BaseModel):
    patchpanel_id: str = Field(..., min_length=1, max_length=50, examples=["PP-01"])
    patchpanel_port: str = Field(..., min_length=1, max_length=20, examples=["A01"])
    patchpanel_pair: Optional[str] = Field(None, max_length=10, examples=["1"])
    room: str = Field(..., min_length=1, max_length=20, examples=["5.13S1"])
    switch_name: str = Field(..., min_length=1, max_length=50, examples=["RFRA3211"])
    switch_port: str = Field(..., min_length=1, max_length=10, examples=["17"])


class PreCabledLinkRead(BaseModel):
    id: int
    patchpanel_id: str
    patchpanel_port: str
    patchpanel_pair: Optional[str] = None
    room: str
    switch_name: str
    switch_port: str
    created_at: datetime
    
    model_config = ConfigDict(from_attributes=True)


class PreCabledLinkUpdate(BaseModel):
    patchpanel_id: Optional[str] = Field(None, min_length=1, max_length=50)
    patchpanel_port: Optional[str] = Field(None, min_length=1, max_length=20)
    patchpanel_pair: Optional[str] = Field(None, max_length=10)
    room: Optional[str] = Field(None, min_length=1, max_length=20)
    switch_name: Optional[str] = Field(None, min_length=1, max_length=50)
    switch_port: Optional[str] = Field(None, min_length=1, max_length=10)


# PatchPanel Schemas
class PatchPanelInstanceCreate(BaseModel):
    instance_id: str = Field(..., examples=["M1A2/RU5"])
    room: str = Field(..., examples=["M1A2"])
    rack_unit: int = Field(..., examples=[5])
    panel_type: Optional[str] = Field("CAT6A", examples=["CAT6A", "Fiber"])
    total_ports: Optional[int] = Field(96, examples=[96])
    notes: Optional[str] = Field(None, examples=["Peer: M5.13S1/RU3"])


class PatchPanelInstanceRead(BaseModel):
    id: int
    instance_id: str
    room: str
    rack_unit: int
    panel_type: Optional[str] = None
    total_ports: int
    installation_date: Optional[datetime] = None
    notes: Optional[str] = None
    created_at: datetime
    updated_at: Optional[datetime] = None
    
    model_config = ConfigDict(from_attributes=True)


class PatchPanelPortCreate(BaseModel):
    patchpanel_id: int = Field(..., examples=[1])
    port_label: str = Field(..., examples=["1A1"])
    row_number: int = Field(..., examples=[1])
    row_letter: str = Field(..., examples=["A"])
    position: int = Field(..., examples=[1])
    peer_instance_id: Optional[str] = Field(None, examples=["M5.13S1/RU3"])
    peer_port_label: Optional[str] = Field(None, examples=["1A1"])
    connected_to: Optional[str] = Field(None, examples=["RFRA3231:eth1/1"])
    status: Optional[str] = Field("available", examples=["connected", "available"])


class PatchPanelPortRead(BaseModel):
    id: int
    patchpanel_id: int
    port_label: str
    row_number: int
    row_letter: str
    position: int
    peer_instance_id: Optional[str] = None
    peer_port_label: Optional[str] = None
    connected_to: Optional[str] = None
    status: str
    created_at: datetime
    updated_at: Optional[datetime] = None
    
    model_config = ConfigDict(from_attributes=True)


class PatchPanelPortDetail(PatchPanelPortRead):
    patchpanel: Optional[PatchPanelInstanceRead] = None


# Optional: Für API-Response mit Device-Infos
class PreCabledLinkDetail(PreCabledLinkRead):
    switch_device: Optional[DeviceRead] = None  # Wenn Switch auch in devices Tabelle ist
    

# ========================
# RACK VIEW MODELS (NEU)
# ========================

class SwitchInfo(BaseModel):
    """Model für Switch-Informationen in der Rack-Ansicht"""
    name: str
    total_ports: int = 48  # Standard: 48 Port Switches
    used_ports: int
    patch_panel: str
    room: str
    utilization_percent: float
    
    model_config = ConfigDict(from_attributes=False)

class RoomOverview(BaseModel):
    """Model für Raum-Übersicht in der Rack-Ansicht"""
    room: str
    total_switches: int
    total_connections: int
    total_utilization: float
    switches: list[SwitchInfo]
    
    model_config = ConfigDict(from_attributes=False)
    

class LinkPeerCustomerIn(BaseModel):
    peer_instance_id: str
    peer_port_label: str
    customer_patchpanel_id: int
    customer_port_label: str


class KwPlan(Base):
    __tablename__ = "kw_plans"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    year: Mapped[int] = mapped_column(Integer, nullable=False, index=True)
    kw: Mapped[int] = mapped_column(Integer, nullable=False, index=True)
    status: Mapped[str] = mapped_column(String(32), nullable=False, default="active", index=True)
    created_by: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    completed_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
    archived_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)

    tasks: Mapped[list["KwTask"]] = relationship(
        "KwTask",
        back_populates="plan",
        cascade="all, delete-orphan",
    )
    changes: Mapped[list["KwChange"]] = relationship(
        "KwChange",
        back_populates="plan",
        cascade="all, delete-orphan",
    )

    __table_args__ = (
        UniqueConstraint("year", "kw", name="uq_kw_plans_year_kw"),
    )


class KwTask(Base):
    __tablename__ = "kw_tasks"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    plan_id: Mapped[int] = mapped_column(ForeignKey("kw_plans.id", ondelete="CASCADE"), nullable=False, index=True)
    type: Mapped[str] = mapped_column(String(32), nullable=False, index=True)
    status: Mapped[str] = mapped_column(String(32), nullable=False, index=True)
    line_id: Mapped[Optional[int]] = mapped_column(Integer, nullable=True, index=True)
    line1_id: Mapped[Optional[int]] = mapped_column(Integer, nullable=True, index=True)
    line2_id: Mapped[Optional[int]] = mapped_column(Integer, nullable=True, index=True)
    payload: Mapped[Optional[dict[str, Any]]] = mapped_column(JSON, nullable=True)
    created_by: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    updated_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), onupdate=func.now())

    plan: Mapped["KwPlan"] = relationship("KwPlan", back_populates="tasks")

    __table_args__ = (
        Index("ix_kw_tasks_plan_type_line", "plan_id", "type", "line_id"),
        Index("ix_kw_tasks_plan_type_pair", "plan_id", "type", "line1_id", "line2_id"),
    )


class KwChange(Base):
    __tablename__ = "kw_changes"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    kw_plan_id: Mapped[int] = mapped_column(ForeignKey("kw_plans.id", ondelete="CASCADE"), nullable=False, index=True)
    type: Mapped[str] = mapped_column(String(32), nullable=False, index=True)
    target_cross_connect_id: Mapped[Optional[int]] = mapped_column(Integer, nullable=True, index=True)
    payload_json: Mapped[Optional[dict[str, Any]]] = mapped_column(JSON, nullable=True)
    status: Mapped[str] = mapped_column(String(32), nullable=False, index=True, default="planned")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    completed_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
    created_by: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    completed_by: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)

    plan: Mapped["KwPlan"] = relationship("KwPlan", back_populates="changes")

    __table_args__ = (
        Index("ix_kw_changes_plan_type", "kw_plan_id", "type"),
    )


# ========================
# Historical Lines (CSV Archive)
# ========================

class HistoricalLine(Base):
    __tablename__ = "historical_lines"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    import_batch_id: Mapped[str] = mapped_column(String, nullable=False, index=True)
    source_filename: Mapped[Optional[str]] = mapped_column(String, nullable=True)
    imported_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    imported_by: Mapped[Optional[str]] = mapped_column(String, nullable=True)

    trunk_no: Mapped[Optional[str]] = mapped_column(String, nullable=True)
    location_a: Mapped[Optional[str]] = mapped_column(String, nullable=True)
    logical_name: Mapped[Optional[str]] = mapped_column(String, nullable=True, index=True)
    customer_name: Mapped[Optional[str]] = mapped_column(String, nullable=True, index=True)
    system_name: Mapped[Optional[str]] = mapped_column(String, nullable=True)
    rfra_ports: Mapped[Optional[str]] = mapped_column(String, nullable=True, index=True)
    pp_a: Mapped[Optional[str]] = mapped_column(String, nullable=True, index=True)
    port_a: Mapped[Optional[str]] = mapped_column(String, nullable=True)
    eqx_port_a: Mapped[Optional[str]] = mapped_column(String, nullable=True)
    pp_1: Mapped[Optional[str]] = mapped_column(String, nullable=True, index=True)
    port_1: Mapped[Optional[str]] = mapped_column(String, nullable=True)
    eqx_port_1: Mapped[Optional[str]] = mapped_column(String, nullable=True)
    pp_2: Mapped[Optional[str]] = mapped_column(String, nullable=True, index=True)
    port_2: Mapped[Optional[str]] = mapped_column(String, nullable=True)
    eqx_port_2: Mapped[Optional[str]] = mapped_column(String, nullable=True)
    pp_z: Mapped[Optional[str]] = mapped_column(String, nullable=True, index=True)
    port_z: Mapped[Optional[str]] = mapped_column(String, nullable=True)
    eqx_port_z: Mapped[Optional[str]] = mapped_column(String, nullable=True)
    serial: Mapped[Optional[str]] = mapped_column(String, nullable=True, index=True)
    sales_order: Mapped[Optional[str]] = mapped_column(String, nullable=True, index=True)
    product_id: Mapped[Optional[str]] = mapped_column(String, nullable=True, index=True)
    looptest_successful: Mapped[Optional[str]] = mapped_column(String, nullable=True)
    created_by: Mapped[Optional[str]] = mapped_column(String, nullable=True)
    installation_date: Mapped[Optional[str]] = mapped_column(String, nullable=True)
    active_line: Mapped[Optional[str]] = mapped_column(String, nullable=True)
    internal_infos_ops: Mapped[Optional[str]] = mapped_column(String, nullable=True)
    raw_row_json: Mapped[Optional[Any]] = mapped_column(JSON, nullable=True)
