"""city_index.yaml v0.7.1 → v0.7.2：2026-10 首批数据复核落地。

来源：results_C_gd/ha/east/west.yaml（2026-10-25 联网采集，官方原文优先）。
- 省锚社保：广东 5521/27603（粤人社发〔2026〕24号）、河南 3912/19560
  （豫人社〔2026〕通知，gov.cn 转述）；深圳养老按省统一口径对齐。
- 25 城公积金更新至 2026 年度官方值；南通（2026 未公布）与衡阳（未查到
  新通知）沿用旧值，as_of 保持陈旧——启动警告继续提示，符合"取最旧口径"。
- as_of 重算口径与 merge_city_index.py 一致：min(省锚, hf, housing)。
- 行级替换，不重排既有 YAML；幂等：广州 as_of 已是 2026-07 时拒绝执行。
"""
import re
import sys
from pathlib import Path

import yaml

HERE = Path(__file__).resolve().parent
DATA = HERE.parents[2] / "backend/app/rules/data"
OUT = DATA / "city_index.yaml"

sys.path.insert(0, str(HERE.parents[2] / "backend"))

# 结果文件 → 城市更新载荷
SOURCES = ["results_C_gd.yaml", "results_C_ha.yaml", "results_C_east.yaml", "results_C_west.yaml"]
# 房价月份来自 v0.6 采集结果（as_of 合成的第三分量）
HOUSING_SOURCES = ["results_A1.yaml", "results_A2.yaml", "results_B1.yaml", "results_B2.yaml"]


def _month(ym: str) -> tuple:
    return tuple(int(x) for x in ym.split("-"))


