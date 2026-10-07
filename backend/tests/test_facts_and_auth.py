"""事实取值校验与认证哈希的纯逻辑测试（无需数据库）。"""
import pytest

from app.api.deps import COOKIE_NAME, hash_token
from app.rules_runtime import get_rules
from app.services.fact_validation import FactValidationError, validate_fact_value


def test_hash_token_deterministic():
    assert hash_token("abc") == hash_token("abc")
    assert hash_token("abc") != hash_token("abd")
    assert len(hash_token("abc")) == 64  # sha256 hex


def test_cookie_name():
    assert COOKIE_NAME == "offer_sid"


def test_enum_value_accepted():
    validate_fact_value(get_rules(), "weekend_pattern", "double_off")


def test_enum_value_rejected():
    with pytest.raises(FactValidationError) as e:
        validate_fact_value(get_rules(), "weekend_pattern", "triple_off")
    assert e.value.code == "invalid_option"


def test_money_accepts_number_only():
    validate_fact_value(get_rules(), "monthly_base", 18500)
    validate_fact_value(get_rules(), "monthly_base", 18500.5)
    with pytest.raises(FactValidationError) as e:
        validate_fact_value(get_rules(), "monthly_base", "18k")
    assert e.value.code == "invalid_number"
    with pytest.raises(FactValidationError) as e2:
        validate_fact_value(get_rules(), "monthly_base", True)  # bool 不是 number
    assert e2.value.code == "invalid_number"


def test_unknown_field_rejected():
    with pytest.raises(FactValidationError) as e:
        validate_fact_value(get_rules(), "not_a_field", 1)
    assert e.value.code == "unknown_field"


def test_text_field():
    validate_fact_value(get_rules(), "city", "北京")
    with pytest.raises(FactValidationError) as e:
        validate_fact_value(get_rules(), "city", "")
    assert e.value.code == "invalid_text"
