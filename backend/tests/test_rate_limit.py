"""进程内限流（单实例防护）。

注意：状态只在本进程内存中，多实例部署时各实例独立计数、不提供全局配额；
本轮范围明确不引入 Redis。
"""
from app.services.rate_limit import SlidingWindowLimiter


def test_allows_within_limit():
    limiter = SlidingWindowLimiter(max_events=3, window_seconds=60)
    assert all(limiter.hit("k") for _ in range(3))


def test_blocks_over_limit():
    limiter = SlidingWindowLimiter(max_events=2, window_seconds=60)
    assert limiter.hit("k")
    assert limiter.hit("k")
    assert not limiter.hit("k")
    # 其它 key 不受影响
    assert limiter.hit("other")


def test_window_slides():
    limiter = SlidingWindowLimiter(max_events=1, window_seconds=0.05)
    assert limiter.hit("k") is True
    assert limiter.hit("k") is False
    import time

    time.sleep(0.08)
    assert limiter.hit("k") is True


def test_keys_are_isolated():
    limiter = SlidingWindowLimiter(max_events=1, window_seconds=60)
    assert limiter.hit("a")
    assert not limiter.hit("a")
    assert limiter.hit("b")


def test_sweep_reclaims_empty_buckets():
    """回归：key 只增不减，窗口滑过后空桶会随会话/IP 数缓慢泄漏。"""
    import time

    limiter = SlidingWindowLimiter(max_events=1, window_seconds=0.05)
    limiter.hit("a")
    limiter.hit("b")
    assert len(limiter._events) == 2
    time.sleep(0.08)
    limiter.sweep()
    assert len(limiter._events) == 0
    # 自动回收：hit 内部按窗口周期触发 sweep
    limiter.hit("c")
    assert len(limiter._events) == 1
    time.sleep(0.08)
    limiter.hit("d")
    assert len(limiter._events) == 1  # 「c」的空桶已被周期性回收
