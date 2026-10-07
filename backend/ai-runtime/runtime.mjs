import { randomUUID } from 'node:crypto';
import { createModels } from '@earendil-works/pi-ai/models';
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai';
import { anthropicProvider } from '@earendil-works/pi-ai/providers/anthropic';
import { githubCopilotProvider } from '@earendil-works/pi-ai/providers/github-copilot';
import { googleProvider } from '@earendil-works/pi-ai/providers/google';
import { deepseekProvider } from '@earendil-works/pi-ai/providers/deepseek';
import { openrouterProvider } from '@earendil-works/pi-ai/providers/openrouter';
import { zaiProvider } from '@earendil-works/pi-ai/providers/zai';
import { kimiCodingProvider } from '@earendil-works/pi-ai/providers/kimi-coding';

const factories = [openaiProvider, anthropicProvider, githubCopilotProvider, googleProvider,
  deepseekProvider, openrouterProvider, zaiProvider, kimiCodingProvider];
const labels = { openai: 'OpenAI / ChatGPT', anthropic: 'Anthropic / Claude',
  'github-copilot': 'GitHub Copilot', google: 'Google Gemini', deepseek: 'DeepSeek',
  openrouter: 'OpenRouter', zai: 'GLM Coding Plan', 'kimi-coding': 'Kimi For Coding' };
const terminal = new Set(['succeeded', 'failed', 'cancelled']);
const analysisParts = [
  ['overall', '总体', '找出真正拉开综合分的加权贡献，并说明是否存在另一份 Offer 在某个维度更好而形成取舍。综合差距很小或证据不足时，说明哪些已知条件可能改变判断；不能拿裸维度分替代加权贡献。'],
  ['economic', '经济回报', '找出最影响经济回报差距的一两个子项，解释它们对持续收入、城市购买力或买房压力的实际意义。入职一次性收入、常规年度现金和非现金福利必须分开看；不要把一次性收入说成长期优势。'],
  ['growth', '职业成长', '找出成长机会中真正形成差别的一两个方面，解释它们对应的是短期承担、技能积累还是后续选择空间。不要根据现有分数臆测未来晋升、行业前景或雇主承诺。'],
  ['experience', '工作体验', '找出时间、休息或边界安排中最能影响日常生活的差别，解释可能的取舍。已填写的普通工时与根据旺季或通勤推算的时间要区分，不能把估算当作确定安排。'],
];
const analysisSystem = `你是 Offer 对比报告的解释助手。只依据提供的确定性报告数据写简体中文解读。
你的任务是帮助用户理解选择，而不是复述表格：开头直接说本部分最值得关注的判断，再解释形成判断的关键差异、实际取舍，以及必要时什么条件会改变结论。只引用支撑判断的少量数字和 Offer 字母；不要逐项列数据、解释字段定义或复述计算公式。
分数和排名由产品规则算出，你不能重算、改变或声称由 AI 决定。不得编造未提供的工资、公司、政策、行业前景或主观经历。缺失值说“未填写”或“不参与本轮评分”；差距很小时不要断言绝对优劣。
写两段连贯文字，总计约 130—220 个汉字。不要输出 Markdown 标题、表格、JSON 或行动清单。`;

function dimensionEntries(values, part) {
  return Object.fromEntries(Object.entries(values ?? {}).filter(([key]) => key.startsWith(`${part}.`)));
}

function analysisEvidence(report, part) {
  if (part === 'overall') return {
    weights: report.weights,
    offers: report.offers.map((offer) => ({ label: offer.label, rank: offer.rank,
      overall_score: offer.overall_score, dimension_scores: offer.dimension_scores,
      score_contributions: offer.score_contributions, missing_core: offer.missing_core })),
  };
  return {
    ...(part === 'economic' ? { buy_house_intent: report.buy_house_intent } : {}),
    offers: report.offers.map((offer) => ({ label: offer.label,
      ...(part === 'economic' ? { city: offer.city, compliance_alert: offer.compliance_alert } : {}),
      dimension_score: offer.dimension_scores?.[part],
      sub_scores: dimensionEntries(offer.sub_scores, part),
      sub_metrics: dimensionEntries(offer.sub_metrics, part) })),
  };
}

export class AiError extends Error {
  constructor(code, message, status = 400) { super(message); this.code = code; this.status = status; }
}

// Never return upstream exception text: it may contain a key, token or callback URL.
function safeFailure(error) {
  const text = String(error?.message ?? '');
  if (/401|403|unauthoriz|invalid_grant|authentication/i.test(text))
    return '授权无效或账号没有该模型的权限，请重新连接或更换模型。';
  if (/429|quota|rate.limit|credit|billing/i.test(text))
    return '服务商额度不足或请求过于频繁，请稍后重试。';
  if (/abort|timeout|timed.out/i.test(text)) return '连接超时或授权已取消，请重试。';
  if (/EADDRINUSE/i.test(text)) return '授权回调端口正在使用，请结束其他授权后重试。';
  return '连接失败，请检查网络、账号权限和模型设置后重试。';
}

