import "./style.css";
import { Listener } from "./speech";
import { loadDocs, saveDocs, newDoc, fileToText, type Doc } from "./docs";
import {
  MODELS,
  GEMINI_DEFAULT_MODEL,
  ENGINE_LABEL,
  NO_QUESTION,
  generateAnswer,
  describeError,
  type Effort,
  type Engine,
} from "./answer";

// ---------- 설정 ----------

interface Settings {
  /** 지금 답변에 쓰는 AI */
  engine: Engine;
  /** Claude API 키 */
  apiKey: string;
  geminiKey: string;
  geminiModel: string;
  org: string;
  model: string;
  effort: Effort;
  silenceSec: number;
  font: number;
  auto: boolean;
}

const SETTINGS_KEY = "council-helper-settings";
const defaults: Settings = {
  engine: "claude",
  apiKey: "",
  geminiKey: "",
  geminiModel: GEMINI_DEFAULT_MODEL,
  org: "",
  model: MODELS[0].id,
  effort: "low",
  silenceSec: 3,
  font: 1,
  auto: false,
};

function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    return raw ? { ...defaults, ...(JSON.parse(raw) as Partial<Settings>) } : { ...defaults };
  } catch {
    return { ...defaults };
  }
}

function saveSettings(): void {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // 저장이 막힌 브라우저(사생활 보호 모드 등)에서는 이번 접속 동안만 유지
  }
}

const settings = loadSettings();

// ---------- 상태 ----------

interface Segment {
  text: string;
  at: Date;
}

const segments: Segment[] = [];
/** 이 인덱스부터가 '답변할 질문'으로 보는 발언 */
let cursor = 0;
let interim = "";
let docs: Doc[] = [];
let autoBusy = false;

// ---------- DOM ----------

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const statusEl = $("status");
const listenBtn = $<HTMLButtonElement>("btn-listen");
const transcriptEl = $("transcript");
const answersEl = $("answers");
const autoEl = $<HTMLInputElement>("auto-mode");

function setStatus(text: string, kind: "idle" | "live" | "error" = "idle"): void {
  statusEl.textContent = text;
  statusEl.className = `status ${kind}`;
}

function toast(message: string): void {
  document.querySelectorAll(".toast").forEach((t) => t.remove());
  const el = document.createElement("div");
  el.className = "toast";
  el.textContent = message;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 4500);
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

function timeLabel(d: Date): string {
  return d.toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
}

// ---------- 탭 ----------

document.querySelectorAll<HTMLButtonElement>(".tabbar button").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tabbar button").forEach((b) => b.classList.toggle("active", b === btn));
    document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.id === `tab-${btn.dataset.tab}`));
  });
});

// ---------- 자막 ----------

function renderTranscript(): void {
  const stickToBottom = transcriptEl.scrollHeight - transcriptEl.scrollTop - transcriptEl.clientHeight < 40;
  const html: string[] = [];
  // 긴 회의에서도 가볍게: 최근 150줄만 그린다 (질문 시작 위치가 더 앞이면 거기부터)
  const start = Math.max(0, Math.min(cursor, segments.length - 150));
  segments.forEach((s, i) => {
    if (i < start) return;
    if (i === cursor) html.push('<div class="divider">▼ 답변할 질문</div>');
    html.push(
      `<div class="seg${i >= cursor ? " pending" : ""}" data-i="${i}"><time>${timeLabel(s.at)}</time>${escapeHtml(s.text)}</div>`,
    );
  });
  if (interim) {
    if (cursor >= segments.length) html.push('<div class="divider">▼ 답변할 질문</div>');
    html.push(`<div class="seg interim">${escapeHtml(interim)}</div>`);
  }
  if (html.length === 0) html.push('<div class="empty">「듣기 시작」을 누르면 여기에 의원 발언이 실시간으로 표시됩니다.</div>');
  transcriptEl.innerHTML = html.join("");
  if (stickToBottom) transcriptEl.scrollTop = transcriptEl.scrollHeight;
}

transcriptEl.addEventListener("click", (e) => {
  const seg = (e.target as HTMLElement).closest<HTMLElement>(".seg[data-i]");
  if (!seg) return;
  cursor = Number(seg.dataset.i);
  renderTranscript();
});

