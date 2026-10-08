const $ = (id) => document.getElementById(id);
const PAT = /^(https?):\/\/(\*\.)?[^/*\s]+(:\d+)?\/\*$/;

function normHost(line) {
  let s = line.trim();
  if (!s) return "";
  if (!/^https?:\/\//.test(s)) s = "https://" + s;
  try { const u = new URL(s.replace(/\*$/, "")); return `${u.protocol}//${u.host}/*`; } catch (e) { return null; }
}

async function load() {
  const s = await chrome.storage.sync.get(["server", "erpHosts", "floating", "guard", "autoAsk", "notify"]);
  $("server").value = s.server || SEC_DEFAULTS.server || "";
  $("hosts").value = (s.erpHosts || SEC_DEFAULTS.erpHosts).join("\n");
  $("floating").checked = s.floating !== undefined ? s.floating : SEC_DEFAULTS.floating;
  for (const k of ["guard", "autoAsk", "notify"]) $(k).checked = s[k] !== undefined ? s[k] : SEC_DEFAULTS[k] !== false;
}

$("save").addEventListener("click", async () => {
  const msg = $("msg");
  let server = $("server").value.trim().replace(/\/+$/, "");
  if (server) {
    try { const u = new URL(server); if (!/^https?:$/.test(u.protocol)) throw 0; server = u.origin + u.pathname.replace(/\/+$/, ""); }
    catch (e) { msg.textContent = "서무비서 주소가 올바르지 않습니다."; return; }
    if (server.startsWith("http://") && !/^http:\/\/(localhost|127\.0\.0\.1)(:|$)/.test(server)) {
      msg.textContent = "보안을 위해 https 주소를 쓰세요(내부 시험용 localhost 만 http 허용)."; return;
    }
  }
  const hosts = [];
  for (const line of $("hosts").value.split("\n")) {
    const h = normHost(line);
    if (h === null || (h && !PAT.test(h))) { msg.textContent = `ERP 주소를 읽지 못했습니다: ${line}`; return; }
    if (h && !hosts.includes(h)) hosts.push(h);
  }
  // 새로 추가한 ERP 주소는 사이트 접근 허용을 받는다(저장 버튼 클릭이 사용자 동작이라 이때만 물을 수 있음)
  const need = [];
  for (const h of hosts) if (!(await chrome.permissions.contains({ origins: [h] }))) need.push(h);
  // 서무비서 주소 — 웹 화면에서 '확장 설치됨' 표시·기한을 확장으로 전달하는 데 쓴다(없어도 옆 패널은 동작)
  const srvPat = server ? new URL(server).origin + "/*" : "";
  const askSrv = srvPat && !(await chrome.permissions.contains({ origins: [srvPat] }));
  if (askSrv) need.push(srvPat);
  if (need.length && !(await chrome.permissions.request({ origins: need }).catch(() => false))) {
    msg.textContent = "ERP 주소 접근이 허용되지 않아 저장하지 않았습니다."; return;
  }
  await chrome.storage.sync.set({ server, erpHosts: hosts, floating: $("floating").checked,
    guard: $("guard").checked, autoAsk: $("autoAsk").checked, notify: $("notify").checked });
  await chrome.runtime.sendMessage({ type: "hostsChanged" }).catch(() => {});
  msg.textContent = "저장했습니다. 열려 있는 ERP 탭은 새로고침하면 적용됩니다.";
});
load();
