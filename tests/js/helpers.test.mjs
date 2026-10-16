import test from "node:test";
import assert from "node:assert/strict";
import { load } from "./load.mjs";

const T = load("2026-10-08");
const plain = (v) => JSON.parse(JSON.stringify(v));   // vm 안에서 만든 값은 다른 realm 이라 깊은 비교 전에 평범한 값으로
const marks = (html) => [...html.matchAll(/<mark class="sec-k (\w)">([^<]*)<\/mark>/g)].map((m) => `${m[1]}:${m[2]}`);

test("hl: 금액·기간·날짜·비율을 종류별로 강조", () => {
  assert.deepEqual(marks(T.hl("4시간 이상 2만원, 7월 10일까지 30% 이내")), ["p:4시간 이상", "m:2만원", "d:7월 10일까지", "n:30% 이내"]);
  assert.deepEqual(marks(T.hl("상한액의 10분의 3 이내")), ["n:10분의 3 이내"]);
});

test("hl: 조문 번호·낱말 속 숫자는 강조하지 않음", () => {
  assert.deepEqual(marks(T.hl("「여비규정」 제17조")), []);
  assert.deepEqual(marks(T.hl("출장 1일반, 불만 원인")), []);
});

test("hl: HTML 을 escape 한다", () => {
  assert.ok(!T.hl("<img src=x onerror=alert(1)> 5만원").includes("<img"));
});

test("hl: 긴 숫자열에도 빠르게 끝난다", () => {
  const t0 = Date.now(); T.hl("1,".repeat(20000)); assert.ok(Date.now() - t0 < 500);
});

test("brief: 긴 문장은 요약 + 나머지, 규정 인용은 꼬리표로", () => {
  const b = T.brief("근무지내 출장(같은 시·군이거나 여행거리 40km 미만): 4시간 이상 2만원, 4시간 미만 1만원. 공용차량을 쓰면 1만원 감액(「여비규정」 제17조).");
  assert.equal(b.cites[0], "여비규정 제17조");
  assert.ok(b.head.length < 70 && b.rest.length > 0);
});

test("keyFacts: 숫자가 든 괄호·(Ⅰ) 구분은 남긴다", () => {
  const f = T.keyFacts({ tips: ["육아휴직은 자녀 1명에 대해 1년(여성 직원 3년) 이내입니다.", "민간인 강사료: 일반강사(Ⅰ) 1시간 30만원, 일반강사(Ⅱ) 1시간 20만원"], steps: [] }).map((x) => x.seg);
  assert.ok(f.some((s) => s.includes("1년(여성 직원 3년)")));
  assert.ok(f.some((s) => s.includes("(Ⅰ)")) && f.some((s) => s.includes("(Ⅱ)")));
});

test("parseDates: 상대·절대 날짜와 지난 일의 연도", () => {
  assert.deepEqual(plain(T.parseDates("내일모레 출장", "2026-10-08").dates), ["2026-10-10"]);
  assert.deepEqual(plain(T.parseDates("10월 5일부터 7일까지 출장", "2026-10-08").dates), ["2026-10-05", "2026-10-07"]);
  assert.deepEqual(plain(T.parseDates("1월 3일 다녀왔어요", "2026-10-08").dates), ["2026-01-03"]);
  assert.deepEqual(plain(T.parseDates("1월 3일 출장 가요", "2026-10-08").dates), ["2027-01-03"]);
  assert.deepEqual(plain(T.parseDates("다음 주 화요일 세종", "2026-10-08").dates), ["2026-10-13"]);
});

test("reconcileCase: 단계를 끼우거나 순서를 바꿔도 체크가 같은 단계에 남는다", () => {
  const p0 = { steps: [{ t: "a", k: "s1" }, { t: "b", k: "s2" }, { t: "c", k: "s3" }], pitfalls: [{ t: "x" }, { t: "y" }] };
  const c = { checks: { 0: true, 2: true }, checkAt: { 2: "2026-10-03" }, pchecks: { p1: true, r9: true } };
  T.reconcileCase(c, p0);
  const p1 = { steps: [{ t: "a", k: "s1" }, { t: "새 단계", k: "s9" }, { t: "b", k: "s2" }, { t: "c 고침", k: "s3" }], pitfalls: [{ t: "z" }, { t: "x" }, { t: "y" }] };
  assert.equal(T.reconcileCase(c, p1), true);
  assert.deepEqual(Object.keys(c.checks).sort(), ["0", "3"]);
  assert.equal(c.checkAt[3], "2026-10-03");
  assert.deepEqual(Object.keys(c.pchecks).sort(), ["p2", "r9"]);
  assert.equal(T.reconcileCase(c, p1), false);          // 바뀐 게 없으면 그대로
});

test("reconcileCase: 키 없는 예전 절차는 단계 문장으로 맞춘다", () => {
  const c = { checks: { 1: true } };
  T.reconcileCase(c, { steps: [{ t: "a" }, { t: "b" }] });
  T.reconcileCase(c, { steps: [{ t: "z" }, { t: "a" }, { t: "b" }] });
  assert.deepEqual(plain(c.checks), { 2: true });
});

