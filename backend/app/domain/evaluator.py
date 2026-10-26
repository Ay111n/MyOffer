"""报告管线编排（v5 三维评分）。

evaluate() 是对外唯一入口：输入 DecisionInput，输出 ReportOutputs
（三维对比报告 + 综合评分排序）。纯函数，无递归；计算细节见
domain/report_v5.py 与 domain/report.py。
"""
from __future__ import annotations

from app.domain.contracts import DecisionInput, ReportOutputs
from app.domain.report_v5 import build_report
from app.rules_runtime import RuleSet


def evaluate(inp: DecisionInput, rules: RuleSet) -> ReportOutputs:
    return build_report(inp, rules)