$("btn-clear").addEventListener("click", () => {
  if (segments.length && !confirm("자막을 모두 지울까요?")) return;
  segments.length = 0;
  cursor = 0;
  interim = "";
  renderTranscript();
});

// ---------- 음성인식 ----------

const listener = new Listener();
let wakeLock: { release(): Promise<void> } | null = null;

async function keepScreenOn(on: boolean): Promise<void> {
  const nav = navigator as Navigator & { wakeLock?: { request(type: "screen"): Promise<{ release(): Promise<void> }> } };
  try {
    if (on && nav.wakeLock && !wakeLock && document.visibilityState === "visible") {
      wakeLock = await nav.wakeLock.request("screen");
    } else if (!on && wakeLock) {
      await wakeLock.release();
      wakeLock = null;
    }
  } catch {
    // 지원하지 않는 브라우저는 무시
  }
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && listener.active) {
    wakeLock = null; // 화면 전환 시 브라우저가 자동으로 해제함
    void keepScreenOn(true);
  }
});

function updateListenButton(): void {
  listenBtn.textContent = listener.active ? "⏹ 듣기 멈춤" : "🎙 듣기 시작";
  listenBtn.classList.toggle("on", listener.active);
}

listener.onState = (state, message) => {
  if (state === "listening") setStatus("● 듣는 중", "live");
  else if (state === "stopped") setStatus("대기");
  else {
    setStatus("오류", "error");
    if (message) toast(message);
    void keepScreenOn(false);
  }
  updateListenButton();
};

let silenceTimer: number | undefined;

function scheduleAuto(): void {
  window.clearTimeout(silenceTimer);
  if (!settings.auto) return;
  silenceTimer = window.setTimeout(maybeAutoAnswer, settings.silenceSec * 1000);
}

listener.onFinal = (text) => {
  segments.push({ text, at: new Date() });
  interim = "";
  renderTranscript();
  scheduleAuto();
};

listener.onInterim = (text) => {
  interim = text;
  renderTranscript();
  if (text) window.clearTimeout(silenceTimer);
};

listenBtn.addEventListener("click", () => {
  if (listener.active) {
    listener.stop();
    void keepScreenOn(false);
  } else {
    if (!Listener.supported()) {
      toast("이 브라우저는 음성인식을 지원하지 않습니다. Android는 Chrome, iPhone은 Safari에서 여세요.");
      return;
    }
    listener.start();
    void keepScreenOn(true);
  }
  updateListenButton();
});

// 질문으로 보일 만한 표현 (자동 답변 모드에서 불필요한 호출을 줄이기 위한 느슨한 필터)
const QUESTION_HINT =
  /(니까|나요|가요|는지|은지|인지|던지|건지|세요|십시오|바랍니다|주시고|주시죠|궁금|말씀해|설명해|답변해|답변 부탁|어떻게|왜|언제|얼마|몇|무엇|뭡|뭔|어디|누가|있습니까|없습니까|겁니까|거예요|거죠|\?)/;

function maybeAutoAnswer(): void {
  if (!settings.auto || autoBusy) return;
  const recent = segments.slice(cursor).map((s) => s.text).join(" ");
  if (recent.replace(/\s/g, "").length < 12 || !QUESTION_HINT.test(recent)) return;
  void answerFromTranscript(true);
}

// ---------- 답변 ----------

interface Job {
  recent: string;
  context: string;
  source: string;
  auto: boolean;
}

function collectFromTranscript(): Job | null {
  let from = cursor;
  // 새 발언이 없으면 마지막 몇 줄을 다시 본다
  if (from >= segments.length && !interim) from = Math.max(0, segments.length - 3);
  const recent = [...segments.slice(from).map((s) => s.text), interim].filter(Boolean).join(" ");
  if (!recent.trim()) return null;
  let context = segments
    .slice(Math.max(0, from - 60), from)
    .map((s) => s.text)
    .join(" ");
  if (context.length > 3000) context = context.slice(-3000);
  return { recent, context, source: "음성", auto: false };
}

