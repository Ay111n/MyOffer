"""进程内滑动窗口限流（单实例防护）。

注意：计数只保存在本进程内存中——多实例部署时各实例独立计数，
不提供全局配额；按本轮范围约定不引入 Redis 等外部依赖。
"""
from __future__ import annotations

import time
from collections import defaultdict, deque
from threading import Lock

from fastapi import HTTPException


class SlidingWindowLimiter:
    """按 key 的滑动窗口计数器（线程安全）。"""

    def __init__(self, max_events: int, window_seconds: float) -> None:
        self.max_events = max_events
        self.window_seconds = window_seconds
        self._events: dict[str, deque[float]] = defaultdict(deque)
        self._lock = Lock()
        self._last_sweep = 0.0

    def hit(self, key: str) -> bool:
        """记录一次事件；窗口内超过上限返回 False（且不记录）。"""
        now = time.monotonic()
        with self._lock:
            # 空桶回收至多每个窗口做一次：key 只增不减会随会话/IP 数缓慢泄漏
            if now - self._last_sweep >= self.window_seconds:
                self._sweep(now)
                self._last_sweep = now
            q = self._events[key]
            cutoff = now - self.window_seconds
            while q and q[0] <= cutoff:
                q.popleft()
            if len(q) >= self.max_events:
                return False
            q.append(now)
            return True

    def sweep(self) -> None:
        """立即清理过期条目并回收空桶（测试/运维可显式调用）。"""
        with self._lock:
            self._sweep(time.monotonic())

    def _sweep(self, now: float) -> None:
        """须持锁调用。"""
        cutoff = now - self.window_seconds
        for key in list(self._events):
            q = self._events[key]
            while q and q[0] <= cutoff:
                q.popleft()
            if not q:
                del self._events[key]


def enforce_rate_limit(limiter: SlidingWindowLimiter, key: str) -> None:
    """超限 → 429 统一错误包络。key 一般为 client IP 或 session_id。"""
    if not limiter.hit(key):
        raise HTTPException(
            status_code=429,
            detail={"code": "rate_limited", "message": "请求过于频繁，请稍后再试", "details": {}},
        )
