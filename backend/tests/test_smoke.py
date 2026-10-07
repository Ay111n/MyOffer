from fastapi.testclient import TestClient

from app.main import app
from app.rules_runtime import get_rules


def test_health():
    r=TestClient(app).get('/healthz'); assert r.status_code==200 and r.json()['status']=='ok' and 'rules_synced' in r.json()
def test_openapi_contains_workflow_endpoints():
    paths=app.openapi()['paths']; assert '/api/v1/sessions/{sid}/questions/{question_key}/answers' in paths; assert '/api/v1/sessions/{sid}/result' in paths
def test_rules_load():
    rules=get_rules(); assert rules.version
    assert len(rules.fields) > 0
    assert set(rules.report['decision_dimensions']) == {'economic','growth','experience'}
    assert rules.report['tax']['cumulative_brackets'][-1]['upper'] is None

def test_rule_references_align():
    rules=get_rules()
    field_keys=set(rules.fields)-{'meta'}
    questions=rules.questions.get('questions',{})
    for q in questions.values():
        assert set(q.get('outputs',[])) <= field_keys
        if q.get('options_from'):
            assert q['options_from'] in field_keys
    # 五险一金费率表：每个支持城市必须有个人/单位两组费率
    cities=rules.data['city_index']['cities']
    for city, cfg in cities.items():
        assert set(cfg['social_insurance']['personal']) == {'medical','pension','unemployment'}, city
        assert set(cfg['social_insurance']['employer']) >= {'medical','pension','unemployment','maternity','injury'}, city


def test_meta_city_tiers_match_universe():
    """城市线级标签（city_index tier 键）经 /meta 下发：键集与 supported_cities
    一致、值合法——前端下拉分组的数据源契约，禁止前端另写一份分组表。"""
    rules = get_rules()
    with TestClient(app) as client:
        r = client.get("/api/v1/meta")
        assert r.status_code == 200
        tiers = r.json()["data"]["city_tiers"]

    assert set(tiers) == set(rules.supported_cities)
    assert set(tiers.values()) <= {"一线", "新一线", "二线", "三线", "四线", "五线"}
    assert tiers["北京"] == "一线"
    assert tiers["拉萨"] == "五线"


def test_meta_field_rules_match_registry():
    """F8 契约锁：/meta field_rules 必须与 fields.yaml 一致——前端输入上限
    曾手抄一份（FIELD_MAX）无同步机制，规则调整后必然漂移。"""
    rules = get_rules()
    with TestClient(app) as client:
        r = client.get("/api/v1/meta")
        assert r.status_code == 200
        field_rules = r.json()["data"]["field_rules"]

    assert field_rules["required_core_fields"] == sorted(
        k for k, s in rules.fields.items()
        if k != "meta" and isinstance(s, dict) and s.get("required_level") == "core")
    assert "city" in field_rules["required_core_fields"]

    bounds = field_rules["bounds"]
    for key in bounds:
        declared = rules.fields[key]
        assert bounds[key] == {"min": declared.get("min"), "max": declared.get("max")}
    # 抽查与 fields.yaml 声明的锚点（前端 FIELD_MAX 兜底值与其一致）
    assert bounds["monthly_base"]["max"] == 1_000_000
    assert bounds["guaranteed_salary_months"]["max"] == 16
    # 非数值字段不进 bounds
    assert "city" not in bounds and "meal_plan" not in bounds
