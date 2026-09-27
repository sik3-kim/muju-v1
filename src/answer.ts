// 의원 질문 → 답변 요지 생성 (Claude API, 스트리밍).

import Anthropic from "@anthropic-ai/sdk";
import type { Doc } from "./docs";

export type Engine = "claude" | "gemini";

export const ENGINE_LABEL: Record<Engine, string> = { claude: "Claude", gemini: "Gemini" };

export const MODELS = [
  { id: "claude-opus-5", label: "Opus 5 — 가장 정확 (기본)" },
  { id: "claude-sonnet-5", label: "Sonnet 5 — 더 빠름" },
  { id: "claude-haiku-4-5", label: "Haiku 4.5 — 가장 빠름·저렴" },
] as const;

/** 구글이 항상 최신 Flash 모델로 연결해 주는 이름 */
export const GEMINI_DEFAULT_MODEL = "gemini-flash-latest";

export type Effort = "low" | "medium" | "high";

export const NO_QUESTION = "[질문 없음]";

export const INSTRUCTIONS = `당신은 지방의회 회의(본회의, 상임위원회, 예산결산특별위원회, 행정사무감사 등)에서 의원 질의에 답변하는 집행부 공무원(과장 등)을 옆에서 돕는 팀장의 보조자입니다.

입력은 회의장 스피커 소리를 휴대폰으로 받아 적은 실시간 음성인식 결과입니다. 오인식, 띄어쓰기 오류, 문장부호 없음이 흔하고 누가 말했는지 구분되어 있지 않습니다.

규칙
1. 답변의 사실·수치·일정은 <자료>에 있는 내용만 사용합니다. 자료에 없는 수치, 날짜, 사업명, 법령 조문을 지어내지 않습니다. 자료에 없으면 '확인 필요'에 적고, 답변 문장은 "확인하여 별도로 보고드리겠습니다"처럼 처리합니다.
2. 음성인식 오류로 보이는 단어는 자료의 사업명·용어를 참고해 바로잡아 이해합니다. 바로잡은 핵심 용어가 있으면 질문 요약에 바른 용어로 씁니다.
3. <최근 발언>에서 의원의 질문을 찾아 답합니다. 질문이 여러 개면 순서대로 모두 답합니다. <이전 발언>은 맥락 파악에만 씁니다.
4. <최근 발언>에 의원의 질문이 없으면(공무원 답변, 의사진행 발언, 인사말 등) 다른 말 없이 ${NO_QUESTION} 만 출력합니다.
5. 답변은 과장이 그대로 읽을 수 있는 짧은 구어체 존댓말("~입니다", "~하겠습니다")로, 결론을 먼저 말합니다.
6. 확정되지 않은 사항을 약속하는 표현은 피하고, 필요하면 '주의'에 적습니다.

출력 형식 (휴대폰 화면용, 머리말·맺음말 없이 아래 형식만)
■ 질문: 의원 질문 한 줄 요약
■ 답변: 2~4문장
■ 근거:
- 수치·사실 (출처: 자료 이름)
■ 확인 필요: 자료에 없어 확인해야 할 사항 (없으면 이 항목 생략)
■ 주의: 민감한 쟁점이나 발언 시 유의점 (필요할 때만)`;

export function materialsBlock(org: string, docs: Doc[]): string {
  const parts: string[] = [];
  if (org.trim()) parts.push(`<답변 부서>\n${org.trim()}\n</답변 부서>`);
  if (docs.length === 0) {
    parts.push("<자료>\n(등록된 자료 없음)\n</자료>");
  } else {
    const body = docs.map((d) => `<문서 이름="${d.name.replace(/"/g, "'")}">\n${d.text}\n</문서>`).join("\n\n");
    parts.push(`<자료>\n${body}\n</자료>`);
  }
  return parts.join("\n\n");
}

export interface AnswerRequest {
  engine: Engine;
  /** 선택한 엔진의 API 키 */
  apiKey: string;
  /** 선택한 엔진의 모델 이름 */
  model: string;
  /** Claude 전용: 생각 깊이 */
  effort: Effort;
  org: string;
  docs: Doc[];
  /** 답변 대상 이전의 발언 (맥락) */
  context: string;
  /** 답변 대상 발언 */
  recent: string;
  onText: (delta: string) => void;
  signal?: AbortSignal;
}

