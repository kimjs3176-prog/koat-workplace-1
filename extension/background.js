// 서무비서 확장 — 서비스 워커
// 역할: 사이드 패널 열기, ERP 화면 감지 결과 전달, 초안을 ERP 입력란(마지막으로 누른 칸)에 넣기, 오른쪽 클릭 메뉴
importScripts("config.js", "diaglog.js");

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
  // 업데이트로 기본 주소가 늘었으면(예: 온나라) 사용자가 저장해 둔 주소 목록에도 더한다
  if (d && d.reason === "update") {
    const { erpHosts } = await chrome.storage.sync.get("erpHosts");
    if (Array.isArray(erpHosts)) {
      const add = SEC_DEFAULTS.erpHosts.filter((h) => !erpHosts.includes(h));
      if (add.length) await chrome.storage.sync.set({ erpHosts: [...erpHosts, ...add] });
    }
  }
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

// 창 종류(일반·팝업)를 미리 알아 둔다 — sidePanel.open 은 사용자 클릭 직후 '기다림 없이' 불러야 해서 그때 물어볼 수 없다
const winType = {};
let lastNormalWin = null;
chrome.windows.getAll().then((ws) => ws.forEach((w) => { winType[w.id] = w.type; if (w.type === "normal" && (w.focused || lastNormalWin == null)) lastNormalWin = w.id; })).catch(() => {});
chrome.windows.onCreated.addListener((w) => { winType[w.id] = w.type; });
chrome.windows.onRemoved.addListener((id) => { delete winType[id]; if (lastNormalWin === id) lastNormalWin = null; });
chrome.windows.onFocusChanged.addListener((id) => { if (winType[id] === "normal") lastNormalWin = id; });

// 패널 열기(+ 물을 말). ERP 가 띄운 작은 창(팝업)에는 옆 패널이 없으므로 원래 창의 옆 패널에서 연다.
// 주의: sidePanel.open 앞에 await 를 두면 클릭(사용자 동작)으로 인정되지 않아 열리지 않는다.
function openPanel(tab, q) {
  if (q) chrome.storage.session.set({ pendingAsk: { tabId: tab.id, q, ts: Date.now() } }).catch(() => {});
  const popup = winType[tab.windowId] && winType[tab.windowId] !== "normal";
  const panelWin = popup && lastNormalWin != null ? lastNormalWin : tab.windowId;
  const opened = PANEL_FALLBACK ? panelWindow(tab)
    : chrome.sidePanel.open(popup && lastNormalWin != null ? { windowId: lastNormalWin } : { tabId: tab.id })
      .then(() => diag("bg", "panel.open", { ok: true, popup: !!popup }))
      .catch((e) => { diag("bg", "panel.open", { ok: false, popup: !!popup, err: e.message }); return panelWindow(tab); });
  return opened.then(() => { if (q) toPanel({ type: "ask", tabId: tab.id, panelWin, q }); });
}
// 사이드 패널을 쓸 수 없을 때: 화면 오른쪽에 작은 창으로(그 탭에 고정)
async function panelWindow(tab) {
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
    diag("bg", "profiles.fetch", { ok: true, profiles: list.length, screens: list.reduce((a, p) => a + (p.screens || []).length, 0) });
    return list;
  } catch (e) { diag("bg", "profiles.fetch", { ok: false, err: e.message }); return (srvProfiles && srvProfiles.list) || []; }
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
  try {
    const res = await chrome.scripting.executeScript({ target: { tabId, allFrames: true },
      func: (name, a) => (typeof globalThis[name] === "function" ? globalThis[name](a) : null), args: [fn, arg ?? null] });
    // 내용 스크립트가 없는 프레임(다른 출처·권한 밖)은 null — 진단에 프레임 수를 남긴다
    if (fn !== "__secHighlight" && fn !== "__secPickStop") diag("bg", "frames." + fn, { frames: res.length, withScript: res.filter((r) => r.result !== null && r.result !== undefined).length });
    return res.map((r) => r.result).filter((x) => x !== null && x !== undefined);
  } catch (e) { diag("bg", "frames.error", { fn, err: e.message }); throw e; }
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
  const out = { ok: filled.length > 0, mapped: true, filled, missing: want.filter((k) => !filled.includes(k)), screen: pick[0].name };
  diag("bg", "fillmap", { screen: out.screen, test: !!m.test, filled, missing: out.missing, perFrame: res.map((r) => ({ path: r.path, filled: r.filled, missing: r.missing, how: r.how })) });
  return out;
}

