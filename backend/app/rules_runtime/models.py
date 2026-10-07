from pathlib import Path
from typing import Any

import yaml
from pydantic import BaseModel, Field


class RuleSet(BaseModel):
    version: str
    meta: dict[str, Any]
    fields: dict[str, Any]
    questions: dict[str, Any]
    report: dict[str, Any]
    reliability: dict[str, Any]
    preferences: dict[str, Any]
    data: dict[str, Any] = Field(default_factory=dict)

    @classmethod
    def load(cls, root: Path) -> "RuleSet":
        def y(name):
            return yaml.safe_load((root / name).read_text(encoding="utf-8")) or {}

        meta = y("meta.yaml")
        data = {}
        data_dir = root / "data"
        if data_dir.is_dir():
            for p in sorted(data_dir.glob("*.yaml")):
                data[p.stem] = yaml.safe_load(p.read_text(encoding="utf-8")) or {}
        return cls(
            version=str(meta["rule_version"]),
            meta=meta,
            fields=y("fields.yaml"),
            questions=y("questions.yaml"),
            report=y("report.yaml"),
            reliability=y("reliability.yaml"),
            preferences=y("preferences.yaml"),
            data=data,
        )

    # ── 类型化访问助手（domain 层使用，避免散落的 dict 取值）─────────
    def field(self, key: str) -> dict[str, Any] | None:
        return self.fields.get(key)

    def question_areas(self) -> dict[str, Any]:
        """问题板块定义（label/round/description）。"""
        return self.questions.get("meta", {}).get("areas", {}) or {}

    def question_area_order(self) -> list[str]:
        return list(self.questions.get("meta", {}).get("area_order", []) or [])

    def question_order(self) -> list[str]:
        return list(self.questions.get("meta", {}).get("question_order", []) or [])

    def default_weights(self) -> dict[str, float]:
        raw = self.preferences.get("default_weights", {}) or {}
        return {str(k): float(v) for k, v in raw.items()}

    def preference_questionnaire(self) -> dict[str, Any]:
        """价值观问卷定义（题目顺序与固定文案的唯一规则层出口）。"""
        return self.preferences.get("questionnaire_v2", {}) or {}

    def decision_dimensions(self) -> dict[str, Any]:
        """综合评分的决策维度定义（report.yaml decision_dimensions）。"""
        return self.report.get("decision_dimensions", {}) or {}

    def field_rules(self) -> dict[str, Any]:
        """字段注册表的 UI 契约出口（经 /meta 下发，前端不再手抄）。

        bounds：数值型字段声明的 min/max（前端输入上限曾手抄一份，无同步
        机制，规则调整后必然漂移）。未声明边界的字段不出现 = 后端同样无上限。
        required_core_fields：required_level=core 的字段（决策必需度口径，
        见 fields.yaml 注释——与前端"生成报告前 UI 引导必填"是两个概念）。
        """
        bounds: dict[str, dict[str, Any]] = {}
        required: list[str] = []
        for key, spec in self.fields.items():
            if key == "meta" or not isinstance(spec, dict):
                continue
            if spec.get("required_level") == "core":
                required.append(key)
            if spec.get("value_type") in ("money", "number", "percent"):
                lo, hi = spec.get("min"), spec.get("max")
                if lo is not None or hi is not None:
                    bounds[key] = {"min": lo, "max": hi}
        return {"required_core_fields": sorted(required), "bounds": bounds}

    @property
    def sources(self) -> dict[str, float]:
        return self.reliability.get("sources", {})

    @property
    def field_applicability(self) -> dict[str, dict[str, float]]:
        return self.reliability.get("field_applicability", {})

    def evidence_category(self, field_key: str) -> str:
        """字段的证据类别；未标注字段归入 general_fact（无适配系数，基础分原样生效）。"""
        spec = self.fields.get(field_key) or {}
        return str(spec.get("evidence_category", "general_fact"))

    def applicable_sources(self, field_key: str) -> list[str]:
        """字段按所属证据类别可选的来源集合（UI 裁剪用）；未定义类别时不限制。"""
        spec = self.fields.get(field_key) or {}
        cat = spec.get("evidence_category")
        table = self.fields.get("meta", {}).get("applicable_sources", {})
        return [str(s) for s in table.get(cat, [])]

    def fact_reliability(self, field_key: str, source: str) -> float:
        """可靠度 = 来源基础分 × 字段类别适配系数（稀疏表，缺省 1.0）。"""
        base = float(self.sources[source])
        appl = self.field_applicability.get(self.evidence_category(field_key), {}).get(source)
        return round(base * (float(appl) if appl is not None else 1.0), 2)

    def reference_values(self, ref: str) -> list[str]:
        """按「data文件名.键」解析 data/ 目录下的具名列表（如 city_index.supported_cities）。

        字段与约束参数的 allowed_from 白名单统一走这里；引用不存在或不是
        列表时返回空列表（由 validate_rules 的启动校验兜底报错）。
        """
        node: Any = self.data
        for part in ref.split("."):
            if not isinstance(node, dict) or part not in node:
                return []
            node = node[part]
        return [str(x) for x in node] if isinstance(node, list) else []

    @property
    def supported_cities(self) -> list[str]:
        """城市 universe：城市写入白名单与前端城市选项的唯一出处。"""
        return self.reference_values("city_index.supported_cities")

    @property
    def city_tiers(self) -> dict[str, str]:
        """城市 → 线级标签（city_index.yaml cities[].tier，2025 榜单口径）。

        /meta 下发给前端做城市下拉分组；启动校验保证 universe 内城市键齐全。"""
        cities = (self.data.get("city_index") or {}).get("cities") or {}
        return {name: str(cfg.get("tier", ""))
                for name, cfg in cities.items() if isinstance(cfg, dict)}
