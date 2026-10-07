"""Private stdio bridge to pi-ai. Credentials stay in the child process's memory."""
from __future__ import annotations

import atexit
import json
import logging
import queue
import re
import shutil
import subprocess
import threading
import time
from functools import lru_cache
from pathlib import Path
from uuid import uuid4

from fastapi import HTTPException

RUNTIME = Path(__file__).resolve().parents[2] / "ai-runtime"
logger = logging.getLogger("offer.ai")


class AiBridge:
    # 桥调用在全局 DbGate 内执行：单次超时会冻结所有端点。超时后的冷却窗口内
    # 快速失败，把「runtime 持续异常 + 每次页面加载重试」的冻结占空比压到
    # 每 30s 至多一次，而不是每次 AI 触点都阻塞一轮超时。
    CALL_TIMEOUT_SECONDS = 10.0
    WEDGE_COOLDOWN_SECONDS = 30.0

    def __init__(self):
        self._lock = threading.Lock()
        self._process: subprocess.Popen | None = None
        self._messages: queue.Queue = queue.Queue()
        self._wedged_until = 0.0

    def _start(self):
        node = shutil.which("node")
        if not node or not (RUNTIME / "node_modules/@earendil-works/pi-ai").is_dir():
            raise HTTPException(503, detail={
                "code": "ai_unavailable", "message": "模型接入服务未安装，请按项目说明安装 AI 运行依赖。",
            })
        self._messages = queue.Queue()
        self._process = subprocess.Popen(
            [node, str(RUNTIME / "bridge.mjs")], cwd=RUNTIME,
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            text=True, encoding="utf-8", bufsize=1,
            creationflags=subprocess.CREATE_NO_WINDOW if hasattr(subprocess, "CREATE_NO_WINDOW") else 0,
        )
        process, messages = self._process, self._messages

        def read():
            try:
                for line in process.stdout:
                    try:
                        message = json.loads(line)
                    except ValueError:
                        # 不记录原文：SDK 输出可能夹带凭据或用户文本。
                        logger.warning("pi-ai bridge skipped non-JSON stdout line (%d chars)", len(line))
                        continue
                    if not isinstance(message, dict) or "id" not in message:
                        logger.warning("pi-ai bridge skipped invalid response frame")
                        continue
                    messages.put(message)
            except (OSError, ValueError):
                logger.warning("pi-ai bridge stdout closed")
            finally:
                messages.put(None)

        threading.Thread(target=read, daemon=True, name="pi-ai-bridge").start()

        def read_errors():
            try:
                for line in process.stderr:
                    # 只输出 Node 崩溃诊断；不把 SDK 的任意输出直接写入日志。
                    category = re.match(r"^(Error|TypeError|SyntaxError|ReferenceError|RangeError)\b", line)
                    code = re.search(r"\b(ERR_[A-Z_]+)\b", line)
                    logger.error("pi-ai stderr: type=%s code=%s (%d chars; raw content omitted)",
                                 category[1] if category else "diagnostic",
                                 code[1] if code else "unknown", len(line))
            except (OSError, ValueError):
                pass

        threading.Thread(target=read_errors, daemon=True, name="pi-ai-stderr").start()

    def call(self, owner: str, op: str, args: dict | None = None) -> dict:
        with self._lock:
            if time.monotonic() < self._wedged_until:
                raise HTTPException(503, detail={
                    "code": "ai_unavailable", "message": "模型接入服务已中断，请刷新页面并重新连接。",
                })
            if self._process is None or self._process.poll() is not None:
                self._start()
            request_id = str(uuid4())
            try:
                self._process.stdin.write(json.dumps({
                    "id": request_id, "owner": owner, "op": op, "args": args or {},
                }, ensure_ascii=False) + "\n")
                self._process.stdin.flush()
                result = self._messages.get(timeout=self.CALL_TIMEOUT_SECONDS)
                if result is None or result.get("id") != request_id:
                    raise OSError("Bridge stopped")
            except (OSError, queue.Empty):
                logger.error("pi-ai bridge interrupted (exit=%s, operation=%s)",
                             self._process.poll(), op)
                self._stop()
                self._wedged_until = time.monotonic() + self.WEDGE_COOLDOWN_SECONDS
                raise HTTPException(503, detail={
                    "code": "ai_unavailable", "message": "模型接入服务已中断，请刷新页面并重新连接。",
                }) from None
            if "error" in result:
                error = result["error"]
                raise HTTPException(error["status"], detail={
                    "code": error["code"], "message": error["message"],
                })
            return result["data"]

    def _stop(self):
        if self._process is not None:
            if self._process.poll() is None:
                self._process.terminate()
                try:
                    self._process.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    self._process.kill()
                    self._process.wait()
            for stream in (self._process.stdin, self._process.stdout, self._process.stderr):
                if stream:
                    stream.close()
            self._process = None

    def close(self):
        with self._lock:
            self._stop()


@lru_cache
def get_bridge() -> AiBridge:
    bridge = AiBridge()
    atexit.register(bridge.close)
    return bridge
