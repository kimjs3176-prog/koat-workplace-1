// 예산과목 기준표 — 엑셀 붙여넣기 해석·적은 값 찾기·흔한 업무 짐작
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SRC = fs.readFileSync(path.join(ROOT, "assets", "secretary.js"), "utf8");
const a = SRC.indexOf("// ── 관리: 예산과목 기준표"), b = SRC.indexOf("function budgetCard(){");
const PROCS = [
  { id: "domestic-trip", title: "국내출장 — 여비" }, { id: "overseas-trip", title: "공무국외출장" },
  { id: "goods-purchase", title: "물품 구매" }, { id: "daily-expense", title: "일상경비" }, { id: "corp-card", title: "법인카드" },
];
const ctx = vm.createContext({ S: { cfg: {} } });
vm.runInContext([
  `const PROCS=${JSON.stringify(PROCS)};`,
  "const allProcs=()=>PROCS; const getProc=id=>PROCS.find(p=>p.id===id)||null; const shortTitle=t=>String(t||'').split(' — ')[0];",
  SRC.slice(a, b),
  "this.T={budgetParse,budgetText,budMatch,budGuess};",
].join("\n"), ctx);
const T = ctx.T;
const J = x => JSON.parse(JSON.stringify(x));   // vm 안 배열은 다른 realm 이라 값으로 비교

test("엑셀 붙여넣기(탭)와 | 구분을 읽고 머리줄은 건너뛴다", () => {
  const { items, problems } = T.budgetParse(
    "코드\t과목명\t업무\t넣는 것\t넣지 않는 것\n210-01\t일반수용비\t물품 구매, 일상경비\t사무용품\t자산취득비\n국내여비 | 국내출장");
  assert.deepEqual(J(problems), []);
  assert.equal(items.length, 2);
  assert.deepEqual(J([...items[0].procs]), ["goods-purchase", "daily-expense"]);
  assert.equal(items[0].excludes, "자산취득비");
  assert.equal(items[1].code, "");
  assert.deepEqual(J([...items[1].procs]), ["domestic-trip"]);
});

test("찾지 못한 업무·빈 과목명·겹친 과목은 고칠 줄로 알린다", () => {
  const { items, problems } = T.budgetParse("1 | 일반수용비 | 없는업무\n2 |  | 물품 구매\n1 | 또 | ");
  assert.equal(items.length, 1);
  assert.equal(problems.length, 3);
});

test("글 → 표 → 글이 같은 과목으로 돌아온다", () => {
  const first = T.budgetParse("210-01 | 일반수용비 | 물품 구매 | 사무용품 | | 50만 원 미만").items;
  const again = T.budgetParse(T.budgetText({ items: first })).items;
  assert.deepEqual(JSON.parse(JSON.stringify(again)), JSON.parse(JSON.stringify(first)));
});

test("코드·과목명·사업명이 붙은 값도 같은 과목으로 찾되 코드가 다르면 찾지 않는다", () => {
  const items = [{ code: "210-01", name: "수용비" }, { code: "210-02", name: "일반수용비" }, { code: "", name: "국내여비" }];
  assert.equal(T.budMatch(items, "210-02 일반수용비"), items[1]);
  assert.equal(T.budMatch(items, "일반수용비"), items[1]);
  assert.equal(T.budMatch(items, "○○사업 일반수용비"), items[1]);   // 더 긴 과목명 우선
  assert.equal(T.budMatch(items, "210-09 일반수용비"), null);
  assert.equal(T.budMatch(items, "국내 여비"), items[2]);
  assert.equal(T.budMatch(items, "업무추진비"), null);
});

test("흔한 연결 짐작 — 있는 절차만", () => {
  assert.deepEqual(J([...T.budGuess({ name: "국외여비" })]), ["overseas-trip"]);
  assert.deepEqual(J([...T.budGuess({ name: "업무추진비" })]), ["corp-card"]);   // event 절차는 없음
  assert.deepEqual(J([...T.budGuess({ name: "잡지출" })]), []);
});
