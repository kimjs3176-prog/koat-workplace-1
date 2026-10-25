import test from "node:test";
import assert from "node:assert/strict";
import { load } from "./load.mjs";

process.env.TZ = "Asia/Seoul";                        // 초대장 UTC 시각 → 한국 시각 시험

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

test("parseDates: 박·해 넘김·숫자(금액·시간·분수)·'N일 전까지'", () => {
  const D = (q, base) => plain(T.parseDates(q, base).dates);
  assert.deepEqual(D("어제 2박 3일 출장 다녀왔어요", "2026-10-25"), ["2026-10-22", "2026-10-24"]);        // 어제 = 돌아온 날
  assert.deepEqual(D("10월 5일부터 2박 3일에 걸쳐 출장", "2026-10-25"), ["2026-10-05", "2026-10-07"]);   // '3일에'는 날짜가 아님
  assert.deepEqual(D("다음 주 화요일부터 2박 3일 출장 가요", "2026-10-25"), ["2026-10-27", "2026-10-29"]);
  assert.deepEqual(D("12월 28일부터 1월 3일까지 출장", "2026-07-10"), ["2026-12-28", "2027-01-03"]);
  assert.deepEqual(D("12/28~1/3 출장", "2026-07-10"), ["2026-12-28", "2027-01-03"]);
  assert.deepEqual(D("12월 28일부터 1월 3일까지 다녀왔어요", "2027-01-05"), ["2026-12-28", "2027-01-03"]);
  for (const q of ["숙박비 7.5만원 넘으면?", "숙박비 1/2 감액되나요", "초과근무 2.5시간 했어요", "출장 3일 전까지 신청해야 하나요?"]) assert.deepEqual(D(q, "2026-10-25"), [], q);
  assert.deepEqual(D("v1.4 업데이트 후 10/5 출장", "2026-10-25"), ["2026-10-05"]);
  assert.deepEqual(D("3일 전에 다녀왔어요", "2026-10-25"), ["2026-10-22"]);
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

test("parseIcs: UTC(Z) 시각은 한국 시각으로 — 아침 일정이 전날로 넘어가지 않게", () => {
  const ics = ["BEGIN:VEVENT", "DTSTART:20261020T050000Z", "DTEND:20261020T060000Z", "SUMMARY:주간회의", "END:VEVENT",
    "BEGIN:VEVENT", "DTSTART:20261019T230000Z", "DTEND:20261020T000000Z", "SUMMARY:조찬", "END:VEVENT"].join("\r\n");
  const ev = plain(T.parseIcs(ics));
  assert.deepEqual([ev[0].date, ev[0].time, ev[0].end], ["2026-10-20", "14:00", ""]);
  assert.deepEqual([ev[1].date, ev[1].time, ev[1].end], ["2026-10-20", "08:00", ""]);
});

const b64 = (s) => Buffer.from(s, "utf8").toString("base64");
const qp = (s) => [...Buffer.from(s, "utf8")].map((b) => "=" + b.toString(16).toUpperCase().padStart(2, "0")).join("");
const latin = (buf) => String.fromCharCode(...buf);

test("emlToText: 단일 파트 base64 본문(머리글에 인코딩)", () => {
  const eml = `Subject: =?UTF-8?B?${b64("운영위원")}?= =?UTF-8?B?${b64("회 안내")}?=\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${b64("일시: 10월 30일 오후 2시")}\r\n`;
  assert.equal(T.emlToText(eml), "제목: 운영위원회 안내\n일시: 10월 30일 오후 2시");
});

test("emlToText: QP 본문 + base64 첨부 — 본문 파트만 자기 인코딩으로", () => {
  const eml = ["Subject: hi", 'Content-Type: multipart/mixed; boundary="B1"', "", "--B1",
    "Content-Type: text/plain; charset=utf-8", "Content-Transfer-Encoding: quoted-printable", "", qp("장소: 대회의실"), "--B1",
    "Content-Type: application/pdf", "Content-Disposition: attachment; filename=a.pdf", "Content-Transfer-Encoding: base64", "", "JVBERi0xLjQK", "--B1--", ""].join("\r\n");
  assert.ok(T.emlToText(eml).includes("장소: 대회의실"));
});

test("emlToText: euc-kr(ks_c_5601-1987) 8bit 본문을 바이트 그대로 읽어 풀기", () => {
  const body = new TextDecoder("euc-kr").decode(new Uint8Array([0xc8, 0xb8, 0xc0, 0xc7])) === "회의"
    ? Buffer.from([0xc8, 0xb8, 0xc0, 0xc7]) : null;
  if (!body) return;                                  // ICU 가 없는 node 면 건너뜀
  const eml = latin(Buffer.concat([Buffer.from("Subject: x\r\nContent-Type: text/plain; charset=ks_c_5601-1987\r\n\r\n"), body]));
  assert.ok(T.emlToText(eml).endsWith("회의"));
});

test("guard: 상신 버튼 이름 — 메뉴(결재요청함)·취소는 제외, ERP 제출 버튼은 포함", async () => {
  const fs = await import("node:fs");
  const src = fs.readFileSync(new URL("../../extension/guard.js", import.meta.url), "utf8");
  const rx = (name) => eval(src.match(new RegExp(`const ${name} = (/.*/[a-z]*);`))[1]);
  const S = rx("SUBMIT");
  // 기관 ERP 제출 버튼 이름은 ERP 규칙 묶음(secretary/erp_presets.json)에서 — KOAT 묶음 기준
  const koat = JSON.parse(fs.readFileSync(new URL("../../secretary/erp_presets.json", import.meta.url), "utf8")).presets.koat.submit_words.map((w) => w.replace(/\s+/g, ""));
  const hit = (t) => S.test(t) || koat.includes(t.replace(/\s+/g, ""));
  for (const t of ["상신", "결재요청", "결재 상신하기", "제출", "서무확정요청", "여비정산신청", "출장신청"]) assert.ok(hit(t), t);
  for (const t of ["결재요청함", "결재상신함", "결재 요청 취소", "결재요청 현황", "보내기", "신청 내역"]) assert.ok(!hit(t), t);
});

test("parseSchedText: 회신·제출 기한과 'N일 전까지'는 일정 날짜가 아님, 끝나는 날은 기간일 때만", () => {
  const a = plain(T.parseSchedText("10월 30일 오후 2시 운영위원회\n자료는 2일 전까지 제출", "2026-10-16"));
  assert.deepEqual([a.title, a.date, a.end, a.time], ["운영위원회", "2026-10-30", "", "14:00"]);
  const b = plain(T.parseSchedText("회신은 10월 25일까지\n10월 30일 회의", "2026-10-16"));
  assert.deepEqual([b.title, b.date, b.end], ["회의", "2026-10-30", ""]);
  const c = plain(T.parseSchedText("워크숍 10월 27일(화) ~ 10월 29일(목)", "2026-10-16"));
  assert.deepEqual([c.date, c.end], ["2026-10-27", "2026-10-29"]);
  assert.equal(T.schedTime("2:30 ~ 4:00"), "14:30");
});

test("parseSchedText: 공문식 날짜 '11. 3.(화) ~ 5.(목)'·'2026.11.3.~11.5.'·제목 앞 날짜 떼기", () => {
  const P = (t) => plain(T.parseSchedText(t, "2026-10-22"));
  assert.deepEqual([P("일시 : 12. 30.(수) 오후 2시").date, P("일시 : 12. 30.(수) 오후 2시").time], ["2026-12-30", "14:00"]);
  assert.deepEqual(((r) => [r.title, r.date, r.end])(P("11. 3.(화) ~ 11. 5.(목) 세종 출장")), ["세종 출장", "2026-11-03", "2026-11-05"]);
  assert.deepEqual(((r) => [r.date, r.end])(P("2026.11.3.~11.5. 워크숍")), ["2026-11-03", "2026-11-05"]);
  assert.deepEqual(((r) => [r.title, r.end])(P("2026. 11. 3.(화) ~ 4.(수) 교육")), ["교육", "2026-11-04"]);
  assert.equal(P("11월 3일부터 5일까지 세종 출장").title, "세종 출장");
  assert.equal(P("확장 1.4.6 배포").date, "");                          // 판 번호는 날짜가 아님
});

test("parseIcs: TZID 시각·DURATION·취소된 모임", () => {
  const ics = "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:a\r\nDTSTART;TZID=America/New_York:20261105T090000\r\nSUMMARY:HQ\r\nEND:VEVENT\r\n" +
    "BEGIN:VEVENT\r\nUID:w\r\nDTSTART;TZID=\"Eastern Standard Time\":20260705T090000\r\nSUMMARY:W\r\nEND:VEVENT\r\n" +
    "BEGIN:VEVENT\r\nUID:c\r\nDTSTART;VALUE=DATE:20261110\r\nDURATION:P2D\r\nSUMMARY:dur\r\nEND:VEVENT\r\n" +
    "BEGIN:VEVENT\r\nUID:d\r\nSTATUS:CANCELLED\r\nDTSTART;VALUE=DATE:20261112\r\nSUMMARY:x\r\nEND:VEVENT\r\nEND:VCALENDAR";
  const ev = plain(T.parseIcs(ics));
  const loc = (u) => { const d = new Date(u); return [`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`, `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`]; };
  assert.deepEqual([ev[0].date, ev[0].time], loc(Date.UTC(2026, 10, 5, 14, 0)));      // 11월 뉴욕은 UTC-5
  assert.deepEqual([ev[1].date, ev[1].time], loc(Date.UTC(2026, 6, 5, 13, 0)));       // 7월(서머타임)은 UTC-4 — Outlook 이름도
  assert.deepEqual([ev[2].date, ev[2].end], ["2026-11-10", "2026-11-11"]);            // 종일 2일
  assert.equal(ev[3].cancelled, true); assert.equal(ev[0].cancelled, false);
  assert.equal(plain(T.parseIcs("METHOD:CANCEL\r\nBEGIN:VEVENT\r\nUID:z\r\nDTSTART:20261101\r\nEND:VEVENT"))[0].cancelled, true);
});
