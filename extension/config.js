// 서무비서 확장 기본 설정 — 기관 배포본은 scripts/build_extension.py 가 이 파일을 기관 값으로 바꿔 만든다.
// 사용자가 설정 화면에서 바꾼 값(chrome.storage)이 있으면 그쪽이 우선한다.
globalThis.SEC_DEFAULTS = {
  server: "",                                  // 서무비서 주소. 예: https://secretary.koat.or.kr
  erpHosts: ["https://kerp.koat.or.kr/*"],     // 서무비서를 붙일 ERP·그룹웨어 주소(기본 포함분은 manifest 에도 있어야 함)
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
  [/행사|세미나|워크숍|간담회|포럼/, "행사 개최", "event"],
  [/용역|계약\s*요청|계약\s*의뢰/, "용역 계약", "service-contract"],
  [/물품|구매\s*(요청|의뢰)|구입/, "물품 구매", "goods-purchase"],
  [/인계|인수/, "업무 인계", "handover"],
  [/지출\s*결의/, "지출결의", "doc-approval"],
  [/기안|품의|전자\s*결재|결재\s*상신/, "기안 결재", "doc-approval"]
];
