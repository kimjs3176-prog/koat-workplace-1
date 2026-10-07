// 서무비서 사이드 패널 — 서무비서 웹앱을 담고, ERP 화면(내용 스크립트)과 이어 준다
const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
let tabId = params.get("tab") ? Number(params.get("tab")) : null;   // 작은 창(대체 모드)일 때 고정
let server = "", origin = "", ready = false, queue = [], ctx = null;

function post(msg) {
  const w = $("app").contentWindow;
  if (!ready || !w) { queue.push(msg); return; }
  w.postMessage(Object.assign({ src: "koat-sec-ext" }, msg), origin);
}
function ask(q) { if (q) post({ type: "ask", q }); }

function showCtx(c) {
  ctx = c;
  const b = $("ctx");
  if (!c) { b.hidden = true; return; }
  b.textContent = "🗂 ERP: " + c.title + " — 안내 보기";
  b.title = "ERP 화면에서 감지한 업무: " + c.title;
  b.hidden = false;
}

async function currentTab() {
  if (params.get("tab")) return tabId;
  const [t] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return t ? t.id : null;
}

async function refreshContext(askNow) {
  tabId = await currentTab();
  if (tabId == null) return;
  const r = await chrome.runtime.sendMessage({ type: "getContext", tabId }).catch(() => null);
  showCtx(r && r.context);
  if (r && r.ask) ask(r.ask);
  else if (askNow && r && r.context) ask(r.context.q);
}

async function init() {
  const s = await chrome.runtime.sendMessage({ type: "settings" });
  server = (s && s.server) || "";
  if (!server) { $("setup").hidden = false; return; }
  try { origin = new URL(server).origin; } catch (e) { $("setup").hidden = false; return; }
  const f = $("app");
  f.src = server + "/?embed=ext";
  f.hidden = false;
  await refreshContext(false);
}

// 앱 → 패널
window.addEventListener("message", async (e) => {
  if (e.origin !== origin || e.source !== $("app").contentWindow) return;
  const m = e.data || {};
  if (m.src !== "koat-sec") return;
  if (m.type === "ready") {
    ready = true;
    post({ type: "hello", version: chrome.runtime.getManifest().version });
    const q = queue; queue = [];
    q.forEach(post);
  } else if (m.type === "insert") {
    const id = await currentTab();
    if (id == null) { post({ type: "inserted", ok: false, error: "ERP 탭을 찾지 못했습니다." }); return; }
    const text = String(m.text || "").slice(0, 20000);
    // 1) 이 ERP 화면에 칸 매핑(ERP 맞춤)이 있으면 여러 칸을 한 번에
    const vals = Object.assign({}, m.values || {}, { _body: text, _title: (text.split("\n").map((x) => x.trim()).find(Boolean) || "") });
    const fm = await chrome.runtime.sendMessage({ type: "fillmap", tabId: id, draft: m.draft || "", values: vals }).catch(() => null);
    if (fm && fm.ok) { post({ type: "inserted", ok: true, mapped: true, filled: fm.filled, missing: fm.missing, screen: fm.screen }); return; }
    // 2) 아니면 마지막으로 누른 칸에
    const r = await chrome.runtime.sendMessage({ type: "insert", tabId: id, text }).catch(() => ({ ok: false }));
    post({ type: "inserted", ok: !!(r && r.ok), error: r && r.error, mappedButMissed: !!(fm && fm.mapped) });
  }
});

// 서비스 워커 → 패널
chrome.runtime.onMessage.addListener((m) => {
  if (m.to !== "panel" || (tabId != null && m.tabId !== tabId)) return;
  if (m.type === "context") showCtx(m.context);
  else if (m.type === "ask") ask(m.q);
});
if (!params.get("tab")) {
  chrome.tabs.onActivated.addListener(() => refreshContext(false));
}

$("ctx").addEventListener("click", () => { if (ctx) ask(ctx.q); });
$("home").addEventListener("click", () => { if (server) { ready = false; $("app").src = server + "/?embed=ext"; } });
$("opt").addEventListener("click", () => chrome.runtime.openOptionsPage());
$("tool").addEventListener("click", async () => { const id = await currentTab(); location.href = "erp.html" + (id != null ? "?tab=" + id + (params.get("tab") ? "&fixed=1" : "") : ""); });
$("setupBtn").addEventListener("click", () => chrome.runtime.openOptionsPage());
chrome.storage.onChanged.addListener((c) => { if (c.server) location.reload(); });
init();
