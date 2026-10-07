// 서무비서 확장 — ERP 맞춤 도구
// 지금 ERP 화면의 구조(모든 프레임의 입력란·편집기·제목)를 분석해,
//  ① 이 화면을 알아보는 규칙(주소·제목) ② 서무비서 업무·초안 ③ 칸 ↔ 초안 항목 연결을 만든다.
// 저장: 내 브라우저(chrome.storage.local) 또는 기관 공유(서버, 관리자 토큰) — 기관 공유본은 모든 직원 확장이 받아 쓴다.
const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
let tabId = params.get("tab") ? Number(params.get("tab")) : null;
let server = "", meta = null, ana = null, cur = null, tabUrl = "";
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const uid = () => "s" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
function toast(m, ms) { const t = $("toast"); t.textContent = m; t.classList.add("show"); clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove("show"), ms || 2600); }
const send = (m) => chrome.runtime.sendMessage(m);
const originOf = (u) => { try { const x = new URL(u); return x.origin + "/*"; } catch (e) { return ""; } };

// 서무비서 초안 항목 + 공통 항목(제목·본문 전체)
const SPECIAL = [["_title", "제목(초안 첫 줄)"], ["_body", "본문 전체(초안 전체)"]];
// 칸 이름 → 항목 자동 추천(정확히 같은 이름 우선, 다음 포함 관계)
const ALIASES = {
  _title: ["제목", "건명", "문서제목", "기안제목", "subject", "title"],
  _body: ["본문", "기안내용", "본문 편집기", "내용입력", "editor"],
  name: ["출장자", "성명", "이름", "신청자", "작성자", "강사"], dept: ["소속", "부서", "소속부서"],
  period: ["출장기간", "기간", "일시", "출장일시", "교육기간", "휴가기간"], place: ["출장지", "장소", "출장장소", "행사장소"],
  purpose: ["출장목적", "목적", "사유"], content: ["주요내용", "출장내용", "결과"], follow: ["향후조치", "조치사항", "향후계획", "건의사항"],
  amount: ["금액", "합계", "사용금액"], date: ["일자", "사용일", "사용일자"], reason: ["사용사유"], fare: ["운임"], lodging: ["숙박비"], evid: ["증빙서류", "증빙"], card: ["결제수단"]
};
const norm = (s) => String(s || "").replace(/\s+/g, "").toLowerCase();
function suggest(field, draftKey) {
  const lb = norm(field.label);
  if (field.kind === "editor") return "_body";
  const dfields = draftFields(draftKey).map((f) => f.k);
  const keys = ["_title", ...dfields, "_body"];
  for (const k of keys) {                                   // 정확히 같은 이름
    const names = [...(ALIASES[k] || []), ...(draftFields(draftKey).find((f) => f.k === k) ? [draftFields(draftKey).find((f) => f.k === k).l] : [])];
    if (names.some((n) => norm(n) === lb)) return k;
  }
  if (field.kind === "textarea" && /내용|본문/.test(field.label || "")) return "_body";
  return "";
}
function draftFields(key) { const d = meta && meta.drafts.find((x) => x.key === key); return d ? d.fields : []; }
function keyLabel(k, draftKey) {
  const sp = SPECIAL.find((x) => x[0] === k); if (sp) return sp[1];
  const f = draftFields(draftKey).find((x) => x.k === k) || (meta ? meta.drafts.flatMap((d) => d.fields).find((x) => x.k === k) : null);
  return f ? f.l : k;
}

async function currentTab() {
  if (tabId != null) { try { const t = await chrome.tabs.get(tabId); tabUrl = t.url || ""; return tabId; } catch (e) {} }
  const [t] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (t) { tabId = t.id; tabUrl = t.url || ""; }
  return tabId;
}

async function loadMeta() {
  const s = await send({ type: "settings" });
  server = (s && s.server) || "";
  if (!server) return;
  try { meta = await (await fetch(server + "/api/secretary/erp/meta", { cache: "no-store" })).json(); }
  catch (e) { meta = null; }
}

