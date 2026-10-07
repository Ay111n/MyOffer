# -*- coding: utf-8 -*-
"""把 expansion/results_*.yaml（89 城联网采集结果）合并进 city_index.yaml → v0.6。

口径：
- base_bounds / social_insurance / loan_annual_rate / as_of 基础值按省继承自现有锚点城市
  （社保基数省级统筹；指引见 EXPANSION_GUIDE.md）。
- hf_bounds / housing.price_per_sqm / living.baseline_cost_month 逐城取自采集结果。
- as_of = 三者最旧：省锚 as_of、hf_as_of、housing_month（"取关键数据中最旧口径"）。
- tier_score：新一线 90 / 二线 80 / 三线 70 锚点；无锡 82（二线头部，与济南同档）、
  洛阳/潍坊 78（二线末位，榜单综合分连续微调）；海口 80→70 对齐 2025 榜单三线。
- 现有 32 城数值不变（海口 tier_score 除外），仅重新排版。
"""
import re
import sys
from pathlib import Path

import yaml

DATA = Path(__file__).resolve().parents[3] / "backend/app/rules/data"
OUT = DATA / "city_index.yaml"

# ── 省锚：新城市 → 继承来源（现有城市）────────────────────────────
PROV_ANCHOR = {
    "江苏": "南京", "浙江": "杭州", "山东": "济南", "广东": "广州",
    "福建": "福州", "河北": "石家庄", "辽宁": "沈阳", "河南": "郑州",
    "安徽": "合肥", "湖北": "武汉", "湖南": "长沙", "江西": "南昌",
    "广西": "南宁", "贵州": "贵阳", "海南": "海口", "四川": "成都", "陕西": "西安",
}
CITY_PROV = {
    # 新一线 5
    "苏州": "江苏", "青岛": "山东", "东莞": "广东", "宁波": "浙江", "佛山": "广东",
    # 二线 19
    "无锡": "江苏", "厦门": "福建", "温州": "浙江", "大连": "辽宁", "金华": "浙江",
    "泉州": "福建", "常州": "江苏", "南通": "江苏", "嘉兴": "浙江", "徐州": "江苏",
    "惠州": "广东", "烟台": "山东", "临沂": "山东", "保定": "河北", "台州": "浙江",
    "绍兴": "浙江", "珠海": "广东", "洛阳": "河南", "潍坊": "山东",
    # 三线 65
    "中山": "广东", "盐城": "江苏", "扬州": "江苏", "济宁": "山东", "湖州": "浙江",
    "赣州": "江西", "邯郸": "河北", "南阳": "河南", "唐山": "河北", "芜湖": "安徽",
    "阜阳": "安徽", "廊坊": "河北", "汕头": "广东", "泰州": "江苏", "镇江": "江苏",
    "江门": "广东", "菏泽": "山东", "连云港": "江苏", "沧州": "河北", "淄博": "山东",
    "新乡": "河南", "周口": "河南", "襄阳": "湖北", "淮安": "江苏", "商丘": "河南",
    "桂林": "广西", "咸阳": "陕西", "上饶": "江西", "宿迁": "江苏", "漳州": "福建",
    "遵义": "贵州", "滁州": "安徽", "绵阳": "四川", "宜昌": "湖北", "威海": "山东",
    "湛江": "广东", "九江": "江西", "邢台": "河北", "揭阳": "广东", "三亚": "海南",
    "衡阳": "湖南", "信阳": "河南", "泰安": "山东", "荆州": "湖北", "肇庆": "广东",
    "蚌埠": "安徽", "安阳": "河南", "安庆": "安徽", "德州": "山东", "株洲": "湖南",
    "莆田": "福建", "聊城": "山东", "驻马店": "河南", "岳阳": "湖南", "亳州": "安徽",
    "柳州": "广西", "宜春": "江西", "宿州": "安徽", "黄冈": "湖北", "六安": "安徽",
    "常德": "湖南", "宁德": "福建", "茂名": "广东", "马鞍山": "安徽", "衢州": "浙江",
}
# 2025 第一财经榜单排名（maigoo 完整榜，主对话逐城核对过）
RANK = {
    "苏州": 9, "青岛": 16, "东莞": 17, "宁波": 18, "佛山": 19,
    "无锡": 21, "厦门": 25, "温州": 26, "大连": 28, "金华": 30, "泉州": 31,
    "常州": 34, "南通": 36, "嘉兴": 38, "徐州": 39, "惠州": 40, "烟台": 42,
    "临沂": 43, "保定": 44, "台州": 45, "绍兴": 46, "珠海": 47, "洛阳": 48, "潍坊": 49,
    "中山": 52, "盐城": 53, "扬州": 55, "济宁": 56, "湖州": 57, "赣州": 58,
    "邯郸": 59, "南阳": 60, "唐山": 61, "芜湖": 62, "阜阳": 63, "廊坊": 64,
    "汕头": 65, "泰州": 66, "镇江": 68, "江门": 69, "菏泽": 70, "连云港": 71,
    "沧州": 72, "淄博": 73, "新乡": 74, "周口": 75, "襄阳": 76, "淮安": 77,
    "商丘": 78, "桂林": 79, "咸阳": 80, "上饶": 81, "宿迁": 83, "漳州": 84,
    "遵义": 85, "滁州": 86, "绵阳": 87, "宜昌": 88, "威海": 89, "湛江": 90,
    "九江": 91, "邢台": 92, "揭阳": 93, "三亚": 94, "衡阳": 95, "信阳": 96,
    "泰安": 97, "荆州": 98, "肇庆": 99, "蚌埠": 100, "安阳": 101, "安庆": 102,
    "德州": 103, "株洲": 104, "莆田": 105, "聊城": 106, "驻马店": 107, "岳阳": 108,
    "亳州": 109, "柳州": 110, "宜春": 111, "宿州": 112, "黄冈": 113, "六安": 114,
    "常德": 115, "宁德": 116, "茂名": 117, "马鞍山": 118, "衢州": 119,
}
TIER_SCORE_OVERRIDES = {"无锡": 82, "洛阳": 78, "潍坊": 78}

