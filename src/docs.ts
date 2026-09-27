// 답변 근거 자료(업무보고서 등) 보관과 파일 → 텍스트 변환.
// 자료는 이 휴대폰 브라우저의 IndexedDB 에만 저장된다.

import { get, set } from "idb-keyval";
import { unzipSync, strFromU8 } from "fflate";

export interface Doc {
  id: string;
  name: string;
  text: string;
  addedAt: number;
}

const KEY = "docs";

export async function loadDocs(): Promise<Doc[]> {
  try {
    return ((await get(KEY)) as Doc[] | undefined) ?? [];
  } catch {
    return [];
  }
}

export async function saveDocs(docs: Doc[]): Promise<void> {
  await set(KEY, docs);
}

export function newDoc(name: string, text: string): Doc {
  return {
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    name,
    text: normalize(text),
    addedAt: Date.now(),
  };
}

function normalize(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export async function fileToText(file: File): Promise<string> {
  const name = file.name.toLowerCase();
  if (name.endsWith(".pdf")) return pdfToText(await file.arrayBuffer());
  if (name.endsWith(".hwpx")) return hwpxToText(await file.arrayBuffer());
  if (name.endsWith(".hwp")) {
    throw new Error("HWP(구버전) 파일은 바로 읽을 수 없습니다. 한글에서 'PDF' 또는 'HWPX'로 저장한 뒤 올려주세요.");
  }
  return file.text();
}

async function pdfToText(buf: ArrayBuffer): Promise<string> {
  // PDF 라이브러리는 크기가 커서 파일을 올릴 때만 불러온다. 구형 휴대폰 브라우저 호환을 위해 legacy 빌드 사용
  const [pdfjs, { default: workerUrl }] = await Promise.all([
    import("pdfjs-dist/legacy/build/pdf.mjs"),
    import("pdfjs-dist/legacy/build/pdf.worker.min.mjs?url"),
  ]);
  pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
  const task = pdfjs.getDocument({
    data: new Uint8Array(buf),
    // 한글 CID 글꼴 PDF 의 글자 추출에 필요한 문자표
    cMapUrl: `https://cdn.jsdelivr.net/npm/pdfjs-dist@${pdfjs.version}/cmaps/`,
    cMapPacked: true,
    standardFontDataUrl: `https://cdn.jsdelivr.net/npm/pdfjs-dist@${pdfjs.version}/standard_fonts/`,
  });
  const pdf = await task.promise;
  const pages: string[] = [];
  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const content = await page.getTextContent();
    let line = "";
    for (const item of content.items) {
      if (!("str" in item)) continue;
      line += item.str;
      if (item.hasEOL) line += "\n";
    }
    pages.push(`[${p}쪽]\n${line}`);
  }
  await task.destroy();
  return pages.join("\n\n");
}

function hwpxToText(buf: ArrayBuffer): string {
  const files = unzipSync(new Uint8Array(buf), {
    filter: (f) => /^Contents\/section\d+\.xml$/i.test(f.name),
  });
  const sections = Object.keys(files).sort(
    (a, b) => Number(a.match(/\d+/)?.[0] ?? 0) - Number(b.match(/\d+/)?.[0] ?? 0),
  );
  if (sections.length === 0) throw new Error("HWPX 본문을 찾지 못했습니다.");
  const out: string[] = [];
  for (const s of sections) {
    const xml = new DOMParser().parseFromString(strFromU8(files[s]), "application/xml");
    // 문단(p) 단위로 글자(t)를 모은다. 표 안의 문단은 그 문단에서 따로 모이므로 바깥 문단에서는 뺀다.
    for (const p of Array.from(xml.getElementsByTagNameNS("*", "p"))) {
      const texts = Array.from(p.getElementsByTagNameNS("*", "t"))
        .filter((t) => nearestParagraph(t) === p)
        .map((t) => t.textContent ?? "");
      const line = texts.join("");
      if (line.trim()) out.push(line);
    }
  }
  return out.join("\n");
}

function nearestParagraph(el: Element): Element | null {
  let e = el.parentElement;
  while (e && e.localName !== "p") e = e.parentElement;
  return e;
}