// ── 분석 ────────────────────────────────────────────────────
async function analyze() {
  await currentTab();
  if (!/^https?:/.test(tabUrl)) { toast("ERP 탭을 먼저 여세요."); return; }
  $("analyze").disabled = true; $("analyze").textContent = "분석 중...";
  const r = await send({ type: "analyze", tabId }).catch((e) => ({ ok: false, error: e.message }));
  $("analyze").disabled = false; $("analyze").textContent = "🔍 이 화면 구조 분석";
  if (!r || !r.ok) { toast((r && r.error) || "분석하지 못했습니다.", 5000); return; }
  ana = r;
  const fields = r.frames.flatMap((f) => f.fields || []);
  // 칸이 가장 많은 프레임(= 실제 서식 화면)의 제목 요소를 앞에, 문서 제목(탭 이름)은 뒤에
  const main = [...r.frames].sort((a, b) => (b.fields || []).length - (a.fields || []).length)[0] || r.frames[0] || {};
  const others = r.frames.filter((f) => f !== main);
  const heads = [...new Set([...(main.headings || []).slice(1), ...others.flatMap((f) => (f.headings || []).slice(1)), (main.headings || [])[0], ...others.map((f) => (f.headings || [])[0])])]
    .filter((h) => h && h.length <= 30).slice(0, 24);
  let urlRule = ""; try { const u = new URL(main.url || r.url); urlRule = u.pathname.length > 1 ? u.pathname : ""; } catch (e) {}
  const ctx = r.context || {};
  const existing = ctx.screenId ? await findScreen(ctx.screenId) : null;
  cur = existing ? JSON.parse(JSON.stringify(existing)) : { id: uid(), name: heads[0] || ctx.title || "", match: { url: urlRule, title: "" }, q: ctx.q || "", proc: ctx.proc || "", draft: ctx.draft || "", fields: [] };
  cur._found = fields;
  cur._heads = heads;
  if (!existing) {
    // 서식 화면의 제목 → 화면 이름·제목 규칙. 기본 감지 규칙으로 업무·초안도 미리 고른다.
    const t = heads.find((h) => (globalThis.SEC_RULES || []).some(([rx]) => rx.test(h))) || heads[0] || "";
    if (t) { cur.match.title = t; cur.name = t; }
    const rule = (globalThis.SEC_RULES || []).find(([rx]) => rx.test(t));
    if (rule && !cur.q) { cur.q = rule[1]; cur.proc = rule[2] || ""; }
    if (!cur.draft && cur.proc && meta) {               // 그 절차의 초안이 하나뿐이거나 화면 이름에 맞으면 미리 고른다
      const pr = (meta.procedures || []).find((x) => x.id === cur.proc);
      const ds = ((pr && pr.drafts) || []).filter((k, i, a) => a.indexOf(k) === i);
      const byName = ds.find((k) => { const d = meta.drafts.find((x) => x.key === k); return d && /복명|결과/.test(t) === /복명|결과/.test(d.title); });
      cur.draft = (ds.length === 1 ? ds[0] : byName) || "";
    }
    if (!cur.draft && meta) { const d = (meta.drafts || []).find((x) => norm(t).includes(norm(x.title).replace(/\(.*\)/, "")) || norm(x.title).includes(norm(t))); if (d) cur.draft = d.key; }
  }
  renderEdit();
  $("cur").innerHTML = `${esc(r.title || "")}<br>${esc(r.url)}<br>프레임 ${r.frames.length}개 · 입력란 ${fields.length}개${ctx.screenId ? ` · <b>저장된 규칙 '${esc(ctx.title)}'로 알아봄</b>` : ctx.q ? ` · 기본 규칙으로 '${esc(ctx.title)}' 감지` : " · 아직 알아보지 못한 화면"}`;
}

async function findScreen(id) {
  const r = await send({ type: "allProfiles" });
  for (const p of r.profiles || []) for (const sc of p.screens || []) if (sc.id === id) return sc;
  return null;
}

