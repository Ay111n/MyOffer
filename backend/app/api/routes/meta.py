"""参考数据端点（无会话依赖，进程内规则缓存直读）。

GET /meta：规则层 reference data 的唯一 API 出口。前端 Offer 城市下拉、
偏好问卷题目顺序与固定文案、未做问卷时的默认权重都从这里读取，
禁止在客户端另写一份事实源。
"""
from fastapi import APIRouter

from app.rules_runtime import get_rules
from app.schemas import MetaResponse

router = APIRouter(prefix="/meta", tags=["meta"])


@router.get("", response_model=MetaResponse)
def get_meta():
    rules = get_rules()
    return MetaResponse(data={
        "supported_cities": rules.supported_cities,
        "city_tiers": rules.city_tiers,
        "preference_questionnaire": rules.preference_questionnaire(),
        "default_weights": rules.default_weights(),
        "field_rules": rules.field_rules(),
    })