/** One store and collection per browser identity; no ambient server credentials. */
export class AiRuntime {
  // 内存护栏：无凭据且无活跃任务的孤儿 user 可以透明重建，超过上限时
  // 按创建顺序淘汰，防止 maps 随历史浏览器身份无限增长。
  static USER_LIMIT = 200;
  static JOB_LIMIT = 20;

  constructor(providerFactories = factories) {
    this.factories = providerFactories;
    this.users = new Map();
    this.callbackJob = null;
    this.deviceId = randomUUID();
    this.pruneTimer = setInterval(() => this.pruneIdleUsers().catch(() => {}), 60_000);
    this.pruneTimer.unref();
  }

  user(owner) {
    if (!this.users.has(owner)) {
      this.#evictOrphanUsers();
      if (this.users.size >= AiRuntime.USER_LIMIT) {
        throw new AiError('ai_capacity', '模型配置容量已满，请稍后重试。', 503);
      }
      const values = new Map();
      const locks = new Map();
      const serialized = async (id, fn) => {
        const previous = locks.get(id) ?? Promise.resolve();
        const next = previous.catch(() => {}).then(fn);
        locks.set(id, next);
        try { return await next; }
        finally { if (locks.get(id) === next) locks.delete(id); }
      };
      const credentials = {
        read: async (id) => structuredClone(values.get(id)),
        list: async () => [...values].map(([providerId, value]) => ({ providerId, type: value.type })),
        modify: (id, fn) => serialized(id, async () => {
          const updated = await fn(structuredClone(values.get(id)));
          if (updated !== undefined) values.set(id, structuredClone(updated));
          return structuredClone(values.get(id));
        }),
        delete: (id) => serialized(id, async () => { values.delete(id); }),
      };
      const models = createModels({ credentials,
        authContext: { env: async () => undefined, fileExists: async () => false } });
      for (const factory of this.factories) models.setProvider(factory());
      this.users.set(owner, { credentials, models, selected: null, checks: new Map(), jobs: new Map(),
        credentialCount: () => values.size, updatedAt: Date.now() });
    }
    const user = this.users.get(owner);
    user.updatedAt = Date.now();
    for (const [id, job] of user.jobs) {
      const ttl = job.kind === 'analysis' ? 86_400_000 : 600_000;
      if (terminal.has(job.status) && Date.now() - job.created > ttl) user.jobs.delete(id);
    }
    return user;
  }

