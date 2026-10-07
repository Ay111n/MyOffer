from functools import lru_cache

from pydantic import Field, field_validator, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

DEFAULT_SESSION_SECRET = "dev-only-change-me"


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=(".env", "../.env"), extra="ignore")
    # production 时强制安全护栏（见 _production_guardrails）
    env: str = "development"
    session_secret: str = DEFAULT_SESSION_SECRET
    cors_origins: str = "http://localhost:3000"
    rules_dir: str = "app/rules"

    cookie_secure: bool = False  # 生产环境（HTTPS）必须置 true
    # 生产 + HTTP（无证书）下的显式确认开关：会话 Cookie 不受 TLS 保护时，
    # 必须显式置 1 才允许启动，防止"忘了配 HTTPS"静默上线。
    allow_insecure_cookie: bool = False
    # ge=1：TTL ≤ 0 会让每个新签会话出生即过期，resolve_user 每请求 401、
    # 每次访问重建身份——像「登录永远失败」的配置事故，直接拒绝启动。
    session_ttl_days: int = Field(default=2, ge=1, le=2)
    max_sessions: int = Field(default=200, ge=1, le=500)
    max_identities: int = Field(default=200, ge=1, le=500)
    memory_db_max_mb: int = Field(default=96, ge=16, le=256)
    db_gate_timeout_seconds: float = Field(default=8.0, gt=0, le=30)
    log_level: str = "INFO"
    telemetry_enabled: bool = False
    telemetry_retention_hours: int = Field(default=24, ge=1, le=48)
    telemetry_max_per_session: int = Field(default=200, ge=1, le=1000)
    telemetry_max_total: int = Field(default=10000, ge=1, le=50000)

    # ── 进程内限流（单实例有效；多实例部署各实例独立计数）──
    rate_limit_sessions_per_minute: int = 30   # 匿名创建会话（按 client IP）
    rate_limit_telemetry_per_minute: int = 120  # 事件批量上报（按会话）

    @property
    def cors_origin_list(self) -> list[str]:
        return [x.strip() for x in self.cors_origins.split(',') if x.strip()]

    @field_validator("env", mode="before")
    @classmethod
    def _normalize_env(cls, value):
        # 大小写/首尾空格曾绕过生产护栏：ENV=Production 被当成 development，
        # 「默认 session secret / 非 secure cookie」的启动拦截全部失效
        return value.strip().lower() if isinstance(value, str) else value

    @model_validator(mode="after")
    def _production_guardrails(self):
        if self.env == "production" and (
            self.session_secret == DEFAULT_SESSION_SECRET
            or self.session_secret.startswith("REPLACE_ME")
            or len(self.session_secret) < 32
        ):
            raise ValueError(
                "SESSION_SECRET must be set explicitly when env=production "
                "(default value is not allowed in production)"
            )
        if self.env == "production" and not self.cookie_secure and not self.allow_insecure_cookie:
            raise ValueError(
                "COOKIE_SECURE=false in production requires ALLOW_INSECURE_COOKIE=1 "
                "(session cookies are sent without TLS protection)"
            )
        return self


@lru_cache
def get_settings() -> Settings:
    return Settings()
