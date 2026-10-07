// 서무비서 확장 — 서비스 워커
// 역할: 사이드 패널 열기, ERP 화면 감지 결과 전달, 초안을 ERP 입력란(마지막으로 누른 칸)에 넣기, 오른쪽 클릭 메뉴
importScripts("config.js");

const state = {};            // tabId → {focusFrame, context:{label,q,title}}
const PANEL_FALLBACK = !chrome.sidePanel || !chrome.sidePanel.open;

async function settings() {
  const s = await chrome.storage.sync.get(["server", "erpHosts", "floating", "guard", "autoAsk", "notify"]);
  return {
    server: (s.server || SEC_DEFAULTS.server || "").replace(/\/+$/, ""),
    erpHosts: s.erpHosts || SEC_DEFAULTS.erpHosts,
    floating: s.floating !== undefined ? s.floating : SEC_DEFAULTS.floating,
    guard: s.guard !== undefined ? s.guard : SEC_DEFAULTS.guard !== false,
    autoAsk: s.autoAsk !== undefined ? s.autoAsk : SEC_DEFAULTS.autoAsk !== false,
    notify: s.notify !== undefined ? s.notify : SEC_DEFAULTS.notify !== false
  };
}

// 도구 모음 아이콘을 누르면 사이드 패널(지원하지 않는 브라우저는 작은 창)
chrome.runtime.onInstalled.addListener(async (d) => {
  if (!PANEL_FALLBACK) chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: "sec-ask", title: "서무비서에 묻기: “%s”", contexts: ["selection"] });
    chrome.contextMenus.create({ id: "sec-open", title: "서무비서 열기", contexts: ["page", "editable"] });
  });
  await registerExtraHosts();
  if (d.reason === "install" && !(await settings()).server) chrome.runtime.openOptionsPage();
});
chrome.runtime.onStartup.addListener(registerExtraHosts);

// 설정 화면에서 추가한 ERP 주소에도 내용 스크립트를 붙인다(권한은 설정 화면에서 사용자가 허용)
async function registerExtraHosts() {
  const { erpHosts } = await settings();
  const builtin = chrome.runtime.getManifest().content_scripts[0].matches;
  const extra = [];
  for (const h of erpHosts || []) {
    if (builtin.includes(h)) continue;
    if (await chrome.permissions.contains({ origins: [h] })) extra.push(h);
  }
  try { await chrome.scripting.unregisterContentScripts({ ids: ["sec-erp-extra"] }); } catch (e) {}
  if (extra.length) {
    await chrome.scripting.registerContentScripts([{ id: "sec-erp-extra", matches: extra, js: ["config.js", "content.js", "guard.js"],
      allFrames: true, matchOriginAsFallback: true, runAt: "document_idle", persistAcrossSessions: true }]).catch((e) => console.warn(e));
  }
}

async function openPanel(tab) {
  if (!PANEL_FALLBACK) {
    try { await chrome.sidePanel.open({ tabId: tab.id }); return; } catch (e) { /* 사용자 동작 밖에서 호출된 경우 등 */ }
  }
  // 사이드 패널이 없는 브라우저: 화면 오른쪽에 작은 창으로
  const url = chrome.runtime.getURL("sidepanel.html") + "?tab=" + tab.id;
  const win = await chrome.windows.getCurrent();
  chrome.windows.create({ url, type: "popup", width: 440, height: Math.min(900, win.height || 900),
    left: Math.max(0, (win.left || 0) + (win.width || 1200) - 440), top: win.top || 0 });
}

