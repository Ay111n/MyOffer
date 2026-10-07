from __future__ import annotations

from datetime import datetime
from uuid import UUID, uuid4

from sqlalchemy import (
    JSON,
    Boolean,
    CheckConstraint,
    DateTime,
    ForeignKey,
    ForeignKeyConstraint,
    Index,
    Integer,
    Numeric,
    SmallInteger,
    String,
    Text,
    UniqueConstraint,
    Uuid,
    func,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base

uuid_col = Uuid(as_uuid=True)

def now_col(onupdate: bool = False):
    kw = {"onupdate": func.now()} if onupdate else {}
    return mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now(), **kw)

class User(Base):
    __tablename__ = "users"
    id: Mapped[UUID] = mapped_column(uuid_col, primary_key=True, default=uuid4)
    created_at: Mapped[datetime] = now_col(); updated_at: Mapped[datetime] = now_col(onupdate=True)

class AuthSession(Base):
    __tablename__ = "auth_sessions"
    id: Mapped[UUID] = mapped_column(uuid_col, primary_key=True, default=uuid4)
    user_id: Mapped[UUID] = mapped_column(uuid_col, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    token_hash: Mapped[str] = mapped_column(String(64), unique=True, nullable=False)
    created_at: Mapped[datetime] = now_col(); last_used_at: Mapped[datetime] = now_col()
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

class DecisionSession(Base):
    __tablename__ = "decision_sessions"
    __table_args__=(CheckConstraint("phase IN ('completion','results')", name="phase"),)
    id: Mapped[UUID] = mapped_column(uuid_col, primary_key=True, default=uuid4)
    user_id: Mapped[UUID] = mapped_column(uuid_col, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    title: Mapped[str | None] = mapped_column(Text)
    # v0.6 两环节模型：创建即进入 completion（Offer 录入页已移除）
    phase: Mapped[str] = mapped_column(String(20), nullable=False, server_default="completion")
    created_at: Mapped[datetime] = now_col(); updated_at: Mapped[datetime] = now_col(onupdate=True)

class Offer(Base):
    __tablename__="offers"
    __table_args__=(UniqueConstraint("session_id","display_order"), UniqueConstraint("id","session_id"))
    id: Mapped[UUID]=mapped_column(uuid_col,primary_key=True,default=uuid4)
    session_id: Mapped[UUID]=mapped_column(uuid_col,ForeignKey("decision_sessions.id",ondelete="CASCADE"),nullable=False)
    display_order: Mapped[int]=mapped_column(SmallInteger,nullable=False)
    # v0.6：公司/岗位选填，留空由服务端填默认值（公司N/岗位X）；
    # 部门/业务线字段已删除。
    company: Mapped[str]=mapped_column(Text,nullable=False); position: Mapped[str]=mapped_column(Text,nullable=False)
    version: Mapped[int]=mapped_column(Integer,nullable=False,server_default="1")
    created_at: Mapped[datetime]=now_col(); updated_at: Mapped[datetime]=now_col(onupdate=True)

class FieldDef(Base):
    __tablename__="field_defs"
    key: Mapped[str]=mapped_column(Text,primary_key=True)
    value_type: Mapped[str]=mapped_column(String(20),nullable=False); unit: Mapped[str|None]=mapped_column(Text)
    scope: Mapped[str]=mapped_column(String(20),nullable=False,server_default="offer")
    required_level: Mapped[str]=mapped_column(String(20),nullable=False,server_default="normal")
    metrics: Mapped[list]=mapped_column(JSON,nullable=False,server_default="[]")
    active: Mapped[bool]=mapped_column(Boolean,nullable=False,server_default="true")
    synced_at: Mapped[datetime]=now_col(); synced_rule_version: Mapped[str]=mapped_column(Text,nullable=False)

class QuestionDef(Base):
    __tablename__="question_defs"
    key: Mapped[str]=mapped_column(Text,primary_key=True); phase: Mapped[str]=mapped_column(String(20),nullable=False)
    comparison_mode: Mapped[str]=mapped_column(String(20),nullable=False); answer_type: Mapped[str]=mapped_column(String(20),nullable=False)
    priority_class: Mapped[str|None]=mapped_column(String(2)); answerability: Mapped[str|None]=mapped_column(String(10))
    active: Mapped[bool]=mapped_column(Boolean,nullable=False,server_default="true")
    synced_at: Mapped[datetime]=now_col(); synced_rule_version: Mapped[str]=mapped_column(Text,nullable=False)

class RawFact(Base):
    __tablename__="raw_facts"
    __table_args__=(
      UniqueConstraint("offer_id","field_key"),
      CheckConstraint("status IN ('known','unknown','need_confirmation','inferred','not_applicable')",name="status"),
      CheckConstraint("(status IN ('known','inferred') AND value IS NOT NULL AND reliability IS NOT NULL) OR (status='need_confirmation' AND reliability IS NOT NULL) OR (status IN ('unknown','not_applicable') AND value IS NULL AND reliability IS NULL)", name="status_value"),
      CheckConstraint("reliability IS NULL OR (reliability >= 0 AND reliability <= 1)",name="reliability_range"),
    )
    id: Mapped[UUID]=mapped_column(uuid_col,primary_key=True,default=uuid4)
    offer_id: Mapped[UUID]=mapped_column(uuid_col,ForeignKey("offers.id",ondelete="CASCADE"),nullable=False)
    field_key: Mapped[str]=mapped_column(Text,ForeignKey("field_defs.key"),nullable=False)
    # none_as_null：None 必须写 SQL NULL；status_value 检查约束要求 unknown 行 value IS NULL（JSON null 会违约）
    value: Mapped[object|None]=mapped_column(JSON(none_as_null=True)); status: Mapped[str]=mapped_column(String(20),nullable=False,server_default="known")
    source: Mapped[str]=mapped_column(String(30),nullable=False); reliability: Mapped[float|None]=mapped_column(Numeric(3,2))
    origin_question_key: Mapped[str|None]=mapped_column(Text,ForeignKey("question_defs.key")); note: Mapped[str|None]=mapped_column(Text)
    version: Mapped[int]=mapped_column(Integer,nullable=False,server_default="1")
    created_at: Mapped[datetime]=now_col(); updated_at: Mapped[datetime]=now_col(onupdate=True)

class UserPreference(Base):
    """v0.7：四维权重及其生成来源。

    当前运行时为进程内临时 SQLite；问卷答案与来源随最新偏好一起保留，
    便于结果解释与后续审计。"""
    __tablename__="user_preferences"
    id: Mapped[UUID]=mapped_column(uuid_col,primary_key=True,default=uuid4)
    session_id: Mapped[UUID]=mapped_column(uuid_col,ForeignKey("decision_sessions.id",ondelete="CASCADE"),nullable=False,unique=True)
    weights: Mapped[dict]=mapped_column(JSON,nullable=False)
    version: Mapped[int]=mapped_column(Integer,nullable=False,server_default="1")
    source: Mapped[str]=mapped_column(String(20),nullable=False,server_default="questionnaire")
    questionnaire_version: Mapped[str|None]=mapped_column(String(20))
    answers: Mapped[list]=mapped_column(JSON,nullable=False,server_default="[]")
    created_at: Mapped[datetime]=now_col(); updated_at: Mapped[datetime]=now_col(onupdate=True)

class QuestionState(Base):
    __tablename__="question_states"
    __table_args__=(
      CheckConstraint("status IN ('unanswered','answered','unknown','need_confirmation')",name="status"),
      ForeignKeyConstraint(["offer_id","session_id"],["offers.id","offers.session_id"],ondelete="CASCADE"),
    )
    id: Mapped[UUID]=mapped_column(uuid_col,primary_key=True,default=uuid4)
    session_id: Mapped[UUID]=mapped_column(uuid_col,ForeignKey("decision_sessions.id",ondelete="CASCADE"),nullable=False)
    question_key: Mapped[str]=mapped_column(Text,ForeignKey("question_defs.key"),nullable=False)
    offer_id: Mapped[UUID|None]=mapped_column(uuid_col); status: Mapped[str]=mapped_column(String(20),nullable=False,server_default="unanswered")
    answer: Mapped[dict|None]=mapped_column(JSON); answered_at: Mapped[datetime|None]=mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime]=now_col(); updated_at: Mapped[datetime]=now_col(onupdate=True)

class DueDiligenceItem(Base):
    __tablename__="due_diligence_items"
    __table_args__=(CheckConstraint("status IN ('open','done','dismissed')",name="status"),ForeignKeyConstraint(["offer_id","session_id"],["offers.id","offers.session_id"],ondelete="CASCADE"))
    id: Mapped[UUID]=mapped_column(uuid_col,primary_key=True,default=uuid4)
    session_id: Mapped[UUID]=mapped_column(uuid_col,ForeignKey("decision_sessions.id",ondelete="CASCADE"),nullable=False)
    offer_id: Mapped[UUID|None]=mapped_column(uuid_col); question_key: Mapped[str|None]=mapped_column(Text,ForeignKey("question_defs.key"))
    content: Mapped[str]=mapped_column(Text,nullable=False); suggested_source: Mapped[str|None]=mapped_column(String(30)); status: Mapped[str]=mapped_column(String(12),nullable=False,server_default="open")
    created_at: Mapped[datetime]=now_col(); updated_at: Mapped[datetime]=now_col(onupdate=True)

class DecisionResult(Base):
    __tablename__="decision_results"
    __table_args__=(UniqueConstraint("session_id","seq"),)
    id: Mapped[UUID]=mapped_column(uuid_col,primary_key=True,default=uuid4)
    session_id: Mapped[UUID]=mapped_column(uuid_col,ForeignKey("decision_sessions.id",ondelete="CASCADE"),nullable=False)
    seq: Mapped[int]=mapped_column(Integer,nullable=False); rule_version: Mapped[str]=mapped_column(Text,nullable=False)
    snapshot_schema_version: Mapped[int]=mapped_column(Integer,nullable=False,server_default="2"); trigger_type: Mapped[str]=mapped_column(String(30),nullable=False)
    payload: Mapped[dict]=mapped_column(JSON,nullable=False); created_at: Mapped[datetime]=now_col()

class TelemetryEvent(Base):
    """匿名行为事件。

    只存事件类型与白名单维度（step / question_key / tier / 计数等），
    绝不含 Offer 原文、事实值或外部凭证。session_id 无外键：事件为追加型
    分析数据，不随会话删除级联。payload 结构由 telemetry_service 白名单校验。
    """
    __tablename__="telemetry_events"
    id: Mapped[UUID]=mapped_column(uuid_col,primary_key=True,default=uuid4)
    session_id: Mapped[UUID|None]=mapped_column(uuid_col,nullable=True)
    event_type: Mapped[str]=mapped_column(String(40),nullable=False)
    payload: Mapped[dict]=mapped_column(JSON,nullable=False,server_default="{}")
    client_ts: Mapped[datetime|None]=mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime]=now_col()

Index("idx_decision_results_latest", DecisionResult.session_id, DecisionResult.seq.desc())
Index("idx_decision_results_rule", DecisionResult.rule_version, DecisionResult.trigger_type, DecisionResult.created_at)
Index("idx_raw_facts_uncertain", RawFact.offer_id)
Index("idx_due_diligence_session", DueDiligenceItem.session_id)
Index("idx_question_states_session_key", QuestionState.session_id, QuestionState.question_key)
Index("idx_telemetry_session_time", TelemetryEvent.session_id, TelemetryEvent.created_at)
Index("idx_telemetry_type", TelemetryEvent.event_type)
