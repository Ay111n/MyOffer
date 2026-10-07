import { createInterface } from 'node:readline';
import { AiError, AiRuntime } from './runtime.mjs';

const runtime = new AiRuntime();
const input = createInterface({ input: process.stdin, terminal: false });
// stdout is exclusively framed RPC responses. SDK logging must never enter it.
console.log = console.info = console.warn = console.error = () => {};
input.on('line', async (line) => {
  let request;
  try {
    request = JSON.parse(line);
    const data = await runtime.dispatch(request.owner, request.op, request.args);
    process.stdout.write(JSON.stringify({ id: request.id, data }) + '\n');
  } catch (error) {
    if (!(error instanceof AiError)) {
      // 诊断只输出异常类别，不把 SDK 原始消息、请求或凭据写入日志。
      const type = ['Error', 'TypeError', 'SyntaxError', 'ReferenceError', 'RangeError']
        .includes(error?.name) ? error.name : 'Error';
      process.stderr.write(`${type}: unexpected bridge failure\n`);
    }
    const safe = error instanceof AiError ? error : new AiError('ai_error', '模型服务暂不可用，请重试。', 503);
    process.stdout.write(JSON.stringify({ id: request?.id,
      error: { code: safe.code, message: safe.message, status: safe.status } }) + '\n');
  }
});
input.on('close', async () => { await runtime.close(); process.exit(0); });