// ── 편집 화면 ───────────────────────────────────────────────
function mappingOptions(sel, draftKey) {
  const dfs = draftFields(draftKey);
  const all = meta ? [...new Map(meta.drafts.flatMap((d) => d.fields).map((f) => [f.k, f])).values()] : [];
  const extra = all.filter((f) => !dfs.some((x) => x.k === f.k));
  const opt = (k, l) => `<option value="${esc(k)}"${sel === k ? " selected" : ""}>${esc(l)}</option>`;
  return `<option value="">— 연결 안 함 —</option>` + SPECIAL.map(([k, l]) => opt(k, l)).join("") +
    (dfs.length ? `<optgroup label="이 초안 항목">${dfs.map((f) => opt(f.k, f.l)).join("")}</optgroup>` : "") +
    (extra.length ? `<optgroup label="다른 초안 항목">${extra.map((f) => opt(f.k, f.l)).join("")}</optgroup>` : "");
}
function fieldKeyOf(f) { return [f.frame, f.sel, f.name, f.fid].join("|"); }
function renderEdit() {
  const e = $("edit"); e.hidden = false;
  const found = cur._found || [];
  // 저장된 연결 + 분석에서 찾은 칸(추천 포함)을 한 목록으로
  const mapped = new Map((cur.fields || []).map((f) => [fieldKeyOf(f), f]));
  const rows = [];
  for (const f of found) {
    const k = fieldKeyOf(f);
    const m = mapped.get(k);
    rows.push({ ...f, key: m ? m.key : suggest(f, cur.draft), auto: !m });
    mapped.delete(k);
  }
  for (const m of mapped.values()) rows.push({ ...m, missing: true });
  cur._rows = rows;
  const procs = (meta && meta.procedures) || [];
  const drafts = (meta && meta.drafts) || [];
  e.innerHTML = `<div class="h">화면 규칙 ${(cur.fields || []).length ? '<span class="sub">(저장된 규칙 편집 중)</span>' : ""}</div>
    <label class="f">화면 이름<input id="scName" value="${esc(cur.name)}" placeholder="예: 출장복명서 작성"></label>
    <div class="grid">
      <label class="f">주소에 들어 있는 글자<input id="scUrl" value="${esc(cur.match.url)}" placeholder="/gw/app/report.do"></label>
      <label class="f">화면 제목 글자<input id="scTitle" value="${esc(cur.match.title)}" placeholder="출장복명서"></label>
    </div>
    ${cur._heads && cur._heads.length ? `<div class="sub">화면에서 찾은 제목 — 누르면 제목 글자로</div><div class="chips">${cur._heads.map((h) => `<button class="chip${h === cur.match.title ? " on" : ""}" data-head="${esc(h)}" type="button">${esc(h)}</button>`).join("")}</div>` : ""}
    <div class="sub">주소·제목 중 하나만 적어도 됩니다. 둘 다 적으면 둘 다 맞을 때만 이 화면으로 봅니다. /정규식/ 도 쓸 수 있습니다.</div>
    <div class="grid">
      <label class="f">서무비서 업무<select id="scProc"><option value="">— 고르기 —</option>${procs.map((p) => `<option value="${esc(p.id)}"${p.id === cur.proc || (!cur.proc && p.q === cur.q) ? " selected" : ""}>${esc(p.icon || "")} ${esc(p.title.split(" — ")[0])}</option>`).join("")}</select></label>
      <label class="f">이 화면에 넣을 초안<select id="scDraft"><option value="">— 없음 —</option>${drafts.map((d) => `<option value="${esc(d.key)}"${d.key === cur.draft ? " selected" : ""}>${esc(d.title)}</option>`).join("")}</select></label>
    </div>
    ${!meta ? `<div class="sub">⚠ 서무비서 주소가 설정되지 않아 업무·초안 목록을 불러오지 못했습니다(⚙ 설정).</div>` : ""}
    <div class="h" style="margin-top:4px">칸 연결 <span class="sub">찾은 칸 ${found.length}개 · 이름이 맞는 칸은 미리 골라 두었습니다</span></div>
    <div class="fl">${rows.map((f, i) => `<div class="fi${f.key ? " on" : ""}">
        <span class="lb" title="${esc(f.label)}">${esc(f.label || "(이름 없는 칸)")}</span>
        <span class="row"><button class="mini" data-hl="${i}" type="button" title="ERP 화면에서 이 칸 보기">👁</button></span>
        <span class="meta">${esc(f.kind)}${f.name ? " · name=" + esc(f.name) : ""}${f.frame ? " · 프레임 " + esc(f.frame) : ""}${f.missing ? " · ⚠ 지금 화면에서 못 찾음" : ""}${f.auto && f.key ? " · 추천" : ""}</span>
        <select data-map="${i}" aria-label="${esc(f.label)} 연결">${mappingOptions(f.key, cur.draft)}</select>
      </div>`).join("") || `<div class="sub">입력란을 찾지 못했습니다. 아래 '화면에서 칸 고르기'로 직접 지정하세요.</div>`}</div>
    <div class="row">
      <button class="btn ghost sm" id="pick" type="button">🎯 화면에서 칸 고르기</button>
      <button class="btn ghost sm" id="test" type="button">▶ 시험 채우기</button>
    </div>
    <div class="row">
      <button class="btn sm" id="saveMine" type="button">💾 내 브라우저에 저장</button>
      <button class="btn sm warn" id="saveOrg" type="button">🏢 기관 전체에 공유</button>
    </div>
    <div class="sub">'기관 전체에 공유'는 관리자 토큰이 필요하며, 모든 직원의 확장이 이 규칙을 받아 씁니다. 칸 위치(이름·선택자)만 저장하고 화면의 내용은 저장하지 않습니다.</div>`;
  e.querySelectorAll("[data-head]").forEach((b) => b.addEventListener("click", () => { $("scTitle").value = b.dataset.head; if (!$("scName").value) $("scName").value = b.dataset.head; e.querySelectorAll("[data-head]").forEach((x) => x.classList.toggle("on", x === b)); }));
  e.querySelectorAll("[data-map]").forEach((s) => s.addEventListener("change", () => { const r = cur._rows[+s.dataset.map]; r.key = s.value; r.auto = false; s.closest(".fi").classList.toggle("on", !!s.value); }));
  e.querySelectorAll("[data-hl]").forEach((b) => b.addEventListener("click", async () => {
    const r = await send({ type: "highlight", tabId, field: cur._rows[+b.dataset.hl] });
    if (!r || !r.ok) toast("ERP 화면에서 이 칸을 찾지 못했습니다.");
  }));
  $("scDraft").addEventListener("change", () => { collect(); cur._rows.forEach((r) => { if (r.auto) r.key = suggest(r, cur.draft); }); cur.fields = cur._rows.filter((r) => r.key && !r.auto); renderEdit(); });
  $("pick").addEventListener("click", startPick);
  $("test").addEventListener("click", async () => {
    const sc = collect();
    if (!sc.fields.length) { toast("연결한 칸이 없습니다."); return; }
    const r = await send({ type: "fillmap", tabId, screen: sc, test: true });
    toast(r && r.ok ? `시험 값으로 ${r.filled.length}칸을 채웠습니다.${r.missing.length ? " 못 찾은 칸: " + r.missing.map((k) => keyLabel(k, sc.draft)).join(", ") : ""}` : "채우지 못했습니다. ERP 탭을 새로고침한 뒤 다시 분석하세요.", 5000);
  });
  $("saveMine").addEventListener("click", () => save(false));
  $("saveOrg").addEventListener("click", () => save(true));
}
function collect() {
  cur.name = $("scName").value.trim(); cur.match = { url: $("scUrl").value.trim(), title: $("scTitle").value.trim() };
  cur.proc = $("scProc").value; cur.draft = $("scDraft").value;
  const pr = ((meta && meta.procedures) || []).find((x) => x.id === cur.proc);
  if (pr) cur.q = pr.q;
  const fields = (cur._rows || []).filter((r) => r.key).map((r) => {
    const o = { key: r.key }; for (const k of ["label", "sel", "name", "fid", "frame", "kind"]) if (r[k] !== undefined && r[k] !== "") o[k] = r[k];
    if (r.frame === "") o.frame = "";
    return o;
  });
  return { id: cur.id, name: cur.name || cur.match.title || "화면", match: cur.match, q: cur.q, proc: cur.proc || "", draft: cur.draft, fields };
}

