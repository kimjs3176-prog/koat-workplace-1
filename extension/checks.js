// 서무비서 확장 — 결재 전 입력값 점검(화면 값 읽기 결과 → 반려 점검 항목별 판정)
// 절차 데이터의 반려 점검 항목에 붙은 check 규칙을 ERP 화면에서 읽은 날짜·시각·첨부 수로 판정한다.
// 읽은 값은 이 브라우저 안에서 판정에만 쓰고, 기록·전송하지 않는다(진단 기록에는 판정 개수만).
//   deadline {ref, days}  — 오늘이 기준일(ref)+days 이하인지(예: 출장 마친 날 다음 날부터 14일 이내 정산)
//   lead     {ref, days}  — 오늘이 기준일-days 이하인지(예: 출국 10일 전까지 제출, 휴가 시작 전 등록)
//   nextmonth{ref, day}   — 기준일 다음 달 day 일까지
//   attach                — 첨부가 1개 이상
//   hours    {max}        — 근무 시각(시작~끝)이 max 시간 이하
//   span     {from, to}   — 근무 시각이 from~to 를 모두 덮는지(공동근무시간)
//   deleg    {blocks}     — 화면 금액으로 위임전결규칙 [별표]의 전결권자를 짚는다(판정이 아니라 안내 — 결재선은 사람이 확인)
(() => {
  const pad = (n) => String(n).padStart(2, "0");
  const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const addDays = (s, n) => { const [y, m, d] = s.split("-").map(Number); const t = new Date(y, m - 1, d); t.setDate(t.getDate() + n); return ymd(t); };
  const md = (s) => { const [, m, d] = s.split("-").map(Number); return `${m}.${d}`; };
  function parseDate(v) {
    const m = String(v || "").match(/((?:19|20)\d{2})\s*[.\-\/년]\s*(\d{1,2})\s*[.\-\/월]\s*(\d{1,2})(?!\d)/) || String(v || "").match(/^((?:19|20)\d{2})(\d{2})(\d{2})$/);
    if (!m) return "";
    const d = new Date(+m[1], +m[2] - 1, +m[3]);
    return d.getMonth() === +m[2] - 1 ? ymd(d) : "";
  }
  // '오후 06:00'·'PM 6:30' 은 12시간을 더하고, '3시간'(걸린 시간)은 시각이 아니다
  function parseTimes(v) {
    return [...String(v || "").matchAll(/(?:(오전|오후|AM|PM)\s*)?(?<!\d)([01]?\d|2[0-4])\s*(?::|시(?!간))\s*([0-5]\d)?/gi)].map((m) => {
      let h = +m[2]; const ap = (m[1] || "").toUpperCase();
      if ((ap === "오후" || ap === "PM") && h < 12) h += 12; else if ((ap === "오전" || ap === "AM") && h === 12) h = 0;
      return h * 60 + (+m[3] || 0);
    }).filter((t) => t <= 1440);
  }
  // 문서 작성일·결재일처럼 업무 날짜가 아닌 칸은 뺀다
  const NOT_WORK = /작성|기안|신청일|등록일|결재|접수|처리일|수정일|생년|입사|오늘|조회/;
  const END = /종료|도착|복귀|귀국|귀임|마친|끝|까지|만료/;
  const START = /시작|출발|출국|개시|부터|사용일|사용\s*예정|출장일|휴가일|근무일|일자|기간|일시|날짜/;
  // fields: [{label, value, row}] (row: 같은 줄·묶음 번호 — '기간 [시작] ~ [끝]' 처럼 이름 없는 둘째 칸을 잇는다)
  // 기관 ERP 의 칸 이름(기관 설정 › ERP › 칸 이름)을 기본 낱말에 더한다
  const esc = (w) => String(w).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // 영문 칸 이름('To'·'From')은 낱말 경계로, 대소문자 없이 — 'Total'·'Today' 에 걸리지 않게
  const wordRx = (w) => (/^[A-Za-z][A-Za-z ]*$/.test(w) ? "\\b" + esc(w) + "\\b" : esc(w));
  const plus = (rx, words) => (words && words.length ? new RegExp(rx.source + "|" + words.map(wordRx).join("|"), "i") : rx);
  const hasWord = (l, words) => (words || []).some((w) => new RegExp(wordRx(w), "i").test(l));
  function readDates(fields, labels) {
    labels = labels || {};
    const NOT_WORK2 = plus(NOT_WORK, labels.ignore), END2 = plus(END, labels.end), START2 = plus(START, labels.start);
    const isEnd = (l) => hasWord(l, labels.end) || (!hasWord(l, labels.start) && END2.test(l));
    // '출발일 ~ 도착일'·'시작일~종료일' 처럼 한 이름이 앞뒤를 다 가리키면 화면 순서대로 앞 = 시작, 뒤 = 끝
    const both = (l) => !hasWord(l, labels.end) && !hasWord(l, labels.start) && START2.test(l) && END2.test(l);
    const out = {}, lb = {};
    const ds = fields.map((f) => ({ ...f, d: parseDate(f.value) })).filter((f) => f.d && !NOT_WORK2.test(f.label || ""));
    for (const f of ds) {
      const l = f.label || "";
      if (both(l)) { if (!out.start) { out.start = f.d; lb.start = l; } else if (!out.end) { out.end = f.d; lb.end = l; } }
      else if (isEnd(l) && !out.end) { out.end = f.d; lb.end = l; }
      else if (START2.test(l) && !out.start) {
        out.start = f.d; lb.start = l;
        const mate = ds.find((g) => g !== f && g.row === f.row && g.d >= f.d && !isEnd(g.label || "") && (g.label === f.label || !START2.test(g.label || "")));
        if (mate && !out.end) { out.end = mate.d; lb.end = mate.label || l; }              // 같은 줄의 이름 없는 둘째 날짜 = 끝
      }
    }
    if (!out.start && ds.length) {
      out.start = ds[0].d; lb.start = ds[0].label;
      // 이름으로 시작·끝을 못 가렸으면 같은 줄의 뒤 날짜를 끝으로('출장 [국내▾] [시작] ~ [끝]')
      const mate = !out.end && ds.find((g) => g !== ds[0] && g.row === ds[0].row && g.d > ds[0].d);
      if (mate) { out.end = mate.d; lb.end = mate.label; }
    }
    if (out.start && !out.end) { out.end = out.start; lb.end = lb.start; }          // 하루짜리
    Object.defineProperty(out, "_l", { value: lb, enumerable: false });   // 판정에 쓴 칸 이름(카드에 '도착일 칸 기준'으로 보여 줌)
    return out;
  }
  // 근무 시각: 업무가 아닌 칸(작성·처리 시각)은 빼고, 같은 줄의 시작~끝 쌍을 쓴다. 여러 쌍이면 시간외·초과 칸을 먼저
  function readTimes(fields, labels) {
    const NOT = plus(NOT_WORK, (labels || {}).ignore);
    const cand = fields.filter((f) => !NOT.test(f.label || "") && (/시간|근무|시각|출근|퇴근|시작|종료/.test(f.label || "") || /^\s*\d{1,2}:\d{2}\s*$/.test(f.value || "")));
    const rows = new Map();
    for (const f of cand) { const ts = parseTimes(f.value); if (ts.length) { const r = rows.get(f.row) || { label: f.label, ts: [] }; r.ts.push(...ts); rows.set(f.row, r); } }
    const pairs = [...rows.values()].filter((r) => r.ts.length >= 2);
    const pick = pairs.find((r) => /시간외|초과|연장|야간/.test(r.label || "")) || pairs[0];
    if (pick) return { from: pick.ts[0], to: pick.ts[1] };
    const all = cand.flatMap((f) => parseTimes(f.value));
    return all.length >= 2 ? { from: all[0], to: all[1] } : null;
  }
  // 금액: '3,300,000' · '330만원' · '1억 5천만' → 원. 단가·수량·번호 칸은 뺀다
  const UNIT = { 억: 1e8, 천만: 1e7, 백만: 1e6, 십만: 1e5, 만: 1e4, 천: 1e3 };
  function parseAmount(v) {
    const t = String(v || "").replace(/[\s,]|원$/g, "");
    if (!/^(\d+(\.\d+)?(억|천만|백만|십만|만|천)?)+$/.test(t)) return 0;
    let n = 0; for (const m of t.matchAll(/(\d+(?:\.\d+)?)(억|천만|백만|십만|만|천)?/g)) n += +m[1] * (UNIT[m[2]] || 1);
    return Math.round(n);
  }
  function readAmount(fields) {
    let best = null;
    for (const f of fields || []) {
      const l = f.label || "";
      if (!/금액|합계|총액|추정|소요|예산액|사용액|결제액|계약액|집행액|비용/.test(l) || /단가|수량|번호|코드|비율|잔액|부가세|세액/.test(l)) continue;
      const n = parseAmount(f.value);
      if (n >= 1000 && (!best || n > best.n)) best = { n, label: l };
    }
    return best;
  }
  // 금액 구간 줄 가운데 맞는 줄 — 맞는 '미만·이하' 중 가장 좁은 것, 없으면 맞는 '이상·초과' 중 가장 큰 것(서버 _sec_deleg_pick 과 같음)
  function delegPick(tiers, n) {
    const ok = (t) => ({ ge: n >= t.amt, gt: n > t.amt, lt: n < t.amt, le: n <= t.amt })[t.op];
    const gen = tiers.filter((t) => !t.q && ok(t)), lo = gen.filter((t) => t.op === "lt" || t.op === "le"), hi = gen.filter((t) => t.op === "ge" || t.op === "gt");
    let pick = lo.length ? lo.reduce((a, b) => (b.amt < a.amt ? b : a)) : hi.length ? hi.reduce((a, b) => (b.amt > a.amt ? b : a)) : null;
    const sp = tiers.find((t) => t.q && ok(t)); if (sp) pick = sp;              // '물품 구매의 경우 5백만원 미만' 같은 특례
    return pick;
  }
  function evaluate(pitfalls, screen, today, labels) {
    const dates = readDates(screen.fields || [], labels), times = readTimes(screen.fields || [], labels);
    const at = (k) => { const l = String(((dates._l || {})[k]) || "").trim(); return l ? `'${l.slice(0, 12)}' 칸` : "화면 날짜"; };
    const res = (pitfalls || []).map((p) => {
      const c = p && p.check; if (!c || !c.kind) return null;
      const ref = c.ref && dates[c.ref];
      if (c.kind === "deadline" && ref) { const due = addDays(ref, +c.days || 0);
        return today <= due ? { ok: true, note: `기한 ${md(due)}까지 — ${at(c.ref)} ${md(ref)} 기준` } : { ok: false, note: `기한 ${md(due)}이(가) 지났습니다(${at(c.ref)} ${md(ref)})` }; }
      if (c.kind === "lead" && ref) { const due = addDays(ref, -(+c.days || 0));
        return today <= due ? { ok: true, note: `${md(due)}까지 — ${at(c.ref)} ${md(ref)} 기준` } : { ok: false, note: `${md(due)}까지였습니다(${at(c.ref)} ${md(ref)}, 오늘 ${md(today)})` }; }
      if (c.kind === "nextmonth" && ref) { const [y, m] = ref.split("-").map(Number); const due = ymd(new Date(y, m, +c.day || 5));
        return today <= due ? { ok: true, note: `${md(due)}까지` } : { ok: false, note: `${md(due)}까지였습니다(${at(c.ref)} ${md(ref)})` }; }
      if (c.kind === "attach" && typeof screen.attach === "number")
        return screen.attach > 0 ? { ok: true, note: `첨부 ${screen.attach}건` } : { ok: false, note: "화면에 첨부가 없습니다" };
      if (c.kind === "hours" && times) { const h = (times.to - times.from) / 60;
        return h > 0 && h <= (+c.max || 0) ? { ok: true, note: `${h}시간` } : h > 0 ? { ok: false, note: `${h}시간 — 하루 ${c.max}시간 넘음` } : null; }
      if (c.kind === "span" && times && times.to > times.from) { const toM = (s) => { const [h, mm] = s.split(":").map(Number); return h * 60 + mm; };
        return times.from <= toM(c.from) && times.to >= toM(c.to) ? { ok: true, note: `${c.from}~${c.to} 포함` } : { ok: false, note: `근무 시각이 ${c.from}~${c.to}를 덮지 않습니다` }; }
      if (c.kind === "deleg") { const a = readAmount(screen.fields); if (!a) return null;
        const parts = (c.blocks || []).map((b) => { const t = delegPick(b.tiers || [], a.n); return t ? `${b.title}: ${t.who}` : ""; }).filter(Boolean);
        return parts.length ? { ok: true, note: `'${a.label.slice(0, 12)}' ${a.n.toLocaleString("ko-KR")}원 → 전결권자 ${parts.join(" · ")} — 결재선에 있는지 확인` } : null; }
      return null;                                            // 화면에서 값을 못 읽음 — 사람이 확인
    });
    if (dates.start && dates.end && dates.start > dates.end) res.extra = { ok: false, note: `시작일(${md(dates.start)})이 끝난 날(${md(dates.end)})보다 늦습니다` };
    return res;
  }
  // 첨부 수: 첨부 목록 글('첨부파일 (2)', '첨부 0건', '첨부된 파일이 없습니다')이나 채워진 파일 칸으로 센다. 못 읽으면 undefined
  function countAttach(text, fileInputs) {
    const t = String(text || "");
    // 숫자가 있는 첨부 목록 글을 먼저 — '※ 증빙 첨부파일이 없는 경우 반려' 같은 안내문 때문에 0으로 보지 않게
    const m = t.match(/(?:첨부|파일\s*첨부|Attachments?)\s*(?:파일|문서)?\s*[(\[:]?\s*(\d{1,3})\s*(?:건|개|\)|\])/i);
    if (m) return +m[1];
    const filled = (fileInputs || []).reduce((n, f) => n + ((f.files && f.files.length) || 0), 0);
    if (filled) return filled;
    if (/(^|\n)\s*(?:첨부(된)?\s*파일(이)?\s*없(습니다|음)\.?|No attachments?\.?)\s*($|\n)/im.test(t)) return 0;
    return undefined;
  }
  globalThis.SEC_CHECK = { evaluate, readDates, readTimes, parseDate, countAttach, parseAmount, readAmount, delegPick };
})();