def main() -> None:
    text = OUT.read_text(encoding="utf-8")
    lines = text.splitlines(keepends=True)

    updates: dict[str, dict] = {}
    for name in SOURCES:
        for city, item in (yaml.safe_load((HERE / name).read_text(encoding="utf-8")) or {}).items():
            updates[city] = {**item, "_from": name}
    # 深圳养老已执行广东省统一基数（results_C_gd.yaml base_note；粤人社发〔2026〕24号
    # 官方原文）。v0.6 旧值 4775/27549 口径不明（疑地方医疗口径），本次对齐省统一。
    updates["深圳"]["base_bounds"] = dict(updates["广州"]["base_bounds"])
    housing: dict[str, str] = {}
    for name in HOUSING_SOURCES:
        for city, item in (yaml.safe_load((HERE / name).read_text(encoding="utf-8")) or {}).items():
            if isinstance(item, dict) and item.get("housing_month"):
                housing[city] = item["housing_month"]

    # ── 逐城定位与替换 ────────────────────────────────────────────    # 省锚新 as_of（本次更新后的值，供 min 合成）
    ANCHOR_NEW = {"广州": "2026-07", "深圳": "2026-07", "郑州": "2026-07"}
    PROV_OF = {}
    for c in ["广州", "深圳", "东莞", "佛山", "惠州", "珠海", "中山", "汕头", "江门",
              "湛江", "揭阳", "肇庆", "茂名"]:
        PROV_OF[c] = "广东"
    for c in ["郑州", "洛阳", "新乡", "周口", "商丘", "信阳", "安阳", "驻马店", "南阳"]:
        PROV_OF[c] = "河南"
    # 其余省 → 锚点城市（EXPANSION_GUIDE.md 省级种子表），as_of 继承锚城市现值
    PROV_ANCHOR = {"浙江": "杭州", "江苏": "南京", "山东": "济南", "河北": "石家庄",
                   "广西": "南宁", "贵州": "贵阳", "四川": "成都", "湖北": "武汉",
                   "湖南": "长沙", "江西": "南昌", "福建": "福州", "安徽": "合肥",
                   "海南": "海口"}

    city_start: dict[str, int] = {}
    current = None
    for i, line in enumerate(lines):
        m = re.match(r"^  (\S+):\s*$", line)
        if m:
            current = m.group(1)
            city_start[current] = i
    assert "广州" in city_start and "郑州" in city_start, "未找到锚点城市节"

    # 各省锚城市的当前 as_of（广东/河南取新值，其余沿用现值）
    anchor_cur: dict[str, str] = {}
    for city, idx in city_start.items():
        m = re.search(r'as_of: "(\d{4}-\d{2})"', lines[idx + 2]) if idx + 2 < len(lines) else None
        if m:
            anchor_cur[city] = m.group(1)

    # 城市 → 省（锚城市自属本省；公积金 25 城逐城标注），供 as_of 继承省锚
    CITY_PROV: dict[str, str] = dict(PROV_OF)
    for prov, anchor_city in PROV_ANCHOR.items():
        CITY_PROV[anchor_city] = prov
    for c, prov in {"温州": "浙江", "常州": "江苏", "南通": "江苏", "烟台": "山东",
                    "潍坊": "山东", "济宁": "山东", "菏泽": "山东", "德州": "山东",
                    "泰安": "山东", "邯郸": "河北", "安庆": "安徽", "亳州": "安徽",
                    "六安": "安徽", "莆田": "福建", "宁德": "福建", "株洲": "湖南",
                    "衡阳": "湖南", "宜昌": "湖北", "荆州": "湖北", "黄冈": "湖北",
                    "九江": "江西", "宜春": "江西", "桂林": "广西", "柳州": "广西",
                    "遵义": "贵州", "绵阳": "四川", "三亚": "海南"}.items():
        CITY_PROV[c] = prov

    def new_as_of(city: str) -> str:
        if city in ANCHOR_NEW:
            return ANCHOR_NEW[city]
        prov = PROV_OF.get(city)
        cands = []
        if prov in ("广东", "河南"):
            cands.append("2026-07")
        else:
            # 非粤/豫城市：继承所在省锚点城市的 as_of（本次未动的省取现值）
            anchor_city = PROV_ANCHOR.get(CITY_PROV.get(city, ""), "")
            if anchor_city and anchor_city in anchor_cur:
                cands.append(anchor_cur[anchor_city])
        u = updates.get(city, {})
        if u.get("hf_as_of"):
            cands.append(u["hf_as_of"])
        if city in housing:
            cands.append(housing[city])
        return min(cands, key=_month)

    changed: list[str] = []
    # 遍历对象 = results_C 载荷城市 ∪ 粤/豫全部城市（省锚更新后非锚城市 as_of 随动）
    for city in sorted(set(updates) | set(PROV_OF)):
        idx = city_start[city]
        # 城市节范围 = 到下一个城市节开头
        nxt = min((v for v in city_start.values() if v > idx), default=len(lines))
        target_as_of = new_as_of(city)
        u = updates.get(city, {})
        touched = False
        hf_changed = False

        for j in range(idx, nxt):
            line = lines[j]
            m = re.match(r'^(\s*)as_of: "(\d{4}-\d{2})"', line)
            if m and m.group(2) != target_as_of:
                lines[j] = f'{m.group(1)}as_of: "{target_as_of}"\n'
                touched = True
            m = re.match(r"^(\s*)base_bounds: \{min: (\d+), max: (\d+)\}", line)
            if m and u.get("base_bounds"):
                nb = u["base_bounds"]
                if (int(m.group(2)), int(m.group(3))) != (nb["min"], nb["max"]):
                    lines[j] = f"{m.group(1)}base_bounds: {{min: {nb['min']}, max: {nb['max']}}}\n"
                    touched = True
            m = re.match(r"^(\s*)hf_bounds:(\s*)\{min: ([\d.]+), max: ([\d.]+)\}", line)
            if m and u.get("hf_bounds"):
                nb = u["hf_bounds"]
                if (float(m.group(3)), float(m.group(4))) != (float(nb["min"]), float(nb["max"])):
                    pad = m.group(2)
                    lo = int(nb["min"]) if float(nb["min"]).is_integer() else nb["min"]
                    hi = int(nb["max"]) if float(nb["max"]).is_integer() else nb["max"]
                    lines[j] = f"{m.group(1)}hf_bounds:{pad}{{min: {lo}, max: {hi}}}\n"
                    touched = True
                    hf_changed = True
            # 节尾注释：公积金数值变化的城市，重写"｜"后的数据说明（保留榜单前缀）
            m = re.match(r"^(\s*# 2025榜单[^｜]*｜)[^（]*(（来源与推断标注见 .*)$", line)
            if m and hf_changed:
                note = ("公积金 2026 年度官方值（2026-10 首批复核，明细见 update-2026-10.md"
                        f" 与 expansion/{u.get('_from', 'results_C.yaml')}）")
                lines[j] = f"{m.group(1)}{note}{m.group(2)}\n"
        if touched:
            changed.append(city)

    # 幂等守卫：没有任何变化且广州已是新值 → 已应用过
    gz_idx = city_start["广州"]
    if "2026-07" in lines[gz_idx + 2] and not changed:
        print("已应用过（广州 as_of 已是 2026-07 且无变更），退出。")
        return

    # ── meta 版本与说明 ──────────────────────────────────────────
    text2 = "".join(lines)
    if '  version: "0.7.1"' in text2:
        text2 = text2.replace('  version: "0.7.1"', '  version: "0.7.2"', 1)
    marker = "# 当前版本支持的城市 universe"
    assert marker in text2, "未找到 meta.status 块结束标记"
    if "v0.7.2（2026-10-25 首批数据复核）" not in text2:
        addition = (
            "    v0.7.2（2026-10-25 首批数据复核）：按 tools/city-data/update-2026-10.md "
            "更新广东/河南省级社保基数（5521/27603、3912/19560，2026-07 执行口径）与"
            "深圳养老省统一对齐，25 城公积金更新至 2026 年度官方值；南通（2026 年度"
            "未公布，且存量上限疑似偏低）、衡阳（未查到新通知）沿用旧值继续计入过期"
            "警告，待人工向两市公积金中心核实。逐城来源 URL 与旧→新对照见 "
            "update-2026-10.md 与 expansion/results_C_*.yaml。\n"
        )
        text2 = text2.replace(marker, addition + marker, 1)

    OUT.write_text(text2, encoding="utf-8")
    print(f"应用完成：{len(changed)} 城有行级变更")
    for c in changed:
        print("  -", c)
    # 未变更但属于本次复核对象的城市（沿用旧值）
    untouched = sorted(set(updates) - set(changed))
    if untouched:
        print("沿用旧值（as_of 不变）：", ", ".join(untouched))


if __name__ == "__main__":
    sys.exit(main())