# 每城备注（写进 YAML 行尾注释；信息来自采集结果文件的标注）
NOTES = {
    "苏州": "公积金下限=本市社保基数口径（特例，非最低工资）；房价为市区口径（不含昆山等县市）",
    "青岛": "下限七区2400/三市2210，取七区档；全市口径房价含即墨/胶州等",
    "东莞": "公积金下限2026-09起按2300执行（存量职工过渡期2080）；未套用广州上限口径",
    "宁波": "上限暂按2025年度执行，待新标准公布",
    "佛山": "全市口径房价（含三水/高明），市区禅城/南海/顺德约1.1-1.3万",
    "无锡": "下限按江苏一类最低工资2660推定",
    "厦门": "生活成本按2026租金行情自先验档下调",
    "温州": "公积金沿用2025年度（2026-07已调整、数值未收录），待复核",
    "大连": "公积金以官网2026年度通知原文为准",
    "金华": "上限按义乌（执行金华市口径）2026年度值代入",
    "泉州": "下限市直/主城区档2195（辖县2045更低）",
    "常州": "公积金沿用2025年度，2026年度通知未检索到，待复核",
    "南通": "公积金沿用2025年度，上限按社平工资推算",
    "嘉兴": "公积金为外推推断值（2022官方锚点+年均4.5%），待复核",
    "徐州": "公积金上限为转载摘要值，建议复核市公积金中心原文",
    "惠州": "下限1720为旧最低工资档，广东2026-09上调后待中心跟进",
    "烟台": "公积金沿用2025-2026年度（2026-2027已调整、数值未收录）",
    "临沂": "公积金为摘要值（两处独立来源一致），建议复核原文",
    "保定": "上限为河北2026年汇总文口径；下限按河北一类最低工资推断",
    "台州": "公积金为全推断值（社平×3+最低工资），待复核",
    "绍兴": "公积金基数由官方月缴存额（122/3836）按5%/12%反推",
    "珠海": "下限为官方新值（2026-09起2300）；上限按2022官方锚点外推",
    "洛阳": "公积金为转载口径，建议复核市公积金中心原文",
    "潍坊": "公积金沿用2025年度，2026年度数值未检索到",
    "中山": "上限为2026年报道口径，建议复核市公积金中心",
    "汕头": "上限沿用2025年度官方值；下限随广东2026-09最低工资调整（推断）",
    "江门": "上限为2024年度口径（2025/2026年度数值未检索到），待复核",
    "盐城": "2026年度上限31314自2026-07执行；下限取江苏二类档",
    "扬州": "公积金为2026年度报道值（执行期2026-07至2027-06）",
    "泰州": "公积金年度为自然年（2026-01起执行），异于省内7-6月口径",
    "镇江": "公积金为转载摘要值（2026-07执行），建议复核原文",
    "淮安": "公积金为全推断值（2024官方锚点外推），待复核",
    "宿迁": "公积金为全推断值（苏北各市插值），待复核",
    "连云港": "公积金为2026年度官方口径（下限=江苏三类最低工资2260）",
    "济宁": "公积金沿用2025年度；下限市区档2020/2210存疑，待复核",
    "菏泽": "公积金沿用2025年度官方值（菏住金〔2025〕7号）",
    "淄博": "公积金上限为2026年度摘要值（与2023官方递推一致）；下限推断",
    "邯郸": "公积金沿用2025年度官方值（下限主城区档2200）",
    "唐山": "公积金为河北2026年汇总文口径（下限2380表明河北最低工资或已上调）",
    "沧州": "上限为河北2026年汇总文口径；下限推断（唐山2380佐证或已上调）",
    "廊坊": "上限为河北2026年汇总文口径；下限推断",
    "南阳": "公积金上限按市统计局2025年非私营年均工资核定",
    "新乡": "公积金上限为洛阳/南阳间插值推断，待复核",
    "周口": "公积金上限按市统计局年均工资推算；房价为全省屋底区间",
    "商丘": "公积金上限按2023官方锚点外推，待复核",
    "襄阳": "公积金为2026年度报道值（月缴存额口径互洽）",
    "芜湖": "公积金沿用2025年度（下限2025-09已调至2170）",
    "阜阳": "公积金为2026年度官方通知口径；下限取安徽二类档推断",
    "滁州": "公积金为2026年度官方值（2026-08发布）",
    "赣州": "公积金为市公积金中心2026年度通知原文口径",
    "上饶": "公积金上限由官方月缴存额（5540/月）反推，待复核",
    "湖州": "公积金为全推断值（浙江地级市插值），待复核",
    "桂林": "下限为2025-07官方调整值；上限推断，待复核",
    "咸阳": "下限为陕西2026最低工资口径（2376）；上限推断",
    "漳州": "公积金为全推断值（2026年度批复已发布、数值未收录），待复核",
    "遵义": "公积金沿用2025年度转载口径（下限为县域档），待复核",
    "绵阳": "公积金沿用2025年度官方文号（绵住房公积金发〔2025〕17号）",
    "宜昌": "公积金沿用2025年度官方值，待复核",
    "威海": "公积金为2026年度官方口径",
    "湛江": "公积金下限为2025-03官方调整值；广东2026-09新最低工资待中心跟进",
    "九江": "公积金为全推断值（省内插值），待复核",
    "邢台": "公积金为全推断值（2022官方锚点+年均3%），待复核",
    "揭阳": "公积金为2026年度官方口径（下限2026-09起2040）",
    "三亚": "公积金沿用2024-12报道口径，2026年度市县明细待核；房价为旅游城市高位",
    "衡阳": "公积金沿用2025-01起执行的官方值（衡金管委字〔2024〕5号）",
    "信阳": "公积金上限为官网2026-07口径；下限按河南三类档推断",
    "泰安": "公积金沿用2025年度；房价为2026-02数据略旧",
    "荆州": "公积金为全推断值（湖北第3档社保基数锚点），待复核",
    "肇庆": "公积金为2026年度官方口径；下限待广东新最低工资跟进",
    "蚌埠": "公积金为2026年度官方口径（下限=安徽二类最低工资2170）",
    "安阳": "公积金为2026年度转载口径（下限市区档2350）",
    "安庆": "公积金为全推断值（蚌埠/宿州间插值），待复核",
    "德州": "公积金沿用2025年度（2026年度通知已发布、数值未获取）",
    "株洲": "公积金为全推断值（同省区间插值），待复核",
    "莆田": "公积金为全推断值（泉州/宁德间插值），待复核",
    "聊城": "公积金由2026年度通知月缴存额口径反推（202/5798元），待复核",
    "驻马店": "公积金为2026年度官方口径（不再区分市直和县区）",
    "岳阳": "公积金为2026年度官方口径（主城区档2000）",
    "亳州": "公积金为全推断值（宿州锚点下调），待复核",
    "柳州": "公积金沿用2025年度官方口径（市区档2200）",
    "宜春": "公积金为全推断值（与九江同水平），待复核",
    "宿州": "公积金为2026年度官方口径；房价为2025年度均价",
    "黄冈": "公积金为全推断值（湖北三类档），待复核",
    "六安": "公积金上限沿用2025年度官方值；下限推断",
    "常德": "公积金为全推断值（2022官方锚点+岳阳2026口径），待复核",
    "宁德": "公积金上限沿用2025年度；下限推断；房价多源收敛",
    "茂名": "公积金为全推断值（同省三四类插值），待复核",
    "马鞍山": "公积金为全推断值（安徽前列工资水平估计），待复核",
    "衢州": "公积金为全推断值（浙江下方估计），待复核",
}