async function startPick() {
  const r = await send({ type: "pickStart", tabId });
  if (!r || !r.ok) { toast("ERP 화면에서 고르기를 시작하지 못했습니다."); return; }
  toast("ERP 화면에서 칸을 누르세요(취소: Esc)", 4000);
}
chrome.runtime.onMessage.addListener((m) => {
  if (m.to !== "panel" || m.type !== "picked" || m.tabId !== tabId || !cur) return;
  if (!m.field) { toast("고르기를 취소했습니다."); return; }
  collect();
  const k = fieldKeyOf(m.field);
  if (!(cur._found || []).some((f) => fieldKeyOf(f) === k)) cur._found = [...(cur._found || []), m.field];
  cur.fields = (cur._rows || []).filter((r) => r.key && !r.auto);
  if (!cur.fields.some((f) => fieldKeyOf(f) === k)) cur.fields.push({ ...m.field, key: suggest(m.field, cur.draft) || "_body" });
  renderEdit();
  toast(`'${m.field.label || "고른 칸"}'을 추가했습니다. 연결할 항목을 고르세요.`);
});

// ── 저장 ────────────────────────────────────────────────────
async function save(org) {
  const sc = collect();
  if (!sc.match.url && !sc.match.title) { toast("이 화면을 알아볼 주소나 제목 글자를 적으세요."); return; }
  const host = originOf(tabUrl);
  if (!host) { toast("ERP 탭 주소를 알 수 없습니다."); return; }
  if (!org) {
    const { myProfiles } = await chrome.storage.local.get("myProfiles");
    const list = myProfiles || [];
    let p = list.find((x) => x.hosts.includes(host));
    if (!p) { p = { id: "p" + Date.now().toString(36), name: new URL(tabUrl).host, hosts: [host], screens: [] }; list.push(p); }
    p.screens = [sc, ...p.screens.filter((x) => x.id !== sc.id)];
    await chrome.storage.local.set({ myProfiles: list });
    await send({ type: "profilesChanged" });
    toast("내 브라우저에 저장했습니다. ERP 화면에 바로 적용됩니다.");
  } else {
    if (!server) { toast("서무비서 주소를 먼저 설정하세요."); return; }
    let tok = (await chrome.storage.session.get("adminTok")).adminTok || "";
    if (!tok) { tok = (prompt("관리자 토큰(서무비서 내규 업로드 토큰)") || "").trim(); if (!tok) return; }
    try {
      const d = await (await fetch(server + "/api/secretary/erp/profiles?fresh=1", { cache: "no-store" })).json();
      const list = d.profiles || [];
      let p = list.find((x) => x.hosts.includes(host));
      if (!p) { p = { id: "p" + Date.now().toString(36), name: new URL(tabUrl).host, hosts: [host], screens: [] }; list.push(p); }
      p.screens = [sc, ...(p.screens || []).filter((x) => x.id !== sc.id)];
      const r = await fetch(server + "/api/secretary/erp/profiles", { method: "POST", headers: { "Content-Type": "application/json", "X-Upload-Token": tok }, body: JSON.stringify({ profiles: list }) });
      const j = await r.json();
      if (!j.success) { if (r.status === 401) await chrome.storage.session.remove("adminTok"); toast(j.error || "공유하지 못했습니다.", 5000); return; }
      await chrome.storage.session.set({ adminTok: tok });
      await send({ type: "profilesChanged", force: true });
      toast(j.message || "기관 전체에 공유했습니다.", 4200);
    } catch (e) { toast("서버에 연결하지 못했습니다."); return; }
  }
  renderSaved();
}

