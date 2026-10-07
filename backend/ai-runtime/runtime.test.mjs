import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { createServer } from 'node:http';
import test from 'node:test';
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai';
import { deepseekProvider } from '@earendil-works/pi-ai/providers/deepseek';
import { AiRuntime } from './runtime.mjs';

test('configured identities have a hard cap and expire; job history is bounded', async () => {
  const oldLimit = AiRuntime.USER_LIMIT;
  AiRuntime.USER_LIMIT = 2;
  const runtime = new AiRuntime([() => fakeProvider()]);
  try {
    for (const owner of ['alice', 'bob']) {
      await runtime.dispatch(owner, 'key', { provider: 'openai', key: 'test-key' });
    }
    await assert.rejects(runtime.dispatch('charlie', 'config'), { code: 'ai_capacity', status: 503 });
    runtime.users.get('alice').updatedAt = Date.now() - 3 * 86_400_000;
    await runtime.pruneIdleUsers();
    assert.equal(runtime.users.has('alice'), false);
    await runtime.dispatch('charlie', 'config');
    const user = runtime.user('bob');
    for (let i = 0; i < 30; i++) {
      const job = runtime.newJob(user, 'test', 'openai', 1000);
      clearTimeout(job.timer);
      job.status = 'succeeded';
    }
    assert.equal(user.jobs.size, AiRuntime.JOB_LIMIT);
  } finally {
    AiRuntime.USER_LIMIT = oldLimit;
    await runtime.close();
  }
});

function fakeProvider({ login, refresh } = {}) {
  const provider = openaiProvider();
  return { ...provider, auth: { ...provider.auth,
    oauth: { name: 'Test subscription', isSubscription: true,
      login: login ?? (async (interaction) => {
        interaction.notify({ type: 'auth_url', url: 'https://example.com/auth' });
        const code = await interaction.prompt({ type: 'manual_code', message: 'Code', signal: interaction.signal });
        if (code !== 'valid-code') throw new Error('401 invalid code: secret-upstream-token');
        return { type: 'oauth', access: 'secret-access', refresh: 'secret-refresh', expires: Date.now() + 3600_000 };
      }),
      refresh: refresh ?? (async (c) => ({ ...c, expires: Date.now() + 3600_000 })),
      toAuth: async (c) => ({ apiKey: c.access }),
    } } };
}

async function settled(runtime, owner, job) {
  for (let i = 0; i < 600; i++) {
    const current = await runtime.dispatch(owner, 'job', { id: job.id });
    if (current.status !== 'pending') return current;
    await delay(5);
  }
  throw new Error('Job did not finish');
}

test('credentials and selected model stay isolated; config never returns secrets', async () => {
  const runtime = new AiRuntime();
  try {
    await runtime.dispatch('alice', 'key', { provider: 'deepseek', key: 'private-api-key' });
    const config = await runtime.dispatch('alice', 'config');
    const model = config.providers.find((p) => p.id === 'deepseek').models[0].id;
    await runtime.dispatch('alice', 'select', { provider: 'deepseek', model });
    assert.equal((await runtime.dispatch('bob', 'config')).selected, null);
    assert.equal((await runtime.dispatch('bob', 'config')).providers.find((p) => p.id === 'deepseek').auth_type, null);
    assert(!JSON.stringify(await runtime.dispatch('alice', 'config')).includes('private-api-key'));
    const disconnected = await runtime.dispatch('alice', 'disconnect', { provider: 'deepseek' });
    assert.equal(disconnected.selected, null);
    await assert.rejects(runtime.dispatch('alice', 'select', { provider: 'deepseek', model }), { code: 'not_connected' });
    await assert.rejects(runtime.dispatch('alice', 'select', { provider: 'deepseek', model: 'made-up' }), { code: 'unknown_model' });
  } finally { await runtime.close(); }
});

test('OAuth resumes through prompts, enforces job ownership and clears callback data', async () => {
  const runtime = new AiRuntime([() => fakeProvider()]);
  try {
    const job = await runtime.dispatch('alice', 'login', { provider: 'openai' });
    await delay(10);
    const pending = await runtime.dispatch('alice', 'job', { id: job.id });
    assert.equal(pending.url, 'https://example.com/auth');
    await assert.rejects(runtime.dispatch('bob', 'job', { id: job.id }), { code: 'not_found' });
    await assert.rejects(runtime.dispatch('alice', 'reply', { id: job.id, prompt_id: 'stale', value: 'valid-code' }), { code: 'stale_prompt' });
    await runtime.dispatch('alice', 'reply', { id: job.id, prompt_id: pending.prompt.id, value: 'valid-code' });
    const done = await settled(runtime, 'alice', job);
    assert.equal(done.status, 'succeeded');
    assert.equal(done.prompt, null);
    assert.equal(done.url, null);
    const config = await runtime.dispatch('alice', 'config');
    assert.equal(config.providers[0].auth_type, 'oauth');
    assert(!JSON.stringify(config).includes('secret-'));
  } finally { await runtime.close(); }
});

