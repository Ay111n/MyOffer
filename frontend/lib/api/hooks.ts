"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "./client";
import type { S } from "./types";

/** 统一约定：query key 以 ['session'] 为前缀；mutation 成功后整体失效 */
export function useInvalidateSession() {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: ["session"] });
}

export function useCreateSession() {
  const invalidate = useInvalidateSession();
  return useMutation({
    mutationFn: async (title?: string | null) => {
      const { data, error } = await api.POST("/api/v1/sessions", { body: { title: title ?? null } });
      if (error) throw error;
      return data.data;
    },
    onSuccess: () => invalidate(),
  });
}

export function useOffers(sid: string | null) {
  return useQuery({
    queryKey: ["session", sid, "offers"],
    queryFn: async () => {
      const { data, error } = await api.GET("/api/v1/sessions/{sid}/offers", {
        params: { path: { sid: sid! } },
      });
      if (error) throw error;
      return data.data;
    },
    enabled: !!sid,
  });
}

export function useQuestionsCatalog(sid: string | null) {
  return useQuery({
    queryKey: ["session", sid, "questions", "catalog"],
    queryFn: async () => {
      const { data, error } = await api.GET("/api/v1/sessions/{sid}/questions", {
        params: { path: { sid: sid! } },
      });
      if (error) throw error;
      return data.data;
    },
    enabled: !!sid,
  });
}

export function useResult(
  sid: string | null,
  snapshotSeq: number | null = null,
  enabled = true,
) {
  return useQuery({
    queryKey: ["session", sid, "result", snapshotSeq],
    queryFn: async () => {
      if (snapshotSeq !== null) {
        const { data, error } = await api.GET("/api/v1/sessions/{sid}/results/{seq}", {
          params: { path: { sid: sid!, seq: snapshotSeq } },
        });
        if (error) throw error;
        return data.data;
      }
      const { data, error } = await api.GET("/api/v1/sessions/{sid}/result", {
        params: { path: { sid: sid! } },
      });
      if (error) throw error;
      return data.data;
    },
    enabled: !!sid && enabled,
    // 会话还没有快照时 /result 就是 404——这是正常状态而非故障，不重试；
    // 调用方应当用 enabled 参数门控，这里 retry:false 只兜底失败速度。
    retry: false,
  });
}

export function useDueDiligence(sid: string | null) {
  return useQuery({
    queryKey: ["session", sid, "due-diligence"],
    queryFn: async () => {
      const { data, error } = await api.GET("/api/v1/sessions/{sid}/due-diligence", {
        params: { path: { sid: sid! } },
      });
      if (error) throw error;
      return data.data.items;
    },
    enabled: !!sid,
  });
}

// ── mutations ──────────────────────────────────────────────

export function useCreateOffer() {
  const invalidate = useInvalidateSession();
  return useMutation({
    mutationFn: async (args: { sessionId: string; body: S["OfferCreateRequest"] }) => {
      const { data, error } = await api.POST("/api/v1/sessions/{sid}/offers", {
        params: { path: { sid: args.sessionId } }, body: args.body,
      });
      if (error) throw error;
      return data;
    },
    onSuccess: () => invalidate(),
  });
}

export function useDeleteOffer() {
  const invalidate = useInvalidateSession();
  return useMutation({
    mutationFn: async (args: { sessionId: string; oid: string }) => {
      const { data, error } = await api.DELETE("/api/v1/sessions/{sid}/offers/{oid}", {
        params: { path: { sid: args.sessionId, oid: args.oid } },
      });
      if (error) throw error;
      return data;
    },
    onSuccess: () => invalidate(),
  });
}

export function useResetOffer() {
  const invalidate = useInvalidateSession();
  return useMutation({
    mutationFn: async (args: { sessionId: string; oid: string; version: number }) => {
      const { data, error } = await api.POST("/api/v1/sessions/{sid}/offers/{oid}/reset", {
        params: { path: { sid: args.sessionId, oid: args.oid } },
        body: { version: args.version },
      });
      if (error) throw error;
      return data;
    },
    onSuccess: () => invalidate(),
  });
}

export function usePatchOffer() {
  const invalidate = useInvalidateSession();
  return useMutation({
    mutationFn: async (args: {
      sessionId: string;
      oid: string;
      body: S["OfferPatchRequest"];
    }) => {
      const { data, error } = await api.PATCH("/api/v1/sessions/{sid}/offers/{oid}", {
        params: { path: { sid: args.sessionId, oid: args.oid } },
        body: args.body,
      });
      if (error) throw error;
      return data;
    },
    onSuccess: () => invalidate(),
  });
}

/** 城市 universe 的唯一前端来源（后端规则层定义）；
 * 规则版本内不变，长期缓存。前端任何地方禁止再写死一份城市列表。 */
export function useSupportedCities() {
  return useQuery({
    queryKey: ["meta", "supported-cities"],
    queryFn: async () => {
      const { data, error } = await api.GET("/api/v1/meta", {});
      if (error) throw error;
      return data.data.supported_cities;
    },
    staleTime: Infinity,
  });
}

/** 城市 → 线级标签（一线/新一线/…，city_index.yaml tier 键唯一事实源）；
 * 城市下拉分组展示用，规则版本内不变，长期缓存。 */
