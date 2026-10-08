// 서무비서 확장 — 진단 센터: 시험 기록 보기·화면 구조 기록·메모·보고서 보내기
const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
let data = null;
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
function toast(m, ms) { const t = $("toast"); t.textContent = m; t.classList.add("show"); clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove("show"), ms || 2800); }
const isErr = (e) => e.ev === "error" || /error|fail/.test(e.ev) || (e.d && (e.d.ok === false || (Array.isArray(e.d.missing) && e.d.missing.length)));

let latest = "";                                   // 서버가 배포하는 확장 최신 버전
async function load() {
  data = await chrome.runtime.sendMessage({ type: "diag.get" });
  $("ver").textContent = `확장 ${data.version} · 서버 ${data.settings.server || "(설정 안 됨)"}`;
  $("on").checked = !!data.enabled;
  if (!latest && data.settings.server) {
    try { latest = ((await (await fetch(data.settings.server + "/api/secretary/extension/info", { cache: "no-store" })).json()) || {}).version || ""; } catch (e) { latest = "?"; }
  }
  renderFindings(); renderStat(); renderRows();
}

// ── 자동 진단: 기록을 읽어 '무엇이 문제이고 어떻게 하면 되는지'를 정리한다 ──────────────
const verLt = (a, b) => { const p = (v) => String(v || "").split(".").map(Number); const x = p(a), y = p(b); for (let i = 0; i < 4; i++) { if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) < (y[i] || 0); } return false; };
const uniq = (arr) => [...new Set(arr.filter(Boolean))];
const IE_RX = /not ready|Cannot access|cannot be scripted/i;
const SUBMIT_LIKE = /상신|결재\s*(올|요청)|올림|제출|기안\s*완료|승인\s*요청/;
const MENU_LIKE = /\(\d+(\/\d+)?\)$|대기|함$|현황|목록|ERP결재|온-나라|^결재$/;
function findings() {
  const L = data.log, out = [];
  const add = (sev, title, fix) => out.push({ sev, title, fix });
  if (!data.settings.server) add("high", "서무비서 주소가 설정되어 있지 않습니다.", "확장 설정(⚙)에서 서무비서 주소를 넣거나, 서무비서 웹의 🧩 확장 설치에서 기관 맞춤 확장을 다시 받으세요.");
  if (latest && latest !== "?" && verLt(data.version, latest)) add("mid", `새 확장 ${latest}이 있습니다(지금 ${data.version}).`, "서무비서 웹 🧩 확장 설치에서 받아 같은 폴더에 덮어쓴 뒤 확장 페이지에서 ↻ 새로고침하세요.");
  if (!data.enabled) add("mid", "진단 기록이 꺼져 있습니다.", "위의 '진단 기록 켜기'를 켜야 문제를 찾을 수 있습니다.");
  // 확장이 화면 안에 들어가지 못한 탭(IE 모드 등)
  const ie = L.filter((e) => /^detect\.tab/.test(e.ev) || (e.ev === "frames.error" && IE_RX.test((e.d || {}).err || "")));
  if (ie.length) {
    const pages = uniq(ie.map((e) => e.page || (e.d && e.d.url))).slice(0, 5);
    add("high", `확장이 화면 안에 들어가지 못한 탭이 있습니다(${ie.length}회).${pages.length ? " " + pages.join(", ") : ""}`,
      "Edge 'IE 모드'(주소창 왼쪽 e 아이콘)로 열린 화면입니다. 브라우저 제약으로 🗂 버튼·결재 전 점검·칸 넣기는 안 되고, 옆 패널 안내와 '복사 → Ctrl+V'만 됩니다. 기관 IE 모드 사이트 목록에서 빼면 모든 기능을 쓸 수 있습니다.");
  }
  // 오류
  const errs = L.filter((e) => e.ev === "error" || (e.ev === "frames.error" && !IE_RX.test((e.d || {}).err || "")));
  if (errs.length) add("high", `확장 오류 ${errs.length}건: ${uniq(errs.map((e) => (e.d && (e.d.msg || e.d.err)) || e.ev)).slice(0, 3).join(" / ")}`, "보고서를 받아 개발 담당(Claude 대화)에 보내 주세요.");
  const pfail = L.filter((e) => e.ev === "panel.open" && e.d && e.d.ok === false);
  if (pfail.length) add("mid", `옆 패널을 열지 못한 적이 ${pfail.length}번 있습니다(대신 작은 창으로 열림).`, "대개 클릭 직후가 아닌 시점에 열려고 할 때입니다. 계속되면 브라우저를 최신으로 올려 주세요.");
  const ins = L.filter((e) => (e.ev === "insert" || e.ev === "erp.insert") && e.d && e.d.ok === false);
  if (ins.length) add("mid", `초안을 ERP에 넣지 못한 적이 ${ins.length}번 있습니다.`, "ERP 입력란을 먼저 한 번 누른 뒤 '📥 ERP에 넣기'를 누르세요. 한글 기안기 같은 편집기는 초안이 복사되니 본문을 누르고 Ctrl+V 하세요.");
  // 업무를 알아보지 못한 화면
  const none = L.filter((e) => e.ev === "detect.none" && e.d && (e.d.texts || []).length);
  const noneBy = {}; none.forEach((e) => { noneBy[e.d.url] = e.d.texts; });
  const nk = Object.keys(noneBy);
  if (nk.length) add("info", `업무를 알아보지 못한 화면 ${nk.length}곳: ` + nk.slice(0, 4).map((u) => `${u} (${(noneBy[u] || []).slice(0, 3).join(" · ")})`).join(", ") + (nk.length > 4 ? " 등" : ""),
    "업무 화면인데 안내가 안 뜨면 그 화면에서 📸 기록과 메모를 남기고 보고서를 보내 주세요. 감지 규칙에 추가합니다.");
  // 상신으로 보이는데 가로채지 않은 버튼
  const miss = uniq(L.filter((e) => e.ev === "button" && e.d && !e.d.submit && SUBMIT_LIKE.test(e.d.label || "") && !MENU_LIKE.test(e.d.label || "")).map((e) => e.d.label));
  if (miss.length) add("mid", `상신 버튼일 수 있는데 결재 전 점검을 띄우지 않은 버튼: ${miss.slice(0, 6).join(", ")}`, "실제 상신 버튼이면 메모로 알려 주세요. 점검 대상 버튼 이름에 추가합니다.");
  const shown = L.filter((e) => e.ev === "guard.show").length, cont = L.filter((e) => e.ev === "guard.continue").length;
  if (shown) add("good", `결재 전 점검 카드가 ${shown}번 떴습니다(계속 ${cont} · 취소 ${L.filter((e) => e.ev === "guard.cancel").length}).`, "");
  const det = uniq(L.filter((e) => e.ev === "context" && e.d).map((e) => e.d.title)).slice(0, 6);
  if (det.length) add("good", `알아본 업무 화면: ${det.join(", ")}`, "");
  if (!out.some((f) => f.sev === "high" || f.sev === "mid")) add("good", L.length ? "큰 문제는 찾지 못했습니다." : "아직 기록이 없습니다. ERP 화면에서 서무비서를 써 본 뒤 다시 보세요.", "");
  const order = { high: 0, mid: 1, info: 2, good: 3 };
  return out.sort((a, b) => order[a.sev] - order[b.sev]);
}
function renderFindings() {
  const icon = { high: "⛔", mid: "⚠️", info: "ℹ️", good: "✅" };
  $("findings").innerHTML = findings().map((f) => `<li class="${f.sev}"><b>${icon[f.sev]} ${esc(f.title)}</b>${f.fix ? `<div class="fix">→ ${esc(f.fix)}</div>` : ""}</li>`).join("");
}