test('cancel prevents late credential writes and releases shared callback port slot', async () => {
  const runtime = new AiRuntime([() => fakeProvider()]);
  try {
    const job = await runtime.dispatch('alice', 'login', { provider: 'openai' });
    await delay(10);
    await assert.rejects(runtime.dispatch('bob', 'login', { provider: 'openai' }), { code: 'oauth_busy' });
    assert.equal((await runtime.dispatch('alice', 'cancel', { id: job.id })).status, 'cancelled');
    assert.equal((await runtime.dispatch('alice', 'config')).providers[0].auth_type, null);
    const next = await runtime.dispatch('bob', 'login', { provider: 'openai' });
    await runtime.dispatch('bob', 'cancel', { id: next.id });
  } finally { await runtime.close(); }
});

test('OAuth refresh is serialized by pi-ai under concurrent requests', async () => {
  let count = 0;
  const runtime = new AiRuntime([() => fakeProvider({ refresh: async (c) => {
    count++; await delay(20); return { ...c, access: 'rotated-secret', expires: Date.now() + 3600_000 };
  } })]);
  try {
    const user = runtime.user('alice');
    await user.credentials.modify('openai', async () => ({ type: 'oauth', access: 'expired', refresh: 'refresh', expires: 0 }));
    const results = await Promise.all([user.models.getAuth('openai'), user.models.getAuth('openai')]);
    assert.equal(count, 1);
    assert.equal(results[0].auth.apiKey, 'rotated-secret');
    assert.equal(results[1].auth.apiKey, 'rotated-secret');
  } finally { await runtime.close(); }
});

test('failed model call returns a safe error and records failure without altering selection', async () => {
  const runtime = new AiRuntime([() => fakeProvider()]);
  try {
    const user = runtime.user('alice');
    await runtime.dispatch('alice', 'key', { provider: 'openai', key: 'private-key' });
    const model = user.models.getModels('openai')[0].id;
    await runtime.dispatch('alice', 'select', { provider: 'openai', model });
    user.models.completeSimple = async () => ({ stopReason: 'error', content: [], errorMessage: '401 private-key' });
    const job = await runtime.dispatch('alice', 'test', { provider: 'openai', model });
    const result = await settled(runtime, 'alice', job);
    assert.equal(result.status, 'failed');
    assert(!JSON.stringify(result).includes('private-key'));
    assert.equal((await runtime.dispatch('alice', 'config')).providers[0].last_check.ok, false);
    assert.equal((await runtime.dispatch('alice', 'config')).selected.model, model);
    user.models.completeSimple = async () => ({ stopReason: 'stop', content: [{ type: 'text', text: 'OK' }] });
    const success = await runtime.dispatch('alice', 'test', { provider: 'openai', model });
    assert.equal((await settled(runtime, 'alice', success)).status, 'succeeded');
  } finally { await runtime.close(); }
});

