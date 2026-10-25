# 서무비서 관리자 안내

[← README](../README.md) · 다른 기관 도입은 [ADOPTION.md](ADOPTION.md)

## 기술 구성
- **프론트엔드**: `index.html`(화면 틀) + `assets/secretary.js`·`assets/secretary.css`(서무비서). 빌드 과정 없음.
- **백엔드**: Flask `api_server.py` — 서무비서 API, 내규 원문·서식 제공, 내규 업로드.
- **배포**: Vercel (`api/index.py`가 Python 서버리스 진입점, 정적 파일은 `index.html`·`upload.html`·`regulations/`·`assets/`)

## 로컬 실행
```bash
pip install -r requirements.txt
npm ci                       # 선택: 한글 서식 작성(kordoc, Node 20+)
python run_local.py          # http://localhost:5100 (PORT 환경변수로 변경 가능)
```

## 배포
- `main` 브랜치에 병합하면 Vercel이 **자동으로 배포**합니다. PR마다 미리보기(Preview) 주소가 생성됩니다.
- 환경변수는 Vercel 프로젝트 설정 → Environment Variables에서 등록합니다(예시: `.env.example`). **키·토큰은 코드나 저장소에 넣지 마세요.**
- 기관 내부 서버에서는 `Dockerfile`로 실행합니다([docs/ADOPTION.md](ADOPTION.md#1-설치)).

## 환경변수

| 이름 | 용도 | 필수 |
|---|---|---|
| `REG_UPLOAD_TOKEN` | 내규 업로드·기관 절차·기관 설정 저장용 관리자 토큰 | 관리 기능 사용 시 |
| `SECRETARY_OPEN_ADMIN` | `1`이면 토큰 없이도 누구나 관리 저장 허용(권장하지 않음). 기본은 토큰이 없으면 **서버 컴퓨터에서 직접 연 화면만** 저장 가능 | 선택 |
| `TRUST_PROXY` | `1`이면 `X-Forwarded-For`를 요청자 IP로 믿음(역방향 프록시 뒤 내부망 설치). Vercel은 자동 | 선택 |
| `SECRETARY_DIAG_BRANCH` | 확장 진단 보고서를 올릴 가지(기본 `secretary-diag`, 배포 가지와 분리) | 선택 |
| `SECRETARY_CONFIG` | 기관 설정 파일 위치(기본 `secretary/config.json`) | 선택 |
| `GITHUB_TOKEN`, `GITHUB_REPO`, `GITHUB_BRANCH` | 읽기 전용 배포에서 업로드·기관 절차를 저장소에 커밋 | 관리 기능 사용 시 |
| `REG_UPLOAD_MAX_MB` | 내규 업로드 최대 크기 | 선택 |
| `ANTHROPIC_API_KEY` | AI 비서(영수증 인식·상황 이해) — Claude | 선택 |
| `GEMINI_API_KEY` | 관련 조문 찾기의 의미 검색(임베딩). Claude 키가 없으면 AI 비서에도 사용 | 선택 |
| `SECRETARY_AI_PROVIDER`, `SECRETARY_AI_MODEL`, `SECRETARY_AI_RATE` | AI 공급자 고정·모델 변경·IP당 요청 한도 | 선택 |
| `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` (또는 `KV_REST_API_URL`, `KV_REST_API_TOKEN`) | 기관 집단 지식 저장소(Vercel 등 읽기 전용 배포). 내부 서버는 없어도 `secretary/insights.json`에 저장 | 선택 |
| `SECRETARY_INSIGHTS_FILE` | 집단 지식 로컬 파일 위치 | 선택 |
| `SEMANTIC_MIN_SCORE` | 의미 검색 최소 유사도 | 선택 |
| `REG_PDF_BASE_URL` | 내규 원본 PDF 주소 접두어 | 선택 |
| `ALLOWED_ORIGINS` | CORS 허용 도메인 | 선택 |

## 절차 관리
- 형식은 `secretary/schema/procedures.schema.json`(절차·절차 팩), `config.schema.json`(기관 설정)에 정의돼 있습니다.
- **공통 절차**: `secretary/procedures.json`. 고친 뒤 `python scripts/stamp_procedures.py`로 근거 개정 정보를 다시 기록합니다(`--check`는 점검만). 근거는 `{"reg":"규정명","art":"조번호"}`로 적으면 화면에서 `regulations/` 원문의 해당 조문을 불러옵니다(조문 번호가 없는 지침은 `"q":"찾을 말"`). 서식은 `{"reg":"규정명","label":"별지 제N호 서식"}`.
- **기관 절차**: 화면의 **⚙ 규정·절차 관리**에서 저장 위치를 '기관'으로 고르고 저장합니다. `REG_UPLOAD_TOKEN`이 필요하고, GitHub 연동 시 `secretary/org.json`으로 커밋됩니다. 같은 id로 저장하면 공통 절차를 덮어씁니다.
- **개인 보충**: 각 사용자가 브라우저에 저장합니다. 내보내기·가져오기로 옮길 수 있습니다.
- 내규가 개정되면 근거 조문은 원문에서 자동으로 최신본이 보입니다. 기한·단계가 바뀌었는지는 **⚙ 규정·절차 관리 › 🔬 규정 개정 영향 분석**에서 확인하고, 제안을 골라 기관 층에 반영합니다.
- **예산과목 기준표**는 **⚙ 규정·절차 관리 › 💰 예산과목 기준표**에서 엑셀 과목표를 붙여 넣고 저장합니다(`config.json`의 `budget`). 칸은 `코드 | 과목명 | 주로 쓰는 업무 | 넣는 것 | 넣지 않는 것 | 기준`이고, '흔한 연결 채우기'는 업무 칸이 빈 과목만 과목명으로 짐작해 채웁니다. 해마다 지침이 바뀌면 다시 붙여 넣으세요.
- 사전 감사 기준(숙박비 상한·추가지급 비율·초안 필수 항목)은 `config.json`의 `audit`로 바꿉니다([docs/ADOPTION.md](ADOPTION.md#7-1-결재-전-사전-감사-기준)).

## 내규 추가·개정
1. `/upload` 페이지에서 개정·신규 내규 문서를 업로드합니다(`REG_UPLOAD_TOKEN` 필요).
2. 변환된 원문은 `regulations/<규정명>/`에 저장되고, 목록은 `regulations_manifest.json`에 반영됩니다.
3. 의미 검색 색인을 다시 만들 때는 `scripts/build_embeddings.py`를 실행합니다(`GEMINI_API_KEY` 필요).

## 📡 ALIO 공시 내규로 최신 유지 (alio-mcp)
[ALIO](https://www.alio.go.kr)에 공시된 우리 기관 내규와 서무비서 등록 내규를 비교해, **개정·신규 규정만 받아 등록**합니다. ALIO 조회·본문 추출은 [alio-mcp](https://github.com/chromehearts79/alio-mcp)를 씁니다.

```bash
git clone https://github.com/chromehearts79/alio-mcp.git ../alio-mcp
(cd ../alio-mcp && npm install --omit=optional)

node scripts/alio_sync.mjs              # 비교만(개정·신규·ALIO 미공시 목록) → secretary/alio_status.json
node scripts/alio_sync.mjs --download   # 개정·신규 현행본을 alio_inbox/ 에 받기(.hwp 는 kordoc 으로 본문 추출)
node scripts/alio_sync.mjs --apply      # 받아서 scripts/import_regs.py 로 등록 — 이후 git diff 확인 → commit·push
```
- 비교 기준: ALIO 시행일 vs 등록본 개정 정보(`2025년도 1월 일부개정`). 다른 경로(`../alio-mcp` 아님)면 `--alio <경로>` 또는 `ALIO_MCP_DIR`.
- 결과는 화면 **규정·절차 관리 › 호환성 점검**에 '📡 ALIO 공시 내규보다 오래된 규정 N건'으로 보입니다. 등록 후에는 근거 규정이 바뀐 절차가 '개정됨'으로 표시되어 **🔬 영향 분석**으로 이어집니다.
- **자동**: `.github/workflows/alio-sync.yml`이 매주 월요일 아침 비교·등록해 PR을 엽니다(수동 실행 가능). GitHub 러너(해외)에서는 ALIO 접속이 가끔 실패하니, 그때는 기관 PC에서 `--apply`를 실행하세요.
  - PR을 자동으로 열려면 저장소 **Settings › Actions › General › Workflow permissions**에서 *Allow GitHub Actions to create and approve pull requests*를 켜야 합니다. 꺼져 있으면 받은 내규를 `alio-sync` 가지에 올리고, 비교 링크를 담은 **이슈**로 알립니다.
  - 이름이 바뀐 규정(ALIO 이름 ≠ 등록 이름)은 관리 화면의 규정명 매핑(`reg_aliases`: ALIO 이름 → 등록 이름)에 넣어 두면 '신규'로 중복 등록하지 않습니다. 전각·반각(`R＆D`/`R&D`)과 `(구 …)` 표기는 자동으로 맞춥니다.
- **Claude Code에서 ALIO 직접 검색**: 저장소의 `.mcp.json`에 alio 서버가 등록되어 있습니다(`ALIO_MCP_DIR`, 기본 `../alio-mcp`). "우리 기관 여비규정 최신 조문 보여줘", "다른 기관 유연근무 규정과 비교해줘"처럼 물으면 됩니다.

---

## 프로젝트 구조
```
├── index.html                 # 서무비서 화면 틀(원문 보기 패널 포함)
├── assets/secretary.js        # 서무비서 기능(절차 안내·기한·초안·이력·관리)
├── assets/secretary.css
├── secretary/procedures.json  # 공통 절차·반려 점검·문서 초안 서식 (기관 절차: secretary/org.json)
├── secretary/config.json      # 기관 설정(기관명·명칭·규정명 매핑·기관 휴일)
├── secretary/holidays.json    # 법정 공휴일·대체공휴일
├── secretary/schema/          # 절차·절차 팩·기관 설정 JSON 스키마
├── docs/ADOPTION.md           # 다른 기관 도입 가이드
├── docs/ERP_TEST.md           # 실제 ERP 시험 순서(🩺 진단 보고서)
├── scripts/diag_report.py     # 진단 보고서 요약·수정 후보 뽑기
├── scripts/alio_sync.mjs      # ALIO 공시 내규와 비교·개정본 등록(alio-mcp)
├── .mcp.json                  # Claude Code용 alio MCP 서버 등록
├── upload.html                # 내규 업로드 페이지
├── api_server.py              # Flask API 서버
├── api/index.py               # Vercel 서버리스 진입점
├── api/forms.mjs, forms/      # 한글 서식 작성(kordoc) — Vercel Node 함수·로컬 CLI
├── extension/                 # Chrome·Edge 확장(ERP 옆 사이드 패널·결재 전 점검·🩺 진단)
├── extension_build.py         # 확장 배포본 zip(🧩 ERP 확장 탭·scripts/build_extension.py)
├── package.json               # kordoc(Node 20+) 의존성
├── reg_chunks.py              # 내규 원문 → 조문 단위 분할
├── regulations/               # 내규 원문(HTML) — 규정별 폴더
├── regulations_manifest.json  # 내규 목록·개정 정보
├── regulations_vectors.*      # 내규 의미 검색 색인
├── scripts/                   # 내규 일괄 등록(import_regs)·근거 개정 기록(stamp_procedures)·색인 생성
├── Dockerfile, .env.example   # 기관 내부 서버 배포
├── run_local.py               # 로컬 실행 스크립트
├── requirements.txt
└── vercel.json                # 배포 설정
```