export function useCityTiers() {
  return useQuery({
    queryKey: ["meta", "city-tiers"],
    queryFn: async () => {
      const { data, error } = await api.GET("/api/v1/meta", {});
      if (error) throw error;
      return data.data.city_tiers ?? {};
    },
    staleTime: Infinity,
  });
}

/** 价值观问卷的题目、顺序与固定文案来自后端规则层；规则版本内长期缓存。 */
export function usePreferenceQuestionnaire() {
  return useQuery({
    queryKey: ["meta", "preference-questionnaire"],
    queryFn: async () => {
      const { data, error } = await api.GET("/api/v1/meta", {});
      if (error) throw error;
      return data.data.preference_questionnaire;
    },
    staleTime: Infinity,
  });
}

/** 未做问卷时的综合评分默认权重（preferences.yaml 唯一事实源）；长期缓存。 */
export function useDefaultWeights() {
  return useQuery({
    queryKey: ["meta", "default-weights"],
    queryFn: async () => {
      const { data, error } = await api.GET("/api/v1/meta", {});
      if (error) throw error;
      return data.data.default_weights;
    },
    staleTime: Infinity,
  });
}

/** 字段数值边界与 core 必需度字段（fields.yaml 唯一事实源，经 /meta 下发）。
 *  前端输入上限曾手抄一份（FIELD_MAX）无同步机制——规则调整后必然漂移，
 *  现在以后端下发为准，本地常量仅作 meta 未返回时的兜底。 */
export function useFieldRules() {
  return useQuery({
    queryKey: ["meta", "field-rules"],
    queryFn: async () => {
      const { data, error } = await api.GET("/api/v1/meta", {});
      if (error) throw error;
      return data.data.field_rules;
    },
    staleTime: Infinity,
  });
}

export function usePreferences(sid: string | null) {
  return useQuery({
    queryKey: ["session", sid, "preferences"],
    queryFn: async () => {
      const { data, error } = await api.GET("/api/v1/sessions/{sid}/preferences", {
        params: { path: { sid: sid! } },
      });
      if (error) throw error;
      return data;
    },
    enabled: !!sid,
  });
}

export function usePutPreferences() {
  const invalidate = useInvalidateSession();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (args: { sessionId: string; body: S["PreferencePutRequest"] }) => {
      const { data, error } = await api.PUT("/api/v1/sessions/{sid}/preferences", {
        params: { path: { sid: args.sessionId } }, body: args.body,
      });
      if (error) throw error;
      return data;
    },
    onSuccess: (data, args) => {
      // PUT 响应携带保存后的最新 version：先写回缓存再失效。只靠失效的异步
      // 重取，重取完成前 prefs.version 落后一代，窗口内的再次保存会以旧
      // version 被 409 拒绝；偏好查询此前出错（无缓存数据）时也靠这里恢复。
      qc.setQueryData<S["PreferenceResponse"]>(
        ["session", args.sessionId, "preferences"], data,
      );
      invalidate();
    },
  });
}

/** 提交答案。
 *
 *  `silent: true` 时不在成功后失效会话缓存，供「一次提交多题」的批量场景使用，
 *  由调用方在整批完成后统一失效一次即可。
 *
 *  ⚠️ 为什么必须这样：失效是 `invalidateQueries({ queryKey: ["session"] })`，会让
 *  该前缀下所有活动查询（offers / questions / preferences）各重取一轮。逐条提交
 *  时每题都触发一轮，实测「生成对比报告」一次流程因此放大到 **45 次 API 请求**，
 *  逼近 nginx 的 `limit_req rate=10r/s burst=20`，会打出 503 并触发重试风暴。
 */
export function useSubmitAnswers(options: { silent?: boolean } = {}) {
  const invalidate = useInvalidateSession();
  const silent = options.silent === true;
  return useMutation({
    mutationFn: async (args: { sessionId: string; questionKey: string; body: S["AnswerRequest"] }) => {
      const { data, error } = await api.POST("/api/v1/sessions/{sid}/questions/{question_key}/answers", {
        params: { path: { sid: args.sessionId, question_key: args.questionKey } },
        body: args.body,
      });
      if (error) throw error;
      return data;
    },
    onSuccess: () => { if (!silent) invalidate(); },
  });
}

export function useResumeQuestions() {
  const invalidate = useInvalidateSession();
  return useMutation({
    mutationFn: async (sessionId: string) => {
      const { data, error } = await api.POST("/api/v1/sessions/{sid}/questions/resume", {
        params: { path: { sid: sessionId } },
      });
      if (error) throw error;
      return data;
    },
    onSuccess: () => invalidate(),
  });
}

export function useStopQuestions() {
  const invalidate = useInvalidateSession();
  return useMutation({
    mutationFn: async (sessionId: string) => {
      const { data, error } = await api.POST("/api/v1/sessions/{sid}/questions/stop", {
        params: { path: { sid: sessionId } },
      });
      if (error) throw error;
      return data;
    },
    onSuccess: () => invalidate(),
  });
}

export function usePatchDueDiligence() {
  const invalidate = useInvalidateSession();
  return useMutation({
    mutationFn: async (args: { sessionId: string; itemId: string; status: "open" | "done" | "dismissed" }) => {
      const { data, error } = await api.PATCH("/api/v1/sessions/{sid}/due-diligence/{item_id}", {
        params: { path: { sid: args.sessionId, item_id: args.itemId } },
        body: { status: args.status },
      });
      if (error) throw error;
      return data;
    },
    onSuccess: () => invalidate(),
  });
}
