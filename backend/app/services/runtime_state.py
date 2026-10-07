"""进程级运行状态（readiness）。

独立模块避免 main ↔ services 循环导入：main.lifespan 写入，
写路径在启动镜像尚未就绪时惰性补齐。
"""
rules_synced: bool = False