async function answerFromTranscript(auto: boolean): Promise<void> {
  const job = collectFromTranscript();
  if (!job) {
    toast("아직 인식된 발언이 없습니다.");
    return;
  }
  job.auto = auto;
  // 다음 질문은 지금 이후 발언부터
  cursor = segments.length;
  renderTranscript();
  await runJob(job);
}

function renderAnswer(text: string): string {
  const lines = text.split("\n");
  const out: string[] = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    const m = line.match(/^■\s*([^:：]{1,10})[:：]\s*(.*)$/);
    if (m) {
      const label = m[1].trim();
      const cls =
        label.startsWith("답변") ? "sec answer" : label.startsWith("확인") || label.startsWith("주의") ? "sec warn" : "sec";
      out.push(`<div class="${cls}"><b>${escapeHtml(label)}</b> ${escapeHtml(m[2])}</div>`);
    } else if (/^[-•·]\s*/.test(line)) {
      out.push(`<div class="item">• ${escapeHtml(line.replace(/^[-•·]\s*/, ""))}</div>`);
    } else {
      out.push(`<div class="line">${escapeHtml(line)}</div>`);
    }
  }
  return out.join("");
}

async function runJob(job: Job, engine: Engine = settings.engine): Promise<void> {
  const apiKey = engine === "gemini" ? settings.geminiKey : settings.apiKey;
  if (!apiKey) {
    toast(`⚙️설정에서 ${ENGINE_LABEL[engine]} API 키를 먼저 입력하세요.`);
    return;
  }
  const other: Engine = engine === "claude" ? "gemini" : "claude";

  const card = document.createElement("article");
  card.className = "card loading";
  card.innerHTML = `
    <header><time>${timeLabel(new Date())}</time><span class="tag">${job.auto ? "자동" : job.source}</span><span class="tag ${engine}">${ENGINE_LABEL[engine]}</span>
      <span class="spin">생성 중…</span></header>
    <div class="body"></div>
    <details class="src"><summary>인식된 발언 보기</summary><p>${escapeHtml(job.recent)}</p></details>
    <footer>
      <button class="btn small stop">중지</button>
      <button class="btn small copy" hidden>복사</button>
      <button class="btn small retry" hidden>다시 만들기</button>
      <button class="btn small other" hidden>${ENGINE_LABEL[other]}로</button>
    </footer>`;
  answersEl.prepend(card);
  // 휴대폰에서는 답변 카드가 화면 아래에 있을 수 있으므로 바로 보이게 스크롤
  card.scrollIntoView({ behavior: "smooth", block: "start" });

  const body = card.querySelector<HTMLElement>(".body")!;
  const stopBtn = card.querySelector<HTMLButtonElement>(".stop")!;
  const copyBtn = card.querySelector<HTMLButtonElement>(".copy")!;
  const retryBtn = card.querySelector<HTMLButtonElement>(".retry")!;
  const otherBtn = card.querySelector<HTMLButtonElement>(".other")!;
  const spin = card.querySelector<HTMLElement>(".spin")!;

  const controller = new AbortController();
  stopBtn.onclick = () => controller.abort();

  let text = "";
  let frame = 0;
  if (job.auto) autoBusy = true;
  try {
    await generateAnswer({
      engine,
      apiKey,
      model: engine === "gemini" ? settings.geminiModel : settings.model,
      effort: settings.effort,
      org: settings.org,
      docs,
      context: job.context,
      recent: job.recent,
      signal: controller.signal,
      onText: (delta) => {
        text += delta;
        if (!frame) {
          frame = requestAnimationFrame(() => {
            frame = 0;
            body.innerHTML = renderAnswer(text);
          });
        }
      },
    });
    cancelAnimationFrame(frame);
    if (text.trim().startsWith(NO_QUESTION)) {
      if (job.auto) {
        card.remove();
        return;
      }
      body.innerHTML =
        '<div class="line muted">질문을 찾지 못했습니다. 자막에서 질문이 시작된 줄을 누른 뒤 다시 「답변 만들기」를 누르세요.</div>';
    } else {
      body.innerHTML = renderAnswer(text);
    }
    spin.textContent = "";
  } catch (err) {
    cancelAnimationFrame(frame);
    if (text) body.innerHTML = renderAnswer(text);
    spin.textContent = "";
    const msg = describeError(err);
    body.insertAdjacentHTML("beforeend", `<div class="line error">${escapeHtml(msg)}</div>`);
  } finally {
    if (job.auto) autoBusy = false;
    card.classList.remove("loading");
    stopBtn.hidden = true;
    copyBtn.hidden = !text;
    retryBtn.hidden = false;
    // 다른 AI 키가 있을 때만 "다른 AI로" 버튼을 보인다
    otherBtn.hidden = !(other === "gemini" ? settings.geminiKey : settings.apiKey);
  }

  copyBtn.onclick = async () => {
    try {
      await navigator.clipboard.writeText(text);
      toast("복사했습니다.");
    } catch {
      toast("복사하지 못했습니다.");
    }
  };
  retryBtn.onclick = () => {
    card.remove();
    void runJob({ ...job, auto: false }, engine);
  };
  otherBtn.onclick = () => {
    void runJob({ ...job, auto: false }, other);
  };
}