// ── 서무비서 메타(절차·반려 점검 항목) — 결재 전 점검에 쓴다 ─────────────────
async function getMeta(force) {
  const { server } = await settings();
  const { meta } = await chrome.storage.local.get("meta");
  if (!server) return meta ? meta.data : null;
  if (!force && meta && Date.now() - meta.ts < 30 * 60 * 1000) return meta.data;
  try {
    const data = await (await fetch(server + "/api/secretary/erp/meta", { cache: "no-store" })).json();
    if (data && data.success) { await chrome.storage.local.set({ meta: { ts: Date.now(), data } }); diag("bg", "meta.fetch", { ok: true, procedures: (data.procedures || []).length }); return data; }
  } catch (e) { diag("bg", "meta.fetch", { ok: false, err: e.message }); }
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
  if (tab && !PANEL_FALLBACK) { openPanel(tab, q); return; }
  const { server } = await settings();
  if (server) chrome.tabs.create({ url: server + "/?q=" + encodeURIComponent(q) });
  else chrome.runtime.openOptionsPage();
});

function toPanel(msg) { chrome.runtime.sendMessage(Object.assign({ to: "panel" }, msg)).catch(() => {}); }

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (!tab) return;
  const q = info.menuItemId === "sec-ask" && info.selectionText ? info.selectionText.trim().slice(0, 200) : "";
  openPanel(tab, q);
});

