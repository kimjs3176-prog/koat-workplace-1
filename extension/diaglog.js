// 서무비서 확장 — 진단 기록(서비스 워커 쪽)
// 실제 ERP 시험에서 무엇이 어떻게 동작했는지 남긴다. 입력한 값(ERP·초안 내용)은 기록하지 않고,
// 화면 구조(칸 이름·종류·프레임 위치·버튼 이름)와 동작 결과만 남긴다. 기록은 이 브라우저 안에만 있고,
// 사용자가 진단 센터에서 '보고서 받기'나 '서버로 보내기'를 눌렀을 때만 밖으로 나간다.
const DIAG_MAX = 3000;
let diagBuf = null, diagLoading = null, diagTimer = null, diagOn = true;

// 서비스 워커가 깨어날 때 여러 프레임의 기록이 한꺼번에 들어와도 버퍼를 한 번만 읽는다(겹쳐 읽으면 앞 기록이 사라짐)
function diagLoad() {
  if (diagBuf) return Promise.resolve(diagBuf);
  if (!diagLoading) diagLoading = chrome.storage.local.get(["diagLog", "diagEnabled"]).then(({ diagLog, diagEnabled }) => {
    diagOn = diagEnabled !== false;
    diagBuf = Array.isArray(diagLog) ? diagLog : [];
    return diagBuf;
  });
  return diagLoading;
}
// 문자열 속 전화·주민·계좌처럼 보이는 숫자열을 가린다(제목·칸 이름에 섞여 들어오는 경우 대비)
function diagScrub(v, depth = 0) {
  if (typeof v === "string") return v.replace(/\d{6}[- ]?\d{7}|\d{2,4}[-. ]\d{3,4}[-. ]\d{4}|\d{9,}/g, "#").slice(0, 300);
  if (Array.isArray(v)) return depth > 4 ? [] : v.slice(0, 80).map((x) => diagScrub(x, depth + 1));
  if (v && typeof v === "object") {
    if (depth > 4) return {};
    const o = {};
    for (const [k, x] of Object.entries(v).slice(0, 60)) o[k] = diagScrub(x, depth + 1);
    return o;
  }
  return v;
}
// 주소는 경로와 쿼리 '이름'만(값은 사번·문서번호일 수 있어 뺀다)
function diagUrl(u) {
  try { const x = new URL(u); return x.origin + x.pathname + (x.search ? "?" + [...x.searchParams.keys()].join("&") : ""); }
  catch (e) { return String(u || "").slice(0, 120); }
}
async function diag(src, ev, data, sender) {
  await diagLoad();
  if (!diagOn) return;
  const e = { t: new Date().toISOString(), src, ev };
  if (sender && sender.tab) { e.tab = sender.tab.id; e.page = diagUrl(sender.tab.url); }
  if (sender && sender.frameId !== undefined) e.fid = sender.frameId;
  if (data !== undefined) e.d = diagScrub(data);
  diagBuf.push(e);
  if (diagBuf.length > DIAG_MAX) diagBuf.splice(0, diagBuf.length - DIAG_MAX);
  clearTimeout(diagTimer);
  diagTimer = setTimeout(() => chrome.storage.local.set({ diagLog: diagBuf }), 800);
}
async function diagSetEnabled(on) { diagOn = !!on; await chrome.storage.local.set({ diagEnabled: diagOn }); }
async function diagClear() { await diagLoad(); diagBuf.length = 0; await chrome.storage.local.set({ diagLog: [] }); }

// 서비스 워커 자체의 오류도 남긴다
self.addEventListener("error", (e) => { diag("bg", "error", { msg: String(e.message || e), at: (e.filename || "") + ":" + (e.lineno || "") }); });
self.addEventListener("unhandledrejection", (e) => { diag("bg", "error", { msg: String((e.reason && e.reason.message) || e.reason) }); });