  #evictOrphanUsers() {
    if (this.users.size < AiRuntime.USER_LIMIT) return;
    for (const [owner, u] of [...this.users].sort((a, b) => a[1].updatedAt - b[1].updatedAt)) {
      if (this.users.size <= AiRuntime.USER_LIMIT / 2) break;
      if (u.credentialCount() > 0) continue; // 有凭据：淘汰等于要求用户重新授权
      if ([...u.jobs.values()].some((j) => !terminal.has(j.status))) continue;
      this.users.delete(owner); // 先淘汰最久未访问的孤儿
    }
  }

  async pruneIdleUsers() {
    const cutoff = Date.now() - 2 * 86_400_000;
    for (const [owner, user] of this.users) {
      if (user.updatedAt >= cutoff) continue;
      await Promise.all([...user.jobs.values()].map((job) => this.cancel(job)));
      // await 期间新的请求可能已访问此身份。
      if (user.updatedAt < cutoff) this.users.delete(owner);
    }
  }

  provider(user, id) {
    const provider = user.models.getProvider(id);
    if (!provider) throw new AiError('unknown_provider', '请选择支持的模型服务商。');
    return provider;
  }

  async config(user) {
    const credentials = await user.credentials.list();
    return {
      storage: 'memory', selected: user.selected,
      providers: user.models.getProviders().map((p) => ({
        id: p.id, name: labels[p.id] ?? p.name,
        api_key: Boolean(p.auth.apiKey?.login), oauth: Boolean(p.auth.oauth),
        subscription: Boolean(p.auth.oauth?.isSubscription),
        auth_type: credentials.find((c) => c.providerId === p.id)?.type ?? null,
        models: user.models.getModels(p.id).map((m) => ({ id: m.id, name: m.name,
          context_window: m.contextWindow, reasoning: m.reasoning, vision: m.input.includes('image') })),
        last_check: user.checks.get(p.id) ?? null,
      })),
      active_jobs: [...user.jobs.values()].filter((j) => !terminal.has(j.status)).map((j) => this.jobView(j)),
    };
  }

  jobView(job) {
    return { id: job.id, kind: job.kind, provider: job.provider, model: job.model ?? null,
      status: job.status, url: job.url ?? null, user_code: job.userCode ?? null,
      message: job.message ?? null, prompt: job.prompt ?? null,
      expires_at: new Date(job.created + job.timeout).toISOString(),
      snapshot_seq: job.snapshotSeq ?? null, stage: job.stage ?? null,
      sections: job.kind === 'analysis' ? { ...job.sections } : {} };
  }

  newJob(user, kind, provider, timeout) {
    for (const [id, job] of user.jobs) {
      if (user.jobs.size < AiRuntime.JOB_LIMIT) break;
      if (terminal.has(job.status)) user.jobs.delete(id);
    }
    if ([...user.jobs.values()].some((j) => !terminal.has(j.status)))
      throw new AiError('ai_busy', '请先完成或取消当前模型任务。', 409);
    const job = { id: randomUUID(), kind, provider, status: 'pending', created: Date.now(),
      timeout, controller: new AbortController() };
    job.timer = setTimeout(() => job.controller.abort(), timeout);
    job.timer.unref();
    user.jobs.set(job.id, job);
    return job;
  }

  launch(job, action, success) {
    job.task = Promise.resolve().then(action).then(() => {
      if (job.controller.signal.aborted) throw new Error('Aborted');
      job.status = 'succeeded'; job.message = success;
    }).catch((error) => {
      if (job.status !== 'cancelled') {
        job.status = 'failed'; job.message = safeFailure(error);
      }
    }).finally(() => {
      clearTimeout(job.timer);
      job.prompt = null; job.answer = null; job.url = null; job.userCode = null;
      if (this.callbackJob === job) this.callbackJob = null;
    });
  }

  async dispatch(owner, op, args = {}) {
    const user = this.user(owner);
    if (op === 'config') return this.config(user);
    if (op === 'key') {
      const p = this.provider(user, args.provider);
      if (!p.auth.apiKey?.login) throw new AiError('unsupported_auth', '该服务商需通过账号授权连接。');
      if ([...user.jobs.values()].some((j) => j.provider === p.id && !terminal.has(j.status)))
        throw new AiError('ai_busy', '请先完成或取消当前连接。', 409);
      const key = args.key?.trim();
      if (!key || key.length > 4096 || /[\r\n]/.test(key)) throw new AiError('invalid_key', '请填写有效的 API Key。');
      await user.credentials.modify(p.id, async () => ({ type: 'api_key', key }));
      user.checks.delete(p.id);
      return this.config(user);
    }
    if (op === 'disconnect') {
      this.provider(user, args.provider);
      for (const job of user.jobs.values()) {
        if (job.provider === args.provider && !terminal.has(job.status)) await this.cancel(job);
      }
      await user.models.logout(args.provider);
      user.checks.delete(args.provider);
      if (user.selected?.provider === args.provider) user.selected = null;
      return this.config(user);
    }
    if (op === 'select') {
      const model = user.models.getModel(args.provider, args.model);
      if (!model) throw new AiError('unknown_model', '请选择该服务商提供的模型。');
      if (!await user.credentials.read(args.provider)) throw new AiError('not_connected', '请先连接该服务商。');
      user.selected = { provider: args.provider, model: args.model };
      return this.config(user);
    }
    if (op === 'login') {
      const p = this.provider(user, args.provider);
      if (!p.auth.oauth) throw new AiError('unsupported_auth', '该服务商请使用 API Key 接入。');
      if (p.id === 'openai' && this.callbackJob)
        throw new AiError('oauth_busy', '当前有账号授权正在进行，请稍后重试。', 409);
      const job = this.newJob(user, 'login', p.id, 600_000);
      if (p.id === 'openai') this.callbackJob = job;
      this.launch(job, async () => {
        await user.models.login(p.id, 'oauth', {
          signal: job.controller.signal,
          notify: (event) => {
            if (event.type === 'auth_url') job.url = event.url;
            if (event.type === 'device_code') { job.url = event.verificationUri; job.userCode = event.userCode; }
            // Raw progress/info can contain sensitive URLs or upstream diagnostics.
          },
          prompt: (prompt) => new Promise((resolve, reject) => {
            const signal = prompt.signal ?? job.controller.signal;
            if (signal.aborted) { reject(new Error('Aborted')); return; }
            const id = randomUUID();
            job.prompt = { id, type: prompt.type,
              message: prompt.type === 'manual_code' ? '授权后将浏览器中的完整回调地址或授权码粘贴到这里。' : prompt.message,
              options: prompt.type === 'select' ? prompt.options : null };
            const abort = () => {
              if (job.prompt?.id === id) { job.prompt = null; job.answer = null; }
              reject(new Error('Aborted'));
            };
            signal.addEventListener('abort', abort, { once: true });
            job.answer = (value) => {
              signal.removeEventListener('abort', abort);
              job.prompt = null; job.answer = null; resolve(value);
            };
          }),
        }, { getDeviceId: () => this.deviceId });
        user.checks.delete(p.id);
      }, '账号已连接，请选择模型并测试连接。');
      return this.jobView(job);
    }
    if (op === 'test') {
      const model = user.models.getModel(args.provider, args.model);
      if (!model) throw new AiError('unknown_model', '请选择有效的模型。');
      if (!await user.credentials.read(args.provider)) throw new AiError('not_connected', '请先连接该服务商。');
      const job = this.newJob(user, 'test', args.provider, 60_000);
      job.model = args.model;
      this.launch(job, async () => {
        const result = await user.models.completeSimple(model,
          { messages: [{ role: 'user', content: 'Reply with the single word OK.', timestamp: Date.now() }] },
          { signal: job.controller.signal, maxTokens: 128, reasoning: 'off', maxRetries: 0 });
        const text = result.content.filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
        const ok = result.stopReason !== 'error' && result.stopReason !== 'aborted' && Boolean(text);
        user.checks.set(args.provider, { model: args.model, ok, checked_at: new Date().toISOString() });
        if (!ok) throw new Error(result.errorMessage ?? 'Empty response');
      }, '连接成功，模型已返回有效回复。');
      job.task.then(() => {
        if (job.status !== 'succeeded') user.checks.set(args.provider,
          { model: args.model, ok: false, checked_at: new Date().toISOString() });
      });
      return this.jobView(job);
    }
    if (op === 'analyze') {
      if (!user.selected) throw new AiError('model_not_selected', '请先在模型配置页连接并选择默认模型。');
      const { provider, model: modelId } = user.selected;
      const model = user.models.getModel(provider, modelId);
      if (!model || !await user.credentials.read(provider))
        throw new AiError('not_connected', '当前模型尚未连接，请到模型配置页重新连接。');
      const report = args.report;
      const selectedPart = analysisParts.find(([key]) => key === args.part);
      if (!selectedPart) throw new AiError('invalid_part', '请选择要生成的报告部分。');
      if (!report || !Number.isInteger(report.snapshot_seq) || !Array.isArray(report.offers)
          || report.offers.length < 2 || report.offers.length > 3
          || report.offers.some((offer) => !Number.isFinite(offer.overall_score)))
        throw new AiError('invalid_report', '请先生成完整的对比报告。');
      const job = this.newJob(user, 'analysis', provider, 240_000);
      job.model = modelId;
      job.snapshotSeq = report.snapshot_seq;
      job.stage = selectedPart[0];
      job.sections = {};
      this.launch(job, async () => {
        const [key, label, focus] = selectedPart;
        const result = await user.models.completeSimple(model, {
          systemPrompt: analysisSystem,
          messages: [{ role: 'user', timestamp: Date.now(),
            content: `请写“${label}”解读。${focus}\n\n报告依据：${JSON.stringify(analysisEvidence(report, key))}` }],
        }, { signal: job.controller.signal, maxTokens: 950, reasoning: 'off', maxRetries: 0 });
        const content = result.content.filter((block) => block.type === 'text')
          .map((block) => block.text).join('').trim();
        if (result.stopReason === 'error' || result.stopReason === 'aborted' || !content)
          throw new Error(result.errorMessage ?? 'Empty analysis');
        if (job.controller.signal.aborted) throw new Error('Aborted');
        job.sections[key] = content.slice(0, 2400);
      }, `${selectedPart[1]}解读已生成。`);
      return this.jobView(job);
    }
    if (['job', 'reply', 'cancel'].includes(op)) {
      const job = user.jobs.get(args.id);
      if (!job) throw new AiError('not_found', '授权或测试任务不存在，请重新开始。', 404);
      if (op === 'reply') {
        if (terminal.has(job.status) || !job.answer || job.prompt?.id !== args.prompt_id)
          throw new AiError('stale_prompt', '该授权步骤已结束，请刷新状态。', 409);
        if (job.prompt.type === 'select' && !job.prompt.options.some((o) => o.id === args.value))
          throw new AiError('invalid_choice', '请选择有效的授权选项。');
        job.answer(args.value);
      }
      if (op === 'cancel') await this.cancel(job);
      return this.jobView(job);
    }
    throw new AiError('unknown_operation', '不支持的操作。');
  }

  async cancel(job) {
    if (terminal.has(job.status)) return;
    job.status = 'cancelled'; job.message = '已取消。';
    job.controller.abort();
    await job.task;
  }

  async close() {
    clearInterval(this.pruneTimer);
    await Promise.all([...this.users.values()].flatMap((u) => [...u.jobs.values()].map((j) => this.cancel(j))));
    this.users.clear();
  }
}
