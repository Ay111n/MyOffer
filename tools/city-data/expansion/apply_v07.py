# -*- coding: utf-8 -*-
"""city_index.yaml v0.6 → v0.7：每城补 tier（线级标签）与 rent_deduction_monthly（租金扣除档）。

- tier：2025 第一财经榜单线级（一/新一/二/三线）+ 省会兜底西宁（四线）/拉萨（五线），
  /meta 以 city_tiers 下发供前端分组。
- rent_deduction_monthly（国发〔2018〕41号三档）：
  1500 = 直辖市 + 省会/首府 + 计划单列市（深圳/大连/青岛/宁波/厦门）；
  1100/800 = 其余地级市按"市辖区户籍人口是否超 100 万"，逐城联网核对
  （rent_tier_R1/R2.yaml，七普市辖区人口口径，边界城市双源确认）。
- 行插入式补键，不重排既有 YAML 与注释；幂等性：检测到已补键即拒绝执行。
"""
import re
import sys
from pathlib import Path

import yaml

sys.path.insert(0, str(Path(__file__).resolve().parents[3] / "backend"))  # backend/ 目录，供 import app.*

DATA = Path(__file__).resolve().parents[3] / "backend/app/rules/data"
OUT = DATA / "city_index.yaml"

# ── 1500 档（直辖市 + 省会/首府 + 计划单列市）─────────────────────
TIER_1500 = {
    # 直辖市
    "北京", "上海", "天津", "重庆",
    # 计划单列市
    "深圳", "大连", "青岛", "宁波", "厦门",
    # 省会/首府
    "石家庄", "太原", "呼和浩特", "沈阳", "长春", "哈尔滨", "南京", "杭州", "合肥",
    "福州", "南昌", "济南", "郑州", "武汉", "长沙", "广州", "南宁", "海口", "成都",
    "贵阳", "昆明", "拉萨", "西安", "兰州", "西宁", "银川", "乌鲁木齐",
}

# ── 每城线级标签（2025 第一财经榜单；西宁四线/拉萨五线为省会兜底）──
TIER_LABEL = {
    "一线": ["北京", "上海", "广州", "深圳"],
    "新一线": ["成都", "杭州", "重庆", "武汉", "苏州", "西安", "南京", "长沙", "郑州",
               "天津", "合肥", "青岛", "东莞", "宁波", "佛山"],
    "二线": ["济南", "无锡", "沈阳", "昆明", "福州", "厦门", "温州", "石家庄", "大连",
             "哈尔滨", "金华", "泉州", "南宁", "长春", "常州", "南昌", "南通", "贵阳",
             "嘉兴", "徐州", "惠州", "太原", "烟台", "临沂", "保定", "台州", "绍兴",
             "珠海", "洛阳", "潍坊"],
    "三线": ["乌鲁木齐", "兰州", "中山", "盐城", "海口", "扬州", "济宁", "湖州", "赣州",
             "邯郸", "南阳", "唐山", "芜湖", "阜阳", "廊坊", "汕头", "泰州", "呼和浩特",
             "镇江", "江门", "菏泽", "连云港", "沧州", "淄博", "新乡", "周口", "襄阳",
             "淮安", "商丘", "桂林", "咸阳", "上饶", "银川", "宿迁", "漳州", "遵义",
             "滁州", "绵阳", "宜昌", "威海", "湛江", "九江", "邢台", "揭阳", "三亚",
             "衡阳", "信阳", "泰安", "荆州", "肇庆", "蚌埠", "安阳", "安庆", "德州",
             "株洲", "莆田", "聊城", "驻马店", "岳阳", "亳州", "柳州", "宜春", "宿州",
             "黄冈", "六安", "常德", "宁德", "茂名", "马鞍山", "衢州"],
    "四线": ["西宁"],
    "五线": ["拉萨"],
}
CITY_TIER = {c: t for t, cs in TIER_LABEL.items() for c in cs}


