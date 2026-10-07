from functools import lru_cache

from sqlalchemy import create_engine, event
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import StaticPool

from app.config import get_settings


@lru_cache
def get_engine():
    """所有比较状态只保存在进程内存，服务退出后自动清空。"""
    engine = create_engine(
        "sqlite+pysqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )

    @event.listens_for(engine, "connect")
    def enable_foreign_keys(connection, _record):
        cursor = connection.cursor()
        cursor.execute("PRAGMA foreign_keys=ON")
        page_size = cursor.execute("PRAGMA page_size").fetchone()[0]
        max_pages = get_settings().memory_db_max_mb * 1024 * 1024 // page_size
        cursor.execute(f"PRAGMA max_page_count={max_pages}")
        cursor.close()

    return engine

@lru_cache
def get_session_factory():
    return sessionmaker(bind=get_engine(), autoflush=False, expire_on_commit=False)

def get_db():
    db: Session = get_session_factory()()
    try:
        yield db
        # 身份续期与访问时间随成功请求提交；认证内部绝不另开共享连接事务。
        db.commit()
    finally:
        db.close()
