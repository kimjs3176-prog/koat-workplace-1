// 서무비서 확장 — 진단 센터: 시험 기록 보기·화면 구조 기록·메모·보고서 보내기
const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
let data = null;
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
function toast(m, ms) { const t = $("toast"); t.textContent = m; t.classList.add("show"); clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove("show"), ms || 2800); }
const isErr = (e) => e.ev === "error" || /error|fail/.test(e.ev) || (e.d && (e.d.ok === false || (Array.isArray(e.d.missing) && e.d.missing.length)));

async function load() {
  data = await chrome.runtime.sendMessage({ type: "diag.get" });
  $("ver").textContent = `확장 ${data.version} · 서버 ${data.settings.server || "(설정 안 됨)"}`;
  $("on").checked = !!data.enabled;
  renderStat(); renderRows();
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
    state: data.state, profiles: data.profiles, deadlines: data.deadlines, meta: data.meta, log: data.log };
}
function summary() {
  const r = report(); const L = r.log;
  const notes = L.filter((e) => e.ev === "note").map((e) => `- ${e.t.slice(11, 16)} ${e.d.text}`);
  const errs = L.filter(isErr).slice(-15).map((e) => `- ${e.t.slice(11, 19)} ${e.src}/${e.ev} ${JSON.stringify(e.d || {}).slice(0, 200)}`);
  const none = [...new Set(L.filter((e) => e.ev === "detect.none").map((e) => (e.d.texts || []).slice(0, 6).join(" | ")))].slice(0, 5);
  const btn = [...new Set(L.filter((e) => e.ev === "button").map((e) => `${e.d.label}${e.d.submit ? "(점검함)" : "(점검 안 함)"}`))].slice(0, 15);
  return [`서무비서 진단 요약 · 확장 ${r.version} · ${r.created.slice(0, 16)}`, `기록 ${L.length}건 · 오류·실패 ${L.filter(isErr).length}건`,
    notes.length ? "메모:\n" + notes.join("\n") : "메모: 없음", errs.length ? "오류·실패(최근):\n" + errs.join("\n") : "오류·실패: 없음",
    none.length ? "업무를 알아보지 못한 화면의 제목 문구:\n" + none.map((x) => "- " + x).join("\n") : "", btn.length ? "누른 결재 관련 버튼: " + btn.join(", ") : ""].filter(Boolean).join("\n\n");
}

$("on").addEventListener("change", async (e) => { await chrome.runtime.sendMessage({ type: "diag.enable", on: e.target.checked }); toast(e.target.checked ? "진단 기록을 켰습니다." : "진단 기록을 껐습니다."); });
$("snap").addEventListener("click", async () => {
  const id = Number($("tabs").value); if (!id) { toast("ERP 탭을 먼저 여세요."); return; }
  $("snapOut").textContent = "기록하는 중...";
  const r = await chrome.runtime.sendMessage({ type: "diag.snapshot", tabId: id }).catch((e) => ({ ok: false, error: e.message }));
  if (!r || !r.ok) { $("snapOut").textContent = "기록하지 못했습니다: " + ((r && r.error) || "") + "\n이 탭 주소가 확장 설정의 ERP 주소에 들어 있는지, 탭을 새로고침했는지 확인하세요."; return; }
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
$("reload").addEventListener("click", load);
tabs(); load();