// ── 이 탭 점검: 지금 이 탭에서 확장이 어떻게 붙어 있는지 ───────────────────────────
async function tabCheck() {
  const id = Number($("tabs").value); if (!id) { toast("ERP 탭을 먼저 여세요."); return; }
  const r = await chrome.runtime.sendMessage({ type: "diag.tabcheck", tabId: id }).catch((e) => ({ ok: false, error: e.message }));
  if (!r || !r.ok) { $("checkOut").innerHTML = `<dt>결과</dt><dd class="bad">${esc((r && r.error) || "점검하지 못했습니다.")}</dd>`; return; }
  let verdict, cls = "bad";
  if (!r.listed) verdict = "이 사이트는 확장 설정의 ERP 주소에 없습니다 → ⚙ 설정에서 주소를 추가하세요.";
  else if (!r.allowed) verdict = "이 사이트 접근 권한이 없습니다 → ⚙ 설정에서 저장하면 권한을 묻습니다.";
  else if (r.frameErr && IE_RX.test(r.frameErr)) verdict = "확장이 화면 안에 들어갈 수 없습니다(Edge IE 모드로 보임) → 패널 안내·복사만 됩니다.";
  else if (r.frames && !r.framesWithScript) verdict = "확장이 아직 붙지 않았습니다 → 이 탭을 새로고침(F5)하세요(설치 전에 열린 탭).";
  else { verdict = r.context ? `정상 — '${r.context.title}' 업무로 알아봤습니다.` : "정상 — 확장이 붙어 있습니다(이 화면은 업무로 알아보지 않음)."; cls = "ok"; }
  const row = (k, v) => `<dt>${esc(k)}</dt><dd>${v}</dd>`;
  $("checkOut").innerHTML = row("판정", `<span class="${cls}">${esc(verdict)}</span>`) + row("주소", esc(r.url)) + row("창", esc(r.windowType === "popup" ? "팝업 창(ERP가 띄운 창)" : r.windowType || "일반"))
    + row("ERP 주소 등록", r.listed ? "예" : "아니요") + row("접근 권한", r.allowed ? "있음" : "없음")
    + row("확장이 붙은 프레임", r.frameErr ? `읽을 수 없음 (${esc(r.frameErr)})` : `${r.framesWithScript} / ${r.frames}`)
    + row("알아본 업무", r.context ? esc(`${r.context.title} → ${r.context.q}${r.context.tabOnly ? " (주소·제목으로)" : ""}`) : "없음")
    + row("결재 전 점검", r.guard ? `${r.guard.n}개 항목${r.guard.enabled ? "" : " (꺼짐)"}` : "없음");
  chrome.runtime.sendMessage({ type: "diag.note", text: `[탭 점검] ${r.url} — ${verdict}` }).catch(() => {});
}
function renderStat() {
  const by = {};
  data.log.forEach((e) => { by[e.ev] = (by[e.ev] || 0) + 1; });
  const errs = data.log.filter(isErr).length;
  $("stat").innerHTML = `<span class="st">기록 ${data.log.length}건</span>` + (errs ? `<span class="st err">오류·실패 ${errs}건</span>` : "") +
    Object.entries(by).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([k, v]) => `<span class="st">${esc(k)} ${v}</span>`).join("");
}
function renderRows() {
  const f = $("f").value;
  const pick = (e) => !f || (f === "err" ? isErr(e) : f === "user" ? e.src === "user" : f === "detect" ? /detect|context/.test(e.ev)
    : f === "fill" ? /fill|insert|focus/.test(e.ev) : /guard|button/.test(e.ev + e.src));
  const rows = data.log.filter(pick).slice(-400).reverse();
  $("cnt").textContent = `${rows.length}건 표시(최근 순)`;
  $("rows").innerHTML = rows.map((e) => `<tr class="${isErr(e) ? "err" : e.src === "user" ? "user" : ""}"><td class="t">${esc(e.t.slice(11, 19))}</td><td>${esc(e.src)}${e.fid ? `<span class="sub"> f${e.fid}</span>` : ""}</td><td>${esc(e.ev)}</td><td class="d">${esc(JSON.stringify(e.d || {})).slice(0, 600)}</td></tr>`).join("") ||
    `<tr><td colspan="4" class="sub">기록이 없습니다. ERP 화면에서 서무비서를 써 보세요.</td></tr>`;
}
async function tabs() {
  const ts = (await chrome.tabs.query({})).filter((t) => /^https?:/.test(t.url || ""));
  const want = Number(params.get("tab"));
  $("tabs").innerHTML = ts.map((t) => `<option value="${t.id}"${t.id === want ? " selected" : ""}>${esc((t.title || "").slice(0, 40))} — ${esc(new URL(t.url).host)}</option>`).join("") || `<option value="">열린 ERP 탭이 없습니다</option>`;
}
function report() {
  return { kind: "secretary-diag", created: new Date().toISOString(), version: data.version, ua: navigator.userAgent,
    settings: { server: data.settings.server, erpHosts: data.settings.erpHosts, floating: data.settings.floating, guard: data.settings.guard, autoAsk: data.settings.autoAsk, notify: data.settings.notify },
    state: data.state, deadlines: data.deadlines, meta: data.meta, latest, findings: findings(), log: data.log };
}
function summary() {
  const r = report(); const L = r.log;
  const notes = L.filter((e) => e.ev === "note").map((e) => `- ${e.t.slice(11, 16)} ${e.d.text}`);
  const errs = L.filter(isErr).slice(-15).map((e) => `- ${e.t.slice(11, 19)} ${e.src}/${e.ev} ${JSON.stringify(e.d || {}).slice(0, 200)}`);
  const none = [...new Set(L.filter((e) => e.ev === "detect.none").map((e) => (e.d.texts || []).slice(0, 6).join(" | ")))].slice(0, 5);
  const btn = [...new Set(L.filter((e) => e.ev === "button").map((e) => `${e.d.label}${e.d.submit ? "(점검함)" : "(점검 안 함)"}`))].slice(0, 15);
  return [`서무비서 진단 요약 · 확장 ${r.version} · ${r.created.slice(0, 16)}`, `기록 ${L.length}건 · 오류·실패 ${L.filter(isErr).length}건`,
    "자동 진단:\n" + r.findings.map((f) => `- [${f.sev}] ${f.title}`).join("\n"),
    notes.length ? "메모:\n" + notes.join("\n") : "메모: 없음", errs.length ? "오류·실패(최근):\n" + errs.join("\n") : "오류·실패: 없음",
    none.length ? "업무를 알아보지 못한 화면의 제목 문구:\n" + none.map((x) => "- " + x).join("\n") : "", btn.length ? "누른 결재 관련 버튼: " + btn.join(", ") : ""].filter(Boolean).join("\n\n");
}