// ── ERP 프로필(화면 규칙·칸 매핑) — 기관 공유본(서버) + 내 브라우저본(로컬, 같은 화면 id 면 우선) ──
async function serverProfiles(force) {
  const { server } = await settings();
  const { srvProfiles } = await chrome.storage.local.get("srvProfiles");
  if (!server) return [];
  if (!force && srvProfiles && Date.now() - srvProfiles.ts < 30 * 60 * 1000) return srvProfiles.list || [];
  try {
    const r = await fetch(server + "/api/secretary/erp/profiles", { cache: "no-store" });
    const d = await r.json();
    const list = (d && d.profiles) || [];
    await chrome.storage.local.set({ srvProfiles: { ts: Date.now(), list, updated: d.updated || "" } });
    return list;
  } catch (e) { return (srvProfiles && srvProfiles.list) || []; }
}
async function allProfiles(force) {
  const srv = await serverProfiles(force);
  const { myProfiles } = await chrome.storage.local.get("myProfiles");
  const mine = myProfiles || [];
  const out = srv.map((p) => ({ ...p, screens: [...(p.screens || [])], source: "org" }));
  for (const p of mine) {
    const same = out.find((x) => x.hosts.some((h) => p.hosts.includes(h)));
    if (!same) { out.push({ ...p, source: "mine" }); continue; }
    for (const sc of p.screens || []) {
      const i = same.screens.findIndex((x) => x.id === sc.id);
      if (i >= 0) same.screens[i] = { ...sc, mine: true }; else same.screens.unshift({ ...sc, mine: true });
    }
  }
  return out;
}
const hostMatch = (pat, url) => { try { const u = new URL(url); return pat.replace(/\/\*$/, "") === u.origin; } catch (e) { return false; } };
async function profilesFor(url) { return (await allProfiles()).filter((p) => (p.hosts || []).some((h) => hostMatch(h, url))); }

// 모든 프레임에서 내용 스크립트 함수 실행(같은 격리 공간이라 globalThis.__sec* 를 부를 수 있다)
async function inFrames(tabId, fn, arg) {
  const res = await chrome.scripting.executeScript({ target: { tabId, allFrames: true },
    func: (name, a) => (typeof globalThis[name] === "function" ? globalThis[name](a) : null), args: [fn, arg ?? null] });
  return res.map((r) => r.result).filter((x) => x !== null && x !== undefined);
}

// 초안 → 매핑된 칸들. 지금 감지된 화면 → 같은 초안을 쓰는 화면 순으로 고른다.
async function fillMap(tabId, m) {
  const tab = await chrome.tabs.get(tabId);
  const ps = await profilesFor(tab.url || "");
  const ctx = (state[tabId] || {}).context || {};
  const screens = ps.flatMap((p) => p.screens || []);
  let pick = screens.filter((sc) => sc.id === ctx.screenId && (sc.fields || []).length);
  if (!pick.length && m.draft) pick = screens.filter((sc) => sc.draft === m.draft && (sc.fields || []).length);
  if (m.screen) pick = [m.screen];
  if (!pick.length) return { ok: false, mapped: false };
  const fields = pick.flatMap((sc) => sc.fields || []);
  const res = await inFrames(tabId, "__secFillMap", { fields, values: m.values || {}, test: !!m.test });
  const filled = [...new Set(res.flatMap((r) => r.filled || []))];
  const want = [...new Set(fields.map((f) => f.key))].filter((k) => m.test || String((m.values || {})[k] ?? "").trim());
  return { ok: filled.length > 0, mapped: true, filled, missing: want.filter((k) => !filled.includes(k)), screen: pick[0].name };
}

// ── 서무비서 메타(절차·반려 점검 항목) — 결재 전 점검에 쓴다 ─────────────────
async function getMeta(force) {
  const { server } = await settings();
  const { meta } = await chrome.storage.local.get("meta");
  if (!server) return meta ? meta.data : null;
  if (!force && meta && Date.now() - meta.ts < 30 * 60 * 1000) return meta.data;
  try {
    const data = await (await fetch(server + "/api/secretary/erp/meta", { cache: "no-store" })).json();
    if (data && data.success) { await chrome.storage.local.set({ meta: { ts: Date.now(), data } }); return data; }
  } catch (e) {}
  return meta ? meta.data : null;
}
async function guardFor(ctx) {
  const s = await settings();
  if (!ctx || !ctx.proc) return null;
  const meta = await getMeta();
  const p = meta && (meta.procedures || []).find((x) => x.id === ctx.proc);
  if (!p) return null;
  return { proc: p.id, title: (p.icon ? p.icon + " " : "") + p.title.split(" — ")[0], q: ctx.q || p.q, pitfalls: p.pitfalls || [], enabled: !!s.guard };
}