$("btn-answer").addEventListener("click", () => void answerFromTranscript(false));

$("btn-manual").addEventListener("click", () => {
  const q = $<HTMLTextAreaElement>("manual-q").value.trim();
  if (!q) {
    toast("질문을 입력하세요.");
    return;
  }
  void runJob({ recent: q, context: "", source: "직접입력", auto: false });
});

// ---------- 자료 ----------

function renderDocs(): void {
  const list = $("doc-list");
  const total = docs.reduce((n, d) => n + d.text.length, 0);
  $("doc-summary").textContent = docs.length
    ? `등록된 자료 ${docs.length}건 · 약 ${total.toLocaleString()}자`
    : "등록된 자료가 없습니다. 자료 없이도 동작하지만, 수치가 필요한 답변은 모두 '확인 필요'로 나옵니다.";
  list.innerHTML = docs
    .map(
      (d) => `<li data-id="${d.id}">
        <div><b>${escapeHtml(d.name)}</b><small>${d.text.length.toLocaleString()}자</small></div>
        <details><summary>내용 보기</summary><pre>${escapeHtml(d.text.slice(0, 3000))}${d.text.length > 3000 ? "\n…" : ""}</pre></details>
        <button class="btn small ghost del">삭제</button>
      </li>`,
    )
    .join("");
}

$("doc-list").addEventListener("click", async (e) => {
  const btn = (e.target as HTMLElement).closest(".del");
  if (!btn) return;
  const id = btn.closest("li")?.dataset.id;
  const doc = docs.find((d) => d.id === id);
  if (!doc || !confirm(`「${doc.name}」을(를) 삭제할까요?`)) return;
  docs = docs.filter((d) => d.id !== id);
  await persistDocs();
});

async function persistDocs(): Promise<void> {
  try {
    await saveDocs(docs);
  } catch {
    toast("자료를 저장하지 못했습니다. 이번 접속 동안만 유지됩니다.");
  }
  renderDocs();
}