chrome.runtime.onMessage.addListener((m, sender, reply) => {
  // ── 진단 기록 ──
  if (m.type === "log") { diag(m.src || "content", m.ev, m.data, sender); return; }
  if (m.type === "diag.get") {
    diagLoad().then(async (buf) => {
      const s = await settings();
      const st = await chrome.storage.local.get(["myProfiles", "srvProfiles", "deadlines", "meta"]);
      reply({ log: buf, enabled: diagOn, settings: { ...s }, version: chrome.runtime.getManifest().version,
        profiles: { mine: st.myProfiles || [], org: (st.srvProfiles && st.srvProfiles.list) || [] },
        deadlines: Object.fromEntries(Object.entries(st.deadlines || {}).map(([k, v]) => [k, (v.items || []).length])),
        meta: st.meta ? { ts: st.meta.ts, procedures: ((st.meta.data || {}).procedures || []).length } : null,
        state: Object.fromEntries(Object.entries(state).map(([k, v]) => [k, { context: v.context || null, guard: v.guard ? { proc: v.guard.proc, n: (v.guard.pitfalls || []).length, enabled: v.guard.enabled } : null, focusFrame: v.focusFrame }])) });
    });
    return true;
  }
  if (m.type === "diag.enable") { diagSetEnabled(m.on).then(() => reply({ ok: true })); return true; }
  if (m.type === "diag.clear") { diagClear().then(() => reply({ ok: true })); return true; }
  if (m.type === "diag.note") { diag("user", "note", { text: String(m.text || "").slice(0, 1000) }); reply({ ok: true }); return; }
  if (m.type === "diag.snapshot") {                       // 지금 ERP 화면 구조 스냅샷(모든 프레임)
    inFrames(m.tabId, "__secSnapshot").then(async (frames) => {
      const tab = await chrome.tabs.get(m.tabId);
      const snap = { page: diagUrl(tab.url), title: tab.title, frames, context: (state[m.tabId] || {}).context || null };
      await diag("user", "snapshot", snap, { tab });
      reply({ ok: true, snap: diagScrub(snap) });
    }).catch((e) => reply({ ok: false, error: e.message }));
    return true;
  }
  const tabId = sender.tab ? sender.tab.id : m.tabId;
  if (m.type === "focus" && sender.tab) {                 // ERP 의 어느 프레임에서 입력란을 눌렀는지
    (state[tabId] = state[tabId] || {}).focusFrame = sender.frameId;
  } else if (m.type === "context" && sender.tab) {        // 화면 감지 결과 — 프레임 중 가장 구체적인 것
    if (!applyContext(sender.tab, sender.frameId, m.context, sender)) { reply && reply({ ignored: true }); return; }
  } else if (m.type === "frameNav" && sender.tab) {      // 업무를 알려 준 프레임이 다른 화면으로 — 이전 업무·점검을 지운다
    const st = state[tabId];
    if (st && st.context && st.ctxFrame === sender.frameId) {
      diag("bg", "context.clear", { was: st.context.title }, sender);
      delete st.context; delete st.guard; delete st.ctxFrame;
      chrome.tabs.sendMessage(tabId, { type: "guard", guard: null }).catch(() => {});
      chrome.tabs.sendMessage(tabId, { type: "chip", q: "", title: "" }).catch(() => {});
      toPanel({ type: "context", tabId, context: null });
    }
  } else if (m.type === "open" && sender.tab) {           // ERP 화면의 🗂 버튼
    openPanel(sender.tab, m.q || "");
  } else if (m.type === "getContext") {                   // 패널이 열릴 때 현재 탭 상태 요청
    chrome.storage.session.get("pendingAsk").then(({ pendingAsk }) => {
      // 방금 누른 🗂·칩의 물음 — 패널이 다른 탭(예: ERP 팝업 창의 원래 창)에 있어도 10초 안이면 받는다
      const fresh = pendingAsk && (pendingAsk.tabId === m.tabId || (!m.fixed && Date.now() - (pendingAsk.ts || 0) < 10000));
      if (fresh) chrome.storage.session.remove("pendingAsk");
      const t = fresh ? pendingAsk.tabId : m.tabId;
      reply({ context: (state[t] || {}).context || null, ask: fresh ? pendingAsk.q : "", tabId: t });
    });
    return true;
  } else if (m.type === "insert") {                       // 패널의 초안 → ERP 입력란
    const st = state[m.tabId] || {};
    const opts = st.focusFrame !== undefined ? { frameId: st.focusFrame } : { frameId: 0 };
    chrome.tabs.sendMessage(m.tabId, { type: "insert", text: m.text }, opts)
      .then((r) => { diag("bg", "insert", { frameId: opts.frameId, ok: !!(r && r.ok), where: r && r.where, len: String(m.text || "").length }); reply(r || { ok: false }); })
      .catch((e) => { diag("bg", "insert", { frameId: opts.frameId, ok: false, err: e.message }); reply({ ok: false, error: "ERP 화면과 연결되지 않았습니다. ERP 탭을 새로고침한 뒤 다시 시도하세요." }); });
    return true;
  } else if (m.type === "getProfiles") {                 // 내용 스크립트: 이 사이트의 화면 규칙(= 이 탭에 확장이 붙었다)
    if (sender.tab && sender.frameId === 0) (state[tabId] = state[tabId] || {}).cs = true;
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
chrome.tabs.onUpdated.addListener((id, info, tab) => {
  if (info.status === "loading" && state[id]) { delete state[id].cs; if (info.url) { delete state[id].context; delete state[id].guard; delete state[id].ctxFrame; } }
  if (info.status === "complete") setTimeout(() => urlContext(id).catch(() => {}), 2500);
});

// 업무 감지 결과를 탭 상태에 반영하고 결재 전 점검·패널·🗂 칩에 알린다(내용 스크립트·주소 감지 공통)
function applyContext(tab, frameId, ctx, sender) {
  const tabId = tab.id;
  const st = (state[tabId] = state[tabId] || {});
  const cur = st.context;
  const rank = (c) => (c && typeof c.rank === "number" ? c.rank : 99);
  if (cur && st.ctxFrame !== frameId && rank(ctx) > rank(cur)) { diag("bg", "context.ignored", { got: ctx, kept: cur }, sender); return false; }
  diag("bg", "context", ctx, sender);
  st.context = ctx; st.ctxFrame = frameId;
  guardFor(ctx).then((g) => {                           // 결재 전 점검 항목을 그 탭의 모든 프레임에
    if (!g) return;
    state[tabId].guard = g;
    chrome.tabs.sendMessage(tabId, { type: "guard", guard: g }).catch(() => {});
  });
  // ERP·온나라가 띄운 팝업 창(기안 작성 창 등)의 감지 결과는 원래 창의 옆 패널로도 보낸다
  const popup = winType[tab.windowId] && winType[tab.windowId] !== "normal";
  toPanel({ type: "context", tabId, context: ctx, panelWin: popup ? lastNormalWin : null });
  chrome.tabs.sendMessage(tabId, { type: "chip", q: ctx.q, title: ctx.title }).catch(() => {});   // 버튼을 그린 프레임이 받는다(frameset 대비)
  return true;
}

// 내용 스크립트가 붙지 못하는 탭(Edge 'IE 모드'로 열리는 온나라 등): 탭 주소·창 제목만으로 업무를 알아본다.
// 이런 탭에는 🗂 버튼·결재 전 점검·칸 채우기를 할 수 없고, 옆 패널 안내와 '초안 복사 → Ctrl+V' 만 된다.
async function urlContext(tabId) {
  const st = state[tabId] || {};
  if (st.cs || st.context) return;
  const tab = await chrome.tabs.get(tabId);
  const { erpHosts } = await settings();
  if (!tab.url || !(erpHosts || []).some((h) => hostMatch(h, tab.url))) return;
  let path = ""; try { path = new URL(tab.url).pathname; } catch (e) { return; }
  const title = String(tab.title || "").replace(/\s*[-–]\s*(Microsoft Edge|Chrome).*$/i, "").trim();
  let ctx = null;
  for (const [i, [rx, q, proc]] of (SEC_RULES || []).entries()) { if (title && rx.test(title)) { ctx = { q, title: title.slice(0, 40), proc: proc || "", rank: i }; break; } }
  if (!ctx) for (const [i, [rx, q, proc]] of (globalThis.SEC_URL_RULES || []).entries()) { if (rx.test(path)) { ctx = { q, title: title || q, proc: proc || "", rank: (SEC_RULES || []).length + i }; break; } }
  diag("bg", ctx ? "detect.tab" : "detect.tab.none", { url: path, title: title.slice(0, 60), note: "확장이 화면 안에 들어가지 못한 탭(IE 모드 등) — 주소·제목으로만 판단" }, { tab });
  if (ctx) { ctx.tabOnly = true; applyContext(tab, 0, ctx, { tab }); }
}
