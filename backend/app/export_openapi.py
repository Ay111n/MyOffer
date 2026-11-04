import json
import sys

from app.main import app

# stdout 显式固定 UTF-8：Windows 上 Python 的默认 stdout 编码跟随系统 ANSI 代码页
# （本机实测为 gbk/cp936），重定向到文件时会写出 GBK 字节；而 CI 在 Ubuntu 上
# 生成的是 UTF-8。两边编码不一致会让「现生成 vs 入库」的 diff 必然失败。
# 让生成结果与运行环境的 locale 无关，保证字节可复现。
sys.stdout.reconfigure(encoding="utf-8")

print(json.dumps(app.openapi(),ensure_ascii=False,indent=2))