$<HTMLInputElement>("file-input").addEventListener("change", async (e) => {
  const input = e.target as HTMLInputElement;
  const files = Array.from(input.files ?? []);
  input.value = "";
  for (const file of files) {
    toast(`「${file.name}」 읽는 중…`);
    try {
      const text = await fileToText(file);
      if (!text.trim()) throw new Error("글자를 찾지 못했습니다 (스캔 이미지 PDF일 수 있음).");
      docs.push(newDoc(file.name.replace(/\.[^.]+$/, ""), text));
      await persistDocs();
      toast(`「${file.name}」 등록 완료 (${text.length.toLocaleString()}자)`);
    } catch (err) {
      toast(`「${file.name}」 실패: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
});

$("btn-paste").addEventListener("click", async () => {
  const nameEl = $<HTMLInputElement>("paste-name");
  const textEl = $<HTMLTextAreaElement>("paste-text");
  if (!textEl.value.trim()) {
    toast("내용을 붙여넣으세요.");
    return;
  }
  docs.push(newDoc(nameEl.value.trim() || "붙여넣은 자료", textEl.value));
  nameEl.value = "";
  textEl.value = "";
  await persistDocs();
  toast("등록했습니다.");
});

// ---------- 설정 화면 ----------

function bindSettings(): void {
  const apiKey = $<HTMLInputElement>("api-key");
  const org = $<HTMLInputElement>("org");
  const model = $<HTMLSelectElement>("model");
  const effort = $<HTMLSelectElement>("effort");
  const silence = $<HTMLSelectElement>("silence");
  const font = $<HTMLSelectElement>("font");

  model.innerHTML = MODELS.map((m) => `<option value="${m.id}">${m.label}</option>`).join("");

  apiKey.value = settings.apiKey;
  org.value = settings.org;
  model.value = settings.model;
  effort.value = settings.effort;
  silence.value = String(settings.silenceSec);
  font.value = String(settings.font);
  autoEl.checked = settings.auto;
  document.documentElement.style.setProperty("--scale", String(settings.font));

  apiKey.addEventListener("change", () => {
    settings.apiKey = apiKey.value.trim();
    saveSettings();
  });
  org.addEventListener("change", () => {
    settings.org = org.value;
    saveSettings();
  });
  model.addEventListener("change", () => {
    settings.model = model.value;
    saveSettings();
  });
  effort.addEventListener("change", () => {
    settings.effort = effort.value as Effort;
    saveSettings();
  });
  silence.addEventListener("change", () => {
    settings.silenceSec = Number(silence.value);
    saveSettings();
  });
  font.addEventListener("change", () => {
    settings.font = Number(font.value);
    document.documentElement.style.setProperty("--scale", font.value);
    saveSettings();
  });
  autoEl.addEventListener("change", () => {
    settings.auto = autoEl.checked;
    saveSettings();
    if (!settings.auto) window.clearTimeout(silenceTimer);
  });

  // 답변 AI 선택 (회의 화면)
  const engineRadios = document.querySelectorAll<HTMLInputElement>('input[name="engine"]');
  engineRadios.forEach((r) => {
    r.checked = r.value === settings.engine;
    r.addEventListener("change", () => {
      if (!r.checked) return;
      settings.engine = r.value as Engine;
      saveSettings();
      const key = settings.engine === "gemini" ? settings.geminiKey : settings.apiKey;
      if (!key) toast(`⚙️설정에서 ${ENGINE_LABEL[settings.engine]} API 키를 입력하세요.`);
    });
  });

  // Gemini
  const geminiKey = $<HTMLInputElement>("gemini-key");
  const geminiModel = $<HTMLSelectElement>("gemini-model");
  const fillGeminiModels = (names: string[]) => {
    const all = Array.from(new Set([GEMINI_DEFAULT_MODEL, settings.geminiModel, ...names]));
    geminiModel.innerHTML = all
      .map((n) => `<option value="${escapeHtml(n)}">${escapeHtml(n)}${n === GEMINI_DEFAULT_MODEL ? " (기본)" : ""}</option>`)
      .join("");
    geminiModel.value = settings.geminiModel;
  };
  fillGeminiModels([]);
  geminiKey.value = settings.geminiKey;
  geminiKey.addEventListener("change", () => {
    settings.geminiKey = geminiKey.value.trim();
    saveSettings();
  });
  geminiModel.addEventListener("change", () => {
    settings.geminiModel = geminiModel.value;
    saveSettings();
  });
  $("btn-gemini-models").addEventListener("click", async () => {
    if (!settings.geminiKey) {
      toast("Gemini API 키를 먼저 입력하세요.");
      return;
    }
    toast("모델 목록을 불러오는 중…");
    try {
      const { listGeminiModels } = await import("./gemini");
      const names = await listGeminiModels(settings.geminiKey);
      fillGeminiModels(names);
      toast(`모델 ${names.length}개를 불러왔습니다. 모르면 기본값을 그대로 두세요.`);
    } catch (err) {
      toast(describeError(err));
    }
  });
}

// ---------- 시작 ----------

bindSettings();
renderTranscript();
updateListenButton();
void loadDocs().then((d) => {
  docs = d;
  renderDocs();
});
if (!settings.apiKey && !settings.geminiKey) toast("처음이시면 ⚙️설정에서 API 키를, 📄자료에서 업무보고서를 등록하세요.");
