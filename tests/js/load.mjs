// assets/secretary.js 는 브라우저용 단일 파일이라 모듈로 가져올 수 없다 — 시험할 함수 구간만 잘라 격리된 공간에서 실행한다.
import fs from "node:fs";
import vm from "node:vm";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SRC = fs.readFileSync(path.join(ROOT, "assets", "secretary.js"), "utf8");

function slice(from, to) {
  const a = SRC.indexOf(from), b = SRC.indexOf(to, a + 1);
  if (a < 0 || b < 0) throw new Error(`구간을 찾지 못함: ${from} … ${to}`);
  return SRC.slice(a, b);
}

export function load(today = "2026-10-08") {
  const ctx = vm.createContext({ S: { moreOpen: {}, cfg: {}, holidays: {} }, console, TextEncoder, TextDecoder, atob });
  const code = [
    "const esc=s=>String(s==null?'':s).replace(/[&<>\"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;',\"'\":'&#39;'}[c]));",
    "const norm=s=>String(s||'').replace(/\\s+/g,'').toLowerCase();",
    "const uid=()=>Math.random().toString(36).slice(2,10);",
    slice("// 캘린더 파일(.ics)", "function ymd(d)"),
    slice("function ymd(d)", "\n") + "\n",
    `function today(){ return ${JSON.stringify(today)}; }`,
    slice("function addDays(s, n)", "\n") + "\n",
    slice("const WD='일월화수목금토';", "\n// ──"),
    slice("// ── 한눈에 읽기", "function keyFactsHtml(p){"),
    slice("function _h(t)", "function reconcileAll(){"),
    slice("// ── 메일에서 일정 가져오기", "// 끌어다 놓기·붙여넣기"),
    // AI 산출물 보고·AI 초안 자료(이 건의 메모·일정·증빙)
    slice("const AI_KIND=", "function aiEvent("),
    slice("const AI_QA=", "\n") + "\n",
    slice("// 월별 AI 산출물 보고", "function aiReportCard(){"),
    slice("function fmtLong(s)", "\n") + "\n",
    "const receipts=c=>(c&&c.receipts)||[]; const scheds=()=>[]; const getProc=()=>null;",
    slice("// AI 초안 자료", "function openDraft(key){"),
    "this.T={parseSchedText,parseIcs,emlToText,schedTime,icsFold,hl,brief,keyFacts,parseDates,reconcileCase,procKeys,stepKey,aiMonth,aiReportText,draftSources};",
  ].join("\n");
  vm.runInContext(code, ctx);
  return ctx.T;
}
