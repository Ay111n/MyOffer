"""跨事件循环的 FIFO 闸门。等待者通过 Future 唤醒，不轮询、不占线程池。"""
import asyncio
import threading
from collections import deque
from dataclasses import dataclass


@dataclass
class Waiter:
    loop: asyncio.AbstractEventLoop
    future: asyncio.Future
    granted: bool = False


class DbGate:
    def __init__(self):
        self._mutex = threading.Lock()
        self._busy = False
        self._waiters: deque[Waiter] = deque()

    async def acquire(self, timeout: float):
        loop = asyncio.get_running_loop()
        waiter = Waiter(loop, loop.create_future())
        with self._mutex:
            if not self._busy:
                self._busy = True
                return
            self._waiters.append(waiter)
        try:
            await asyncio.wait_for(asyncio.shield(waiter.future), timeout)
        except BaseException:
            with self._mutex:
                if waiter.granted:
                    self._release_locked()
                else:
                    self._waiters.remove(waiter)
            raise

    @staticmethod
    def _wake(waiter):
        if not waiter.future.done():
            waiter.future.set_result(None)

    def _release_locked(self):
        while self._waiters:
            waiter = self._waiters.popleft()
            try:
                waiter.loop.call_soon_threadsafe(self._wake, waiter)
            except RuntimeError:
                continue  # 嵌入式客户端的事件循环已关闭
            waiter.granted = True
            return
        self._busy = False

    def release(self):
        with self._mutex:
            self._release_locked()