def main() -> None:
    text = OUT.read_text(encoding="utf-8")
    doc = yaml.safe_load(text)
    cities: dict = doc["cities"]
    supported: list = doc["supported_cities"]
    assert len(supported) == 121, len(supported)
    # 幂等守卫查全部城市：只查首个城市时，部分补键的文件会漏检并插出重复键
    if any("tier" in cfg for cfg in cities.values()):
        raise SystemExit("已补过 tier 键，拒绝重复执行")

    # 租金档：1500 档 + 联网核对结果（R1/R2 批）
    rent_tier: dict[str, int] = {c: 1500 for c in TIER_1500}
    for name in ("rent_tier_R1.yaml", "rent_tier_R2.yaml"):
        path = Path(__file__).parent / name
        batch = yaml.safe_load(path.read_text(encoding="utf-8"))
        for city, cfg in batch.items():
            tier = int(cfg["tier"])
            if tier not in (1100, 800):
                raise SystemExit(f"{name}: {city} tier={tier} 非法（只允许 1100/800）")
            if city in TIER_1500:
                raise SystemExit(f"{name}: {city} 属 1500 档却出现在核对批次")
            rent_tier[city] = tier

    missing = [c for c in supported if c not in rent_tier]
    if missing:
        raise SystemExit(f"缺租金档判定: {missing}")

    # ── 行插入：tier 跟在 tier_score 后，rent_deduction_monthly 跟在 living 后 ──
    lines = text.split("\n")
    out: list[str] = []
    current: str | None = None
    inserted_tier = inserted_rent = 0
    for line in lines:
        out.append(line)
        m_tier = re.match(r"^  (\S+):$", line)
        if m_tier:
            current = m_tier.group(1)
            continue
        if current is None:
            continue
        if re.match(r"^    tier_score:", line):
            out.append(f'    tier: "{CITY_TIER[current]}"')
            inserted_tier += 1
        elif re.match(r"^    living:", line):
            out.append(f"    rent_deduction_monthly: {rent_tier[current]}")
            inserted_rent += 1

    assert inserted_tier == 121 and inserted_rent == 121, (inserted_tier, inserted_rent)

    # ── meta 版本与 status 追加 ──
    patched = "\n".join(out)
    # 版本替换前断言源状态：静默不替换会让产物停留在 0.6 版本号
    assert patched.count('  version: "0.6"') == 1, 'meta version 行缺失或不止一处'
    patched = patched.replace('  version: "0.6"', '  version: "0.7"', 1)
    anchor = "    2026-09 报价）；生活水平模块由平均工资（社保基数上限÷3）与物价系数推导。"
    assert anchor in patched
    patched = patched.replace(
        anchor,
        anchor + "\n"
        "    v0.7（2026-10）：每城新增 tier（2025 榜单线级标签，/meta city_tiers 下发，\n"
        "    供前端下拉分组）与 rent_deduction_monthly（住房租金专项附加扣除档值，\n"
        "    国发〔2018〕41号三档：1500 直辖市/省会/计划单列；1100/800 按市辖区户籍\n"
        "    人口是否超 100 万，85 城逐城联网核对见 rent_tier_R1/R2.yaml）。",
        1,
    )
    # 写盘前先对补丁文本做内存校验：值损伤（如 fmt 精度丢失）在覆盖文件前即被发现
    pre = yaml.safe_load(patched)
    for name, cfg in pre["cities"].items():
        assert cfg["tier"] == CITY_TIER[name], name
        assert cfg["rent_deduction_monthly"] == rent_tier[name], name
    OUT.write_text(patched, encoding="utf-8")

    # ── 终检：重新加载 + 校验器全绿 ──
    from app.rules_runtime.models import RuleSet
    from app.rules_runtime.validate import validate_rules
    root = DATA.parent
    rules = RuleSet.load(root)
    issues = validate_rules(rules)
    assert not issues, issues[:5]
    reloaded = yaml.safe_load(OUT.read_text(encoding="utf-8"))
    for name, cfg in reloaded["cities"].items():
        assert cfg["tier"] == CITY_TIER[name], name
        assert cfg["rent_deduction_monthly"] == rent_tier[name], name
    dist: dict = {}
    for cfg in reloaded["cities"].values():
        dist[cfg["rent_deduction_monthly"]] = dist.get(cfg["rent_deduction_monthly"], 0) + 1
    print(f"OK v0.7：121 城补齐 tier + rent_deduction_monthly；档位分布 {dist}")


if __name__ == "__main__":
    sys.exit(main())
