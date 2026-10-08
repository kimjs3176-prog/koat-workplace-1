#!/usr/bin/env node
// ALIO(공공기관 경영정보 공개시스템)에 공시된 우리 기관 내규와 서무비서에 등록된 내규를 비교해,
// 새로 개정된 규정만 받아 서무비서에 등록한다. ALIO 조회·본문 추출은 alio-mcp(chromehearts79/alio-mcp)를 쓴다.
//
//   git clone https://github.com/chromehearts79/alio-mcp.git ../alio-mcp
//   (cd ../alio-mcp && npm install --omit=optional)
//
//   node scripts/alio_sync.mjs                 # 비교만 — 개정·신규·ALIO 미공시 목록 + secretary/alio_status.json
//   node scripts/alio_sync.mjs --download      # 개정·신규 규정 현행본을 alio_inbox/ 에 받기(파일명: 규정명(개정 정보).확장자)
//   node scripts/alio_sync.mjs --apply         # 받은 뒤 scripts/import_regs.py 로 서무비서에 등록
//   node scripts/alio_sync.mjs --apply --all   # 개정 여부와 상관없이 ALIO 현행본 전부 다시 등록
//   옵션: --org 기관명(기본: secretary/config.json 의 org.name) · --alio <alio-mcp 경로>(기본: ALIO_MCP_DIR 또는 ../alio-mcp)
//
// 주의: ALIO 는 국내망에서 가장 안정적으로 열린다(해외 클라우드에서는 간헐적으로 실패). 기관 PC 에서 돌리는 것을 권한다.
// 규정 원문은 기관이 ALIO 에 공시한 것이며, 서무비서 저장소에는 기존처럼 우리 기관 규정만 등록한다.
import fs from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const APPLY = flag("--apply"), DOWNLOAD = APPLY || flag("--download"), ALL = flag("--all");
const INBOX = path.join(ROOT, "alio_inbox");
const STATUS = path.join(ROOT, "secretary", "alio_status.json");

const readJson = async (p, d) => { try { return JSON.parse(await fs.readFile(p, "utf8")); } catch { return d; } };

async function loadAlio() {
  const dir = path.resolve(opt("--alio", process.env.ALIO_MCP_DIR || path.join(ROOT, "..", "alio-mcp")));
  try { await fs.access(path.join(dir, "src", "alio-client.js")); }
  catch {
    console.error(`alio-mcp 를 찾지 못했습니다: ${dir}\n  git clone https://github.com/chromehearts79/alio-mcp.git ${dir}\n  (cd ${dir} && npm install --omit=optional)\n또는 --alio <경로> / ALIO_MCP_DIR 로 위치를 알려 주세요.`);
    process.exit(2);
  }
  const client = await import(pathToFileURL(path.join(dir, "src", "alio-client.js")).href);
  const text = await import(pathToFileURL(path.join(dir, "src", "rule-text.js")).href);
  return { dir, ...client, extractDocument: text.extractDocument, pickZipEntry: text.pickZipEntry };
}

