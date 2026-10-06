// 서무비서 확장 — 서비스 워커
// 역할: 사이드 패널 열기, ERP 화면 감지 결과 전달, 초안을 ERP 입력란(마지막으로 누른 칸)에 넣기, 오른쪽 클릭 메뉴
importScripts("config.js");

const state = {};            // tabId → {focusFrame, context:{label,q,title}}
const PANEL_FALLBACK = !chrome.sidePanel || !chrome.sidePanel.open;

async function settings() {
  const s = await chrome.storage.sync.get(["server", "erpHosts", "floating"]);
  return {
    server: (s.server || SEC_DEFAULTS.server || "").replace(/\/+$/, ""),
    erpHosts: s.erpHosts || SEC_DEFAULTS.erpHosts,
    floating: s.floating !== undefined ? s.floating : SEC_DEFAULTS.floating
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
    await chrome.scripting.registerContentScripts([{ id: "sec-erp-extra", matches: extra, js: ["config.js", "content.js"],
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
  } else if (m.type === "context" && sender.tab) {        // 화면 감지 결과(가장 최근 것)
    (state[tabId] = state[tabId] || {}).context = m.context;
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
  } else if (m.type === "settings") {
    settings().then(reply); return true;
  } else if (m.type === "hostsChanged") {
    registerExtraHosts().then(() => reply({ ok: true })); return true;
  }
});

chrome.tabs.onRemoved.addListener((id) => { delete state[id]; });