async function renderSaved(force) {
  await currentTab();
  const r = await send({ type: "allProfiles", force: !!force });
  const host = originOf(tabUrl);
  const ps = (r.profiles || []).filter((p) => !host || p.hosts.includes(host));
  const rows = ps.flatMap((p) => (p.screens || []).map((sc) => ({ p, sc })));
  $("savedSub").textContent = host ? `${host.replace("/*", "")} · ${rows.length}개` : `${rows.length}개`;
  $("saved").innerHTML = rows.map(({ p, sc }, i) => `<div class="sv"><b>${esc(sc.name)}</b>
      <span class="tag${sc.mine || p.source === "mine" ? " mine" : ""}">${sc.mine || p.source === "mine" ? "내 브라우저" : "기관"}</span>
      <span class="sub">${esc(sc.match.title || "")}${sc.match.url ? " · " + esc(sc.match.url) : ""} · 칸 ${(sc.fields || []).length}개${sc.draft ? " · " + esc(keyDraftTitle(sc.draft)) : ""}</span>
      <button class="mini" data-ed="${i}" type="button">편집</button>
      ${sc.mine || p.source === "mine" ? `<button class="mini" data-del="${i}" type="button">삭제</button>` : ""}</div>`).join("") ||
    `<div class="sub">이 ERP에 저장된 규칙이 없습니다. 위에서 화면을 분석해 만드세요.</div>`;
  $("saved").querySelectorAll("[data-ed]").forEach((b) => b.addEventListener("click", async () => {
    const { sc } = rows[+b.dataset.ed];
    await analyze();
    cur = { ...JSON.parse(JSON.stringify(sc)), _found: (cur && cur._found) || [], _heads: (cur && cur._heads) || [] };
    renderEdit(); $("edit").scrollIntoView({ behavior: "smooth" });
  }));
  $("saved").querySelectorAll("[data-del]").forEach((b) => b.addEventListener("click", async () => {
    const { sc } = rows[+b.dataset.del];
    if (!confirm(`'${sc.name}' 규칙을 내 브라우저에서 지울까요?`)) return;
    const { myProfiles } = await chrome.storage.local.get("myProfiles");
    const list = (myProfiles || []).map((p) => ({ ...p, screens: (p.screens || []).filter((x) => x.id !== sc.id) })).filter((p) => p.screens.length);
    await chrome.storage.local.set({ myProfiles: list });
    await send({ type: "profilesChanged" }); renderSaved();
  }));
}
function keyDraftTitle(k) { const d = meta && meta.drafts.find((x) => x.key === k); return d ? d.title : k; }