test('server environment keys are not used as browser credentials', async () => {
  const old = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'server-private-key';
  const runtime = new AiRuntime();
  try { assert.equal(await runtime.user('alice').models.getAuth('openai'), undefined); }
  finally {
    await runtime.close();
    if (old === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = old;
  }
});

test('real pi-ai adapter sends the stored key and fixed probe through HTTP and parses SSE', async () => {
  let captured;
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    captured = { path: request.url, key: request.headers.authorization, body: JSON.parse(body) };
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end('data: ' + JSON.stringify({ id: 'probe', object: 'chat.completion.chunk',
      choices: [{ index: 0, delta: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
  const runtime = new AiRuntime([() => {
    const provider = deepseekProvider();
    return { ...provider, getModels: () => provider.getModels().map((m) => ({ ...m, baseUrl })) };
  }]);
  try {
    await runtime.dispatch('alice', 'key', { provider: 'deepseek', key: 'test-only-key' });
    const model = runtime.user('alice').models.getModels('deepseek')[0].id;
    const job = await runtime.dispatch('alice', 'test', { provider: 'deepseek', model });
    assert.equal((await settled(runtime, 'alice', job)).status, 'succeeded');
    assert.equal(captured.path, '/v1/chat/completions');
    assert.equal(captured.key, 'Bearer test-only-key');
    assert.equal(captured.body.model, model);
    assert.equal(captured.body.messages.at(-1).content, 'Reply with the single word OK.');
    assert(!JSON.stringify(captured.body).includes('Offer'));
  } finally {
    await runtime.close();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('each report section starts one independent, owner-scoped model call', async () => {
  const runtime = new AiRuntime([() => fakeProvider()]);
  try {
    await runtime.dispatch('alice', 'key', { provider: 'openai', key: 'private-key' });
    const user = runtime.user('alice');
    const model = user.models.getModels('openai')[0].id;
    await runtime.dispatch('alice', 'select', { provider: 'openai', model });
    const prompts = [];
    user.models.completeSimple = async (_model, context) => {
      prompts.push(context.messages[0].content);
      return { stopReason: 'stop', content: [{ type: 'text', text: `分析 ${prompts.length}` }] };
    };
    const report = {
      snapshot_seq: 7, weights: { economic: 0.5, growth: 0.3, experience: 0.2 },
      offers: [
        { label: 'Offer A', overall_score: 82,
          dimension_scores: { economic: 88, growth: 72, experience: 80 },
          score_contributions: { economic: 44, growth: 21.6, experience: 16 },
          sub_scores: { 'economic.cash': 90, 'growth.skills': 70, 'experience.rest': 80 },
          sub_metrics: { 'economic.recurring_net': 300000, 'experience.rest_days_weekly': 2 } },
        { label: 'Offer B', overall_score: 78,
          dimension_scores: { economic: 76, growth: 86, experience: 75 },
          score_contributions: { economic: 38, growth: 25.8, experience: 15 },
          sub_scores: { 'economic.cash': 75, 'growth.skills': 88, 'experience.rest': 75 },
          sub_metrics: { 'economic.recurring_net': 260000, 'experience.rest_days_weekly': 1 } },
      ],
    };
    const finished = [];
    for (const part of ['overall', 'economic', 'growth', 'experience']) {
      const job = await runtime.dispatch('alice', 'analyze', { report, part });
      await assert.rejects(runtime.dispatch('bob', 'job', { id: job.id }), { code: 'not_found' });
      const done = await settled(runtime, 'alice', job);
      assert.equal(done.status, 'succeeded');
      assert.equal(done.snapshot_seq, 7);
      assert.equal(done.stage, part);
      assert.deepEqual(Object.keys(done.sections), [part]);
      finished.push(done);
    }
    assert.equal(prompts.length, 4);
    assert(prompts[0].includes('总体'));
    assert(prompts[1].includes('经济回报'));
    assert(prompts[2].includes('职业成长'));
    assert(prompts[3].includes('工作体验'));
    const evidence = prompts.map((prompt) => JSON.parse(prompt.split('报告依据：')[1]));
    assert.equal(evidence[0].offers[0].score_contributions.economic, 44);
    assert.equal(evidence[1].offers[0].dimension_score, 88);
    assert.equal(evidence[1].offers[0].sub_metrics['economic.recurring_net'], 300000);
    assert(!JSON.stringify(evidence[1]).includes('growth.skills'));
    assert.equal(evidence[2].offers[1].sub_scores['growth.skills'], 88);
    assert(!JSON.stringify(evidence[2]).includes('economic.recurring_net'));
    assert.equal(evidence[3].offers[0].sub_metrics['experience.rest_days_weekly'], 2);
    assert(!JSON.stringify(finished).includes('private-key'));
    await assert.rejects(runtime.dispatch('alice', 'analyze', { report, part: 'other' }), { code: 'invalid_part' });
  } finally { await runtime.close(); }
});

test('one section sends one grounded prompt through the real pi-ai HTTP adapter', async () => {
  const requests = [];
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    requests.push(JSON.parse(body));
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end('data: ' + JSON.stringify({ id: `analysis-${requests.length}`,
      object: 'chat.completion.chunk',
      choices: [{ index: 0, delta: { role: 'assistant', content: `第${requests.length}份分析` },
        finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
  const runtime = new AiRuntime([() => {
    const provider = deepseekProvider();
    return { ...provider, getModels: () => provider.getModels().map((m) => ({ ...m, baseUrl })) };
  }]);
  try {
    await runtime.dispatch('alice', 'key', { provider: 'deepseek', key: 'local-only-key' });
    const model = runtime.user('alice').models.getModels('deepseek')[0].id;
    await runtime.dispatch('alice', 'select', { provider: 'deepseek', model });
    const job = await runtime.dispatch('alice', 'analyze', { part: 'economic', report: {
      snapshot_seq: 3, weights: { economic: 0.34, growth: 0.33, experience: 0.33 },
      offers: [{ label: 'Offer A', city: '北京', overall_score: 75 },
        { label: 'Offer B', city: '成都', overall_score: 73 }],
    } });
    const done = await settled(runtime, 'alice', job);
    assert.equal(done.status, 'succeeded');
    assert.equal(requests.length, 1);
    assert(requests.every((item) => item.messages.some((message) => message.role === 'system')));
    assert(requests[0].messages.at(-1).content.includes('经济回报'));
    assert.equal(done.stage, 'economic');
    assert.deepEqual(Object.keys(done.sections), ['economic']);
  } finally {
    await runtime.close();
    await new Promise((resolve) => server.close(resolve));
  }
});
