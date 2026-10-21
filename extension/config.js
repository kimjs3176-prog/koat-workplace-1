// 서무비서 확장 기본 설정 — 기관 배포본은 scripts/build_extension.py 가 이 파일을 기관 값으로 바꿔 만든다.
// 사용자가 설정 화면에서 바꾼 값(chrome.storage)이 있으면 그쪽이 우선한다.
globalThis.SEC_DEFAULTS = {
  server: "",                                  // 서무비서 주소. 예: https://secretary.koat.or.kr
  erpHosts: ["https://kerp.koat.or.kr/*", "https://onnara.koat.or.kr/*"],  // ERP·그룹웨어·온나라 주소(기본 포함분은 manifest 에도 있어야 함)
  floating: true,                              // ERP 화면 오른쪽 아래 🗂 버튼
  guard: true,                                 // ERP 의 상신·결재요청 버튼을 누르면 결재 전 점검 카드
  autoAsk: true,                               // ERP 화면을 알아보면 열린 패널에서 바로 그 업무 안내
  notify: true                                 // 기한 알림(아이콘 배지·바탕화면 알림)
};
// ERP 화면 문구 → 서무비서에 물을 상황·절차 id. 위에서부터 먼저 맞는 것을 쓴다(정규식, 상황 문장, 절차 id).
// 절차 id 는 결재 전 점검(반려 점검 항목)을 띄울 때 쓴다.
globalThis.SEC_RULES = [
  [/국외\s*출장|해외\s*출장|공무국외/, "해외 출장 가요", "overseas-trip"],
  [/여비\s*정산|출장\s*(비|정산)|출장\s*결과/, "출장 다녀와서 정산해야 해요", "domestic-trip"],
  [/출장/, "출장 가요", "domestic-trip"],
  [/연차|휴가|병가|공가|근무\s*상황/, "휴가 신청", "leave"],
  [/시간\s*외|초과\s*근무|연장\s*근무/, "시간외 근무", "overtime"],
  [/법인\s*카드|카드\s*사용/, "법인카드 사용", "corp-card"],
  [/일상\s*경비/, "일상경비 정산", "daily-expense"],
  [/상품권/, "상품권 구매", "gift-cert"],
  [/외부\s*강의|출강/, "외부강의 나가요", "outside-lecture"],
  [/교육\s*훈련|위탁\s*교육|교육\s*신청/, "교육 훈련 신청", "training"],
  [/행사|세미나(?!실)|워크숍|간담회|포럼/, "행사 개최", "event"],
  [/용역|계약\s*요청|계약\s*의뢰/, "용역 계약", "service-contract"],
  [/물품|구매\s*(요청|의뢰)|구입/, "물품 구매", "goods-purchase"],
  [/인계|인수/, "업무 인계", "handover"],
  [/지출\s*결의/, "지출결의", "doc-approval"],
  [/기안|품의|전자\s*결재|결재\s*상신|공문|시행문|문서\s*작성|문서\s*관리\s*카드/, "기안 결재", "doc-approval"]
];
// 제목 문구가 없는 화면(제목을 그림·스크립트로 그리는 ERP)은 주소 경로로 — 기관 ERP 의 주소 규칙은 아래 'ERP 규칙'에서 온다.
globalThis.SEC_URL_RULES = [];
// 업무를 알아보지 않을 화면(주소 경로) — 메일·일정·게시판·포털 포틀릿·로그인은 제목에 '세미나실' 같은 말이 있어도 업무 화면이 아니다
globalThis.SEC_SKIP_URL = /\/mail2?\/|\/schedule\/|\/board\/|\/portlet\/|\/uat\/uia\/|[Ll]ogin/i;

// ── ERP 규칙(기관·ERP 마다 다른 것) ─────────────────────────────────────────
// 서무비서 기관 설정 › ERP 에서 고른 바탕 묶음(일반·KOAT·더존·온나라·SAP)과 기관 맞춤 규칙을 합친 것.
// 서버(/api/secretary/erp/meta)에서 받아 쓰고, 기관 배포본에는 받을 수 없을 때를 대비해 아래 값이 미리 들어간다.
//   submit_words: 이름 전체가 같을 때만 결재 전 점검을 띄우는 제출 버튼 이름(메뉴 안 링크 제외)
//   screen_rules: [{by:'url'|'title', match:정규식, q:물을 말, proc:절차 id}] — 기본 규칙보다 먼저 본다
//   skip_paths:   업무 화면이 아닌 주소(정규식)   labels: 입력값 점검이 날짜 칸을 알아볼 칸 이름 {start, end, ignore}
globalThis.SEC_PROFILE_DEFAULT = null;
globalThis.secCompileProfile = (p) => {
  const rx = (s) => { try { return new RegExp(s, "i"); } catch (e) { return null; } };
  p = p || {};
  const rules = (by) => (p.screen_rules || []).filter((r) => (r.by || "title") === by).map((r) => [rx(r.match), r.q || "", r.proc || ""]).filter((r) => r[0]);
  const norm = (s) => String(s || "").replace(/\s+/g, "");
  return { title: rules("title"), url: rules("url"), skip: (p.skip_paths || []).map(rx).filter(Boolean),
    submit: new Set((p.submit_words || []).map(norm).filter(Boolean)), labels: p.labels || {}, preset: p.preset || "" };
};
globalThis.SEC_PROFILE = globalThis.secCompileProfile(globalThis.SEC_PROFILE_DEFAULT);
// 기관 규칙을 앞에 둔 전체 규칙 — 내용 스크립트·서비스 워커 공통
globalThis.secRules = () => {
  const P = globalThis.SEC_PROFILE || globalThis.secCompileProfile(null);
  return { title: [...P.title, ...(globalThis.SEC_RULES || [])], url: [...P.url, ...(globalThis.SEC_URL_RULES || [])],
    skip: (path) => (globalThis.SEC_SKIP_URL && SEC_SKIP_URL.test(path)) || P.skip.some((r) => r.test(path)) };
};
