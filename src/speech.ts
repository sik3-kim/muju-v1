// 브라우저 내장 음성인식(Web Speech API) 래퍼.
// Android Chrome / iOS Safari 에서 한국어(ko-KR) 연속 인식을 하고,
// 브라우저가 인식 세션을 끊으면(무음·시간 초과 등) 자동으로 다시 시작한다.

interface SRAlternative {
  transcript: string;
}
interface SRResult {
  readonly isFinal: boolean;
  readonly length: number;
  [index: number]: SRAlternative;
}
interface SRResultEvent {
  readonly resultIndex: number;
  readonly results: { readonly length: number; [index: number]: SRResult };
}
interface SRErrorEvent {
  readonly error: string;
}
interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  onresult: ((e: SRResultEvent) => void) | null;
  onerror: ((e: SRErrorEvent) => void) | null;
  onend: (() => void) | null;
  onstart: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}
type SRConstructor = new () => SpeechRecognitionLike;

function getCtor(): SRConstructor | undefined {
  const w = window as unknown as {
    SpeechRecognition?: SRConstructor;
    webkitSpeechRecognition?: SRConstructor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition;
}

export type ListenerState = "listening" | "stopped" | "error";

export class Listener {
  /** replacesPrevious: 직전 확정 문장이 더 길어진 것이면 true (새 줄 대신 앞줄을 바꿔야 함) */
  onFinal: (text: string, replacesPrevious: boolean) => void = () => {};
  onInterim: (text: string) => void = () => {};
  onState: (state: ListenerState, message?: string) => void = () => {};

  private rec: SpeechRecognitionLike | null = null;
  private wanted = false;
  private failures = 0;

  static supported(): boolean {
    return getCtor() !== undefined;
  }

  get active(): boolean {
    return this.wanted;
  }

  start(): void {
    if (this.wanted) return;
    this.wanted = true;
    this.failures = 0;
    this.spawn();
  }

  stop(): void {
    this.wanted = false;
    this.rec?.stop();
    this.onInterim("");
  }

  private spawn(): void {
    const Ctor = getCtor();
    if (!Ctor) {
      this.wanted = false;
      this.onState("error", "이 브라우저는 음성인식을 지원하지 않습니다. Android는 Chrome, iPhone은 Safari를 사용하세요.");
      return;
    }
    const rec = new Ctor();
    rec.lang = "ko-KR";
    rec.continuous = true;
    rec.interimResults = true;
    rec.maxAlternatives = 1;

    // Android Chrome 은 말하는 도중의 문장을 조금씩 늘려 가며 여러 번 final 로 보낸다
    // ("농공단지" → "농공단지 입주율은" → …). 직전 확정 문장이 이어진 것이면 새 줄 대신 바꿔치기한다.
    let lastFinal = "";
    let lastFinalAt = 0;

    rec.onstart = () => {
      this.onState("listening");
    };
    rec.onresult = (e) => {
      this.failures = 0;
      let interim = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        const text = r[0]?.transcript ?? "";
        if (r.isFinal) {
          const t = text.trim();
          if (!t) continue;
          const now = Date.now();
          const cur = squash(t);
          const prev = squash(lastFinal);
          const recent = now - lastFinalAt < 10_000;
          // 같은 문장이거나 이미 받은 문장의 앞부분이면 무시
          if (prev && recent && prev.startsWith(cur)) continue;
          const extends_ = Boolean(prev) && recent && cur.startsWith(prev);
          lastFinal = t;
          lastFinalAt = now;
          this.onFinal(t, extends_);
        } else {
          interim += text;
        }
      }
      this.onInterim(interim.trim());
    };
    rec.onerror = (e) => {
      if (e.error === "not-allowed" || e.error === "service-not-allowed") {
        this.wanted = false;
        this.onState("error", "마이크 권한이 없습니다. 브라우저 주소창의 자물쇠 아이콘에서 마이크를 허용하세요.");
      } else if (e.error === "network") {
        this.failures++;
      } else if (e.error === "audio-capture") {
        this.wanted = false;
        this.onState("error", "마이크를 사용할 수 없습니다. 다른 앱이 마이크를 쓰고 있는지 확인하세요.");
      }
      // no-speech, aborted 등은 onend 에서 재시작한다.
    };
    rec.onend = () => {
      this.rec = null;
      this.onInterim("");
      if (!this.wanted) {
        this.onState("stopped");
        return;
      }
      if (this.failures >= 5) {
        this.wanted = false;
        this.onState("error", "음성인식 서버 연결이 계속 실패합니다. 인터넷(와이파이/5G) 연결을 확인하세요.");
        return;
      }
      // 연속 실패 시 조금씩 늦춰서 재시작
      setTimeout(() => {
        if (this.wanted) this.spawn();
      }, 200 + this.failures * 1000);
    };

    this.rec = rec;
    try {
      rec.start();
    } catch {
      // 시작 자체가 실패하면 onend 가 오지 않으므로 직접 재시도한다
      this.rec = null;
      this.failures++;
      if (this.failures >= 5) {
        this.wanted = false;
        this.onState("error", "음성인식을 시작하지 못했습니다. 페이지를 새로고침한 뒤 다시 시도하세요.");
        return;
      }
      setTimeout(() => {
        if (this.wanted) this.spawn();
      }, 1000);
    }
  }
}

/** 띄어쓰기·문장부호 차이는 무시하고 비교 */
function squash(s: string): string {
  return s.replace(/[\s.,?!]/g, "");
}
