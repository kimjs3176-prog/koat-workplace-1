// 서무비서 웹 화면(서버 주소)에서만 동작: 확장이 설치되어 있음을 화면에 알리고,
// 웹 화면이 보내는 '다가오는 기한'을 확장(아이콘 배지·알림)에 전달한다.
(() => {
  const v = chrome.runtime.getManifest().version;
  document.documentElement.setAttribute("data-sec-ext", v);
  window.addEventListener("message", (e) => {
    if (e.source !== window || !e.data || e.data.src !== "koat-sec") return;
    if (e.data.type === "deadlines") chrome.runtime.sendMessage({ type: "deadlines", source: "tab", items: e.data.items || [] }).catch(() => {});
    else if (e.data.type === "openPanel") chrome.runtime.sendMessage({ type: "openHere" }).catch(() => {});
  });
})();