// 규정명 비교: 기관명 접두어·괄호의 개정 표기·공백·가운뎃점을 뗀다
function normTitle(t, orgName, baseTitle) {
  let s = baseTitle ? baseTitle(t) : String(t || "");
  for (const o of [orgName, "한국농업기술진흥원"]) if (o) s = s.split(o.replace(/\s+/g, "")).join("");
  return s.replace(/[\s·ㆍ・「」『』"']/g, "");
}
// "2025년도 1월 일부개정" · "2026년도 6월 11일 개정" · "2024-03-02" → [연, 월, 일|0]
function ymd(s) {
  const t = String(s || "");
  let m = t.match(/((?:19|20)\d{2})\s*년도?\s*(\d{1,2})\s*월(?:\s*(\d{1,2})\s*일)?/);
  if (m) return [Number(m[1]), Number(m[2]), Number(m[3] || 0)];
  m = t.match(/((?:19|20)\d{2})[-./]?\s*(\d{1,2})[-./]?\s*(\d{1,2})?/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3] || 0)] : null;
}
// ALIO 시행일이 등록본보다 늦으면 개정. 등록본에 '일'이 없으면 달까지만 비교한다.
function newer(alio, ours) {
  if (!alio || !ours) return null;
  if (alio[0] !== ours[0]) return alio[0] > ours[0];
  if (alio[1] !== ours[1]) return alio[1] > ours[1];
  return ours[2] ? alio[2] > ours[2] : false;
}
const revLabel = (d) => d ? `${d[0]}년도 ${d[1]}월${d[2] ? ` ${d[2]}일` : ""} 개정` : "";
const safeName = (s) => String(s).replace(/[\\/:*?"<>|]+/g, "_").trim().slice(0, 90);

async function main() {
  const cfg = await readJson(path.join(ROOT, "secretary", "config.json"), {});
  const orgName = opt("--org", (cfg.org && cfg.org.name) || "한국농업기술진흥원");
  const A = await loadAlio();
  console.error(`ALIO 조회: ${orgName} (alio-mcp ${A.dir})`);

  const orgs = await A.listOrgs();
  const key = orgName.replace(/\s+/g, "");
  const org = orgs.find((o) => o.name.replace(/\s+/g, "") === key) || orgs.find((o) => o.name.replace(/\s+/g, "").includes(key));
  if (!org) { console.error(`ALIO 기관 목록에서 '${orgName}'을 찾지 못했습니다. --org 로 정확한 기관명을 주세요.`); process.exit(2); }

  const rules = A.markSuperseded(await A.searchRules(org)).filter((r) => !r.superseded);
  const manifest = await readJson(path.join(ROOT, "regulations_manifest.json"), []);
  const ours = new Map(manifest.map((m) => [normTitle(m.title, orgName, A.baseTitle), m]));
  const seen = new Set();
  const rows = [];
  for (const r of rules) {
    const k = normTitle(r.title, orgName, A.baseTitle);
    const m = ours.get(k);
    if (m) seen.add(k);
    const a = ymd(r.enfDate), o = m ? ymd(m.revision) : null;
    const n = m ? newer(a, o) : null;
    const status = !m ? "new" : n === null ? "unknown" : n ? "revised" : "current";
    rows.push({ title: m ? m.title : r.title.replace(/\s*[(（][^)）]*\d{4}[^)）]*[)）]\s*$/, ""),
      alioTitle: r.title, alioDate: r.enfDate || "", alioModified: r.modDate || "", ours: m ? m.revision || "" : "",
      status, idx: r.idx, rule: r });
  }
  const notOnAlio = manifest.filter((m) => !seen.has(normTitle(m.title, orgName, A.baseTitle))).map((m) => ({ title: m.title, ours: m.revision || "" }));

  const label = { revised: "📝 개정", new: "🆕 신규(서무비서 미등록)", unknown: "❔ 개정일 비교 불가", current: "✓ 최신" };
  const by = (s) => rows.filter((x) => x.status === s);
  console.log(`\n# ALIO 내규 최신성 — ${org.name} (${new Date().toISOString().slice(0, 10)})`);
  console.log(`ALIO 공시 ${rules.length}건 · 서무비서 등록 ${manifest.length}건`);
  for (const s of ["revised", "new", "unknown"]) {
    const L = by(s); if (!L.length) continue;
    console.log(`\n## ${label[s]} ${L.length}건`);
    for (const x of L) console.log(`- ${x.title}: ALIO 시행일 ${x.alioDate || "?"}${x.ours ? ` · 서무비서 ${x.ours}` : ""}`);
  }
  console.log(`\n## ✓ 최신 ${by("current").length}건`);
  if (notOnAlio.length) console.log(`\n## ALIO 에서 찾지 못한 등록 규정 ${notOnAlio.length}건(이름이 다르거나 비공시) — ${notOnAlio.slice(0, 15).map((x) => x.title).join(", ")}${notOnAlio.length > 15 ? " 등(전체는 상태 파일)" : ""}`);

  // 서무비서 화면(관리 › 호환성 점검)이 읽는 상태 파일 — 규정 원문은 담지 않는다
  await fs.writeFile(STATUS, JSON.stringify({
    checked: new Date().toISOString(), org: org.name, alio: rules.length, registered: manifest.length,
    items: rows.filter((x) => x.status !== "current").map(({ rule, ...x }) => x),
    current: by("current").length, notOnAlio,
  }, null, 1) + "\n");
  console.log(`\n상태 저장: ${path.relative(ROOT, STATUS)}`);

  if (!DOWNLOAD) { console.log("받으려면 --download, 받아서 등록까지 하려면 --apply"); return; }
  const targets = rows.filter((x) => ALL || x.status === "revised" || x.status === "new");
  if (!targets.length) { console.log("받을 규정이 없습니다."); return; }
  await fs.rm(INBOX, { recursive: true, force: true });
  await fs.mkdir(INBOX, { recursive: true });
  let ok = 0;
  const failed = [];
  for (const x of targets) {
    try {
      const files = await A.getRuleFiles(x.rule);
      const pick = A.pickLatestFile(files);
      if (!pick) throw new Error("첨부 없음");
      const { buf } = await A.fetchRuleFile(pick.fileNo);
      const ext = (pick.fileName.match(/\.(\w+)$/) || [, "bin"])[1].toLowerCase();
      const base = `${safeName(x.title)}(${revLabel(ymd(x.alioDate)) || "ALIO 현행본"})`;
      if (["hwpx", "docx", "pdf"].includes(ext)) {
        await fs.writeFile(path.join(INBOX, `${base}.${ext}`), buf);           // 서무비서가 직접 변환하는 형식
      } else {
        const r = await A.extractDocument(buf, pick.fileName);                 // .hwp·zip 등 → kordoc 으로 본문 추출
        if (!r || !r.markdown || !r.markdown.trim()) throw new Error(`본문 추출 실패(${pick.fileName})`);
        await fs.writeFile(path.join(INBOX, `${base}.md`), r.markdown);
      }
      ok++;
      console.log(`  ⬇ ${x.title} ← ${pick.fileName}`);
    } catch (e) { failed.push(`${x.title}: ${e.message}`); console.log(`  ✗ ${x.title}: ${e.message}`); }
  }
  console.log(`받음 ${ok}건${failed.length ? ` · 실패 ${failed.length}건` : ""} → ${path.relative(ROOT, INBOX)}/`);
  if (!APPLY) { console.log("확인 뒤 등록: python scripts/import_regs.py alio_inbox"); return; }
  const py = process.env.PYTHON || (process.platform === "win32" ? "python" : "python3");
  const r = spawnSync(py, [path.join(ROOT, "scripts", "import_regs.py"), INBOX], { stdio: "inherit", cwd: ROOT });
  if (r.status !== 0) process.exit(r.status || 1);
  console.log("\n다음: ① git diff 로 바뀐 규정 확인 ② (의미 검색을 쓰면) python scripts/build_embeddings.py");
  console.log("     ③ 화면 [규정·절차 관리 › 호환성 점검]에서 '근거 규정 개정' 절차를 영향 분석 → 확인 ④ commit·push");
}

main().catch((e) => { console.error(`실패: ${e.code ? e.code + " " : ""}${e.message}`); process.exit(1); });