$("analyze").addEventListener("click", analyze);
$("back").addEventListener("click", () => { location.href = "sidepanel.html" + (params.get("fixed") ? "?tab=" + tabId : ""); });
$("opt").addEventListener("click", () => chrome.runtime.openOptionsPage());
$("refresh").addEventListener("click", async () => { await renderSaved(true); toast("기관 규칙을 다시 받았습니다."); });
$("export").addEventListener("click", async () => {
  const { myProfiles } = await chrome.storage.local.get("myProfiles");
  const blob = new Blob([JSON.stringify({ kind: "secretary-erp-profiles", exported: new Date().toISOString().slice(0, 10), profiles: myProfiles || [] }, null, 1)], { type: "application/json" });
  const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = "서무비서_ERP규칙.json"; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
});
$("import").addEventListener("change", (e) => {
  const f = e.target.files && e.target.files[0]; e.target.value = ""; if (!f) return;
  const rd = new FileReader();
  rd.onload = async () => {
    try {
      const d = JSON.parse(rd.result); const inc = (d && d.profiles) || [];
      if (!Array.isArray(inc)) throw 0;
      const { myProfiles } = await chrome.storage.local.get("myProfiles");
      const list = myProfiles || [];
      for (const p of inc) {
        if (!p || !Array.isArray(p.hosts) || !Array.isArray(p.screens)) continue;
        const same = list.find((x) => x.hosts.some((h) => p.hosts.includes(h)));
        if (!same) list.push(p); else for (const sc of p.screens) same.screens = [sc, ...same.screens.filter((x) => x.id !== sc.id)];
      }
      await chrome.storage.local.set({ myProfiles: list });
      await send({ type: "profilesChanged" }); renderSaved(); toast("ERP 규칙을 가져왔습니다.");
    } catch (err) { toast("ERP 규칙 파일이 아닙니다."); }
  };
  rd.readAsText(f);
});
chrome.tabs.onActivated && !params.get("fixed") && chrome.tabs.onActivated.addListener(async () => { tabId = null; await currentTab(); renderSaved(); });

(async () => { await currentTab(); await loadMeta(); renderSaved(); $("cur").textContent = tabUrl || "ERP 탭을 연 상태에서 분석하세요."; })();