test("icsFold: 75바이트마다 접고 이어 붙이면 원문", () => {
  const L = "SUMMARY:" + "국내출장 — 운임·숙박비 증거서류를 갖춰 정산을 신청합니다 ".repeat(3);
  const lines = T.icsFold(L).split("\r\n");
  assert.ok(lines.every((l) => Buffer.byteLength(l) <= 75));
  assert.equal(lines.map((l, i) => (i ? l.slice(1) : l)).join(""), L);
  assert.equal(T.icsFold("SHORT"), "SHORT");
});

test("icsFold: 여러 줄 묶음은 줄마다 접고 짧은 줄은 그대로", () => {
  const block = ["BEGIN:VEVENT", "DTSTART;VALUE=DATE:20261022", "SUMMARY:" + "정보보안 교육 ".repeat(8), "END:VEVENT"].join("\r\n");
  const out = T.icsFold(block).split("\r\n");
  assert.equal(out[1], "DTSTART;VALUE=DATE:20261022");
  assert.ok(out.every((l) => Buffer.byteLength(l) <= 75));
  assert.equal(out.filter((l) => !l.startsWith(" ")).length, 4);
});

test("parseSchedText: 그룹웨어 메일(머리글+일시·장소 줄)", () => {
  const mail = `보낸사람: 기획조정실 <plan@koat.or.kr>
보낸날짜: 2026-10-14 (수) 09:12
제목: [회의] 2026년 4분기 운영위원회 개최 안내
안녕하세요. 아래와 같이 운영위원회를 개최하오니 참석 바랍니다.
일시: 2026. 10. 22.(목) 14:00~16:00
장소: 본관 3층 대회의실`;
  const r = plain(T.parseSchedText(mail, "2026-10-16"));
  assert.equal(r.title, "2026년 4분기 운영위원회 개최 안내");
  assert.equal(r.date, "2026-10-22");
  assert.equal(r.time, "14:00");
  assert.equal(r.end, "");
  assert.equal(r.memo, "장소: 본관 3층 대회의실");
});

test("parseSchedText: 문장 속 날짜·'오후 2시'·여러 날", () => {
  const r = plain(T.parseSchedText("RE: 정보보안 교육 안내\n10월 27일부터 28일까지 오후 2시에 교육장에서 진행합니다.", "2026-10-16"));
  assert.equal(r.title, "정보보안 교육 안내");
  assert.deepEqual([r.date, r.end, r.time], ["2026-10-27", "2026-10-28", "14:00"]);
});

test("schedTime: 시각 표현과 '2시간' 제외", () => {
  assert.equal(T.schedTime("오전 10시 30분"), "10:30");
  assert.equal(T.schedTime("3시 반 회의"), "15:30");
  assert.equal(T.schedTime("약 2시간 소요"), "");
  assert.equal(T.schedTime("09:00 시작"), "09:00");
});

test("parseIcs: 초대장 — 시각 일정·종일 여러 날·접힌 줄", () => {
  const ics = ["BEGIN:VCALENDAR", "BEGIN:VEVENT", "DTSTART;TZID=Asia/Seoul:20261022T140000", "DTEND;TZID=Asia/Seoul:20261022T160000",
    "SUMMARY:운영위원회", "LOCATION:본관 3층 대회의실", "END:VEVENT",
    "BEGIN:VEVENT", "DTSTART;VALUE=DATE:20261027", "DTEND;VALUE=DATE:20261029", "SUMMARY:정보보안 교육 (전 직원 ", " 대상)", "END:VEVENT", "END:VCALENDAR"].join("\r\n");
  const ev = plain(T.parseIcs(ics));
  assert.equal(ev.length, 2);
  assert.deepEqual([ev[0].title, ev[0].date, ev[0].time, ev[0].end], ["운영위원회", "2026-10-22", "14:00", ""]);
  assert.ok(ev[0].memo.includes("본관 3층"));
  assert.deepEqual([ev[1].title, ev[1].date, ev[1].end], ["정보보안 교육 (전 직원 대상)", "2026-10-27", "2026-10-28"]);
});

test("parseSchedText: '~했습니다'가 있어도 앞으로의 날짜로", () => {
  const r = plain(T.parseSchedText("제목: 워크숍 일정 확정\n1월 15일 워크숍을 열기로 결정했습니다.", "2026-10-16"));
  assert.equal(r.date, "2027-01-15");
});

test("parseSchedText: 한 줄로 이어 붙은 글(확장 메뉴 선택 글)", () => {
  const r = plain(T.parseSchedText("제목: 청렴교육 실시 안내 일시: 11월 3일(화) 오전 10시 장소: 2층 교육장 대상: 전 직원", "2026-10-16"));
  assert.deepEqual([r.title, r.date, r.time], ["청렴교육 실시 안내", "2026-11-03", "10:00"]);
  assert.ok(r.memo.startsWith("장소: 2층 교육장"));
});
