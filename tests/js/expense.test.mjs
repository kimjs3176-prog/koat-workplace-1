// assets/expense.js(지출결의서) — 증빙 OCR 텍스트에서 금액·일자·종류 추출, 금액 한글 표기.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SRC = fs.readFileSync(path.join(ROOT, "assets", "expense.js"), "utf8");
const doc = { addEventListener() {}, getElementById() { return null; }, querySelectorAll() { return []; } };
const ctx = vm.createContext({ document: doc, window: {}, localStorage: { getItem() { return null; }, setItem() {} }, console });
vm.runInContext(SRC + "\nthis.T={_ocrParseReceipt,_hanAmount,_commaFmt,_expDefault};", ctx);
const T = ctx.T;

test("철도 승차권: 결제금액·승차일", () => {
  const p = T._ocrParseReceipt("코레일 승차권\nKTX 101 서울 → 대전\n승차일 2026.10.21 07:30\n운임 23,700원\n할인 0원\n결제금액 23,700원\n카드번호 1234-****-****-5678");
  assert.equal(p.amount, 23700);
  assert.equal(p.date, "2026-10-21");
  assert.equal(p.kind, "transit");
});

test("숙박: 부가세·승인번호는 금액으로 보지 않고, 연도 오인식은 올해로 보정", () => {
  const p = T._ocrParseReceipt("대전 비즈니스 호텔\n사업자 123-45-67890\n체크인 2226-10-21\n객실료 75,000\n부가세 7,500\n합계 82,500원\n승인번호30012345");
  assert.equal(p.amount, 82500);
  assert.equal(p.kind, "lodging");
  assert.equal(p.date, new Date().getFullYear() + "-10-21");
});

test("택시: 두 자리 연도", () => {
  const p = T._ocrParseReceipt("택시 영수증\n26/10/22 18:05\n요금 12,300원\n합계 12,300원");
  assert.equal(p.amount, 12300);
  assert.equal(p.date, "2026-10-22");
  assert.equal(p.label, "택시비");
});

test("금액 한글 표기·콤마", () => {
  assert.equal(T._hanAmount(1234500), "일백이십삼만사천오백");
  assert.equal(T._commaFmt("1234567원"), "1,234,567");
  assert.equal(T._expDefault().type, "general");
});