$("on").addEventListener("change", async (e) => { await chrome.runtime.sendMessage({ type: "diag.enable", on: e.target.checked }); toast(e.target.checked ? "진단 기록을 켰습니다." : "진단 기록을 껐습니다."); });
$("snap").addEventListener("click", async () => {
  const id = Number($("tabs").value); if (!id) { toast("ERP 탭을 먼저 여세요."); return; }
  $("snapOut").textContent = "기록하는 중...";
  const r = await chrome.runtime.sendMessage({ type: "diag.snapshot", tabId: id }).catch((e) => ({ ok: false, error: e.message }));
  if (!r || !r.ok) {
    const err = (r && r.error) || "";
    $("snapOut").textContent = "기록하지 못했습니다: " + err + (/not ready|Cannot access/i.test(err)
      ? "\n이 탭은 Edge 'IE 모드'(주소창 왼쪽 e 아이콘) 등으로 열려 확장이 화면 안에 들어갈 수 없습니다. 주소·제목으로만 업무를 알아보고, 초안은 복사 → Ctrl+V 로 넣습니다."
      : "\n이 탭 주소가 확장 설정의 ERP 주소에 들어 있는지, 탭을 새로고침했는지 확인하세요.");
    return;
  }
  const s = r.snap;
  $("snapOut").textContent = [`${s.title} — ${s.page}`, `감지: ${s.context ? s.context.title + " (" + (s.context.proc || "절차 없음") + ")" : "없음"}`,
    ...s.frames.map((f) => `▸ 프레임 '${f.path || "(맨 위)"}' ${f.url}\n   칸 ${f.fields.length}: ${f.fields.map((x) => x.label + "[" + x.kind + "]").join(", ").slice(0, 300)}\n   버튼: ${(f.buttons || []).map((b) => b.t).join(", ").slice(0, 300)}\n   iframe: ${(f.iframes || []).map((i) => (i.id || i.name || i.src) + (i.designMode === "on" || i.editable ? "(편집기)" : "")).join(", ")}\n   단서: ${(f.scriptHints || []).join(", ")}`)].join("\n");
  toast("화면 구조를 기록했습니다."); load();
});
$("noteBtn").addEventListener("click", async () => {
  const t = $("note").value.trim(); if (!t) { toast("메모를 적어 주세요."); return; }
  await chrome.runtime.sendMessage({ type: "diag.note", text: t }); $("note").value = ""; toast("메모를 남겼습니다."); load();
});
$("dl").addEventListener("click", () => {
  const blob = new Blob([JSON.stringify(report(), null, 1)], { type: "application/json" });
  const a = document.createElement("a"); a.href = URL.createObjectURL(blob);
  a.download = `secretary-diag-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, "")}.json`; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 3000);
});
$("copy").addEventListener("click", async () => {
  try { await navigator.clipboard.writeText(summary()); toast("요약을 복사했습니다. Claude 대화에 붙여넣으세요."); }
  catch (e) { $("snapOut").textContent = summary(); toast("복사하지 못해 위 칸에 요약을 펼쳤습니다."); }
});
$("up").addEventListener("click", async () => {
  if (!data.settings.server) { toast("서무비서 주소가 설정되어 있지 않습니다."); return; }
  let tok = (await chrome.storage.session.get("adminTok")).adminTok || "";
  if (!tok) { tok = (prompt("관리자 토큰(서무비서 내규 업로드 토큰)") || "").trim(); if (!tok) return; }
  $("sendMsg").textContent = "보내는 중...";
  try {
    const r = await fetch(data.settings.server + "/api/secretary/diag", { method: "POST", headers: { "Content-Type": "application/json", "X-Upload-Token": tok }, body: JSON.stringify(report()) });
    const j = await r.json();
    if (!j.success) { if (r.status === 401) await chrome.storage.session.remove("adminTok"); $("sendMsg").innerHTML = `<span class="bad">${esc(j.error || "보내지 못했습니다.")}</span>`; return; }
    await chrome.storage.session.set({ adminTok: tok });
    $("sendMsg").innerHTML = `<span class="ok">보냈습니다 — ${esc(j.path)}</span>. Claude에게 "진단 보고서 확인해줘"라고 말하면 됩니다.`;
  } catch (e) { $("sendMsg").innerHTML = `<span class="bad">서버에 연결하지 못했습니다. 보고서 받기로 파일을 받아 주세요.</span>`; }
});
$("clear").addEventListener("click", async () => { if (!confirm("진단 기록을 모두 지울까요?")) return; await chrome.runtime.sendMessage({ type: "diag.clear" }); load(); toast("지웠습니다."); });
$("f").addEventListener("change", renderRows);
$("check").addEventListener("click", tabCheck);
$("reload").addEventListener("click", load);
tabs(); load();
