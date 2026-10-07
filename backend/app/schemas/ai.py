from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, SecretStr, field_validator


class AiModel(BaseModel):
    id: str
    name: str
    context_window: int
    reasoning: bool
    vision: bool


class AiSelection(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    provider: str = Field(min_length=1, max_length=100)
    model: str = Field(min_length=1, max_length=200)


class AiCheck(BaseModel):
    model: str
    ok: bool
    checked_at: str


class AiPromptOption(BaseModel):
    id: str
    label: str
    description: str | None = None


class AiPrompt(BaseModel):
    id: str
    type: Literal["text", "secret", "select", "manual_code"]
    message: str
    options: list[AiPromptOption] | None = None


class AiJob(BaseModel):
    id: str
    kind: Literal["login", "test", "analysis"]
    provider: str
    model: str | None = None
    status: Literal["pending", "succeeded", "failed", "cancelled"]
    url: str | None = None
    user_code: str | None = None
    message: str | None = None
    prompt: AiPrompt | None = None
    expires_at: str
    snapshot_seq: int | None = None
    stage: Literal["overall", "economic", "growth", "experience"] | None = None
    sections: dict[str, str] = Field(default_factory=dict)


class AiProvider(BaseModel):
    id: str
    name: str
    api_key: bool
    oauth: bool
    subscription: bool
    auth_type: Literal["api_key", "oauth"] | None = None
    models: list[AiModel]
    last_check: AiCheck | None = None


class AiConfig(BaseModel):
    storage: Literal["memory"]
    selected: AiSelection | None = None
    providers: list[AiProvider]
    active_jobs: list[AiJob]


class AiConfigResponse(BaseModel):
    data: AiConfig


class AiJobResponse(BaseModel):
    data: AiJob


class AiReportRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    snapshot_seq: int = Field(ge=1)
    part: Literal["overall", "economic", "growth", "experience"]


class AiKeyRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    api_key: SecretStr = Field(json_schema_extra={"writeOnly": True})

    @field_validator("api_key")
    @classmethod
    def valid_key(cls, value: SecretStr) -> SecretStr:
        key = value.get_secret_value().strip()
        if not key or len(key) > 4096 or "\n" in key or "\r" in key:
            raise ValueError("请填写有效的 API Key。")
        return SecretStr(key)


class AiReplyRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    prompt_id: str = Field(min_length=1, max_length=100)
    value: SecretStr = Field(json_schema_extra={"writeOnly": True})

    @field_validator("value")
    @classmethod
    def valid_value(cls, value: SecretStr) -> SecretStr:
        text = value.get_secret_value().strip()
        if not text or len(text) > 8192:
            raise ValueError("请填写授权码、回调地址或选择授权选项。")
        return SecretStr(text)