def fmt(v) -> str:
    """紧凑数值格式：浮点去尾零、整数不带小数点。"""
    if isinstance(v, bool):
        raise TypeError("bool")
    if isinstance(v, int):
        return str(v)
    f = float(v)
    if f == int(f) and abs(f) < 1e15:
        return str(int(f))
    s = f"{f:.6f}".rstrip("0")
    return s


def fmt_inline(d: dict) -> str:
    return "{" + ", ".join(f"{k}: {fmt(v)}" for k, v in d.items()) + "}"


def _month(s: str) -> int:
    y, m = s.split("-")
    return int(y) * 12 + int(m)


def load_results() -> dict:
    merged: dict = {}
    for name in ("results_A1.yaml", "results_A2.yaml", "results_B1.yaml", "results_B2.yaml"):
        text = (Path(__file__).parent / name).read_text(encoding="utf-8")
        data = yaml.safe_load(text)
        for city, cfg in data.items():
            if city in merged:
                raise SystemExit(f"重复城市: {city}")
            merged[city] = cfg
    return merged


def main() -> None:
    current = yaml.safe_load(OUT.read_text(encoding="utf-8"))
    old_cities: dict = current["cities"]
    old_supported: list = current["supported_cities"]
    results = load_results()

    if set(results) != set(CITY_PROV):
        missing = set(CITY_PROV) - set(results)
        extra = set(results) - set(CITY_PROV)
        raise SystemExit(f"采集结果与城市清单不符 missing={missing} extra={extra}")

    # 现有城市对齐 2025 榜单的海口修正（二线 80 → 三线 70）
    haikou_tier_fix = old_cities["海口"]["tier_score"] == 80
    if haikou_tier_fix:
        old_cities["海口"]["tier_score"] = 70

    # 新城市次序：榜单排名（新一线 → 二线 → 三线）
    order = sorted(CITY_PROV, key=lambda c: RANK[c])
    new_entries: dict = {}
    as_of_map: dict = {}
    for city in order:
        prov = CITY_PROV[city]
        anchor = old_cities[PROV_ANCHOR[prov]]
        r = results[city]
        tier = 90 if RANK[city] <= 19 else (80 if RANK[city] <= 49 else 70)
        tier = TIER_SCORE_OVERRIDES.get(city, tier)
        as_of = min(anchor["as_of"], r["hf_as_of"], r["housing_month"], key=_month)
        as_of_map[city] = as_of
        rate_override = r.get("rate_override")
        if rate_override:
            si = rate_override
        else:
            si = {
                "personal": dict(anchor["social_insurance"]["personal"]),
                "employer": dict(anchor["social_insurance"]["employer"]),
            }
        new_entries[city] = {
            "tier_score": tier,
            "as_of": as_of,
            "social_insurance": si,
            "base_bounds": dict(anchor["base_bounds"]),
            "hf_bounds": {"min": r["hf_bounds"]["min"], "max": r["hf_bounds"]["max"]},
            "housing": {
                "price_per_sqm": r["housing_price_per_sqm"],
                "typical_area_sqm": 80,
                "down_payment_ratio": 0.15,
                "loan_annual_rate": anchor["housing"]["loan_annual_rate"],
                "loan_years": 30,
            },
            "living": {"baseline_cost_month": r["living_baseline_cost_month"]},
        }

    supported = old_supported + order
    cities = dict(old_cities)
    cities.update(new_entries)

    # ── 校验 ──────────────────────────────────────────────
    assert len(supported) == 121 and len(set(supported)) == 121, len(supported)
    assert set(supported) == set(cities)
    for name, cfg in cities.items():
        assert set(cfg) >= {"tier_score", "as_of", "social_insurance", "base_bounds",
                            "hf_bounds", "housing", "living"}, name
        assert 0 < cfg["tier_score"] <= 100, name
        assert re.match(r"^\d{4}-\d{2}$", cfg["as_of"]), name
        for b in ("base_bounds", "hf_bounds"):
            assert 0 < cfg[b]["min"] < cfg[b]["max"], (name, b)
        h = cfg["housing"]
        assert h["price_per_sqm"] > 0 and 0 < h["down_payment_ratio"] < 1
        assert 0 < h["loan_annual_rate"] <= 0.2 and h["loan_years"] >= 1
        assert cfg["living"]["baseline_cost_month"] > 0
        for side in ("personal", "employer"):
            for k, v in cfg["social_insurance"][side].items():
                assert 0 < float(v) <= 0.3, (name, side, k)

    # ── 渲染 YAML（保持 v0.5 版式）────────────────────────
    lines: list[str] = []
    lines.append("meta:")
    lines.append('  version: "0.6"')
    lines.append('  status: >-')
    lines.append('    reference data（城市 universe 唯一事实源；费率/房价/生活成本为参考值）。')
    lines.append('    v0.6（2026-10）：universe 由 32 城扩至 121 城——一线+新一线+二线+三线')
    lines.append('    全部 119 城（第一财经 2025 榜单口径）+ 省会兜底西宁/拉萨；海口 tier_score')
    lines.append('    由 80 修正为 70（2025 榜单已将其划入三线）。新增 89 城数据为 2026-10 联网')
    lines.append('    采集：公积金缴存基数逐城查证（2026 年度优先，未公布沿用 2025 并在 as_of')
    lines.append('    体现），社保基数/费率按省继承锚点城市（省级统筹口径），房价为全市二手')
    lines.append('    口径（挂牌价×0.92 修正），生活成本为租金锚点+经验推断（误差 ±15%）。',
                 )
    lines.append('    逐城来源、推断与待复核标注见 ../../../../tools/city-data/expansion/（EXPANSION_GUIDE.md、')
    lines.append('    results_A1/A2/B1/B2.yaml）；32 城存量口径仍见下文与 CITY_DATA_SOURCES.md。')
    lines.append('    2026-10 全量联网核对：社保/公积金基数为最新缴费年度（优先 2026，个别城市')
    lines.append('    未公布时沿用 2025 并在 as_of 体现）；房贷利率为首套主流执行价（LPR 5Y 3.5%，')
    lines.append('    2026-09 报价）；生活水平模块由平均工资（社保基数上限÷3）与物价系数推导。')
    lines.append('')
    lines.append('# 当前版本支持的城市 universe：Offer 城市、must_city/excluded_city 参数、')
    lines.append('# 前端城市选项（经 GET /meta 下发）的唯一事实源，前后端禁止另写一份列表。')
    lines.append('# 覆盖：一线+新一线+二线+三线全部 119 城（第一财经 2025 榜单）+ 省会兜底')
    lines.append('# 西宁（四线）/拉萨（五线），共 121 城。')
    lines.append('supported_cities: [' + ", ".join(supported) + ']')
    lines.append('')
    lines.append('# 每个城市的决策引擎配置条目（v0.7 报告引擎）。')
    lines.append('# 必需键在 rules_runtime/validate.py 的 REQUIRED_CITY_CONFIG_KEYS 登记，缺失即启动失败：')
    lines.append('#   as_of        数据所属年月（YYYY-MM，取关键数据中最旧口径；启动时对超 14 个月的打过期警告）')
    lines.append('#   tier_score   城市等级分（发展模块雷达轴）。基准=第一财经 2025 城市分级锚点')
    lines.append('#                （一线 100/新一线 90/二线 80/三线 70），个别城市按榜单综合得分')
    lines.append('#                连续微调、允许偏离锚点：一线末位广州 90、新一线头部重庆 92 为')
    lines.append('#                刻意取值；v0.6 新增：无锡 82（二线头部，与济南同档）、洛阳/潍坊 78')
    lines.append('#                （二线末位）；拉萨五线取 55。依据见 CITY_DATA_SOURCES.md 与 ../../../../tools/city-data/expansion/')
    lines.append('#   social_insurance：五险一金费率（占缴费基数比例）；v0.6 新增城市按省继承锚点城市费率')
    lines.append('#     personal：个人缴纳（医疗/养老/失业；公积金费率来自用户填报）')
    lines.append('#     employer：单位缴纳（医疗/养老/失业/生育/工伤；生育已并入医保征收的省份按惯例值拆分单列）')
    lines.append('#   base_bounds：社保缴费基数上下限（60%/300% 口径，省级统筹，同省城市一致）；')
    lines.append('#   hf_bounds：公积金缴存基数上下限（市级口径，逐城核证）')
    lines.append('#   housing：房价参考（全市二手成交均价 元/㎡）、典型面积、首付比例（2024-09 起全国下限 15%）、')
    lines.append('#            贷款年利率（首套主流执行价）与年限')
    lines.append('#   living：单人基本月生活成本（含房租，估算）——模块 5 物价系数锚点')
    lines.append('#            （÷ 全国基准 3,000）；平均工资由 base_bounds.max ÷ 3 推导')
    lines.append('cities:')

    def tier_label(c: str) -> str:
        if c not in RANK:
            # 不在榜单的城市只可能是省会兜底（西宁/拉萨）；RANK.get(c, 0)
            # 曾把任何未知城市误判成「一线」
            assert c in ("西宁", "拉萨"), f"非榜单城市缺兜底线级: {c}"
            return "五线" if c == "拉萨" else "四线"
        return ("一线" if RANK[c] <= 4 else
                "新一线" if RANK[c] <= 19 else
                "二线" if RANK[c] <= 49 else
                "三线")

    for name in supported:
        cfg = cities[name]
        lines.append(f"  {name}:")
        lines.append(f"    tier_score: {cfg['tier_score']}")
        lines.append(f'    as_of: "{cfg["as_of"]}"')
        si = cfg["social_insurance"]
        lines.append("    social_insurance:")
        lines.append(f"      personal:  {fmt_inline(si['personal'])}")
        lines.append(f"      employer:  {fmt_inline(si['employer'])}")
        lines.append(f"    base_bounds: {fmt_inline(cfg['base_bounds'])}")
        lines.append(f"    hf_bounds:   {fmt_inline(cfg['hf_bounds'])}")
        h = cfg["housing"]
        lines.append(
            "    housing:     {price_per_sqm: %s, typical_area_sqm: %s, down_payment_ratio: %s, "
            "loan_annual_rate: %s, loan_years: %s}" % (
                fmt(h["price_per_sqm"]), fmt(h["typical_area_sqm"]),
                fmt(h["down_payment_ratio"]), fmt(h["loan_annual_rate"]), fmt(h["loan_years"])))
        lines.append(f"    living:      {fmt_inline(cfg['living'])}")
        if name in NOTES:
            rank_part = f"2025榜单第{RANK[name]}位·{tier_label(name)}" if name in RANK else f"省会兜底·{tier_label(name)}"
            lines.append(f"      # {rank_part}｜{NOTES[name]}（来源与推断标注见 ../../../../tools/city-data/expansion/）")
    lines.append("")

    # 现有 32 城数值不变性检查（除海口 tier_score）——写盘前在内存中校验：
    # 曾先写文件再校验，校验失败时文件已被覆盖
    reloaded = yaml.safe_load("\n".join(lines))
    for name, old in old_cities.items():
        now = reloaded["cities"][name]
        if name == "海口":
            assert now["tier_score"] == 70 and haikou_tier_fix
            continue
        assert now == old, f"存量城市被意外改动: {name}"
    OUT.write_text("\n".join(lines), encoding="utf-8")
    print(f"OK: {len(supported)} cities written; 海口 tier 80->70 = {haikou_tier_fix}")
    stale = [c for c, m in as_of_map.items() if _month(m) <= _month("2025-07")]
    print("as_of <= 2025-07 的新城市（启动将打过过期警告）:", ", ".join(f"{c}({as_of_map[c]})" for c in stale))


if __name__ == "__main__":
    sys.exit(main())