export function buildUserText(context: string, recent: string): string {
  return [
    context.trim() ? `<이전 발언>\n${context.trim()}\n</이전 발언>` : "",
    `<최근 발언>\n${recent.trim()}\n</최근 발언>`,
    "위 <최근 발언>에 있는 의원 질문에 대한 답변 요지를 작성하세요.",
  ]
    .filter(Boolean)
    .join("\n\n");
}

export async function generateAnswer(req: AnswerRequest): Promise<string> {
  if (req.engine === "gemini") {
    // Gemini 라이브러리는 선택했을 때만 불러온다
    const { generateGemini } = await import("./gemini");
    return generateGemini(req);
  }
  return generateClaude(req);
}

async function generateClaude(req: AnswerRequest): Promise<string> {
  const client = new Anthropic({
    apiKey: req.apiKey,
    // 휴대폰 브라우저에서 바로 호출한다. API 키는 이 기기에만 저장된다.
    dangerouslyAllowBrowser: true,
  });

  const isHaiku = req.model.startsWith("claude-haiku");
  const isOpus5 = req.model === "claude-opus-5";

  const stream = client.beta.messages.stream(
    {
      model: req.model,
      max_tokens: 16000,
      // Haiku 4.5 는 adaptive thinking / effort 를 지원하지 않는다
      ...(isHaiku ? {} : { thinking: { type: "adaptive" as const }, output_config: { effort: req.effort } }),
      // Opus 5 가 안전 분류기로 거절하면 서버에서 다른 모델로 자동 재시도
      ...(isOpus5 ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {}),
      system: [
        { type: "text", text: INSTRUCTIONS },
        // 자료는 회의 동안 바뀌지 않으므로 캐시해 두면 두 번째 질문부터 빠르고 저렴하다
        { type: "text", text: materialsBlock(req.org, req.docs), cache_control: { type: "ephemeral", ttl: "1h" } },
      ],
      messages: [{ role: "user", content: buildUserText(req.context, req.recent) }],
    },
    { signal: req.signal },
  );

  stream.on("text", (delta) => req.onText(delta));
  const message = await stream.finalMessage();

  if (message.stop_reason === "refusal") {
    throw new Error("AI가 이 요청에 답하지 않았습니다. 질문 범위를 조정해 다시 시도하세요.");
  }
  return message.content
    .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");
}

export function describeError(err: unknown): string {
  if (err instanceof Anthropic.APIUserAbortError) return "취소됨";
  if (err instanceof Anthropic.AuthenticationError) return "Claude API 키가 올바르지 않습니다. 설정에서 키를 확인하세요.";
  if (err instanceof Anthropic.PermissionDeniedError) return "이 API 키로는 해당 모델을 쓸 수 없습니다. 설정에서 다른 모델을 고르세요.";
  if (err instanceof Anthropic.RateLimitError) return "요청이 너무 많습니다. 잠시 후 다시 시도하세요.";
  if (err instanceof Anthropic.BadRequestError) {
    if (/credit|balance|billing/i.test(err.message)) return "Claude API 크레딧(잔액)이 부족합니다. Claude Console에서 충전하세요.";
    return `요청 오류: ${err.message}`;
  }
  if (err instanceof Anthropic.APIConnectionError) return "인터넷 연결을 확인하세요 (와이파이/5G).";
  if (err instanceof Anthropic.APIError) return `API 오류 (${err.status}): ${err.message}`;
  if (err instanceof Error && err.name === "AbortError") return "취소됨";
  // Gemini SDK 오류 (ApiError, status 포함)
  const status = (err as { status?: unknown } | null)?.status;
  if (err instanceof Error && typeof status === "number") {
    if (status === 400 && /api key/i.test(err.message)) return "Gemini API 키가 올바르지 않습니다. 설정에서 키를 확인하세요.";
    if (status === 403) return "Gemini API 키 권한이 없습니다. 키를 다시 발급하거나 설정을 확인하세요.";
    if (status === 404) return "Gemini 모델 이름을 찾을 수 없습니다. 설정에서 모델을 다시 고르세요.";
    if (status === 429) return "Gemini 무료 사용 한도를 넘었습니다. 잠시 후 다시 시도하거나 Claude로 바꿔 보세요.";
    if (status >= 500) return "Gemini 서버가 일시적으로 응답하지 않습니다. 잠시 후 다시 시도하세요.";
    return `Gemini 오류 (${status}): ${err.message}`;
  }
  if (err instanceof TypeError && /fetch|network/i.test(err.message)) return "인터넷 연결을 확인하세요 (와이파이/5G).";
  return err instanceof Error ? err.message : String(err);
}
