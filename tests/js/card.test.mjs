// 법인카드 이용내역 점검(화면에서만 대조) — 붙여넣기 해석·취소 짝·사용시간·제한업종·분할·월 한도·내 증빙
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SRC = fs.readFileSync(path.join(ROOT, "assets", "secretary.js"), "utf8");
const a = SRC.indexOf("// ── 법인카드 이용내역 점검"), b = SRC.indexOf("function cardToolHtml(){");
const ctx = vm.createContext({});
vm.runInContext("const won=n=>(Number(n)||0).toLocaleString('ko-KR');\n" + SRC.slice(a, b) + "\nthis.T={cardParse,cardCheck,cardDate,cardTime,cardAmt};", ctx);
const T = ctx.T;
const J = (x) => JSON.parse(JSON.stringify(x));
const RULES = { hours: { from: 8, to: 22 }, limit: { amount: 1_000_000 }, basis: { reg: "법인카드 운영요령", art: "4" },
  industries: [{ name: "레저업종", kw: ["노래방", "골프장"] }, { name: "기타주점업종", kw: ["호프집"] }], goods: [{ name: "귀금속", kw: ["귀금속"] }] };
const off = (d) => (d === "2026-10-03" ? "개천절" : ["2026-10-10", "2026-10-11"].includes(d) ? "주말" : "");

test("붙여넣기: 탭·CSV(따옴표·쉼표 금액)·머리줄 위 안내 줄·일시 한 칸", () => {
  const tsv = "카드사 이용내역 조회\n이용일자\t이용시간\t가맹점명\t업종\t이용금액\t승인번호\n2026.10.05\t21:40\t○○식당\t한식\t182,000\t1234";
  const p = T.cardParse(tsv);
  assert.deepEqual(J(p.map), { date: 0, time: 1, merchant: 2, industry: 3, amount: 4, appr: 5 });
  assert.equal(p.rows.length, 1);
  const csv = 'No,거래일시,이용가맹점,금액\n1,"2026-10-05 07:30:00","A, 마트","47,800"';
  const q = T.cardParse(csv);
  assert.equal(q.map.date, 1); assert.equal(q.map.merchant, 2); assert.equal(q.rows[0][2], "A, 마트");
  assert.equal(T.cardDate("20261005"), "2026-10-05"); assert.equal(T.cardDate("26/10/05"), "2026-10-05"); assert.equal(T.cardDate("2026-02-30"), "");
  assert.equal(T.cardTime("2026-10-05 07:30:00"), 450); assert.equal(T.cardAmt("-47,800원"), -47800);
});

test("점검: 사용시간·휴일·제한업종·제한물품·분할·취소 짝·월 한도·내 증빙", () => {
  const txt = ["이용일자\t이용시간\t가맹점명\t업종\t이용금액\t카드번호\t구분",
    "2026-10-05\t12:10\t행복식당\t한식\t60,000\t1234-****-1111\t승인",
    "2026-10-05\t22:30\t행복식당\t한식\t50,000\t1234-****-1111\t승인",           // 22시 넘음 + 같은 날 같은 가맹점 2회
    "2026-10-03\t13:00\t별빛노래방\t노래연습장\t40,000\t1234-****-1111\t승인",      // 휴일 + 제한업종
    "2026-10-06\t10:00\t미래귀금속\t소매\t900,000\t1234-****-1111\t승인",          // 제한물품, 월 한도 초과
    "2026-10-07\t10:00\t문구센터\t문구\t30,000\t1234-****-1111\t승인",
    "2026-10-07\t10:05\t문구센터\t문구\t-30,000\t1234-****-1111\t취소"].join("\n");
  const r = T.cardCheck(T.cardParse(txt), RULES, { offInfo: off, receipts: [{ date: "2026-10-05", amount: 60000, title: "부서 간담회" }] });
  const by = (m) => r.rows.filter((x) => x.merchant === m);
  assert.equal(r.cancelled, 2);                                              // 문구센터 승인·취소 짝은 빠진다
  assert.equal(r.rows.length, 4);
  const [lunch, late] = by("행복식당");
  assert.deepEqual(J(lunch.flags.map((f) => f.k)), ["split"]);
  assert.deepEqual(J(late.flags.map((f) => f.k)).sort(), ["split", "time"]);
  assert.equal(lunch.match.title, "부서 간담회"); assert.equal(late.match, null);
  const karaoke = by("별빛노래방")[0];
  assert.match(karaoke.flags.find((f) => f.k === "time").t, /개천절/);
  assert.equal(karaoke.flags.find((f) => f.k === "ind").sev, "high");
  assert.equal(by("미래귀금속")[0].flags[0].k, "goods");
  assert.equal(r.over.length, 1); assert.equal(r.over[0].v, 1_050_000);
  assert.equal(r.total, 1_050_000);
});
