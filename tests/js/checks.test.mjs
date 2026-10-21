// 확장 결재 전 입력값 점검(extension/checks.js) — 화면 값 → 반려 점검 항목 판정
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const ctx = vm.createContext({});
vm.runInContext(fs.readFileSync(new URL("../../extension/checks.js", import.meta.url), "utf8"), ctx);
const C = ctx.SEC_CHECK;
const plain = (v) => JSON.parse(JSON.stringify(v));

test("readDates: '출장기간 [시작] ~ [끝]'·작성일 제외·이름 붙은 끝 날짜", () => {
  assert.deepEqual(plain(C.readDates([{ label: "작성일", value: "2026-10-21", row: 0 },
    { label: "출장기간", value: "2026.10.01", row: 1 }, { label: "출장기간", value: "2026.10.03", row: 1 }])), { start: "2026-10-01", end: "2026-10-03" });
  assert.deepEqual(plain(C.readDates([{ label: "출발일", value: "2026-10-05", row: 0 }, { label: "도착일", value: "20261007", row: 1 }])), { start: "2026-10-05", end: "2026-10-07" });
  assert.deepEqual(plain(C.readDates([{ label: "휴가일자", value: "2026-11-02", row: 0 }])), { start: "2026-11-02", end: "2026-11-02" });
});

test("evaluate: 정산 14일 기한·사전 신청·첨부·근무 시간·공동근무시간·기간 뒤바뀜", () => {
  const ps = [{ t: "정산 14일", check: { kind: "deadline", ref: "end", days: 14 } }, { t: "첨부", check: { kind: "attach" } },
    { t: "사전", check: { kind: "lead", ref: "start", days: 5 } }, { t: "확인만" }];
  const scr = { fields: [{ label: "출장기간", value: "2026-10-01", row: 0 }, { label: "출장기간", value: "2026-10-03", row: 0 }], attach: 0 };
  const r = C.evaluate(ps, scr, "2026-10-21");
  assert.equal(r[0].ok, false); assert.match(r[0].note, /10\.17/);           // 10.3 + 14 = 10.17 지남
  assert.equal(r[1].ok, false);
  assert.equal(r[2].ok, false);
  assert.equal(r[3], null);
  assert.equal(C.evaluate(ps, scr, "2026-10-10")[0].ok, true);
  const ot = C.evaluate([{ t: "4시간", check: { kind: "hours", max: 4 } }, { t: "공동", check: { kind: "span", from: "10:30", to: "15:30" } }],
    { fields: [{ label: "근무시간", value: "18:00", row: 0 }, { label: "근무시간", value: "23:00", row: 0 }] }, "2026-10-21");
  assert.equal(ot[0].ok, false); assert.match(ot[0].note, /5시간/); assert.equal(ot[1].ok, false);
  const bad = C.evaluate([{ t: "x", check: { kind: "attach" } }], { fields: [{ label: "시작일", value: "2026-10-09", row: 0 }, { label: "종료일", value: "2026-10-05", row: 1 }] }, "2026-10-01");
  assert.ok(bad.extra && !bad.extra.ok);
  assert.equal(bad[0], null);                                                   // 첨부 수를 못 읽으면 판정하지 않음
});

test("countAttach: 첨부 목록 글에서 첨부 수", () => {
  assert.equal(C.countAttach("첨부파일 (2)"), 2);
  assert.equal(C.countAttach("첨부 0건"), 0);
  assert.equal(C.countAttach("첨부된 파일이 없습니다"), 0);
  assert.equal(C.countAttach("결재 의견"), undefined);
});

test("readDates: 기관 칸 이름(설정 › ERP › 칸 이름) — 시작·끝·제외", () => {
  const f = [{ label: "처리일자", value: "2026-10-20", row: 0 }, { label: "여행 개시", value: "2026-10-05", row: 1 }, { label: "귀임", value: "2026-10-07", row: 2 }];
  assert.deepEqual(plain(C.readDates(f, { start: ["여행 개시"], end: ["귀임"], ignore: ["처리일자"] })), { start: "2026-10-05", end: "2026-10-07" });
});

test("config.js: 기관 ERP 규칙이 기본 규칙보다 먼저, 제외 주소·제출 버튼 이름", () => {
  const g = vm.createContext({});
  vm.runInContext(fs.readFileSync(new URL("../../extension/config.js", import.meta.url), "utf8"), g);
  g.SEC_PROFILE = g.secCompileProfile({ screen_rules: [{ by: "url", match: "/hr/trip/", q: "출장 가요", proc: "domestic-trip" }, { by: "title", match: "여비\\s*청구", q: "정산", proc: "domestic-trip" }],
    skip_paths: ["/approval/list"], submit_words: ["결재 상신"] });
  const R = g.secRules();
  assert.equal(R.url[0][2], "domestic-trip"); assert.ok(R.title[0][0].test("여비 청구서")); assert.ok(R.title.length > 1);
  assert.ok(R.skip("/approval/list.do") && R.skip("/mail/inbox") && !R.skip("/hr/trip/apply"));
  assert.ok(g.SEC_PROFILE.submit.has("결재상신"));
  assert.equal(g.secCompileProfile({ screen_rules: [{ by: "url", match: "([" }] }).url.length, 0);   // 잘못된 정규식은 버림
});
