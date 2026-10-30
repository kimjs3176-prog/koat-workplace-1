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
// 버전·업데이트 — 폴더의 파일이 새 판이면 바로 적용, 서버에 새 판이 있으면 받는 법 안내
const verLt = (a, b) => { const p = (v) => String(v || "").split(".").map(Number); const x = p(a), y = p(b); for (let i = 0; i < 4; i++) { if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) < (y[i] || 0); } return false; };
async function version() {
  const cur = chrome.runtime.getManifest().version; $("ver").textContent = cur;
  const st = await chrome.runtime.sendMessage({ type: "update.check" }).catch(() => null);
  if (st && st.pending) { $("updhow").textContent = `폴더의 파일이 ${st.disk} 판으로 바뀌어 있습니다. 적용하면 확장이 다시 불러와집니다.`; $("updapply").hidden = false; return; }
  const server = $("server").value.trim().replace(/\/+$/, ""); if (!server) return;
  try { const i = await (await fetch(server + "/api/secretary/extension/info", { cache: "no-store" })).json();
    if (i && i.version && verLt(cur, i.version)) {
      $("latest").textContent = `· 서버 최신 ${i.version}`;
      $("updhow").innerHTML = "확장 폴더 안의 <b>업데이트.cmd</b>(Mac: 업데이트.command)를 더블클릭하면 새 판을 받아 덮어쓰고, 확장이 스스로 다시 불러옵니다. 폴더 위치: 확장 관리 페이지 › 서무비서 › 세부정보 › 소스. 그 파일이 없으면(옛 판) 아래에서 받아 확장 폴더에 넣고 더블클릭하세요.";
      $("updget").href = server + "/api/secretary/extension/update.cmd"; $("updget").hidden = false;
    } else $("latest").textContent = "· 최신";
  } catch (e) { $("latest").textContent = "· 서버 확인 안 됨"; }
}
$("updapply").addEventListener("click", () => { $("updapply").disabled = true; chrome.runtime.sendMessage({ type: "update.apply" }).catch(() => {}); });
load().then(version);