// ── 기한 알림 — 서무비서(패널·탭)가 보내 준 다가오는 기한으로 아이콘 배지·바탕화면 알림 ──────
const ymd = (d) => d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
const addDays = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return ymd(d); };
async function deadlineItems() {
  const { deadlines } = await chrome.storage.local.get("deadlines");
  const seen = new Set(), out = [];
  for (const src of Object.values(deadlines || {})) for (const it of src.items || []) {
    const k = it.caseId + "|" + it.i;
    if (!seen.has(k)) { seen.add(k); out.push(it); }
  }
  return out.sort((a, b) => (a.date < b.date ? -1 : 1));
}
async function updateBadge() {
  const s = await settings();
  const items = s.notify ? (await deadlineItems()).filter((x) => !x.optional) : [];
  const today = ymd(new Date()), soon = addDays(2);
  const over = items.filter((x) => x.date < today).length;
  const near = items.filter((x) => x.date >= today && x.date <= soon).length;
  const n = over + near;
  await chrome.action.setBadgeText({ text: n ? String(n) : "" });
  await chrome.action.setBadgeBackgroundColor({ color: over ? "#dc2626" : "#d97706" });
  await chrome.action.setTitle({ title: n ? `서무비서 — 기한 지남 ${over}건 · 2일 안 ${near}건` : "서무비서 열기" });
}
async function notifyDue() {
  const s = await settings();
  if (!s.notify) return;
  const today = ymd(new Date()), tomorrow = addDays(1);
  const items = (await deadlineItems()).filter((x) => !x.optional && x.date <= tomorrow);
  if (!items.length) return;
  const { notified } = await chrome.storage.local.get("notified");
  const key = today + ":" + items.map((x) => x.caseId + x.i).join(",");
  if (notified === key) return;                          // 같은 날 같은 목록은 한 번만
  await chrome.storage.local.set({ notified: key });
  const over = items.filter((x) => x.date < today);
  chrome.notifications.create("sec-due", {
    type: "list", iconUrl: "icons/128.png", priority: 1,
    title: over.length ? `서무비서 — 기한 지난 일 ${over.length}건` : `서무비서 — 오늘·내일 기한 ${items.length}건`,
    message: "처리할 일을 확인하세요.",
    items: items.slice(0, 5).map((x) => ({ title: (x.date < today ? "⏰ " : x.date === today ? "오늘 " : "내일 ") + x.proc, message: String(x.step || "").slice(0, 60) }))
  });
}
chrome.alarms.onAlarm.addListener((a) => { if (a.name === "sec-due") { updateBadge(); notifyDue(); getMeta(); } });
chrome.notifications.onClicked.addListener(async () => {
  const { server } = await settings();
  if (server) chrome.tabs.create({ url: server + "/?view=cal" });
});
function ensureAlarm() { chrome.alarms.create("sec-due", { periodInMinutes: 60, delayInMinutes: 1 }); }
chrome.runtime.onInstalled.addListener(ensureAlarm);
chrome.runtime.onStartup.addListener(() => { ensureAlarm(); updateBadge(); });

