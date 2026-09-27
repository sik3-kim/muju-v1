// Google Gemini API 로 답변 생성 (스트리밍). Claude 와 같은 지침·자료를 쓴다.

import { GoogleGenAI } from "@google/genai";
import { INSTRUCTIONS, materialsBlock, buildUserText, type AnswerRequest } from "./answer";

export async function generateGemini(req: AnswerRequest): Promise<string> {
  const ai = new GoogleGenAI({ apiKey: req.apiKey });
  const stream = await ai.models.generateContentStream({
    model: req.model,
    contents: buildUserText(req.context, req.recent),
    config: {
      systemInstruction: `${INSTRUCTIONS}\n\n${materialsBlock(req.org, req.docs)}`,
      abortSignal: req.signal,
    },
  });

  let text = "";
  let finishReason: string | undefined;
  let blockReason: string | undefined;
  for await (const chunk of stream) {
    const delta = chunk.text ?? "";
    if (delta) {
      text += delta;
      req.onText(delta);
    }
    finishReason = chunk.candidates?.[0]?.finishReason ?? finishReason;
    blockReason = chunk.promptFeedback?.blockReason ?? blockReason;
  }

  if (!text.trim()) {
    if (blockReason || finishReason === "SAFETY" || finishReason === "PROHIBITED_CONTENT") {
      throw new Error("Gemini가 이 요청에 답하지 않았습니다. Claude로 바꿔 다시 시도하세요.");
    }
    throw new Error(`Gemini가 빈 답변을 보냈습니다${finishReason ? ` (${finishReason})` : ""}. 다시 시도하세요.`);
  }
  return text;
}

/** 이 키로 쓸 수 있는 Gemini 모델 이름 목록 (답변 생성이 가능한 것만) */
export async function listGeminiModels(apiKey: string): Promise<string[]> {
  const ai = new GoogleGenAI({ apiKey });
  const names: string[] = [];
  for await (const m of await ai.models.list()) {
    const name = (m.name ?? "").replace(/^models\//, "");
    if (!name.startsWith("gemini")) continue;
    if (m.supportedActions && !m.supportedActions.includes("generateContent")) continue;
    names.push(name);
  }
  return names.sort();
}
