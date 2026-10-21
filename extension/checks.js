// 서무비서 확장 — 결재 전 입력값 점검(화면 값 읽기 결과 → 반려 점검 항목별 판정)
// 절차 데이터의 반려 점검 항목에 붙은 check 규칙을 ERP 화면에서 읽은 날짜·시각·첨부 수로 판정한다.
// 읽은 값은 이 브라우저 안에서 판정에만 쓰고, 기록·전송하지 않는다(진단 기록에는 판정 개수만).
//   deadline {ref, days}  — 오늘이 기준일(ref)+days 이하인지(예: 출장 마친 날 다음 날부터 14일 이내 정산)
//   lead     {ref, days}  — 오늘이 기준일-days 이하인지(예: 출국 10일 전까지 제출, 휴가 시작 전 등록)
//   nextmonth{ref, day}   — 기준일 다음 달 day 일까지
//   attach                — 첨부가 1개 이상
//   hours    {max}        — 근무 시각(시작~끝)이 max 시간 이하
//   span     {from, to}   — 근무 시각이 from~to 를 모두 덮는지(공동근무시간)
(() => {
  const pad = (n) => String(n).padStart(2, "0");
  const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const addDays = (s, n) => { const [y, m, d] = s.split("-").map(Number); const t = new Date(y, m - 1, d); t.setDate(t.getDate() + n); return ymd(t); };
  const md = (s) => { const [, m, d] = s.split("-").map(Number); return `${m}.${d}`; };
  function parseDate(v) {
    const m = String(v || "").match(/((?:19|20)\d{2})\s*[.\-\/년]\s*(\d{1,2})\s*[.\-\/월]\s*(\d{1,2})/) || String(v || "").match(/^((?:19|20)\d{2})(\d{2})(\d{2})$/);
    if (!m) return "";
    const d = new Date(+m[1], +m[2] - 1, +m[3]);
    return d.getMonth() === +m[2] - 1 ? ymd(d) : "";
  }
  function parseTimes(v) {
    return [...String(v || "").matchAll(/(?<!\d)([01]?\d|2[0-3])\s*[:시]\s*([0-5]\d)?/g)].map((m) => +m[1] * 60 + (+m[2] || 0));
  }
  // 문서 작성일·결재일처럼 업무 날짜가 아닌 칸은 뺀다
  const NOT_WORK = /작성|기안|신청일|등록일|결재|접수|처리일|수정일|생년|입사|오늘|조회/;
  const END = /종료|도착|복귀|귀국|귀임|마친|끝|까지|만료/;
  const START = /시작|출발|출국|개시|부터|사용일|사용\s*예정|출장일|휴가일|근무일|일자|기간|일시|날짜/;
  // fields: [{label, value, row}] (row: 같은 줄·묶음 번호 — '기간 [시작] ~ [끝]' 처럼 이름 없는 둘째 칸을 잇는다)
  function readDates(fields) {
    const out = {};
    const ds = fields.map((f) => ({ ...f, d: parseDate(f.value) })).filter((f) => f.d && !NOT_WORK.test(f.label || ""));
    for (const f of ds) {
      const l = f.label || "";
      if (END.test(l) && !out.end) out.end = f.d;
      else if (START.test(l) && !out.start) {
        out.start = f.d;
        const mate = ds.find((g) => g !== f && g.row === f.row && g.d >= f.d && !END.test(g.label || "") && (g.label === f.label || !START.test(g.label || "")));
        if (mate && !out.end) out.end = mate.d;              // 같은 줄의 이름 없는 둘째 날짜 = 끝
      }
    }
    if (!out.start && ds.length) out.start = ds[0].d;
    if (out.start && !out.end) out.end = out.start;          // 하루짜리
    return out;
  }
  function readTimes(fields) {
    const ts = fields.filter((f) => /시간|근무|시각|출근|퇴근|시작|종료/.test(f.label || "") || /^\s*\d{1,2}:\d{2}\s*$/.test(f.value || ""))
      .flatMap((f) => parseTimes(f.value));
    return ts.length >= 2 ? { from: ts[0], to: ts[1] } : null;
  }
  function evaluate(pitfalls, screen, today) {
    const dates = readDates(screen.fields || []), times = readTimes(screen.fields || []);
    const res = (pitfalls || []).map((p) => {
      const c = p && p.check; if (!c || !c.kind) return null;
      const ref = c.ref && dates[c.ref];
      if (c.kind === "deadline" && ref) { const due = addDays(ref, +c.days || 0);
        return today <= due ? { ok: true, note: `기한 ${md(due)}까지 — 화면 날짜 ${md(ref)} 기준` } : { ok: false, note: `기한 ${md(due)}이(가) 지났습니다(화면 날짜 ${md(ref)})` }; }
      if (c.kind === "lead" && ref) { const due = addDays(ref, -(+c.days || 0));
        return today <= due ? { ok: true, note: `${md(due)}까지 — 화면 날짜 ${md(ref)} 기준` } : { ok: false, note: `${md(due)}까지였습니다(화면 날짜 ${md(ref)}, 오늘 ${md(today)})` }; }
      if (c.kind === "nextmonth" && ref) { const [y, m] = ref.split("-").map(Number); const due = ymd(new Date(y, m, +c.day || 5));
        return today <= due ? { ok: true, note: `${md(due)}까지` } : { ok: false, note: `${md(due)}까지였습니다(화면 날짜 ${md(ref)})` }; }
      if (c.kind === "attach" && typeof screen.attach === "number")
        return screen.attach > 0 ? { ok: true, note: `첨부 ${screen.attach}건` } : { ok: false, note: "화면에 첨부가 없습니다" };
      if (c.kind === "hours" && times) { const h = (times.to - times.from) / 60;
        return h > 0 && h <= (+c.max || 0) ? { ok: true, note: `${h}시간` } : h > 0 ? { ok: false, note: `${h}시간 — 하루 ${c.max}시간 넘음` } : null; }
      if (c.kind === "span" && times) { const toM = (s) => { const [h, mm] = s.split(":").map(Number); return h * 60 + mm; };
        return times.from <= toM(c.from) && times.to >= toM(c.to) ? { ok: true, note: `${c.from}~${c.to} 포함` } : { ok: false, note: `근무 시각이 ${c.from}~${c.to}를 덮지 않습니다` }; }
      return null;                                            // 화면에서 값을 못 읽음 — 사람이 확인
    });
    if (dates.start && dates.end && dates.start > dates.end) res.extra = { ok: false, note: `시작일(${md(dates.start)})이 끝난 날(${md(dates.end)})보다 늦습니다` };
    return res;
  }
  // 첨부 수: 첨부 목록 글('첨부파일 (2)', '첨부 0건', '첨부된 파일이 없습니다')이나 채워진 파일 칸으로 센다. 못 읽으면 undefined
  function countAttach(text, fileInputs) {
    const t = String(text || "");
    if (/첨부(된)?\s*파일(이)?\s*없/.test(t)) return 0;
    const m = t.match(/첨부\s*(?:파일|문서)?\s*[(\[:]?\s*(\d{1,3})\s*(?:건|개|\)|\])/);
    if (m) return +m[1];
    const filled = (fileInputs || []).reduce((n, f) => n + ((f.files && f.files.length) || 0), 0);
    return filled || undefined;
  }
  globalThis.SEC_CHECK = { evaluate, readDates, readTimes, parseDate, countAttach };
})();