// ── 주소창: '서무' + 띄어쓰기 + 상황 ────────────────────────────────────
chrome.omnibox.setDefaultSuggestion({ description: "서무비서에 묻기: %s" });
chrome.omnibox.onInputEntered.addListener(async (text) => {
  const q = String(text || "").trim().slice(0, 200);
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!q) return;
  if (tab && !PANEL_FALLBACK) {
    try {
      await chrome.storage.session.set({ pendingAsk: { tabId: tab.id, q } });
      await chrome.sidePanel.open({ tabId: tab.id });
      toPanel({ type: "ask", tabId: tab.id, q });
      return;
    } catch (e) { /* 패널을 열 수 없으면 새 탭으로 */ }
  }
  const { server } = await settings();
  if (server) chrome.tabs.create({ url: server + "/?q=" + encodeURIComponent(q) });
  else chrome.runtime.openOptionsPage();
});

function toPanel(msg) { chrome.runtime.sendMessage(Object.assign({ to: "panel" }, msg)).catch(() => {}); }

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (!tab) return;
  await openPanel(tab);
  if (info.menuItemId === "sec-ask" && info.selectionText) {
    const q = info.selectionText.trim().slice(0, 200);
    await chrome.storage.session.set({ pendingAsk: { tabId: tab.id, q } });
    toPanel({ type: "ask", tabId: tab.id, q });
  }
});

chrome.runtime.onMessage.addListener((m, sender, reply) => {
  const tabId = sender.tab ? sender.tab.id : m.tabId;
  if (m.type === "focus" && sender.tab) {                 // ERP 의 어느 프레임에서 입력란을 눌렀는지
    (state[tabId] = state[tabId] || {}).focusFrame = sender.frameId;
  } else if (m.type === "context" && sender.tab) {        // 화면 감지 결과 — 프레임 중 가장 구체적인 것
    const st = (state[tabId] = state[tabId] || {});
    const cur = st.context;
    const rank = (c) => (c && typeof c.rank === "number" ? c.rank : 99);
    if (cur && st.ctxFrame !== sender.frameId && rank(m.context) > rank(cur)) { reply && reply({ ignored: true }); return; }
    st.context = m.context; st.ctxFrame = sender.frameId;
    guardFor(m.context).then((g) => {                     // 결재 전 점검 항목을 그 탭의 모든 프레임에
      if (!g) return;
      state[tabId].guard = g;
      chrome.tabs.sendMessage(tabId, { type: "guard", guard: g }).catch(() => {});
    });
    toPanel({ type: "context", tabId, context: m.context });
    chrome.tabs.sendMessage(tabId, { type: "chip", q: m.context.q, title: m.context.title }, { frameId: 0 }).catch(() => {});
  } else if (m.type === "open" && sender.tab) {           // ERP 화면의 🗂 버튼
    openPanel(sender.tab).then(async () => {
      if (m.q) { await chrome.storage.session.set({ pendingAsk: { tabId, q: m.q } }); toPanel({ type: "ask", tabId, q: m.q }); }
    });
  } else if (m.type === "getContext") {                   // 패널이 열릴 때 현재 탭 상태 요청
    chrome.storage.session.get("pendingAsk").then(({ pendingAsk }) => {
      const pa = pendingAsk && pendingAsk.tabId === m.tabId ? pendingAsk.q : "";
      if (pa) chrome.storage.session.remove("pendingAsk");
      reply({ context: (state[m.tabId] || {}).context || null, ask: pa });
    });
    return true;
  } else if (m.type === "insert") {                       // 패널의 초안 → ERP 입력란
    const st = state[m.tabId] || {};
    const opts = st.focusFrame !== undefined ? { frameId: st.focusFrame } : { frameId: 0 };
    chrome.tabs.sendMessage(m.tabId, { type: "insert", text: m.text }, opts)
      .then((r) => reply(r || { ok: false }))
      .catch(() => reply({ ok: false, error: "ERP 화면과 연결되지 않았습니다. ERP 탭을 새로고침한 뒤 다시 시도하세요." }));
    return true;
  } else if (m.type === "getProfiles") {                 // 내용 스크립트: 이 사이트의 화면 규칙
    profilesFor(m.url || (sender.tab && sender.tab.url) || "").then((profiles) => reply({ profiles }));
    return true;
  } else if (m.type === "allProfiles") {                  // ERP 맞춤 도구·설정
    allProfiles(!!m.force).then(async (profiles) => {
      const { myProfiles, srvProfiles } = await chrome.storage.local.get(["myProfiles", "srvProfiles"]);
      reply({ profiles, mine: myProfiles || [], org: (srvProfiles && srvProfiles.list) || [], orgUpdated: (srvProfiles && srvProfiles.updated) || "" });
    });
    return true;
  } else if (m.type === "profilesChanged") {              // 저장 후: 열린 ERP 탭에 새 규칙 전달
    allProfiles(!!m.force).then(async () => {
      for (const t of await chrome.tabs.query({})) {
        if (!t.url || !/^https?:/.test(t.url)) continue;
        const profiles = await profilesFor(t.url);
        chrome.tabs.sendMessage(t.id, { type: "profiles", profiles }).catch(() => {});
      }
      reply({ ok: true });
    });
    return true;
  } else if (m.type === "analyze") {                      // ERP 구조 분석(모든 프레임)
    inFrames(m.tabId, "__secAnalyze").then(async (frames) => {
      const tab = await chrome.tabs.get(m.tabId);
      reply({ ok: true, url: tab.url, title: tab.title, frames, context: (state[m.tabId] || {}).context || null });
    }).catch((e) => reply({ ok: false, error: "이 탭의 화면을 읽을 수 없습니다. ERP 주소가 확장 설정에 들어 있는지, 탭을 새로고침했는지 확인하세요. (" + e.message + ")" }));
    return true;
  } else if (m.type === "highlight") {
    inFrames(m.tabId, "__secHighlight", m.field).then((r) => reply({ ok: r.some(Boolean) })).catch(() => reply({ ok: false }));
    return true;
  } else if (m.type === "pickStart") {
    inFrames(m.tabId, "__secPick").then(() => reply({ ok: true })).catch((e) => reply({ ok: false, error: e.message }));
    return true;
  } else if (m.type === "picked" && sender.tab) {         // 어느 프레임에서 골랐으면 나머지 프레임의 고르기 끝내기
    inFrames(sender.tab.id, "__secPickStop").catch(() => {});
    toPanel({ type: "picked", tabId, field: m.field });
  } else if (m.type === "fillmap") {                      // 패널: 초안 → 매핑된 칸들
    fillMap(m.tabId, m).then(reply).catch((e) => reply({ ok: false, error: e.message }));
    return true;
  } else if (m.type === "openHere" && sender.tab) {        // 서무비서 웹 화면의 '패널로 열기'
    openPanel(sender.tab);
  } else if (m.type === "getGuard" && sender.tab) {
    reply({ guard: (state[tabId] || {}).guard || null });
  } else if (m.type === "deadlines") {                    // 서무비서(패널·탭) → 다가오는 기한
    chrome.storage.local.get("deadlines").then(async ({ deadlines }) => {
      const d = deadlines || {};
      d[String(m.source || "panel").slice(0, 20)] = { ts: Date.now(), items: (m.items || []).slice(0, 200) };
      await chrome.storage.local.set({ deadlines: d });
      await updateBadge();
      reply({ ok: true });
    });
    return true;
  } else if (m.type === "settings") {
    settings().then(reply); return true;
  } else if (m.type === "hostsChanged") {
    registerExtraHosts().then(() => reply({ ok: true })); return true;
  }
});

chrome.tabs.onRemoved.addListener((id) => { delete state[id]; });
// 탭이 다른 주소로 넘어가면 감지 결과를 비운다(같은 탭에서 다른 업무 화면으로)
chrome.tabs.onUpdated.addListener((id, info) => { if (info.status === "loading" && info.url && state[id]) { delete state[id].context; delete state[id].guard; delete state[id].ctxFrame; } });
