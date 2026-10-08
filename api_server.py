"""
KOAT 서무비서 — 서무 규정·지침·서식을 담아 두고, 상황을 말하면 절차·기한·서식·근거를 안내
배포: Vercel / Render / Railway
로컬: python run_local.py
"""

import os, json, re, time, threading, webbrowser, base64
import xml.etree.ElementTree as ET
# 신뢰할 수 없는 XML(업로드 파일·외부 법령 XML)의 엔티티 폭탄(billion laughs) 방어.
# defusedxml 이 있으면 그 파서를 쓰고, 없으면 표준 파서로 폴백한다.
try:
    import defusedxml.ElementTree as _DET
    def _xml_fromstring(s): return _DET.fromstring(s)
except Exception:
    def _xml_fromstring(s): return ET.fromstring(s)
import urllib3
from urllib.parse import quote
from flask import Flask, request, jsonify, Response
from flask_cors import CORS
import hmac
import requests as req_lib
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

app = Flask(__name__)
# CORS는 교차 출처(다른 웹사이트) 호출에만 적용된다. 이 앱의 프론트엔드는
# 동일 출처(/api/... 상대경로)라 아래 제한과 무관하게 항상 동작한다.
# 열린 CORS를 두면 임의의 외부 사이트가 브라우저에서 서버의 AI 키를 대신
# 소모할 수 있으므로, 허용 출처를 이 서비스 도메인·로컬 개발로 제한한다.
# 커스텀 도메인 등은 ALLOWED_ORIGINS(쉼표 구분)로 추가할 수 있다.
_origins_env = os.environ.get("ALLOWED_ORIGINS", "").strip()
if _origins_env:
    _cors_origins = [o.strip() for o in _origins_env.split(",") if o.strip()]
else:
    _cors_origins = [
        re.compile(r"^https://agro-law[\w.-]*\.vercel\.app$"),
        re.compile(r"^http://localhost(:\d+)?$"),
        re.compile(r"^http://127\.0\.0\.1(:\d+)?$"),
    ]
CORS(app, origins=_cors_origins)

# 요청 본문 상한 — 큰 본문을 다 읽기 전에 거른다(규정 업로드 포함 넉넉히). Vercel 은 자체 상한(4.5MB)이 먼저 걸린다.
app.config["MAX_CONTENT_LENGTH"] = 25 * 1024 * 1024


@app.after_request
def _frame_policy(resp):
    """웹 화면(HTML)은 이 서비스와 브라우저 확장 패널 안에서만 담길 수 있게(vercel.json 과 같은 정책 — 내부망 설치 대비)."""
    if resp.mimetype == "text/html" and "Content-Security-Policy" not in resp.headers:
        resp.headers["Content-Security-Policy"] = "frame-ancestors 'self' chrome-extension: extension: moz-extension:"
    return resp


@app.errorhandler(413)
def _too_large(_e):
    return jsonify({"success": False, "error": "보낸 내용이 너무 큽니다. 파일 크기를 줄여 다시 시도하세요."}), 413


def _bad_request_body(e):
    """형식이 틀린 요청(예: 목록 자리에 객체)으로 생긴 형 오류는 500 대신 400 으로 알려 준다.
    코드 결함일 수도 있으니 서버 로그에는 위치를 남긴다(요청 내용은 남기지 않는다)."""
    if not request.path.startswith("/api/"):
        app.logger.exception("처리 중 오류: %s", request.path)
        return "서버 오류", 500
    app.logger.warning("형식 오류 %s %s: %s", request.method, request.path, type(e).__name__, exc_info=True)
    return jsonify({"success": False, "error": "요청 형식이 올바르지 않습니다."}), 400


for _exc in (TypeError, AttributeError, ValueError, KeyError, IndexError):
    app.register_error_handler(_exc, _bad_request_body)

HEADERS = {"User-Agent": "KOAT-Secretary/1.0", "Accept": "application/json, */*;q=0.9"}

# ── 재시도 정책이 적용된 requests 세션 ────────────────────────────────────────
def _make_session(verify: bool = True) -> req_lib.Session:
    retry = Retry(
        total=4,                              # 최대 4회 재시도
        backoff_factor=0.8,                   # 0.8→1.6→3.2→6.4s
        status_forcelist={429, 500, 502, 503, 504},
        allowed_methods={"GET", "POST"},
        raise_on_status=False,
        # ConnectionReset/ProtocolError 재시도 허용
        respect_retry_after_header=False,
    )
    adapter = HTTPAdapter(
        max_retries=retry,
        pool_connections=8,
        pool_maxsize=24,
    )
    s = req_lib.Session()
    s.mount("https://", adapter)
    s.mount("http://",  adapter)
    s.headers.update(HEADERS)
    s.verify = verify
    return s

# 기본 세션은 TLS 인증서를 검증한다(GitHub 토큰·Google API 키 전송에 사용).
_SESSION = _make_session()


def _decode(raw: bytes) -> str:
    for enc in ("utf-8", "euc-kr"):
        try:
            return raw.decode(enc, errors="strict")
        except (UnicodeDecodeError, LookupError):
            continue
    return raw.decode("utf-8", errors="replace")


# ── Flask 라우트 ──────────────────────────────────────────────────────────────
@app.route("/")
def index():
    # 로컬 실행 시 index.html 서빙
    # Vercel에서는 vercel.json이 index.html을 직접 서빙함
    try:
        import os
        html_path = os.path.join(os.path.dirname(__file__), "index.html")
        with open(html_path, encoding="utf-8") as f:
            return Response(f.read(), mimetype="text/html; charset=utf-8")
    except FileNotFoundError:
        return Response("<h1>index.html not found</h1>", status=404)


# ── 내규 원본 PDF(Supabase Storage 등) ───────────────────────────────────────
# 원본 HWP/HWPX를 PDF로 변환해 올린 스토리지의 공개 URL 접두사.
#   예) https://xxxx.supabase.co/storage/v1/object/public/regulations/pdf
REG_PDF_BASE_URL = os.environ.get("REG_PDF_BASE_URL", "").strip().rstrip("/")
_REG_MANIFEST: list | None = None


def _load_reg_manifest() -> list:
    """규정명 → 원본 PDF 매핑(regulations_manifest.json). 없으면 빈 목록."""
    global _REG_MANIFEST
    if _REG_MANIFEST is not None:
        return _REG_MANIFEST
    try:
        p = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                         "regulations_manifest.json")
        with open(p, encoding="utf-8") as f:
            _REG_MANIFEST = json.load(f)
    except Exception as e:
        print(f"[reg-manifest] 로드 실패: {e}")
        _REG_MANIFEST = []
    return _REG_MANIFEST

# ── 서식(별표·별지) 라이브러리 — 번들 규정 HTML에서 서식 '정의'만 집계(캐시) ──────
_REG_FORMS_CACHE = None
_FORM_BRACKET_RE = re.compile(r'[\[［]\s*(별[표지][^\]］]{0,22})[\]］]')
# 참조(‘…에 의한다/과 같다/에 따라’)와 정의(뒤에 서식명이 오는 경우)를 구분하는 조사·서술어
_FORM_REF_HEAD = re.compile(
    r'^(에|의|와|과|및|을|를|은|는|이|가|로|으로|에서|에는|에게|부터|까지|따라|같|의한|의하여|규정|호)(?:\s|다|$)')

def _reg_forms_index():
    """번들 규정 HTML을 훑어 별표·별지 서식 목록을 만든다(모듈 캐시).

    각 항목: {reg, slug, category, label, title, html, pdf}. 본문 인용(‘별지 제N호
    서식에 의한다’)은 제외하고, 라벨 뒤에 서식명이 오는 '정의'만 담는다.
    """
    global _REG_FORMS_CACHE
    if _REG_FORMS_CACHE is not None:
        return _REG_FORMS_CACHE
    out = []
    try:
        import reg_chunks
    except Exception:
        reg_chunks = None
    for rec in _load_reg_manifest():
        slug = (rec.get("slug") or "").strip()
        if not slug:
            continue
        path = os.path.join(REG_DIR, slug, "index.html")
        try:
            with open(path, encoding="utf-8") as f:
                raw = f.read()
        except Exception:
            continue
        text = reg_chunks.html_to_text(raw) if reg_chunks else re.sub(r"<[^>]+>", " ", raw)
        seen = set()
        entries = []
        for m in _FORM_BRACKET_RE.finditer(text):
            label = re.sub(r"\s+", " ", m.group(1)).strip()
            if len(label) < 2:
                continue
            after = text[m.end():m.end() + 120]
            for _ in range(3):                             # <제N조 관련>·<개정 …> 등 주석 반복 제거
                new = re.sub(r"^\s*[<＜][^>＞]*[>＞]", "", after)
                if new == after:
                    break
                after = new
            after = after.lstrip(" \t\r\n·:：")
            if not after or after[0] in "<（(" or _FORM_REF_HEAD.match(after):
                continue                                   # 본문 인용·주석 → 제외
            title = re.split(r"[\r\n.·。:：]", after)[0].strip()
            title = re.sub(r"\s+", " ", title)[:40].strip()
            # 서식명은 한글 2자 이상 포함해야 인정(숫자·기호·표셀 노이즈 제거)
            if len(re.findall(r"[가-힣]", title)) < 2:
                continue
            key = re.sub(r"\s+", "", label)
            if key in seen:
                continue
            seen.add(key)
            entries.append({"label": label, "title": title})
        if not entries:
            continue
        reg = (rec.get("title") or "").strip()
        for e in entries:
            out.append({"reg": reg, "slug": slug, "category": rec.get("category", ""),
                        "label": e["label"], "title": e["title"],
                        "html": rec.get("html", ""), "pdf": rec.get("pdf", "")})
    out.sort(key=lambda x: (x["reg"], x["label"]))
    _REG_FORMS_CACHE = out
    return out

@app.route("/api/internal/forms")
def internal_forms():
    """서식(별표·별지) 라이브러리 — 번들 규정에서 추출한 서식 목록. 프런트에서 검색·필터."""
    try:
        forms = _reg_forms_index()
        q = (request.args.get("q") or "").strip()
        if q:
            ql = q.replace(" ", "").lower()
            forms = [f for f in forms
                     if ql in (f["reg"] + f["label"] + f["title"]).replace(" ", "").lower()]
        return jsonify({"success": True, "count": len(forms), "forms": forms})
    except Exception as e:
        return jsonify({"success": False, "error": f"서식 목록 조회 실패: {e}"})


def _norm_key(s: str) -> str:
    return re.sub(r"\s+", "", (s or "")).lower()


def _save_reg_manifest(man: list) -> None:
    """manifest 저장 — 기존 파일과 같은 포맷(indent=1)으로 써서 diff 를 최소화한다."""
    tmp = REG_MANIFEST_PATH + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(man, f, ensure_ascii=False, indent=1)
        f.write("\n")
    os.replace(tmp, REG_MANIFEST_PATH)


def _find_reg_exact(name: str) -> dict | None:
    """규정명 '정확 일치'만 반환(공백·대소문자 무시). 유사명 매칭을 하지 않는다."""
    man = _load_reg_manifest()
    key = _norm_key(name)
    if not man or not key:
        return None
    for m in man:
        if _norm_key(m.get("title", "")) == key:
            return m
    return None


def _find_reg_original(name: str) -> dict | None:
    """규정명으로 원본 항목을 찾는다(정확 일치 → 포함 관계).

    포함 관계 매칭은 '가장 가까운' 제목을 고른다. 예전에는 '가장 긴 제목'을
    골라 '감사규정' 조회가 '감사규정 시행세칙'으로 잘못 연결되는 문제가 있었다.
    이제 질의어와 길이 차가 가장 작은(=가장 근접한) 제목을 우선한다.
    """
    m = _find_reg_exact(name)                      # 1) 정확 일치
    if m:
        return m
    man = _load_reg_manifest()
    key = _norm_key(name)
    if not man or not key:
        return None
    cands = [m for m in man                        # 2) 포함 관계(가장 근접한 제목 우선)
             if _norm_key(m.get("title", "")) and
             (_norm_key(m["title"]) in key or key in _norm_key(m["title"]))]
    if cands:
        return min(cands, key=lambda m: (abs(len(_norm_key(m.get("title", ""))) - len(key)),
                                         len(m.get("title", ""))))
    return None


# ══════════════════════════════════════════════════════════════════════════════
#  개정 내규 업로드 (HWPX·DOCX·HTML·TXT·PDF)
#    · 원본을 regulations/<슬러그>/ 에 보관하고 열람용 HTML 을 생성한다
#    · regulations_manifest.json 에 등록해 기존 내규 조회·전문 화면에서 바로 열린다
#    · 추출 본문(text.txt)은 내규 검색·전문 조회의 로컬 소스로 쓰인다
# ══════════════════════════════════════════════════════════════════════════════
import zipfile, io as _io, unicodedata
from datetime import datetime, timezone, timedelta

REG_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "regulations")
REG_MANIFEST_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                 "regulations_manifest.json")
# 업로드 토큰(설정 시 업로드에 필수) — 공개 배포본에서 무단 업로드 방지
REG_UPLOAD_TOKEN = os.environ.get("REG_UPLOAD_TOKEN", "").strip()
SEC_DIAG_BRANCH = os.environ.get("SECRETARY_DIAG_BRANCH", "secretary-diag").strip() or "secretary-diag"
REG_UPLOAD_MAX_MB = int(os.environ.get("REG_UPLOAD_MAX_MB", "40"))
REG_CATEGORIES = ["정관", "규정", "규칙", "세칙", "예규", "매뉴얼", "기타"]
_ALLOWED_EXT = {".hwpx", ".hwp", ".docx", ".pdf", ".html", ".htm", ".txt", ".md"}
_KST = timezone(timedelta(hours=9))

# 규정명 끝말 → 내규 체계상의 구분.
# 기관 내규는 정관 > 규정 > 규칙 > 세칙 > 예규 순이고,
# 지침·요령·기준·수칙·계획 등 하위 문서는 모두 예규로 묶는다.
_REG_CAT_SUFFIX = (
    ("정관", "정관"),
    ("규정", "규정"),
    ("규칙", "규칙"),
    ("세칙", "세칙"),
    ("예규", "예규"),
    ("지침", "예규"), ("요령", "예규"), ("기준", "예규"), ("수칙", "예규"),
    ("준칙", "예규"), ("규준", "예규"), ("요강", "예규"), ("계획", "예규"),
    ("매뉴얼", "매뉴얼"), ("편람", "매뉴얼"), ("가이드", "매뉴얼"),
    ("안내서", "매뉴얼"), ("핸드북", "매뉴얼"),
)


def _guess_reg_category(title: str) -> str:
    """규정명으로 구분을 추정. 판단이 서지 않으면 '기타'.

    정관은 기관당 1건뿐이므로 이름이 '정관'으로 끝날 때만 인정한다.
    (예전에는 업로드 폼의 첫 선택지가 정관이라 '보직관리기준'처럼
     끝말이 목록에 없는 규정이 그대로 정관으로 등록되는 사고가 있었다.)
    """
    t = re.sub(r"\s+", "", (title or ""))
    t = re.sub(r"[(（\[【].*$", "", t)          # 뒤에 붙은 (제정 …)·[별표] 등 제거
    for suf, cat in _REG_CAT_SUFFIX:
        if t.endswith(suf):
            return cat
    return "기타"


def _now_kst() -> str:
    return datetime.now(_KST).strftime("%Y-%m-%d %H:%M")


def _reg_slug(title: str) -> str:
    """규정명 → 디렉터리 슬러그. 기존 manifest 규칙(공백→_)을 따른다."""
    s = unicodedata.normalize("NFC", (title or "").strip())
    s = re.sub(r"[\\/:*?\"<>|]+", "", s)          # 경로·윈도우 금지문자 제거
    s = re.sub(r"\s+", "_", s).strip("._")
    return s[:120]


def _reg_writable() -> bool:
    """regulations/ 에 실제로 쓸 수 있는지(Vercel 등 읽기전용 FS 판별)."""
    try:
        os.makedirs(REG_DIR, exist_ok=True)
        probe = os.path.join(REG_DIR, ".write_probe")
        with open(probe, "w", encoding="utf-8") as f:
            f.write("ok")
        os.remove(probe)
        return os.access(REG_MANIFEST_PATH, os.W_OK) or not os.path.exists(REG_MANIFEST_PATH)
    except Exception:
        return False


# ── 문서 → 블록(단락·표) 추출 ────────────────────────────────────────────────
def _local(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]


def _xml_blocks(root: ET.Element, para_tag: str, table_tag: str,
                row_tag: str, cell_tag: str, text_tags: set,
                break_tags: set) -> list:
    """
    OWPML(HWPX)·OOXML(DOCX) 공통 블록 추출.
    표는 단락 안에 중첩되어 나타나므로(HWPX: p > run > tbl) 표를 만나면
    앞까지의 텍스트를 단락으로 끊고 표 블록을 따로 만든다 — 표가 줄글로 풀리지 않게.
    """
    blocks = []
    buf = []

    def flush():
        txt = re.sub(r"[ \t]+", " ", "".join(buf)).strip()
        buf.clear()
        if not txt:
            blocks.append({"type": "p", "text": ""})
            return
        for line in txt.split("\n"):
            blocks.append({"type": "p", "text": line.strip()})

    def cell_text(tc: ET.Element) -> str:
        parts = []
        for el in tc.iter():
            t = _local(el.tag)
            if t in text_tags:
                parts.append(el.text or "")
            elif t == para_tag and parts:
                parts.append(" ")
        return re.sub(r"\s+", " ", "".join(parts)).strip()

    def cell_span(tc: ET.Element):
        """셀 병합 정보(colspan, rowspan). HWPX는 hp:cellSpan, DOCX는 gridSpan/vMerge."""
        cs = rs = 1
        for sub in tc.iter():
            n = _local(sub.tag)
            if n == "cellSpan":                      # HWPX
                cs = int(sub.get("colSpan") or 1)
                rs = int(sub.get("rowSpan") or 1)
            elif n == "gridSpan":                    # DOCX
                try:
                    cs = int(list(sub.attrib.values())[0])
                except (ValueError, IndexError):
                    pass
        return max(cs, 1), max(rs, 1)

    def table_block(tbl: ET.Element):
        rows = []
        for tr in tbl.iter():
            if _local(tr.tag) != row_tag:
                continue
            cells = []
            for tc in tr:
                if _local(tc.tag) != cell_tag:
                    continue
                cs, rs = cell_span(tc)
                cells.append({"t": cell_text(tc), "cs": cs, "rs": rs})
            if cells:
                rows.append(cells)
        _merge_char_cells(rows)      # 세로쓰기로 글자마다 쪼개진 셀 복원
        while rows and not any(c["t"] for c in rows[0]):   # 앞뒤 빈 행 제거
            rows.pop(0)
        while rows and not any(c["t"] for c in rows[-1]):
            rows.pop()
        if not rows:
            return None
        # 1열 표는 제목·안내 박스로 쓰인 레이아웃 표 → 표 대신 단락으로
        if max(sum(c["cs"] for c in r) for r in rows) <= 1:
            for r in rows:
                blocks.append({"type": "p", "text": (r[0]["t"] if r else "").strip()})
            return None
        return {"type": "table", "rows": rows}

    def walk(node, in_para: bool):
        for child in list(node):
            tag = _local(child.tag)
            if tag == table_tag:
                flush()                       # 표 앞 텍스트를 단락으로 마무리
                tb = table_block(child)
                if tb:
                    blocks.append(tb)
                continue
            if tag == para_tag and not in_para:
                buf.clear()
                walk(child, True)
                flush()
                continue
            if tag in text_tags:
                buf.append(child.text or "")
                continue
            if tag in break_tags:
                buf.append("\n")
                continue
            walk(child, in_para)

    walk(root, False)
    if buf:
        flush()
    return blocks


# 업로드 zip(HWPX/DOCX) 압축 해제 폭탄(zip bomb) 방어용 상한
_ZIP_ENTRY_MAX = 80 * 1024 * 1024     # 단일 항목 최대 80MB(압축 해제 기준)
_ZIP_TOTAL_MAX = 200 * 1024 * 1024    # 누적 읽기 최대 200MB


class _ZipBudget:
    """zip 항목의 압축 해제 크기를 검사하며 안전하게 읽는 헬퍼."""
    def __init__(self, z):
        self.z = z
        self.total = 0

    def read(self, name: str) -> bytes:
        try:
            size = self.z.getinfo(name).file_size
        except KeyError:
            size = 0
        if size > _ZIP_ENTRY_MAX:
            raise ValueError("압축 해제 크기 제한 초과")
        if self.total + size > _ZIP_TOTAL_MAX:
            raise ValueError("압축 해제 크기 제한 초과")
        data = self.z.read(name)
        self.total += len(data)
        if self.total > _ZIP_TOTAL_MAX:
            raise ValueError("압축 해제 크기 제한 초과")
        return data


def _hwpx_blocks(raw: bytes) -> list:
    """HWPX(한/글 OWPML, zip) 본문 추출."""
    blocks = []
    with zipfile.ZipFile(_io.BytesIO(raw)) as z:
        budget = _ZipBudget(z)
        names = [n for n in z.namelist()
                 if re.match(r"Contents/section\d+\.xml$", n, re.I)]
        names.sort(key=lambda n: int(re.search(r"(\d+)", n).group(1)))
        if not names:
            raise ValueError("HWPX 본문(Contents/section*.xml)을 찾을 수 없습니다.")
        for n in names:
            root = _xml_fromstring(budget.read(n))
            blocks += _xml_blocks(root, "p", "tbl", "tr", "tc",
                                  {"t"}, {"lineBreak"})
    return blocks


def _docx_blocks(raw: bytes) -> list:
    """DOCX(OOXML) 본문 추출."""
    with zipfile.ZipFile(_io.BytesIO(raw)) as z:
        budget = _ZipBudget(z)
        root = _xml_fromstring(budget.read("word/document.xml"))
    return _xml_blocks(root, "p", "tbl", "tr", "tc", {"t"}, {"br", "cr"})


def _text_blocks(text: str) -> list:
    return [{"type": "p", "text": l.rstrip()} for l in text.replace("\r\n", "\n").split("\n")]


_SCRIPT_RE = re.compile(
    r"<\s*(script|iframe|object|embed|applet|style)\b.*?<\s*/\s*\1\s*>",
    re.I | re.S)
_SCRIPT_OPEN_RE = re.compile(
    r"<\s*/?\s*(script|iframe|object|embed|applet|link|meta|base)\b[^>]*>", re.I)
_ON_ATTR_RE = re.compile(r"\son[a-z]+\s*=\s*(\"[^\"]*\"|'[^']*'|[^\s>]+)", re.I)
# srcdoc/formaction 은 스크립트 실행 경로가 되므로 속성째 제거
_DANGER_ATTR_RE = re.compile(
    r"\s(srcdoc|formaction)\s*=\s*(\"[^\"]*\"|'[^']*'|[^\s>]+)", re.I)
_JS_URL_RE = re.compile(
    r"(href|src)\s*=\s*(\"|')\s*(?:javascript|data|vbscript):[^\"']*(\2)", re.I)


def _sanitize_html(html: str) -> str:
    """업로드된 HTML에서 스크립트·이벤트 핸들러 제거(같은 출처에서 서빙되므로 필수).

    이는 심층 방어(defense-in-depth)일 뿐, 실제 신뢰 경계는 업로드 토큰이다.
    <table>/<tr>/<td>/<span>/<p>/<div>/style="..." 등 규정 서식에 필요한 요소는
    의도적으로 보존한다.
    """
    out = _SCRIPT_RE.sub("", html)
    out = _SCRIPT_OPEN_RE.sub("", out)
    out = _ON_ATTR_RE.sub("", out)
    out = _DANGER_ATTR_RE.sub("", out)
    out = _JS_URL_RE.sub(r"\1=\2#\2", out)
    return out


_ONE_HANGUL = re.compile(r"^[가-힣]$")


def _merge_char_cells(rows: list) -> list:
    """세로쓰기 라벨이 글자마다 별도 셀로 쪼개진 것을 한 셀로 합친다.

    한글 문서에서 '활 용 기' 같은 라벨은 칸을 나눠 글자를 하나씩 넣는 경우가 많다.
    그대로 두면 폭 좁은 빈 칸이 늘어서 표가 어수선해진다.
    합친 셀의 colspan 을 합계로 유지해 열 정렬은 그대로 둔다.
    (숫자·기호는 실제 자료일 수 있으므로 한글 한 글자만 대상으로 한다)
    """
    for r in rows:
        out, i = [], 0
        while i < len(r):
            j = i
            while (j < len(r)
                   and _ONE_HANGUL.match((r[j]["t"] or "").strip())
                   and r[j]["rs"] == r[i]["rs"]):
                j += 1
            if j - i >= 2:
                out.append({"t": "".join((c["t"] or "").strip() for c in r[i:j]),
                            "cs": sum(c["cs"] for c in r[i:j]),
                            "rs": r[i]["rs"]})
                i = j
            else:
                out.append(r[i])
                i += 1
        r[:] = out
    return rows


def _blocks_to_text(blocks: list) -> str:
    lines = []
    for b in blocks:
        if b["type"] == "table":
            for row in b["rows"]:
                lines.append(" | ".join(c["t"] for c in row))
        else:
            lines.append(b.get("text", ""))
    # 3줄 이상 연속 공백 줄은 2줄로 압축
    return re.sub(r"\n{3,}", "\n\n", "\n".join(lines)).strip()


def _esc(s: str) -> str:
    return (str(s or "").replace("&", "&amp;").replace("<", "&lt;")
            .replace(">", "&gt;").replace('"', "&quot;"))


_ART_HEAD_RE = re.compile(r"^제\s*\d+\s*조(?:\s*의\s*\d+)?\s*(?:\(|$|\s)")
_CHAP_HEAD_RE = re.compile(r"^제\s*\d+\s*(?:편|장|절|관)\b")
_APX_HEAD_RE = re.compile(r"^\[?\s*(?:별표|별지|붙임|서식)")


def _table_html(rows: list) -> str:
    """병합(colspan/rowspan)을 반영해 표를 렌더. 첫 행이 머리글로 보일 때만 thead 사용."""
    def cells(row, tag):
        out = []
        for c in row:
            attr = ""
            if c["cs"] > 1:
                attr += f' colspan="{c["cs"]}"'
            if c["rs"] > 1:
                attr += f' rowspan="{c["rs"]}"'
            out.append(f'<{tag}{attr}>{_esc(c["t"])}</{tag}>')
        return "".join(out)

    if not rows:
        return ""
    # 머리글 판정: 첫 행이 모두 채워져 있고 짧으면 헤더로 본다.
    # (자료 행이 헤더로 올라가 열이 어긋나는 것을 막는다)
    first = rows[0]
    # 날짜·호수·순수 숫자가 있으면 머리글이 아니라 자료 행(예: 연혁 표의 '제정 2010.07.14 …')
    _data_like = re.compile(r"^\s*(?:\d{4}\s*[.\-]|제\s*[\d\-]+\s*호|[\d,]+)\s*\.?\s*$")
    is_head = (len(rows) > 1
               and all(c["t"].strip() for c in first)
               and all(len(c["t"]) <= 20 for c in first)
               and not any(c["rs"] > 1 for c in first)
               and not any(_data_like.match(c["t"]) for c in first))
    head = f"<thead><tr>{cells(first, 'th')}</tr></thead>" if is_head else ""
    body_rows = rows[1:] if is_head else rows
    tb = "".join(f"<tr>{cells(r, 'td')}</tr>" for r in body_rows)
    return f'<div class="tbl-wrap"><table>{head}<tbody>{tb}</tbody></table></div>'


def _blocks_to_view_html(title: str, meta: dict, blocks: list,
                         orig_name: str = "") -> str:
    """열람용 HTML 생성 — 조·장 제목을 구분해 기존 원본 뷰어와 동일하게 읽히도록."""
    body = []
    for b in blocks:
        if b["type"] == "table":
            body.append(_table_html(b["rows"]))
            continue
        t = (b.get("text") or "").strip()
        if not t:
            body.append('<p class="blank"></p>')
        elif _CHAP_HEAD_RE.match(t):
            body.append(f'<h2 class="chap">{_esc(t)}</h2>')
        elif _ART_HEAD_RE.match(t):
            body.append(f'<h3 class="art">{_esc(t)}</h3>')
        elif _APX_HEAD_RE.match(t):
            body.append(f'<h3 class="apx">{_esc(t)}</h3>')
        else:
            body.append(f"<p>{_esc(t)}</p>")

    metarows = "".join(
        f"<tr><th>{_esc(k)}</th><td>{_esc(v)}</td></tr>"
        for k, v in [("규정 구분", meta.get("category")),
                     ("개정 구분", meta.get("revision")),
                     ("시행일자", meta.get("effective_date")),
                     ("담당 부서", meta.get("department")),
                     ("원본 파일", orig_name),
                     ("업로드", meta.get("uploaded_at"))] if v)
    note = meta.get("note") or ""
    return f"""<!DOCTYPE html>
<html lang="ko"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>{_esc(title)}</title>
<style>
 :root{{--tx:#1a1d21;--mu:#5b6472;--bd:#e5e8ec;--g:#1D9E75;--gl:#eafaf3;}}
 body{{font-family:'Malgun Gothic','맑은 고딕',system-ui,sans-serif;color:var(--tx);
   line-height:1.85;max-width:900px;margin:0 auto;padding:28px 26px 60px;font-size:15px;}}
 h1{{font-size:22px;text-align:center;margin:0 0 6px;letter-spacing:2px;}}
 .sub{{text-align:center;color:var(--mu);font-size:13px;margin-bottom:18px;}}
 .meta{{border-collapse:collapse;margin:0 auto 26px;font-size:13px;min-width:60%;}}
 .meta th,.meta td{{border:1px solid var(--bd);padding:5px 12px;text-align:left;}}
 .meta th{{background:var(--gl);color:var(--g);white-space:nowrap;font-weight:700;}}
 .note{{background:#fffbeb;border-left:3px solid #f59e0b;padding:8px 12px;
   font-size:13px;margin-bottom:22px;white-space:pre-wrap;}}
 h2.chap{{font-size:17px;margin:32px 0 12px;padding-bottom:5px;
   border-bottom:1px solid var(--bd);}}
 h3.art{{font-size:15px;margin:22px 0 6px;color:#0f172a;}}
 h3.apx{{font-size:15px;margin:26px 0 8px;color:var(--g);}}
 p{{margin:0 0 4px;white-space:pre-wrap;word-break:keep-all;}}
 p.blank{{height:8px;margin:0;}}
 .tbl-wrap{{overflow-x:auto;-webkit-overflow-scrolling:touch;margin:10px 0 18px;}}
 table{{border-collapse:collapse;font-size:12.5px;width:100%;table-layout:auto;}}
 th,td{{border:1px solid var(--bd);padding:5px 8px;vertical-align:top;
   word-break:keep-all;overflow-wrap:anywhere;line-height:1.55;}}
 thead th{{background:#f7f8fa;font-weight:700;text-align:center;}}
 /* 좁은 화면: 표를 원래 폭으로 두고 가로 스크롤(줄바꿈으로 뭉개지는 것 방지) */
 @media(max-width:820px){{ table{{width:auto;min-width:100%;}}
   th,td{{white-space:nowrap;}} }}
 @media print{{body{{padding:0;}}}}
</style></head><body>
<h1>{_esc(title)}</h1>
<div class="sub">{_esc(meta.get('revision') or '')}</div>
{f'<table class="meta">{metarows}</table>' if metarows else ''}
{f'<div class="note">{_esc(note)}</div>' if note else ''}
{chr(10).join(body)}
</body></html>"""


def _convert_upload(filename: str, raw: bytes, title: str, meta: dict) -> dict:
    """업로드 파일 → {view_html, text, converted, warning}."""
    ext = os.path.splitext(filename)[1].lower()
    if ext in (".html", ".htm"):
        html = _sanitize_html(raw.decode("utf-8", errors="replace"))
        text = re.sub(r"<[^>]+>", " ", html)
        text = re.sub(r"[ \t]+", " ", text)
        return {"view_html": html, "text": re.sub(r"\n{3,}", "\n\n", text).strip(),
                "converted": True, "warning": ""}
    if ext == ".hwpx":
        blocks = _hwpx_blocks(raw)
    elif ext == ".docx":
        blocks = _docx_blocks(raw)
    elif ext in (".txt", ".md"):
        blocks = _text_blocks(_decode(raw))
    elif ext == ".pdf":
        # F08: /regulations/* 의 CSP(object-src/frame-src 'none')는 <embed>/<iframe>
        # 인라인 PDF 표시를 차단한다. 전체 내규의 스크립트 차단을 풀지 않고, 원본 PDF를
        # 새 탭 열기·다운로드 링크로 제공한다(최상위 탐색은 CSP 영향을 받지 않음).
        src = "original.pdf"
        html = (f'<!DOCTYPE html><html lang="ko"><head><meta charset="utf-8">'
                f'<meta name="viewport" content="width=device-width,initial-scale=1">'
                f'<title>{_esc(title)}</title><style>'
                f'body{{margin:0;font-family:system-ui,"Malgun Gothic",sans-serif;background:#f6f7f9;color:#1f2937;}}'
                f'.wrap{{max-width:640px;margin:8vh auto;padding:28px;background:#fff;'
                f'border:1px solid #e5e7eb;border-radius:14px;text-align:center;}}'
                f'.ic{{font-size:44px}}h1{{font-size:18px;margin:10px 0 6px}}'
                f'p{{color:#6b7280;font-size:14px;line-height:1.6}}'
                f'.btns{{margin-top:18px;display:flex;gap:10px;justify-content:center;flex-wrap:wrap}}'
                f'a.btn{{display:inline-block;padding:11px 18px;border-radius:10px;'
                f'font-weight:700;text-decoration:none;font-size:14px}}'
                f'a.p{{background:#256ef4;color:#fff}}'
                f'a.s{{background:#eef2f7;color:#1f2937;border:1px solid #e5e7eb}}'
                f'</style></head><body><div class="wrap"><div class="ic">📄</div>'
                f'<h1>{_esc(title)}</h1>'
                f'<p>이 규정은 PDF 원본으로 등록되어 있습니다.<br>'
                f'아래 버튼으로 원문을 열람하거나 내려받을 수 있습니다.</p>'
                f'<div class="btns"><a class="btn p" href="{src}" target="_blank" rel="noopener">원본 PDF 열기</a>'
                f'<a class="btn s" href="{src}" download>다운로드</a></div>'
                f'<p style="margin-top:16px;font-size:12px">본문 검색이 필요하면 한/글에서 '
                f'HWPX 또는 DOCX로 저장해 다시 올려주세요.</p></div></body></html>')
        return {"view_html": html, "text": "", "converted": False,
                "warning": "PDF는 원본 열기·다운로드로 제공됩니다. 본문 검색이 필요하면 HWPX 또는 DOCX로 올려주세요."}
    elif ext == ".hwp":
        blocks = []
    else:
        raise ValueError(f"지원하지 않는 형식입니다: {ext}")

    if ext == ".hwp":
        html = _blocks_to_view_html(
            title, meta,
            [{"type": "p", "text": "이 규정은 구버전 HWP(바이너리) 형식으로 업로드되어 "
                                   "본문을 자동 변환하지 못했습니다."},
             {"type": "p", "text": "한/글에서 '다른 이름으로 저장 → HWPX'로 저장해 다시 올리면 "
                                   "본문까지 조회·검색됩니다. 원본 파일은 아래 링크로 내려받을 수 있습니다."}],
            orig_name=filename)
        return {"view_html": html, "text": "", "converted": False,
                "warning": "HWP(구버전)는 본문 자동 변환을 지원하지 않습니다. HWPX로 저장해 올리면 본문까지 검색됩니다."}

    text = _blocks_to_text(blocks)
    if not text:
        raise ValueError("본문 텍스트를 추출하지 못했습니다. 파일이 손상되었는지 확인해주세요.")
    return {"view_html": _blocks_to_view_html(title, meta, blocks, orig_name=filename),
            "text": text, "converted": True, "warning": ""}


# ── 업로드된 내규의 로컬 본문 ────────────────────
def _local_reg_text(slug: str) -> str:
    try:
        p = os.path.join(REG_DIR, slug, "text.txt")
        if os.path.exists(p):
            with open(p, encoding="utf-8") as f:
                return f.read()
    except Exception as e:
        print(f"[reg-upload] 로컬 본문 읽기 실패({slug}): {e}")
    return ""


def _uploaded_regs() -> list:
    return [m for m in _load_reg_manifest() if m.get("uploaded_at") or m.get("history")]


REG_BACKUP_DIR = os.path.join(REG_DIR, ".backup")


def _backup_reg_dir(slug: str) -> str:
    """개정본으로 덮어쓰기 전 기존 규정 폴더를 보관한다(되돌리기용). 보관 경로명 반환."""
    src = os.path.join(REG_DIR, slug)
    if not os.path.isdir(src):
        return ""
    import shutil
    os.makedirs(REG_BACKUP_DIR, exist_ok=True)
    name = f"{slug}__{datetime.now(_KST).strftime('%Y%m%d-%H%M%S')}"
    dst = os.path.join(REG_BACKUP_DIR, name)
    shutil.rmtree(dst, ignore_errors=True)
    shutil.copytree(src, dst)
    return name


def _restore_reg_dir(slug: str, backup_name: str) -> bool:
    """보관해 둔 이전 규정 폴더를 되돌린다."""
    if not backup_name:
        return False
    src = os.path.join(REG_BACKUP_DIR, os.path.basename(backup_name))
    dst = os.path.join(REG_DIR, slug)
    if not os.path.isdir(src):
        return False
    import shutil
    shutil.rmtree(dst, ignore_errors=True)
    shutil.move(src, dst)
    return True


def _write_reg_files(slug: str, view_html: str, text: str,
                     orig_filename: str, raw: bytes) -> str:
    """regulations/<slug>/ 에 열람 HTML·본문·원본을 쓴다. 저장된 원본 파일명 반환."""
    d = os.path.join(REG_DIR, slug)
    os.makedirs(d, exist_ok=True)
    with open(os.path.join(d, "index.html"), "w", encoding="utf-8") as f:
        f.write(view_html)
    if text:
        with open(os.path.join(d, "text.txt"), "w", encoding="utf-8") as f:
            f.write(text)
    ext = os.path.splitext(orig_filename)[1].lower()
    stored = ("original.pdf" if ext == ".pdf" else f"original{ext}")
    with open(os.path.join(d, stored), "wb") as f:
        f.write(raw)
    return stored


def _upsert_manifest(entry: dict, backup_name: str = "") -> dict:
    """
    manifest 에 등록/갱신. 같은 규정명이 있으면 개정판으로 교체하고
    이전 항목 전체를 이력에 남긴다(되돌리기로 복원 가능).
    """
    man = list(_load_reg_manifest())
    key = _norm_key(entry["title"])
    idx = next((i for i, m in enumerate(man)
                if _norm_key(m.get("title", "")) == key), -1)
    if idx >= 0:
        old = dict(man[idx])
        history = list(old.pop("history", None) or [])
        history.insert(0, {"revision": old.get("revision", ""),
                           "src": old.get("src", ""),
                           "replaced_at": entry.get("uploaded_at", ""),
                           "backup": backup_name,
                           "entry": old})
        entry = {**old, **entry, "history": history[:20]}
        man[idx] = entry
    else:
        man.append(entry)
    # 정렬하지 않는다 — 기존 항목 순서를 유지해 커밋 diff 를 최소화한다
    _save_reg_manifest(man)
    global _REG_MANIFEST
    _REG_MANIFEST = man
    return entry


def _local_request() -> bool:
    """이 컴퓨터에서 직접 연 요청인지(프록시를 거치지 않은 127.0.0.1·::1)."""
    return (request.remote_addr in ("127.0.0.1", "::1")
            and not request.headers.get("X-Forwarded-For") and not os.environ.get("VERCEL"))


def _client_ip() -> str:
    """요청한 쪽 IP — X-Forwarded-For 는 믿을 수 있는 프록시 뒤일 때만(Vercel 은 직접 덮어쓴다, 그 밖은 TRUST_PROXY=1)."""
    if os.environ.get("VERCEL") or os.environ.get("TRUST_PROXY", "").strip() in ("1", "true"):
        xff = (request.headers.get("X-Forwarded-For") or "").split(",")[0].strip()
        if xff:
            return xff
    return request.remote_addr or "?"


def _upload_authorized() -> tuple[bool, str]:
    """업로드 허용 여부와 거부 사유를 반환한다.

    fail-closed 원칙: 업로드가 리포지토리에 그대로 커밋·배포되는 환경
    (_gh_enabled)에서 REG_UPLOAD_TOKEN 이 설정돼 있지 않으면 익명 업로드가
    저장소를 오염시킬 수 있으므로 거부한다. 토큰이 설정된 경우에는 일치해야
    한다. 로컬 쓰기 전용(비-GitHub) 개발 환경에서는 토큰 없이도 허용한다.
    """
    if not REG_UPLOAD_TOKEN:
        if _gh_enabled():
            return (False, "이 서버는 업로드가 리포지토리에 자동 커밋되므로 "
                           "REG_UPLOAD_TOKEN 설정이 필요합니다. 관리자에게 문의하세요.")
        # 토큰이 없으면 이 컴퓨터에서 연 화면(로컬 개발)만 저장을 허용한다 — 내부망 서버를 누구나 고치지 못하게.
        # 꼭 열어 두려면 SECRETARY_OPEN_ADMIN=1 (권장하지 않음)
        if _local_request() or os.environ.get("SECRETARY_OPEN_ADMIN", "").strip().lower() in ("1", "true", "yes"):
            return (True, "")
        return (False, "관리자 토큰(REG_UPLOAD_TOKEN)이 설정되지 않은 서버입니다. 서버에 토큰을 설정한 뒤 저장하세요.")
    tok = (request.form.get("token") or request.headers.get("X-Upload-Token") or "").strip()
    if hmac.compare_digest(tok.encode(), REG_UPLOAD_TOKEN.encode()):
        return (True, "")
    return (False, "업로드 토큰이 올바르지 않습니다.")


# ── GitHub 직접 커밋 (읽기전용 배포에서 업로드를 반영하는 경로) ────────────────
# 업로드 → 변환 → 리포지토리에 커밋 → Vercel 자동 배포.
# regulations/ 를 그대로 단일 출처로 유지하고, 개정 이력이 git 히스토리로 남는다.
def _env_clean(name: str, default: str = "") -> str:
    """환경변수 값 정리 — 붙여넣기 과정에서 딸려오는 따옴표·공백·개행을 털어낸다.

    Vercel 대시보드에 토큰을 붙여넣을 때 따옴표가 함께 들어가면 401 이 난다.
    """
    v = (os.environ.get(name, default) or "").strip()
    if len(v) >= 2 and v[0] == v[-1] and v[0] in "\"'":
        v = v[1:-1].strip()
    return v


GITHUB_TOKEN  = _env_clean("GITHUB_TOKEN")
GITHUB_REPO   = _env_clean("GITHUB_REPO").strip("/")               # 예: owner/repo
GITHUB_BRANCH = _env_clean("GITHUB_BRANCH", "main") or "main"
GITHUB_API    = _env_clean("GITHUB_API", "https://api.github.com").rstrip("/")
# GitHub 연결 점검 결과 캐시 — 업로드 화면에서 미리 알려주기 위한 용도
_GH_CHECK: dict = {"ts": 0.0, "ok": False, "error": ""}


def _gh_enabled() -> bool:
    return bool(GITHUB_TOKEN and GITHUB_REPO)


def _gh_headers() -> dict:
    return {"Authorization": f"Bearer {GITHUB_TOKEN}",
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28"}


def _gh_hint(status: int, detail: str, path: str = "") -> str:
    """GitHub 오류를 담당자가 바로 조치할 수 있는 안내로 바꾼다."""
    d = (detail or "").lower()
    if status == 401:
        return ("GITHUB_TOKEN 이 유효하지 않습니다(만료·폐기되었거나 값이 잘못 입력됨). "
                "GitHub → Settings → Developer settings 에서 토큰을 새로 발급한 뒤 "
                "Vercel 환경변수 GITHUB_TOKEN 을 교체하고 재배포하세요. "
                "값에 따옴표·공백·줄바꿈이 섞이지 않았는지도 확인해주세요.")
    if status == 403:
        if "rate limit" in d:
            return "GitHub API 호출 한도를 초과했습니다. 잠시 후 다시 시도하세요."
        return (f"토큰에 저장소({GITHUB_REPO}) 쓰기 권한이 없습니다. "
                "Fine-grained 토큰이면 해당 저장소를 Repository access 에 포함하고 "
                "Contents 권한을 Read and write 로 설정하세요.")
    if status == 404:
        return (f"저장소나 브랜치를 찾을 수 없습니다(GITHUB_REPO={GITHUB_REPO or '미설정'}, "
                f"GITHUB_BRANCH={GITHUB_BRANCH}). 값이 'owner/repo' 형식인지, "
                "브랜치 이름이 맞는지, 비공개 저장소라면 토큰 권한 범위에 포함됐는지 확인하세요.")
    if status == 409:
        return "다른 커밋과 충돌했습니다. 잠시 후 다시 시도하세요."
    if status == 422:
        return f"GitHub 가 요청을 거부했습니다: {detail}"
    return f"GitHub 오류({status}): {detail}"


def _gh(method: str, path: str, **kw):
    url = f"{GITHUB_API}/repos/{GITHUB_REPO}{path}"
    r = _SESSION.request(method, url, headers=_gh_headers(), timeout=30, **kw)
    if r.status_code >= 400:
        detail = ""
        try:
            detail = (r.json() or {}).get("message", "")
        except Exception:
            detail = (r.text or "")[:160]
        print(f"[gh] {method} {path} → {r.status_code} {detail}")
        err = RuntimeError(_gh_hint(r.status_code, detail, path))
        err.status = r.status_code            # 404(정상 미존재)와 그 외 오류 구분용
        raise err
    return r.json() if r.content else {}


def _gh_check(force: bool = False) -> dict:
    """토큰·저장소·브랜치가 실제로 쓸 수 있는 상태인지 확인(5분 캐시).

    업로드를 끝까지 진행한 뒤에야 401 을 만나는 일이 없도록 화면에서 미리 알린다.
    """
    if not _gh_enabled():
        return {"ok": False, "error": ""}
    if not force and time.time() - _GH_CHECK["ts"] < 300:
        return {"ok": _GH_CHECK["ok"], "error": _GH_CHECK["error"]}
    try:
        _gh("GET", f"/git/ref/heads/{GITHUB_BRANCH}")
        _GH_CHECK.update({"ts": time.time(), "ok": True, "error": ""})
    except Exception as e:
        _GH_CHECK.update({"ts": time.time(), "ok": False, "error": str(e)})
    return {"ok": _GH_CHECK["ok"], "error": _GH_CHECK["error"]}


def _gh_commit_files(files: dict, message: str, deletes=None, branch: str = ""):
    """여러 파일을 한 커밋으로 반영. files={경로: bytes|str}, deletes=[경로].

    Git Data API(blob→tree→commit→ref)로 원자적으로 커밋한다.
    Contents API를 파일마다 호출하면 커밋이 쪼개지고 중간 실패 시 상태가 깨진다.
    """
    branch = branch or GITHUB_BRANCH
    try:
        ref = _gh("GET", f"/git/ref/heads/{branch}")
    except Exception:
        if branch == GITHUB_BRANCH:
            raise
        # 따로 쓰는 가지(진단 보고서 등)가 아직 없으면 배포 가지에서 만든다
        base = _gh("GET", f"/git/ref/heads/{GITHUB_BRANCH}")
        _gh("POST", "/git/refs", json={"ref": f"refs/heads/{branch}", "sha": base["object"]["sha"]})
        ref = _gh("GET", f"/git/ref/heads/{branch}")
    head_sha = ref["object"]["sha"]
    base_tree = _gh("GET", f"/git/commits/{head_sha}")["tree"]["sha"]

    tree = []
    for path, content in (files or {}).items():
        if isinstance(content, str):
            content = content.encode("utf-8")
        blob = _gh("POST", "/git/blobs",
                   json={"content": base64.b64encode(content).decode("ascii"),
                         "encoding": "base64"})
        tree.append({"path": path, "mode": "100644", "type": "blob",
                     "sha": blob["sha"]})
    for path in (deletes or []):
        tree.append({"path": path, "mode": "100644", "type": "blob", "sha": None})
    if not tree:
        raise RuntimeError("커밋할 파일이 없습니다.")

    new_tree = _gh("POST", "/git/trees",
                   json={"base_tree": base_tree, "tree": tree})
    commit = _gh("POST", "/git/commits",
                 json={"message": message, "tree": new_tree["sha"],
                       "parents": [head_sha]})
    _gh("PATCH", f"/git/refs/heads/{branch}",
        json={"sha": commit["sha"], "force": False})
    return commit["sha"]


def _gh_get_manifest():
    """리포지토리의 현재 manifest 를 읽어온다(로컬 파일이 낡았을 수 있으므로).

    GitHub 연동이 켜진 상태에서 원격 읽기가 '네트워크/HTTP 오류'로 실패하면,
    낡은 로컬 manifest 로 커밋해 다른 인스턴스가 추가한 항목을 덮어써 유실시킬
    위험이 있다. 따라서 그런 경우엔 폴백하지 않고 예외를 올려 커밋을 중단시킨다.
    저장소에 아직 manifest 가 없는 정상적인 404 는 로컬/빈 목록으로 폴백해도 안전하다.
    """
    if not _gh_enabled():
        return list(_load_reg_manifest())
    try:
        d = _gh("GET", "/contents/regulations_manifest.json",
                params={"ref": GITHUB_BRANCH})
        raw = base64.b64decode(d.get("content", "") or "")
        return json.loads(raw.decode("utf-8"))
    except Exception as e:
        if getattr(e, "status", None) == 404:
            print(f"[gh] manifest 없음(404), 로컬 사용")
            return list(_load_reg_manifest())
        print(f"[gh] manifest 조회 실패(안전을 위해 중단): {e}")
        raise RuntimeError("저장소 상태를 읽지 못해 안전을 위해 중단했습니다. "
                           "잠시 후 다시 시도하세요.")


def _gh_dir(path: str, ref: str = ""):
    """저장소 디렉터리 목록. 없으면 []."""
    try:
        d = _gh("GET", f"/contents/{path}", params={"ref": ref or GITHUB_BRANCH})
        return d if isinstance(d, list) else []
    except Exception:
        return []


def _gh_file(path: str, ref: str = ""):
    """저장소 파일 내용(bytes). 없으면 None."""
    try:
        d = _gh("GET", f"/contents/{path}", params={"ref": ref or GITHUB_BRANCH})
        if isinstance(d, dict) and d.get("content"):
            return base64.b64decode(d["content"])
        # 1MB 초과 파일은 content 가 비므로 blob 으로 받는다
        if isinstance(d, dict) and d.get("sha"):
            b = _gh("GET", f"/git/blobs/{d['sha']}")
            return base64.b64decode(b.get("content", "") or "")
    except Exception:
        pass
    return None


def _gh_prev_commit(path: str) -> str:
    """이 경로에 개정본이 올라오기 '직전' 상태의 커밋 sha. 없으면 ''.

    업로드 화면이 만든 커밋('내규 등록/개정: …')을 먼저 찾아 그 부모를 쓴다.
    그 뒤에 다른 수정 커밋이 끼어 있어도 개정 이전 원본을 정확히 되살리기 위함이다.
    """
    try:
        cs = _gh("GET", "/commits", params={"path": path, "sha": GITHUB_BRANCH,
                                            "per_page": 10})
        if not isinstance(cs, list) or not cs:
            return ""
        for c in cs:
            msg = ((c.get("commit") or {}).get("message") or "")
            if msg.startswith("내규 등록:") or msg.startswith("내규 개정:"):
                parents = c.get("parents") or []
                if parents:
                    return parents[0].get("sha", "")
                break
        return cs[1].get("sha", "") if len(cs) >= 2 else ""
    except Exception as e:
        print(f"[gh] 이전 커밋 조회 실패({path}): {e}")
    return ""


def _merge_manifest(man: list, entry: dict):
    """같은 규정명이 있으면 교체(이전 개정은 history 에 누적), 없으면 추가."""
    key = _norm_key(entry.get("title", ""))
    out, replaced, prev = [], False, None
    for m in man:
        if _norm_key(m.get("title", "")) == key:
            prev = {k: v for k, v in m.items() if k != "history"}
            hist = list(m.get("history") or [])
            # 이력 스키마를 _upsert_manifest 와 통일: 이전 개정 라벨 + 교체 시각 기록.
            # entry 는 유지(되돌리기 복원에 사용).
            hist.insert(0, {"revision": prev.get("revision", ""),
                            "replaced_at": entry.get("uploaded_at", ""),
                            "entry": prev})
            entry = dict(entry)
            entry["history"] = hist[:20]
            out.append(entry); replaced = True
        else:
            out.append(m)
    if not replaced:
        out.append(entry)
    return out, replaced


@app.route("/regulations/<path:subpath>")
def serve_regulation_file(subpath):
    """내규 원본 서식·업로드 문서 서빙(로컬 실행용 — Vercel은 vercel.json이 정적 처리)."""
    from flask import send_from_directory
    # 보관용 백업 폴더(.backup)는 노출하지 않는다
    if any(part.startswith(".") for part in subpath.replace("\\", "/").split("/")):
        return Response("<h1>404</h1>", status=404, mimetype="text/html; charset=utf-8")
    try:
        return send_from_directory(REG_DIR, subpath)
    except Exception:
        return Response("<h1>404 — 규정 파일을 찾을 수 없습니다</h1>",
                        status=404, mimetype="text/html; charset=utf-8")


@app.route("/assets/<path:subpath>")
def serve_asset_file(subpath):
    """정적 리소스(서무비서 스크립트·엑셀 서식 등) 서빙 — 로컬 실행용. Vercel은 vercel.json이 정적 처리."""
    from flask import send_from_directory
    if any(part.startswith(".") for part in subpath.replace("\\", "/").split("/")):
        return Response("Not found", status=404)
    try:
        resp = send_from_directory(os.path.join(os.path.dirname(os.path.abspath(__file__)), "assets"), subpath)
        resp.headers["X-Content-Type-Options"] = "nosniff"
        return resp
    except Exception:
        return Response("Not found", status=404)


@app.route("/upload")
@app.route("/upload.html")
def upload_page():
    """개정 내규 업로드 페이지."""
    try:
        p = os.path.join(os.path.dirname(os.path.abspath(__file__)), "upload.html")
        with open(p, encoding="utf-8") as f:
            return Response(f.read(), mimetype="text/html; charset=utf-8")
    except FileNotFoundError:
        return Response("<h1>upload.html not found</h1>", status=404)


@app.route("/api/regs/upload/status")
def reg_upload_status():
    """업로드 가능 여부·카테고리·업로드 이력."""
    ups = _uploaded_regs()
    chk = _gh_check(force=bool(request.args.get("recheck")))
    return jsonify({
        "success": True,
        "writable": _reg_writable(),
        "github": _gh_enabled(),
        "github_repo": GITHUB_REPO if _gh_enabled() else "",
        "github_branch": GITHUB_BRANCH if _gh_enabled() else "",
        "github_ok": chk["ok"],
        "github_error": chk["error"],
        "token_required": bool(REG_UPLOAD_TOKEN) or not _local_request(),
        "max_mb": REG_UPLOAD_MAX_MB,
        "categories": REG_CATEGORIES,
        "allowed_ext": sorted(_ALLOWED_EXT),
        "total": len(_load_reg_manifest()),
        "uploaded": [
            {"title": m.get("title"), "revision": m.get("revision"),
             "category": m.get("category"), "slug": m.get("slug"),
             "html": m.get("html"), "src": m.get("src"),
             "uploaded_at": m.get("uploaded_at"),
             "uploader": m.get("uploader", ""),
             "searchable": bool(_local_reg_text(m.get("slug", ""))),
             "history": m.get("history") or []}
            for m in sorted(ups, key=lambda x: x.get("uploaded_at", ""), reverse=True)
        ],
    })


@app.route("/api/regs/names")
def reg_names_for_upload():
    """등록된 규정명 목록 — 업로드 화면의 '기존 규정 개정' 자동완성용."""
    man = _load_reg_manifest()
    return jsonify({"success": True, "names": [
        {"title": m.get("title", ""), "category": m.get("category", ""),
         "revision": m.get("revision", ""), "uploaded_at": m.get("uploaded_at", "")}
        for m in man if m.get("title")]})


@app.route("/api/regs/upload", methods=["POST"])
def reg_upload():
    """개정 내규 업로드 — 변환·저장·manifest 등록."""
    _ok, _why = _upload_authorized()
    if not _ok:
        return jsonify({"error": _why}), 401

    f = request.files.get("file")
    if not f or not f.filename:
        return jsonify({"error": "파일을 선택해주세요."}), 400
    filename = os.path.basename(f.filename)
    ext = os.path.splitext(filename)[1].lower()
    if ext not in _ALLOWED_EXT:
        return jsonify({"error": f"지원하지 않는 형식입니다({ext}). "
                                f"가능: {', '.join(sorted(_ALLOWED_EXT))}"}), 400

    raw = f.read()
    if not raw:
        return jsonify({"error": "빈 파일입니다."}), 400
    if len(raw) > REG_UPLOAD_MAX_MB * 1024 * 1024:
        return jsonify({"error": f"파일이 너무 큽니다(최대 {REG_UPLOAD_MAX_MB}MB)."}), 413

    # 규정명: 입력값 우선, 없으면 파일명에서 추출 ("감사규정(2023년도 7월 일부개정).hwpx")
    title = (request.form.get("title") or "").strip()
    stem = os.path.splitext(filename)[0]
    m_par = re.match(r"^(.*?)\s*\(([^)]*)\)\s*$", stem)
    if not title:
        title = (m_par.group(1) if m_par else stem).strip()
    revision = (request.form.get("revision") or "").strip()
    if not revision and m_par:
        revision = m_par.group(2).strip()
    if not title:
        return jsonify({"error": "규정명을 입력해주세요."}), 400

    # 구분 결정: 개정판이면 기존 등록 구분을 잇고, 없으면 규정명으로 추정한다.
    # 사람이 고른 값이라도 이름과 어긋나는 '정관'은 받지 않는다(정관은 기관당 1건).
    category = (request.form.get("category") or "").strip()
    guessed = _guess_reg_category(title)
    prev_cat = ""
    for _m in (_load_reg_manifest() or []):
        if _norm_key(_m.get("title") or "") == _norm_key(title):
            prev_cat = (_m.get("category") or "").strip()
            break
    if category in ("", "자동", "자동 분류"):
        category = prev_cat or guessed
    if category == "정관" and guessed != "정관":
        print(f"[upload] '{title}' 구분 정관 → {prev_cat or guessed} 로 교정")
        category = prev_cat if prev_cat and prev_cat != "정관" else guessed
    if category not in REG_CATEGORIES:
        category = guessed

    meta = {
        "category": category,
        "revision": revision,
        "effective_date": (request.form.get("effective_date") or "").strip(),
        "department": (request.form.get("department") or "").strip(),
        "note": (request.form.get("note") or "").strip(),
        "uploader": (request.form.get("uploader") or "").strip()[:40],
        "uploaded_at": _now_kst(),
    }

    try:
        conv = _convert_upload(filename, raw, title, meta)
    except zipfile.BadZipFile:
        return jsonify({"error": "파일을 열 수 없습니다. HWPX/DOCX 파일이 손상되었을 수 있습니다."}), 400
    except Exception as e:
        return jsonify({"error": f"변환 실패: {e}"}), 400

    slug = _reg_slug(title)
    if not slug:
        return jsonify({"error": "규정명에서 저장 폴더명을 만들 수 없습니다."}), 400

    stored_ext = ".pdf" if ext == ".pdf" else ext
    entry = {
        "title": title,
        "revision": revision or meta["uploaded_at"][:10] + " 개정",
        "category": category,
        "slug": slug,
        "src": filename,
        # 기존 manifest 형식과 동일하게 인코딩하지 않은 경로로 저장
        "html": f"/regulations/{slug}/index.html",
        "pdf": f"pdf/{slug}.pdf",
        "effective_date": meta["effective_date"],
        "department": meta["department"],
        "note": meta["note"],
        "uploader": meta["uploader"],
        "uploaded_at": meta["uploaded_at"],
        "original": f"/regulations/{slug}/original{stored_ext}",
        "searchable": bool(conv["text"]),
    }

    # ── GitHub 직접 커밋: 읽기전용 배포에서도 업로드를 반영한다 ──
    want_zip = (request.args.get("as") or request.form.get("as") or "") == "zip"
    if not want_zip and _gh_enabled():
        try:
            base = f"regulations/{slug}"
            stored_name = f"original{stored_ext}"
            entry["original"] = f"/{base}/{stored_name}"
            man, replaced = _merge_manifest(_gh_get_manifest(), entry)
            files = {
                f"{base}/index.html": conv["view_html"],
                f"{base}/{stored_name}": raw,
                "regulations_manifest.json":
                    json.dumps(man, ensure_ascii=False, indent=1) + "\n",
            }
            if conv["text"]:
                files[f"{base}/text.txt"] = conv["text"]
            # F03: 변환 불가 파일(PDF/HWP 등)로 교체할 때 이전 추출 본문(text.txt)과
            # 확장자가 바뀐 구 원본을 명시적으로 제거한다. 그대로 두면 최신 개정일이
            # 표시되는데 검색·전문은 구버전 text.txt를 반환하는 불일치가 생긴다.
            deletes = []
            try:
                existing = {f.get("name") for f in _gh_dir(base)
                            if isinstance(f, dict) and f.get("name")}
            except Exception:
                existing = set()
            if replaced and not conv["text"] and "text.txt" in existing:
                deletes.append(f"{base}/text.txt")
            for nm in existing:                      # 확장자가 바뀐 구 원본 정리
                if nm.startswith("original.") and nm != stored_name:
                    deletes.append(f"{base}/{nm}")
            who = meta.get("uploader") or "익명"
            msg = (f"내규 {'개정' if replaced else '등록'}: {title}"
                   + (f" ({revision})" if revision else "")
                   + f"\n\n업로더: {who}"
                   + (f"\n개정사유: {meta['note']}" if meta.get("note") else "")
                   + "\n\n업로드 화면(/upload)에서 자동 커밋됨")
            sha = _gh_commit_files(files, msg, deletes=deletes or None)
            print(f"[reg-upload] GitHub 커밋 완료: {title} → {sha[:7]}"
                  + (f" (삭제 {len(deletes)}건)" if deletes else ""))
            return jsonify({
                "success": True, "entry": entry, "replaced": replaced,
                "searchable": bool(conv["text"]), "warning": conv["warning"],
                "committed": True, "commit_sha": sha[:7],
                "commit_url": f"https://github.com/{GITHUB_REPO}/commit/{sha}",
                "message": "리포지토리에 커밋했습니다. 배포 반영까지 1~2분 걸립니다.",
            })
        except Exception as e:
            import traceback; traceback.print_exc()
            return jsonify({"error": f"GitHub 커밋 실패: {e}"}), 502

    # ── 읽기 전용 배포에서 GitHub 미설정: 변환 결과를 ZIP 으로 내려준다 ──
    if want_zip or not _reg_writable():
        buf = _io.BytesIO()
        with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
            base = f"regulations/{slug}"
            z.writestr(f"{base}/index.html", conv["view_html"])
            if conv["text"]:
                z.writestr(f"{base}/text.txt", conv["text"])
            z.writestr(f"{base}/original{stored_ext}", raw)
            z.writestr("manifest_entry.json",
                       json.dumps(entry, ensure_ascii=False, indent=2))
            z.writestr("READ_ME.txt",
                       "이 ZIP 을 리포지토리 루트에 풀고 manifest_entry.json 의 내용을\n"
                       "regulations_manifest.json 배열에 추가(같은 규정명이 있으면 교체)한 뒤\n"
                       "커밋·푸시하면 배포본에 반영됩니다.\n")
        if not want_zip and not _reg_writable():
            print(f"[reg-upload] 읽기 전용 FS — ZIP 응답으로 대체: {title}")
        buf.seek(0)
        return Response(
            buf.read(), mimetype="application/zip",
            headers={"Content-Disposition":
                     f"attachment; filename*=UTF-8''{quote(slug)}.zip",
                     "X-Reg-Readonly": "1" if not _reg_writable() else "0",
                     "X-Reg-Warning": quote(conv["warning"] or "")})

    try:
        backup = _backup_reg_dir(slug)      # 기존 규정 폴더 보관(되돌리기용)
        stored = _write_reg_files(slug, conv["view_html"], conv["text"], filename, raw)
        entry["original"] = f"/regulations/{slug}/{stored}"
        entry = _upsert_manifest(entry, backup)
    except Exception as e:
        import traceback; traceback.print_exc()
        return jsonify({"error": f"저장 실패: {e}"}), 500

    print(f"[reg-upload] 등록 완료: {title} ({revision}) → {slug}")
    return jsonify({"success": True, "entry": entry,
                    "warning": conv["warning"],
                    "searchable": bool(conv["text"]),
                    "view_url": entry["html"],
                    "replaced": bool(entry.get("history"))})


def _gh_revert(slug: str):
    """GitHub 커밋으로 개정 되돌리기.

    이전 개정이 있으면 그 개정본을 올리기 직전 커밋에서 파일을 되살리고,
    신규 등록이었으면 폴더 파일을 지운다. manifest 와 함께 한 커밋으로 반영한다.
    """
    man = _gh_get_manifest()
    idx = next((i for i, m in enumerate(man) if m.get("slug") == slug), -1)
    if idx < 0:
        return jsonify({"error": "해당 규정을 찾을 수 없습니다."}), 404
    cur = man[idx]
    if not cur.get("uploaded_at") and not cur.get("history"):
        return jsonify({"error": "업로드로 등록된 규정만 되돌릴 수 있습니다."}), 400

    base = f"regulations/{slug}"
    now_files = [f.get("name") for f in _gh_dir(base) if f.get("type") == "file"]
    history = list(cur.get("history") or [])
    files, deletes, warning = {}, [], ""

    if history:                                   # ── 이전 개정본으로 복원 ──
        h = history.pop(0)
        prev = dict(h.get("entry") or {})
        prev.pop("history", None)
        if history:
            prev["history"] = history
        # 이번 개정을 커밋하기 직전 상태(= 이전 개정본)를 git 에서 되살린다
        ref = _gh_prev_commit(f"{base}/index.html")
        old_files = [f.get("name") for f in _gh_dir(base, ref)] if ref else []
        for name in old_files:
            data = _gh_file(f"{base}/{name}", ref)
            if data is not None:
                files[f"{base}/{name}"] = data
        for name in now_files:                    # 이전에 없던 파일(확장자 변경 등)은 정리
            if name not in old_files:
                deletes.append(f"{base}/{name}")
        if not files:
            warning = ("이전 개정본 파일을 저장소 이력에서 찾지 못해 등록 정보만 되돌렸습니다. "
                       "문서 내용은 현재 개정본이 그대로 남아 있습니다.")
            print(f"[gh-revert] 이전 파일 복원 실패: {base} (ref={ref or '없음'})")
        man[idx] = prev
        restored_rev = prev.get("revision", "")
    else:                                         # ── 신규 등록 → 등록 해제 ──
        man.pop(idx)
        deletes = [f"{base}/{n}" for n in now_files]
        restored_rev = ""

    files["regulations_manifest.json"] = (
        json.dumps(man, ensure_ascii=False, indent=1) + "\n")
    title = cur.get("title", slug)
    msg = (f"내규 되돌리기: {title}"
           + (f" → {restored_rev}" if restored_rev else " (등록 해제)")
           + "\n\n업로드 화면(/upload)에서 자동 커밋됨")
    sha = _gh_commit_files(files, msg, deletes=deletes)
    print(f"[gh-revert] 완료: {title} → {sha[:7]}")
    return jsonify({
        "success": True, "removed": title,
        "restored": bool(restored_rev), "restored_revision": restored_rev,
        "files_restored": not warning, "warning": warning,
        "committed": True, "commit_sha": sha[:7],
        "commit_url": f"https://github.com/{GITHUB_REPO}/commit/{sha}",
        "message": "리포지토리에 커밋했습니다. 배포 반영까지 1~2분 걸립니다.",
    })


@app.route("/api/regs/upload/delete", methods=["POST"])
def reg_upload_delete():
    """
    업로드한 개정 내규 되돌리기.
      · 이전 개정이 있으면 그 개정본(파일·manifest 항목)으로 복원한다
      · 이전 개정이 없으면(신규 등록) 등록을 해제하고 파일을 삭제한다
    """
    _ok, _why = _upload_authorized()
    if not _ok:
        return jsonify({"error": _why}), 401
    slug = (request.form.get("slug") or (request.json or {}).get("slug") or "").strip()
    if not slug or "/" in slug or "\\" in slug or slug.startswith("."):
        return jsonify({"error": "slug 값이 올바르지 않습니다."}), 400

    # 읽기 전용 배포(서버리스)에서는 업로드와 같은 경로로 GitHub 에 커밋해 되돌린다.
    if not _reg_writable():
        if not _gh_enabled():
            return jsonify({"error": "읽기 전용 환경이고 GitHub 연동도 없어 되돌릴 수 없습니다. "
                                     "GITHUB_TOKEN·GITHUB_REPO 를 설정하세요."}), 503
        try:
            return _gh_revert(slug)
        except Exception as e:
            import traceback; traceback.print_exc()
            return jsonify({"error": f"되돌리기 실패: {e}"}), 502

    man = list(_load_reg_manifest())
    idx = next((i for i, m in enumerate(man) if m.get("slug") == slug), -1)
    if idx < 0:
        return jsonify({"error": "해당 규정을 찾을 수 없습니다."}), 404
    cur = man[idx]
    if not cur.get("uploaded_at") and not cur.get("history"):
        return jsonify({"error": "업로드로 등록된 규정만 되돌릴 수 있습니다."}), 400

    history = list(cur.get("history") or [])
    restored_rev, files_restored = "", True
    if history:                                   # 이전 개정본으로 복원
        h = history.pop(0)
        prev = dict(h.get("entry") or {})
        prev.pop("history", None)
        if history:                               # 남은 이력이 없으면 키를 만들지 않는다
            prev["history"] = history
        files_restored = _restore_reg_dir(slug, h.get("backup", ""))
        man[idx] = prev
        restored_rev = prev.get("revision", "")
    else:                                         # 신규 등록 → 완전 삭제
        man.pop(idx)
        d = os.path.join(REG_DIR, slug)
        if os.path.isdir(d) and os.path.abspath(d).startswith(
                os.path.abspath(REG_DIR) + os.sep):
            import shutil
            shutil.rmtree(d, ignore_errors=True)

    _save_reg_manifest(man)
    global _REG_MANIFEST
    _REG_MANIFEST = man

    return jsonify({"success": True, "removed": cur.get("title", ""),
                    "restored": bool(restored_rev),
                    "restored_revision": restored_rev,
                    "files_restored": files_restored,
                    "warning": ("" if files_restored else
                                "이전 개정본 파일 보관분을 찾지 못해 등록 정보만 되돌렸습니다. "
                                "regulations/ 폴더는 git 에서 복원해주세요(git checkout -- regulations/).")})


# ── 의미 검색(임베딩) + 키워드 하이브리드 ─────────────────────────────────────
# 벡터는 리포지토리에 함께 배포되는 int8 파일에서 읽는다(벡터DB 불필요).
_VEC_BIN = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                        "regulations_vectors.bin")
_VEC_META = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                         "regulations_vectors.json")
_VEC_CACHE: dict = {"loaded": False, "meta": None, "mat": None, "np": None}
# 코사인 하한. 관련 없는 조문은 대체로 0.5 아래에 몰려 있어 노이즈를 걸러낸다.
_SEM_MIN = float(os.environ.get("SEMANTIC_MIN_SCORE", "0.55"))


def _vec_load():
    """벡터 파일 로드(프로세스당 1회). numpy 가 없으면 의미 검색을 끈다."""
    if _VEC_CACHE["loaded"]:
        return _VEC_CACHE
    _VEC_CACHE["loaded"] = True
    try:
        import numpy as np
    except ImportError:
        print("[vec] numpy 미설치 — 의미 검색 비활성")
        return _VEC_CACHE
    try:
        with open(_VEC_META, encoding="utf-8") as f:
            meta = json.load(f)
        dim, cnt = meta["dim"], meta["count"]
        raw = np.fromfile(_VEC_BIN, dtype=np.int8)
        if raw.size != dim * cnt:
            print(f"[vec] 크기 불일치 {raw.size} != {dim*cnt} — 비활성")
            return _VEC_CACHE
        mat = raw.reshape(cnt, dim).astype(np.float32)
        norms = np.linalg.norm(mat, axis=1, keepdims=True)
        norms[norms == 0] = 1.0
        _VEC_CACHE.update({"meta": meta, "mat": mat / norms, "np": np})
        print(f"[vec] 로드 {cnt:,}청크 × {dim}차원")
    except FileNotFoundError:
        pass                                   # 벡터 파일 없음 = 기능 미사용
    except Exception as e:
        print(f"[vec] 로드 실패: {e}")
    return _VEC_CACHE


def _embed_query(text: str, api_key: str, model: str, dim: int = 0):
    """질의 임베딩. 실패 시 None.

    문서 벡터를 MRL 로 축소해 저장했으면 질의도 같은 차원으로 뽑아야 한다.
    """
    try:
        # 키는 주소가 아니라 헤더로 — 주소는 오류 메시지·재시도 경고·접근 로그에 그대로 남는다
        url = (f"https://generativelanguage.googleapis.com/v1beta/models"
               f"/{model}:embedContent")
        body = {"model": f"models/{model}",
                "content": {"parts": [{"text": text}]},
                "taskType": "RETRIEVAL_QUERY"}
        if dim:
            body["outputDimensionality"] = dim
        r = _SESSION.post(url, timeout=15, json=body, headers={"x-goog-api-key": api_key})
        if r.status_code != 200:
            print(f"[vec] 질의 임베딩 실패({r.status_code})")
            return None
        return r.json()["embedding"]["values"]
    except Exception as e:
        print(f"[vec] 질의 임베딩 오류: {type(e).__name__}")   # 예외 문구는 남기지 않는다(요청 정보가 섞일 수 있음)
        return None


def semantic_search(query: str, api_key: str, top_k: int = 20):
    """의미 검색. [{slug,title,no,art_title,preview,score}] 또는 []"""
    c = _vec_load()
    if c["mat"] is None or not api_key:
        return []
    np = c["np"]
    qv = _embed_query(query, api_key,
                      c["meta"].get("model", "gemini-embedding-001"),
                      dim=int(c["meta"].get("dim") or 0))
    if not qv or len(qv) != c["mat"].shape[1]:
        if qv:
            print(f"[vec] 질의 차원 불일치 {len(qv)} != {c['mat'].shape[1]}")
        return []
    q = np.asarray(qv, dtype=np.float32)
    n = float(np.linalg.norm(q)) or 1.0
    sims = c["mat"] @ (q / n)
    k = min(top_k, sims.shape[0])
    idx = np.argpartition(-sims, k - 1)[:k]
    idx = idx[np.argsort(-sims[idx])]
    chunks = c["meta"]["chunks"]
    return [{**chunks[int(i)], "score": float(sims[int(i)])} for i in idx]


def _user_gemini_key():
    """사용자 Gemini 키 — 헤더(X-Gemini-Key) → '내 AI 키'(X-AI-Key, Gemini) → 서버 키.

    F02: URL 쿼리로 키를 받지 않는다. 쿼리 파라미터는 접근 로그·관측 시스템에
    남을 수 있어, 사용자별 키는 요청 헤더로만 전달받는다.
    """
    up, uk = _sec_ai_user()
    return (request.headers.get("X-Gemini-Key")
            or (uk if up == "gemini" else "")
            or os.environ.get("GEMINI_API_KEY", "")).strip()


def _semantic_for_search(query: str, top_k: int = 18):
    """내규 검색 응답에 실을 의미 검색 결과. 인덱스·키가 없으면 빈 목록."""
    try:
        key = _user_gemini_key()
        if not key or _vec_load()["mat"] is None:
            return []
        return [{"title": h["title"], "slug": h["slug"], "no": h["no"],
                 "art_title": h["art_title"], "preview": h["preview"],
                 "score": round(h["score"], 4)}
                for h in semantic_search(query, key, top_k=top_k)
                if h["score"] >= _SEM_MIN]
    except Exception as e:
        print(f"[internal-search] 의미 검색 생략: {e}")
        return []


@app.route("/api/internal/original")
def internal_original():
    """내규 원본(PDF) 위치 조회 — 전문 화면의 '원본 보기/다운로드'용."""
    name = request.args.get("name", "").strip()
    if not name:
        return jsonify({"error": "name 파라미터가 필요합니다"}), 400
    m, _via = _sec_resolve_reg(name)      # 다른 기관: 규정명 매핑·접두어·근사 연결까지
    if not m:
        return jsonify({"success": True, "found": False, "name": name})
    out = {"success": True, "found": True, "name": name,
           "title": m.get("title"), "revision": m.get("revision"),
           "category": m.get("category"), "source_file": m.get("src", "")}
    # 원본 서식 HTML — 리포에 함께 배포되므로 항상 사용 가능
    slug = m.get("slug", "")
    if slug:
        out["html_url"] = "/regulations/" + quote(slug) + "/index.html"
    # PDF는 별도 스토리지를 설정한 경우에만
    if REG_PDF_BASE_URL:
        fname = os.path.basename(m.get("pdf", "")) or (slug + ".pdf")
        out["pdf_url"] = f"{REG_PDF_BASE_URL}/{quote(fname)}"
    return jsonify(out)


@app.route("/api/ping")
def ping():
    """서버 생존 확인"""
    return jsonify({"server": True, "ok": True})


# ══════════════════════════════════════════════════════════════════════════
# 서무비서 — 서무 규정·지침·서식을 담아 두고, 상황을 말하면 절차·기한·서식·근거를 안내
#   공통(secretary/procedures.json, 저장소 기본 탑재) → 기관(secretary/org.json, 관리자 등록)
#   → 개인 보충(브라우저 localStorage) 세 층으로 관리한다. 근거 조문은 번들 내규 원문에서 뽑는다.
#
#   다른 기관에서 쓰려면: secretary/config.json(기관명·명칭·규정명 매핑·휴일)을 바꾸고
#   자기 내규를 regulations/ 에 올린다(scripts/import_regs.py). 절차의 규정명은
#   매핑 → 정확 일치 → 기관명 접두어 제거 → 포함 관계 순으로 그 기관 규정에 연결된다.
# ══════════════════════════════════════════════════════════════════════════
SEC_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "secretary")
SEC_COMMON_PATH = os.path.join(SEC_DIR, "procedures.json")
SEC_ORG_PATH = os.path.join(SEC_DIR, "org.json")
SEC_ORG_REPO_PATH = "secretary/org.json"
SEC_CONFIG_PATH = os.environ.get("SECRETARY_CONFIG", "").strip() or os.path.join(SEC_DIR, "config.json")
SEC_CONFIG_REPO_PATH = "secretary/config.json"
SEC_HOLIDAYS_PATH = os.path.join(SEC_DIR, "holidays.json")
_SEC_ORG_CACHE: dict = {"ts": 0.0, "data": None}
_SEC_CFG_CACHE: dict = {"ts": 0.0, "data": None}
_SEC_CHUNKS = None            # [(title, no, art_title, body)] — 근거 조문·관련 조문 검색용(모듈 캐시)
_SEC_ART_INDEX = None         # {(norm 규정명, 조번호): (title, no, art_title, text)}
_SEC_ID_RE = re.compile(r"^[a-z0-9][a-z0-9\-]{1,47}$")
_SEC_ACT_KINDS = {"proc"}          # 단계 바로가기는 다른 절차로의 이동만 허용
_SEC_TERM_KEYS = ("erp", "portal", "accounting", "approval")
_SEC_CFG_DEFAULT = {
    "schema_version": 1,
    "org": {"name": "한국농업기술진흥원", "short": "KOAT", "abbr": "농진원"},
    "service": {"title": "서무비서", "icon": "🗂", "primary": "#256ef4",
                "tagline": "출장·물품·행사·복무·결재 — 상황을 말하면 절차·기한·서식·근거 안내",
                "footer": "근거 조문은 기관 현행 내규 원문을 기준으로 안내합니다. 최종 판단은 원문과 담당 부서 확인을 거쳐 주세요."},
    # 절차 문장 속 [[erp]] 같은 자리표시를 기관 명칭으로 바꾼다
    "terms": {"erp": "ERP", "portal": "내부 포털", "accounting": "회계부서", "approval": "전자결재"},
    # 절차가 가리키는 규정명 → 우리 기관 규정명
    "reg_aliases": {},
    # 기본 공휴일(holidays.json) 외 기관 휴일(창립기념일 등) 추가·제외
    "holidays": {"extra": [], "exclude": []},
}


def _sec_read_json(path: str, default):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return default


def _sec_layer_load(cache: dict, repo_path: str, local_path: str, force: bool = False):
    """저장소 파일(기관 층·설정). GitHub 연동 시 저장소 최신본(60초 캐시) — 배포 전에도 방금 저장한 값이 보이게."""
    if not force and cache["data"] is not None and time.time() - cache["ts"] < 60:
        return cache["data"]
    data = None
    if _gh_enabled():
        raw = _gh_file(repo_path)
        if raw:
            try:
                data = json.loads(raw.decode("utf-8"))
            except Exception:
                data = None
    if data is None:
        data = _sec_read_json(local_path, {})
    data = data if isinstance(data, dict) else {}
    cache.update({"ts": time.time(), "data": data})
    return data


def _sec_org_load(force: bool = False) -> dict:
    data = _sec_layer_load(_SEC_ORG_CACHE, SEC_ORG_REPO_PATH, SEC_ORG_PATH, force)
    data.setdefault("procedures", [])
    data.setdefault("drafts", {})
    return data


def _sec_config(force: bool = False) -> dict:
    """기관 설정 = 기본값 위에 config.json 을 얕게(섹션 단위) 덮어쓴 값."""
    raw = _sec_layer_load(_SEC_CFG_CACHE, SEC_CONFIG_REPO_PATH, SEC_CONFIG_PATH, force)
    cfg = json.loads(json.dumps(_SEC_CFG_DEFAULT))
    for k, v in raw.items():
        if isinstance(v, dict) and isinstance(cfg.get(k), dict) and k != "reg_aliases":
            cfg[k].update(v)
        else:
            cfg[k] = v
    return cfg


def _sec_clean_str(v, n: int = 400) -> str:
    return re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f]", "", str(v or "")).strip()[:n]


def _sec_ref_list(arr, n=6):
    out = []
    for b in (arr or [])[:n]:
        if not isinstance(b, dict) or not _sec_clean_str(b.get("reg"), 80):
            continue
        r = {"reg": _sec_clean_str(b.get("reg"), 80)}
        for k in ("art", "q", "label", "title"):
            if b.get(k):
                r[k] = _sec_clean_str(b.get(k), 60)
        out.append(r)
    return out


def _sec_clean_proc(p: dict) -> dict | None:
    """관리자가 보낸 절차 1건 정규화. 허용된 필드·길이만 남긴다(화면에서 실행되는 값은 화이트리스트)."""
    if not isinstance(p, dict):
        return None
    pid = _sec_clean_str(p.get("id"), 48).lower()
    title = _sec_clean_str(p.get("title"), 80)
    if not _SEC_ID_RE.match(pid) or not title:
        return None
    if p.get("hidden"):
        return {"id": pid, "title": title, "hidden": True}   # 기관 층에서 공통 절차 숨김(같은 id)

    def act(a):
        if not isinstance(a, dict) or a.get("k") not in _SEC_ACT_KINDS:
            return None
        r = {"k": a["k"], "l": _sec_clean_str(a.get("l"), 30) or "바로가기"}
        if a.get("id"):
            r["id"] = _sec_clean_str(a.get("id"), 48)
        return r

    steps = []
    for s in (p.get("steps") or [])[:20]:
        if not isinstance(s, dict) or not _sec_clean_str(s.get("t")):
            continue
        st = {"t": _sec_clean_str(s.get("t"), 400)}
        for k in ("when", "draft"):
            if s.get(k):
                st[k] = _sec_clean_str(s.get(k), 60)
        if s.get("optional"):
            st["optional"] = True
        if isinstance(s.get("docs"), list):
            st["docs"] = [_sec_clean_str(d, 80) for d in s["docs"][:10] if _sec_clean_str(d)]
        dl = s.get("deadline")
        if isinstance(dl, dict) and dl.get("ref"):
            try:
                st["deadline"] = {"ref": _sec_clean_str(dl.get("ref"), 12),
                                  "days": max(-365, min(365, int(dl.get("days") or 0)))}
                if dl.get("label"):
                    st["deadline"]["label"] = _sec_clean_str(dl.get("label"), 40)
            except (TypeError, ValueError):
                pass
        if s.get("basis"):
            st["basis"] = _sec_ref_list(s.get("basis"))
        if isinstance(s.get("form"), dict):
            f = _sec_ref_list([s["form"]], 1)
            if f:
                st["form"] = f[0]
        a = act(s.get("act"))
        if a:
            st["act"] = a
        steps.append(st)
    pitfalls = []
    for pf in (p.get("pitfalls") or [])[:15]:
        if isinstance(pf, str):
            pf = {"t": pf}
        if isinstance(pf, dict) and _sec_clean_str(pf.get("t")):
            x = {"t": _sec_clean_str(pf.get("t"), 300)}
            if pf.get("basis"):
                x["basis"] = _sec_ref_list(pf.get("basis"), 3)
            pitfalls.append(x)
    return {
        "id": pid, "title": title,
        "icon": _sec_clean_str(p.get("icon"), 4) or "📌",
        "category": _sec_clean_str(p.get("category"), 20) or "기타",
        "summary": _sec_clean_str(p.get("summary"), 300),
        "approval": _sec_clean_str(p.get("approval"), 200),
        "triggers": [_sec_clean_str(t, 30) for t in (p.get("triggers") or [])[:40] if _sec_clean_str(t)],
        "dates": [{"k": _sec_clean_str(d.get("k"), 12), "l": _sec_clean_str(d.get("l"), 30)}
                  for d in (p.get("dates") or [])[:3] if isinstance(d, dict) and d.get("k")],
        "steps": steps,
        "forms": _sec_ref_list(p.get("forms"), 12),
        "pitfalls": pitfalls,
        "tips": [_sec_clean_str(t, 300) for t in (p.get("tips") or [])[:10] if _sec_clean_str(t)],
    }


def _sec_chunks():
    global _SEC_CHUNKS, _SEC_ART_INDEX
    if _SEC_CHUNKS is None:
        try:
            import reg_chunks
            _SEC_CHUNKS = [(c["title"], c["no"], c["art_title"], c["text"])
                           for c in reg_chunks.iter_chunks(max_chars=4000) if not c["boiler"]]
        except Exception as e:
            print(f"[secretary] 조문 색인 실패: {e}")
            _SEC_CHUNKS = []
        _SEC_ART_INDEX = {}
        for c in _SEC_CHUNKS:
            _SEC_ART_INDEX.setdefault((_norm_key(c[0]), c[1]), c)
    return _SEC_CHUNKS


def _sec_art(title: str, no: str):
    _sec_chunks()
    return (_SEC_ART_INDEX or {}).get((_norm_key(title), no))


_SEC_REG_SUFFIX = re.compile(r"(규정|규칙|지침|요령|세칙|기준|매뉴얼|훈령|예규)$")


def _sec_resolve_reg(name: str):
    """절차의 규정명 → 우리 기관 manifest 항목. (항목, 방식) — 방식: alias|exact|prefix|approx.

    다른 기관에 그대로 옮겨도 절차가 깨지지 않도록 단계적으로 찾는다.
    approx(포함 관계·어간) 는 틀릴 수 있으므로 호환성 점검에서 '확인 필요'로 표시한다.
    """
    name = (name or "").strip()
    if not name:
        return None, ""
    cfg = _sec_config()
    aliases = {_norm_key(k): v for k, v in (cfg.get("reg_aliases") or {}).items() if v}
    via = ""
    if _norm_key(name) in aliases:
        name, via = aliases[_norm_key(name)], "alias"
    m = _find_reg_exact(name)
    if m:
        return m, via or "exact"
    org = cfg.get("org") or {}
    for pre in (org.get("name"), org.get("short"), org.get("abbr")):   # "○○공사 여비규정" ↔ "여비규정"
        if not pre:
            continue
        if name.startswith(pre):
            m = _find_reg_exact(name[len(pre):].strip())
        else:
            m = _find_reg_exact(f"{pre} {name}") or _find_reg_exact(f"{pre}{name}")
        if m:
            return m, via or "prefix"
    m = _find_reg_original(name)                       # 포함 관계(가장 가까운 제목)
    if m:
        return m, via or "approx"
    stem = _SEC_REG_SUFFIX.sub("", _norm_key(name))    # "여비규정" ↔ "여비 지급 지침"
    if len(stem) >= 2:
        def _st(x):
            return _SEC_REG_SUFFIX.sub("", _norm_key(x.get("title", "")))
        cands = [x for x in _load_reg_manifest()
                 if len(_st(x)) >= 2 and (_st(x).startswith(stem) or stem.startswith(_st(x)))]
        if cands:
            return min(cands, key=lambda x: (abs(len(_st(x)) - len(stem)), len(x.get("title", "")))), via or "approx"
    return None, ""


def _sec_reg_text(title: str) -> str:
    m, _ = _sec_resolve_reg(title)
    slug = (m or {}).get("slug") or title.replace(" ", "_")
    path = os.path.join(REG_DIR, slug, "index.html")
    try:
        import reg_chunks
        with open(path, encoding="utf-8", errors="replace") as f:
            return reg_chunks.html_to_text(f.read())
    except Exception:
        return ""


def _sec_forms_set():
    return {(_norm_key(f["reg"]), _norm_key(f["label"])) for f in _reg_forms_index()}


def _sec_proc_refs(p: dict):
    """절차가 참조하는 (종류, ref) 목록 — 근거·서식."""
    out = []
    for s in p.get("steps") or []:
        out += [("basis", b) for b in s.get("basis") or []]
        if s.get("form"):
            out.append(("form", s["form"]))
    out += [("form", f) for f in p.get("forms") or []]
    for pf in p.get("pitfalls") or []:
        out += [("basis", b) for b in (pf.get("basis") or [])]
    return out


def _sec_proc_status(p: dict, forms=None) -> dict:
    """호환성 점검 — 연결 안 된 근거·서식(missing), 근사 연결(approx), 근거 규정 개정(stale)."""
    forms = forms if forms is not None else _sec_forms_set()
    missing, approx, seen = [], [], set()
    resolved = {}
    for kind, r in _sec_proc_refs(p):
        reg = r.get("reg", "")
        if reg not in resolved:
            resolved[reg] = _sec_resolve_reg(reg)
        m, via = resolved[reg]
        key = (kind, reg, r.get("art", ""), r.get("label", ""))
        if key in seen:
            continue
        seen.add(key)
        if not m:
            missing.append({"kind": kind, "reg": reg, "why": "규정 없음", **{k: r[k] for k in ("art", "label") if r.get(k)}})
            continue
        if via == "approx" and not any(a["reg"] == reg for a in approx):
            approx.append({"reg": reg, "matched": m.get("title", "")})
        if kind == "basis" and r.get("art") and not _sec_art(m["title"], r["art"]):
            missing.append({"kind": kind, "reg": reg, "art": r["art"], "why": "조문 없음"})
        if kind == "form" and (_norm_key(m["title"]), _norm_key(r.get("label", ""))) not in forms:
            missing.append({"kind": kind, "reg": reg, "label": r.get("label", ""), "why": "서식 없음"})
    # verified: {절차의 규정명: 개정} 또는 {절차의 규정명: {"title": 확인한 규정, "revision": 개정}}
    #   같은 규정인데 개정이 다르면 stale(재확인 필요), 다른 규정(다른 기관·매핑)이면 unverified(우리 규정으로 확인 전)
    stale, unverified = [], []
    for reg, v in (p.get("verified") or {}).items():
        m, via = resolved.get(reg) or _sec_resolve_reg(reg)
        if not m or via == "approx":
            continue
        vt, vr = (v.get("title") or reg, v.get("revision", "")) if isinstance(v, dict) else (reg, v)
        cur = m.get("revision", "")
        if _norm_key(vt) != _norm_key(m.get("title", "")):
            unverified.append({"reg": reg, "verified_title": vt, "matched": m.get("title", "")})
        elif vr and cur and _norm_key(cur) != _norm_key(vr):
            stale.append({"reg": reg, "verified": vr, "current": cur})
    return {"ok": not missing and not stale, "missing": missing, "approx": approx,
            "stale": stale, "unverified": unverified}


def _sec_stamp(p: dict) -> dict:
    """절차가 근거로 삼은 규정의 현재 개정 정보를 기록(이후 개정되면 '재확인 필요'로 감지)."""
    ver = {}
    for _, r in _sec_proc_refs(p):
        m, _v = _sec_resolve_reg(r.get("reg", ""))
        if m and m.get("revision"):
            same = _norm_key(m.get("title", "")) == _norm_key(r["reg"])
            ver[r["reg"]] = m["revision"] if same else {"title": m["title"], "revision": m["revision"]}
    if ver:
        p["verified"] = dict(sorted(ver.items()))
    return p


def _sec_holidays(cfg: dict) -> dict:
    base = (_sec_read_json(SEC_HOLIDAYS_PATH, {}) or {}).get("dates") or {}
    h = dict(base)
    hc = cfg.get("holidays") or {}
    for d in hc.get("extra") or []:
        if isinstance(d, dict) and re.match(r"^\d{4}-\d{2}-\d{2}$", str(d.get("date", ""))):
            h[d["date"]] = _sec_clean_str(d.get("name"), 30) or "기관 휴일"
    for d in hc.get("exclude") or []:
        h.pop(str(d), None)
    return h


def _sec_public_config(cfg: dict) -> dict:
    return {"org": cfg.get("org", {}), "service": cfg.get("service", {}), "terms": cfg.get("terms", {}),
            "reg_aliases": cfg.get("reg_aliases", {}), "holidays": cfg.get("holidays", {}),
            "audit": cfg.get("audit") or {}, "insights": cfg.get("insights") or {}, "erp": cfg.get("erp") or {},
            "updated": cfg.get("updated", "")}


@app.route("/api/secretary/config")
def secretary_config():
    """기관 설정(브랜드·명칭·매핑·휴일). 업로드 화면 등 다른 페이지도 이 값을 쓴다."""
    cfg = _sec_config(force=request.args.get("fresh") == "1")
    return jsonify({"success": True, "config": _sec_public_config(cfg), "holidays": _sec_holidays(cfg)})


@app.route("/api/secretary/procedures")
def secretary_procedures():
    """서무비서 절차 — 공통 층 + 기관 층(+각 절차의 호환성 상태). 개인 층은 브라우저가 합친다."""
    fresh = request.args.get("fresh") == "1"
    common = _sec_read_json(SEC_COMMON_PATH, {"procedures": [], "drafts": {}})
    org = _sec_org_load(force=fresh)
    cfg = _sec_config(force=fresh)
    forms = _sec_forms_set()
    status = {}
    for layer, procs in (("common", common.get("procedures", [])), ("org", org.get("procedures", []))):
        for p in procs:
            if not p.get("hidden"):
                status[f"{layer}:{p['id']}"] = _sec_proc_status(p, forms)
    return jsonify({
        "success": True,
        "common": {"procedures": common.get("procedures", []), "drafts": common.get("drafts", {}),
                   "updated": common.get("updated", "")},
        "org": {"procedures": org.get("procedures", []), "drafts": org.get("drafts", {}),
                "updated": org.get("updated", ""), "updated_by": org.get("updated_by", "")},
        "status": status,
        "config": _sec_public_config(cfg),
        "holidays": _sec_holidays(cfg),
        "regs": len(_load_reg_manifest()),
        # 화면으로 개정본이 올라와 이전본과 비교할 수 있는 규정(개정 영향 분석 대상)
        "revised": [{"title": m.get("title", ""), "revision": m.get("revision", ""),
                     "from": (m.get("history") or [{}])[0].get("revision", ""),
                     "at": (m.get("history") or [{}])[0].get("replaced_at", "")}
                    for m in _load_reg_manifest() if m.get("history")][:60],
        # ALIO 공시본 대비 최신성(scripts/alio_sync.mjs 가 만든 상태 파일 — 없으면 null)
        "alio": _sec_alio_status(),
        "ai": _sec_ai_status(),
        "insights": {"available": bool(_sec_ins_backend()), "min_n": max(1, int(_sec_ins_cfg().get("min_n") or 3))},
        "admin": {"token_required": bool(REG_UPLOAD_TOKEN) or _gh_enabled(),
                  "github": _gh_enabled()},
    })


@app.route("/api/secretary/check", methods=["POST"])
def secretary_check():
    """절차 목록(개인 절차·가져올 절차 팩)의 호환성 점검 — 저장하지 않는다."""
    body = request.get_json(silent=True) or {}
    procs = body.get("procedures")
    if not isinstance(procs, list) or len(procs) > 150:
        return jsonify({"success": False, "error": "procedures 목록(최대 150건)이 필요합니다."}), 400
    forms = _sec_forms_set()
    out = {}
    for p in procs:
        c = _sec_clean_proc(p)
        if c and not c.get("hidden"):
            if isinstance(p.get("verified"), dict):
                c["verified"] = {str(k)[:80]: ({"title": _sec_clean_str(v.get("title"), 80), "revision": _sec_clean_str(v.get("revision"), 60)}
                                               if isinstance(v, dict) else _sec_clean_str(v, 60))
                                 for k, v in list(p["verified"].items())[:40]}
            out[c["id"]] = _sec_proc_status(c, forms)
    return jsonify({"success": True, "status": out})


@app.route("/api/secretary/regs")
def secretary_regs():
    """규정명 매핑용 — 우리 기관 규정 목록과, 절차들이 참조하는 규정명이 어디에 연결되는지."""
    common = _sec_read_json(SEC_COMMON_PATH, {"procedures": []})
    org = _sec_org_load()
    names = set()
    for p in common.get("procedures", []) + org.get("procedures", []):
        names |= {r.get("reg", "") for _, r in _sec_proc_refs(p)}
    refs = []
    for n in sorted(x for x in names if x):
        m, via = _sec_resolve_reg(n)
        refs.append({"name": n, "matched": (m or {}).get("title", ""), "via": via})
    regs = [{"title": m.get("title", ""), "category": m.get("category", ""), "revision": m.get("revision", "")}
            for m in _load_reg_manifest()]
    return jsonify({"success": True, "refs": refs, "regs": regs})


@app.route("/api/secretary/basis")
def secretary_basis():
    """근거 조문 본문. reg+art 이면 해당 조문, reg+q 이면 규정 안에서 q 가 들어간 단락."""
    reg = (request.args.get("reg") or "").strip()
    art = (request.args.get("art") or "").strip().replace("제", "").replace("조", "")
    q = (request.args.get("q") or "").strip()
    if not reg or not (art or q):
        return jsonify({"error": "reg 와 art 또는 q 가 필요합니다."}), 400
    meta, via = _sec_resolve_reg(reg)
    if not meta:
        return jsonify({"success": False, "error": f"「{reg}」 규정이 등록되어 있지 않습니다. "
                                                   "관리자에게 규정 업로드나 규정명 매핑을 요청하세요."})
    title = meta.get("title") or reg
    extra = {"revision": meta.get("revision", ""), "via": via,
             **({"requested": reg} if _norm_key(reg) != _norm_key(title) else {})}
    if art:
        hit = _sec_art(title, art)
        if hit:
            t, no, at, text = hit
            return jsonify({"success": True, "reg": t, "art": no, "art_title": at, "text": text, **extra})
        return jsonify({"success": False, "error": f"「{title}」 제{art}조를 찾지 못했습니다.", **extra})
    text = _sec_reg_text(title)
    if not text:
        return jsonify({"success": False, "error": f"「{title}」 원문을 찾지 못했습니다."})
    lines = [re.sub(r"[ \t]+", " ", ln).strip() for ln in text.split("\n")]
    lines = [ln for ln in lines if ln]
    ql = _norm_key(q)
    picks, used = [], set()
    for i, ln in enumerate(lines):
        if ql in _norm_key(ln) and i not in used:
            seg = [j for j in range(i, min(i + 4, len(lines))) if j not in used]
            used.update(seg)
            picks.append("\n".join(lines[j] for j in seg))
        if len(picks) >= 3:
            break
    if not picks:
        return jsonify({"success": False, "error": f"「{title}」에서 '{q}'를 찾지 못했습니다.", **extra})
    snippet = "\n…\n".join(picks)[:1800]
    return jsonify({"success": True, "reg": title, "q": q, "text": snippet, **extra})


@app.route("/api/secretary/related")
def secretary_related():
    """등록된 절차가 없을 때 — 상황 문장과 관련 있는 내규 조문(키워드 + 가능하면 의미 검색)."""
    q = (request.args.get("q") or "").strip()
    if len(q) < 2:
        return jsonify({"success": True, "items": []})
    words = [w for w in re.split(r"[\s,.!?~·]+", q) if len(w) >= 2]
    # 조사·어미를 대충 떼어 낸 어간도 함께 본다("정산해야" → "정산")
    stems = set()
    for w in words:
        stems.add(w)
        s = re.sub(r"(해야|하려면|하고|해서|했는데|하는|할|해요|합니다|에서|으로|에게|까지|부터|이랑|를|을|이|가|은|는|에|로|와|과|도|만)$", "", w)
        if len(s) >= 2:
            stems.add(s)
    scored = []
    for t, no, at, text in _sec_chunks():
        head = (t + " " + (at or ""))
        sc = 0
        for s in stems:
            if s in head:
                sc += 3
            c = text.count(s)
            if c:
                sc += min(c, 4)
        if sc:
            scored.append((sc, t, no, at, text))
    scored.sort(key=lambda x: -x[0])
    items, seen = [], set()
    for sc, t, no, at, text in scored[:40]:
        k = (t, no)
        if k in seen:
            continue
        seen.add(k)
        items.append({"reg": t, "art": no, "art_title": at, "preview": text[:220], "score": sc, "src": "keyword"})
        if len(items) >= 8:
            break
    for h in _semantic_for_search(q, top_k=6):
        k = (h["title"], h["no"])
        if k in seen:
            continue
        seen.add(k)
        items.append({"reg": h["title"], "art": h["no"], "art_title": h["art_title"],
                      "preview": h["preview"][:220], "score": h["score"], "src": "semantic"})
    return jsonify({"success": True, "items": items[:12]})


def _sec_save_repo_file(repo_path: str, local_path: str, payload: str, message: str) -> str:
    """기관 층·설정 저장 — GitHub 연동 시 커밋, 아니면 로컬 파일. 안내 문구를 돌려준다."""
    if _gh_enabled():
        sha = _gh_commit_files({repo_path: payload}, message)
        return f"저장소에 커밋했습니다({sha[:7]}). 배포가 끝나면 모든 사용자에게 반영됩니다."
    os.makedirs(os.path.dirname(local_path), exist_ok=True)
    tmp = local_path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        f.write(payload)
    os.replace(tmp, local_path)
    return "서버에 저장했습니다."


_SEC_READONLY_MSG = ("이 서버는 파일을 쓸 수 없습니다(읽기 전용 배포). "
                     "GITHUB_TOKEN·GITHUB_REPO 를 설정하면 저장소에 커밋됩니다.")


@app.route("/api/secretary/org", methods=["POST"])
def secretary_org_save():
    """기관 층 저장(관리자). 내규 업로드와 같은 토큰을 쓰고, GitHub 연동 시 저장소에 커밋한다."""
    ok, why = _upload_authorized()
    if not ok:
        return jsonify({"success": False, "error": why}), 401
    body = request.get_json(silent=True) or {}
    raw = body.get("procedures")
    if not isinstance(raw, list) or len(raw) > 200:
        return jsonify({"success": False, "error": "procedures 목록(최대 200건)이 필요합니다."}), 400
    procs = [_sec_clean_proc(x) for x in raw]
    if any(p is None for p in procs):
        # 잘못된 항목을 조용히 버리고 저장하면 기존 기관 절차가 유실될 수 있으므로 거부한다
        return jsonify({"success": False, "error": "id(영문 소문자·숫자·하이픈)나 제목이 올바르지 않은 절차가 있습니다."}), 400
    ids = [p["id"] for p in procs]
    if len(ids) != len(set(ids)):
        return jsonify({"success": False, "error": "같은 id 의 절차가 두 번 들어 있습니다."}), 400
    procs = [p if p.get("hidden") else _sec_stamp(p) for p in procs]   # 저장 시점의 근거 개정 기록
    drafts = {}
    for k, d in (body.get("drafts") or {}).items():
        k = _sec_clean_str(k, 48).lower()
        if not _SEC_ID_RE.match(k) or not isinstance(d, dict) or not d.get("template"):
            continue
        drafts[k] = {"title": _sec_clean_str(d.get("title"), 60) or k,
                     "template": _sec_clean_str(d.get("template"), 4000),
                     "fields": [{"k": _sec_clean_str(f.get("k"), 24), "l": _sec_clean_str(f.get("l"), 40),
                                 "ph": _sec_clean_str(f.get("ph"), 80), **({"multi": True} if f.get("multi") else {})}
                                for f in (d.get("fields") or [])[:20] if isinstance(f, dict) and f.get("k")]}
    data = {"version": 1, "layer": "org", "updated": _now_kst(),
            "updated_by": _sec_clean_str(body.get("editor"), 40),
            "procedures": procs, "drafts": drafts}
    payload = json.dumps(data, ensure_ascii=False, indent=1) + "\n"
    try:
        where = _sec_save_repo_file(SEC_ORG_REPO_PATH, SEC_ORG_PATH, payload,
                                    f"서무비서 기관 절차 갱신: {len(procs)}건")
    except OSError:
        return jsonify({"success": False, "error": _SEC_READONLY_MSG}), 500
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 502
    _SEC_ORG_CACHE.update({"ts": time.time(), "data": data})
    return jsonify({"success": True, "count": len(procs), "message": where, "org": data})


_SEC_HEX = re.compile(r"^#[0-9a-fA-F]{6}$")


@app.route("/api/secretary/config", methods=["POST"])
def secretary_config_save():
    """기관 설정 저장(관리자) — 기관명·서비스 이름·색·명칭·규정명 매핑·기관 휴일."""
    ok, why = _upload_authorized()
    if not ok:
        return jsonify({"success": False, "error": why}), 401
    body = (request.get_json(silent=True) or {}).get("config") or {}
    if not isinstance(body, dict):
        return jsonify({"success": False, "error": "config 객체가 필요합니다."}), 400
    org = body.get("org") or {}
    svc = body.get("service") or {}
    if not _sec_clean_str(org.get("name"), 60):
        return jsonify({"success": False, "error": "기관명을 입력하세요."}), 400
    primary = _sec_clean_str(svc.get("primary"), 7)
    cfg = {
        "schema_version": 1,
        "org": {k: _sec_clean_str(org.get(k), 60) for k in ("name", "short", "abbr")},
        "service": {"title": _sec_clean_str(svc.get("title"), 30) or "서무비서",
                    "icon": _sec_clean_str(svc.get("icon"), 4) or "🗂",
                    "primary": primary if _SEC_HEX.match(primary) else "#256ef4",
                    "tagline": _sec_clean_str(svc.get("tagline"), 120),
                    "footer": _sec_clean_str(svc.get("footer"), 300)},
        "terms": {k: _sec_clean_str((body.get("terms") or {}).get(k), 30) or _SEC_CFG_DEFAULT["terms"][k]
                  for k in _SEC_TERM_KEYS},
        "reg_aliases": {_sec_clean_str(k, 80): _sec_clean_str(v, 80)
                        for k, v in list((body.get("reg_aliases") or {}).items())[:300]
                        if _sec_clean_str(k, 80) and _sec_clean_str(v, 80)},
        "holidays": {
            "extra": [{"date": d["date"], "name": _sec_clean_str(d.get("name"), 30) or "기관 휴일"}
                      for d in ((body.get("holidays") or {}).get("extra") or [])[:100]
                      if isinstance(d, dict) and re.match(r"^\d{4}-\d{2}-\d{2}$", str(d.get("date", "")))],
            "exclude": [str(d) for d in ((body.get("holidays") or {}).get("exclude") or [])[:100]
                        if re.match(r"^\d{4}-\d{2}-\d{2}$", str(d))],
        },
        "updated": _now_kst(),
        "updated_by": _sec_clean_str((request.get_json(silent=True) or {}).get("editor"), 40),
    }
    # ERP·그룹웨어 주소(브라우저 확장이 붙을 곳) — 'https://호스트/*' 꼴로 정리
    import extension_build
    erp_in = body.get("erp") if isinstance(body.get("erp"), dict) else {}
    hosts = [h for h in (extension_build.origin_pattern(str(x)) for x in (erp_in.get("hosts") or [])[:20]) if h]
    cfg["erp"] = {"hosts": list(dict.fromkeys(hosts)), "name": _sec_clean_str(erp_in.get("name"), 40)}
    # 화면에서 고치지 않는 고급 설정(감사 기준·집단 지식)은 받은 값, 없으면 기존 값을 그대로 둔다
    cur = _sec_config(force=True)
    for k in ("audit", "insights"):
        v = body.get(k) if isinstance(body.get(k), dict) else cur.get(k)
        if isinstance(v, dict) and v and len(json.dumps(v, ensure_ascii=False)) < 20000:
            cfg[k] = v
    payload = json.dumps(cfg, ensure_ascii=False, indent=1) + "\n"
    try:
        where = _sec_save_repo_file(SEC_CONFIG_REPO_PATH, SEC_CONFIG_PATH, payload,
                                    f"서무비서 기관 설정 갱신: {cfg['org']['name']}")
    except OSError:
        return jsonify({"success": False, "error": _SEC_READONLY_MSG}), 500
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 502
    _SEC_CFG_CACHE.update({"ts": time.time(), "data": cfg})
    return jsonify({"success": True, "message": where, "config": _sec_public_config(_sec_config())})


# ══════════════════════════════════════════════════════════════════════════
# 서무비서 AI — 영수증 인식 · 상황 이해 (기관이 키를 설정한 경우에만)
#   ANTHROPIC_API_KEY 가 있으면 Claude, 없고 GEMINI_API_KEY 가 있으면 Gemini 를 쓴다
#   (SECRETARY_AI_PROVIDER=claude|gemini 로 고정 가능). 키가 없으면 화면은 수동 입력으로 동작한다.
#   기관 키가 없어도 사용자가 화면 설정에 '내 AI 키'를 넣으면, 그 요청에 한해 헤더(X-AI-Key·X-AI-Provider)로 받아 쓴다.
#   사용자 키는 서버에 저장·기록하지 않고, 그 요청의 AI 호출에만 쓴다.
#   AI 는 절차를 '고르기'와 영수증 '읽기'에만 쓰고, 규정 내용을 만들어 내게 하지 않는다.
# ══════════════════════════════════════════════════════════════════════════
SEC_AI_MAX_IMAGE = 5 * 1024 * 1024          # 영수증 이미지 최대 크기(바이트, 디코딩 후)
_SEC_AI_IMAGE_TYPES = {"image/jpeg", "image/png", "image/webp", "image/gif"}
_SEC_AI_HITS: dict = {}                      # IP → [시각] — 기관 키 남용을 막는 간단한 속도 제한
_SEC_AI_LIMIT = int(os.environ.get("SECRETARY_AI_RATE", "40") or 40)   # IP 당 10분에 허용할 요청 수


def _sec_ai_user() -> tuple:
    """이 요청에 사용자가 보낸 AI 키 → (provider, key). 없으면 ("", "")."""
    try:
        from flask import has_request_context
        if not has_request_context():
            return "", ""
        key = (request.headers.get("X-AI-Key") or "").strip()
        prov = (request.headers.get("X-AI-Provider") or "").strip().lower()
    except Exception:
        return "", ""
    if not key or len(key) > 300 or not re.match(r"^[\x21-\x7e]+$", key):
        return "", ""
    if prov not in ("claude", "gemini"):
        prov = "claude" if key.startswith("sk-ant-") else "gemini"
    return prov, key


def _sec_ai_provider() -> str:
    up, _uk = _sec_ai_user()
    if up:
        return up
    p = (os.environ.get("SECRETARY_AI_PROVIDER") or "").strip().lower()
    if p in ("claude", "gemini"):
        return p if _sec_ai_key(p) else ""
    if _sec_ai_key("claude"):
        return "claude"
    if _sec_ai_key("gemini"):
        return "gemini"
    return ""


def _sec_ai_key(provider: str) -> str:
    up, uk = _sec_ai_user()
    if up == provider and uk:
        return uk
    return _env_clean("ANTHROPIC_API_KEY" if provider == "claude" else "GEMINI_API_KEY")


def _sec_ai_model(provider: str) -> str:
    m = _env_clean("SECRETARY_AI_MODEL")
    if m:
        return m
    return "claude-opus-5-5" if provider == "claude" else (_env_clean("GEMINI_MODEL") or "gemini-2.5-flash")


def _sec_ai_status() -> dict:
    p = _sec_ai_provider()
    return {"available": bool(p), "provider": p, "model": _sec_ai_model(p) if p else "",
            "user_key": bool(_sec_ai_user()[0])}


def _sec_ai_rate_ok() -> bool:
    ip = _client_ip()
    now = time.time()
    hits = [t for t in _SEC_AI_HITS.get(ip, []) if now - t < 600]
    if len(hits) >= _SEC_AI_LIMIT:
        _SEC_AI_HITS[ip] = hits
        return False
    hits.append(now)
    _SEC_AI_HITS[ip] = hits
    if len(_SEC_AI_HITS) > 5000:             # 메모리 보호
        _SEC_AI_HITS.clear()
    return True


class _SecAIError(Exception):
    pass


def _sec_ai_json(system: str, text: str, schema: dict, image=None, effort: str = "low") -> dict:
    """AI 에 구조화된 JSON 응답을 요청한다. image=(media_type, base64 문자열)."""
    provider = _sec_ai_provider()
    if not provider:
        raise _SecAIError("AI 키가 설정되어 있지 않습니다.")
    model = _sec_ai_model(provider)
    who = "내 AI 키" if _sec_ai_user()[0] else ("서버 AI 키(ANTHROPIC_API_KEY)" if provider == "claude" else "서버 AI 키(GEMINI_API_KEY)")
    if provider == "claude":
        try:
            import anthropic
        except ImportError:
            raise _SecAIError("서버에 anthropic 패키지가 설치되어 있지 않습니다.")
        content = []
        if image:
            content.append({"type": "image", "source": {"type": "base64", "media_type": image[0], "data": image[1]}})
        content.append({"type": "text", "text": text})
        client = anthropic.Anthropic(api_key=_sec_ai_key("claude"), timeout=60.0, max_retries=1)
        try:
            resp = client.beta.messages.create(
                model=model,
                max_tokens=16000,
                system=system,
                messages=[{"role": "user", "content": content}],
                # 추출·분류는 low, 감사·영향 분석처럼 대조가 필요한 작업은 호출 쪽에서 올린다. 응답은 스키마로 고정.
                output_config={"effort": effort, "format": {"type": "json_schema", "schema": schema}},
                # 안전 분류기가 거절하면 서버가 권장 모델로 다시 실행한다
                betas=["server-side-fallback-2026-07-01"],
                fallbacks="default",
            )
        except anthropic.AuthenticationError:
            raise _SecAIError(f"{who}가 올바르지 않습니다. 키를 다시 확인하세요.")
        except anthropic.RateLimitError:
            raise _SecAIError("AI 사용량 한도에 걸렸습니다. 잠시 후 다시 시도하세요.")
        except anthropic.BadRequestError as e:
            raise _SecAIError(f"AI 요청 오류: {e.message}")
        except anthropic.APIStatusError as e:
            raise _SecAIError(f"AI 서버 오류({e.status_code}). 잠시 후 다시 시도하세요.")
        except anthropic.APIConnectionError:
            raise _SecAIError("AI 서버에 연결하지 못했습니다.")
        if resp.stop_reason == "refusal":
            raise _SecAIError("AI 가 이 요청을 처리하지 않았습니다.")
        if resp.stop_reason == "max_tokens":
            raise _SecAIError("AI 응답이 너무 길어 끊겼습니다.")
        out = next((b.text for b in resp.content if b.type == "text"), "")
    else:
        parts = []
        if image:
            parts.append({"inline_data": {"mime_type": image[0], "data": image[1]}})
        parts.append({"text": text + "\n\n다음 JSON 스키마를 따르는 JSON 하나만 출력:\n"
                      + json.dumps(schema, ensure_ascii=False)})
        url = f"https://generativelanguage.googleapis.com/v1beta/models/{quote(model)}:generateContent"
        try:
            # 키는 헤더로(주소에 넣으면 로그에 남는다). 재시도 세션 대신 한 번만 — 사용자 키 사용량을 불리지 않는다
            r = req_lib.post(url, headers={"x-goog-api-key": _sec_ai_key("gemini")}, timeout=60, json={
                "systemInstruction": {"parts": [{"text": system}]},
                "contents": [{"role": "user", "parts": parts}],
                "generationConfig": {"responseMimeType": "application/json", "temperature": 0}})
        except req_lib.RequestException:
            raise _SecAIError("AI 서버에 연결하지 못했습니다.")
        if r.status_code in (400, 401, 403) and "API_KEY" in (r.text or "")[:2000]:
            raise _SecAIError(f"{who}가 올바르지 않습니다. 키를 다시 확인하세요.")
        if r.status_code == 429:
            raise _SecAIError("AI 사용량 한도에 걸렸습니다. 잠시 후 다시 시도하세요.")
        if r.status_code >= 400:
            raise _SecAIError(f"AI 서버 오류({r.status_code}).")
        try:
            out = r.json()["candidates"][0]["content"]["parts"][0]["text"]
        except Exception:
            raise _SecAIError("AI 응답을 읽지 못했습니다.")
    try:
        data = json.loads(out)
    except Exception:
        m = re.search(r"\{.*\}", out or "", re.S)
        if not m:
            raise _SecAIError("AI 응답 형식이 올바르지 않습니다.")
        try:
            data = json.loads(m.group(0))
        except ValueError:
            raise _SecAIError("AI 응답 형식이 올바르지 않습니다.")
    if not isinstance(data, dict):
        raise _SecAIError("AI 응답 형식이 올바르지 않습니다.")
    return data


_SEC_RECEIPT_KINDS = ["운임", "숙박", "식비", "회의비", "물품", "기타"]
_SEC_RECEIPT_SCHEMA = {
    "type": "object",
    "properties": {
        "date": {"type": "string", "description": "거래(이용) 날짜 YYYY-MM-DD. 모르면 빈 문자열"},
        "end_date": {"type": "string", "description": "숙박 체크아웃·이용 종료일 YYYY-MM-DD. 없으면 빈 문자열"},
        "amount": {"type": "integer", "description": "총 결제 금액(부가세 포함, 원). 모르면 0"},
        "vendor": {"type": "string", "description": "가맹점·상호(예: 코레일, ○○호텔)"},
        "kind": {"type": "string", "enum": _SEC_RECEIPT_KINDS},
        "payment": {"type": "string", "enum": ["법인카드", "개인카드", "현금", "기타", "알수없음"]},
        "nights": {"type": "integer", "description": "숙박이면 박 수, 아니면 0"},
        "route": {"type": "string", "description": "운임이면 구간(예: 서울→오송), 아니면 빈 문자열"},
        "items": {"type": "string", "description": "주요 품목·내역을 짧게"},
        "confidence": {"type": "string", "enum": ["high", "medium", "low"]},
        "note": {"type": "string", "description": "흐림·잘림 등 확인이 필요한 점. 없으면 빈 문자열"},
    },
    "required": ["date", "end_date", "amount", "vendor", "kind", "payment", "nights", "route", "items",
                 "confidence", "note"],
    "additionalProperties": False,
}
_SEC_RECEIPT_SYSTEM = (
    "당신은 한국 공공기관의 경비 정산을 돕는 서무 비서입니다. 영수증·승차권·숙박 영수증·카드 매출전표 이미지에서 "
    "정산에 필요한 항목만 정확히 읽습니다. 이미지에 실제로 보이는 값만 쓰고, 보이지 않거나 흐린 값은 추측하지 말고 "
    "빈 문자열이나 0으로 두세요. 카드번호·전화번호·주민등록번호 같은 개인정보는 어떤 칸에도 옮겨 적지 마세요. "
    "금액은 총 결제액(부가세 포함)을 원 단위 정수로 씁니다. kind 는 철도·버스·항공·택시·통행료·주차는 '운임', "
    "숙박업소는 '숙박', 음식점은 '식비', 다과·회의 장소는 '회의비', 물품 구입은 '물품', 그 밖은 '기타'로 고릅니다."
)


@app.route("/api/secretary/ai/status")
def secretary_ai_status():
    return jsonify({"success": True, **_sec_ai_status()})


@app.route("/api/secretary/ai/receipt", methods=["POST"])
def secretary_ai_receipt():
    """영수증 이미지 → 날짜·금액·가맹점·종류. 이미지는 저장하지 않고 AI 분석에만 쓴다."""
    if not _sec_ai_provider():
        return jsonify({"success": False, "need_key": True,
                        "error": "AI 영수증 인식이 설정되어 있지 않습니다. 날짜·금액을 직접 입력하세요."}), 503
    if not _sec_ai_rate_ok():
        return jsonify({"success": False, "error": "요청이 너무 많습니다. 잠시 후 다시 시도하세요."}), 429
    body = request.get_json(silent=True) or {}
    m = re.match(r"^data:(image/[a-z+.-]+);base64,(.+)$", str(body.get("image") or ""), re.S)
    if not m or m.group(1) not in _SEC_AI_IMAGE_TYPES:
        return jsonify({"success": False, "error": "JPG·PNG·WEBP 이미지만 올릴 수 있습니다."}), 400
    b64 = re.sub(r"\s+", "", m.group(2))
    try:
        size = len(base64.b64decode(b64, validate=True))
    except Exception:
        return jsonify({"success": False, "error": "이미지를 읽지 못했습니다."}), 400
    if size > SEC_AI_MAX_IMAGE:
        return jsonify({"success": False, "error": "이미지가 너무 큽니다(최대 5MB)."}), 413
    ctx = _sec_clean_str(body.get("context"), 120)
    year = _sec_clean_str(body.get("year"), 4)
    prompt = ("이 증빙 이미지를 읽어 주세요."
              + (f" 처리 중인 업무: {ctx}." if ctx else "")
              + (f" 연도가 인쇄되지 않았으면 {year}년으로 봅니다." if re.match(r"^\d{4}$", year or "") else ""))
    try:
        data = _sec_ai_json(_SEC_RECEIPT_SYSTEM, prompt, _SEC_RECEIPT_SCHEMA, image=(m.group(1), b64))
    except _SecAIError as e:
        return jsonify({"success": False, "error": str(e)}), 502
    # 응답 정리: 날짜 형식·금액 범위·열거값을 다시 확인한다(AI 출력은 데이터로만 다룬다)
    def _d(v):
        v = str(v or "").strip()
        return v if re.match(r"^\d{4}-\d{2}-\d{2}$", v) else ""
    def _i(v, hi):
        try:
            return max(0, min(hi, int(v)))
        except (TypeError, ValueError):
            return 0
    rc = {
        "date": _d(data.get("date")), "end_date": _d(data.get("end_date")),
        "amount": _i(data.get("amount"), 100_000_000), "nights": _i(data.get("nights"), 60),
        "vendor": _sec_clean_str(data.get("vendor"), 60), "route": _sec_clean_str(data.get("route"), 60),
        "items": _sec_clean_str(data.get("items"), 120), "note": _sec_clean_str(data.get("note"), 160),
        "kind": data.get("kind") if data.get("kind") in _SEC_RECEIPT_KINDS else "기타",
        "payment": data.get("payment") if data.get("payment") in ("법인카드", "개인카드", "현금", "기타") else "알수없음",
        "confidence": data.get("confidence") if data.get("confidence") in ("high", "medium", "low") else "low",
    }
    return jsonify({"success": True, "receipt": rc, "provider": _sec_ai_provider()})


_SEC_UNDERSTAND_SYSTEM = (
    "당신은 한국 공공기관 서무 담당자를 돕는 비서입니다. 사용자가 말한 업무 상황을 읽고, 주어진 '절차 목록'에서 "
    "이 상황에 필요한 절차를 고릅니다. 여러 업무가 섞여 있으면 실제로 처리할 순서대로 모두 고르세요(최대 4개). "
    "목록에 없는 절차를 지어내거나 규정·기한을 추측해 쓰지 마세요. 맞는 절차가 없으면 빈 목록을 돌려주세요. "
    "summary 에는 상황을 어떻게 이해했는지 한두 문장으로, uncovered 에는 목록으로 처리되지 않는 부분을 적습니다. "
    "reasons 에는 고른 절차마다 왜 필요한지 상황의 말을 근거로 한 문장. facts 에는 상황에서 읽은 사실(날짜·기간·장소·금액·"
    "사람 수 등, 사용자가 실제로 말한 것만). questions 에는 절차를 진행하려면 사용자에게 더 확인해야 할 것(최대 4개). "
    "cautions 에는 고른 절차의 '반려 점검 항목'(pitfalls, 0부터 번호) 가운데 이 상황에서 특히 조심할 것을 번호로 고릅니다(최대 4개). "
    "점검 항목의 문장을 새로 지어내지 말고 번호로만 고르세요."
)


@app.route("/api/secretary/ai/understand", methods=["POST"])
def secretary_ai_understand():
    """상황 문장 → 해당 절차(복수 가능). 절차 목록 안에서만 고르게 해 근거 없는 안내를 막는다."""
    if not _sec_ai_provider():
        return jsonify({"success": False, "need_key": True, "error": "AI 상황 이해가 설정되어 있지 않습니다."}), 503
    if not _sec_ai_rate_ok():
        return jsonify({"success": False, "error": "요청이 너무 많습니다. 잠시 후 다시 시도하세요."}), 429
    body = request.get_json(silent=True) or {}
    q = _sec_clean_str(body.get("q"), 400)
    if len(q) < 2:
        return jsonify({"success": False, "error": "상황을 입력하세요."}), 400
    procs = []
    for p in (body.get("procedures") or [])[:80]:
        if not isinstance(p, dict):
            continue
        pid = _sec_clean_str(p.get("id"), 48).lower()
        if _SEC_ID_RE.match(pid):
            procs.append({"id": pid, "title": _sec_clean_str(p.get("title"), 80),
                          "summary": _sec_clean_str(p.get("summary"), 200),
                          "keywords": [_sec_clean_str(t, 20) for t in (p.get("triggers") or [])[:15]],
                          "steps": [_sec_clean_str(t, 90) for t in (p.get("steps") or [])[:12] if isinstance(t, str)],
                          "pitfalls": [_sec_clean_str(t, 120) for t in (p.get("pitfalls") or [])[:10] if isinstance(t, str)]})
    if not procs:
        return jsonify({"success": False, "error": "절차 목록이 비어 있습니다."}), 400
    ids = [p["id"] for p in procs]
    schema = {
        "type": "object",
        "properties": {
            "procedure_ids": {"type": "array", "items": {"type": "string", "enum": ids}},
            "summary": {"type": "string"},
            "uncovered": {"type": "string"},
            "reasons": {"type": "array", "items": {"type": "object", "properties": {
                "id": {"type": "string", "enum": ids}, "why": {"type": "string"}},
                "required": ["id", "why"], "additionalProperties": False}},
            "facts": {"type": "array", "items": {"type": "string"}},
            "questions": {"type": "array", "items": {"type": "string"}},
            "cautions": {"type": "array", "items": {"type": "object", "properties": {
                "id": {"type": "string", "enum": ids}, "idx": {"type": "integer"}},
                "required": ["id", "idx"], "additionalProperties": False}},
        },
        "required": ["procedure_ids", "summary", "uncovered", "reasons", "facts", "questions", "cautions"],
        "additionalProperties": False,
    }
    text = ("절차 목록(JSON):\n" + json.dumps(procs, ensure_ascii=False)
            + "\n\n사용자 상황:\n" + q)
    try:
        data = _sec_ai_json(_SEC_UNDERSTAND_SYSTEM, text, schema)
    except _SecAIError as e:
        return jsonify({"success": False, "error": str(e)}), 502
    seen, pick = set(), []
    for i in data.get("procedure_ids") or []:
        if i in ids and i not in seen:
            seen.add(i); pick.append(i)
    pick = pick[:4]
    npit = {p["id"]: len(p["pitfalls"]) for p in procs}
    reasons = [{"id": r.get("id"), "why": _sec_clean_str(r.get("why"), 200)} for r in (data.get("reasons") or [])
               if isinstance(r, dict) and r.get("id") in pick][:4]
    cautions = []
    for c in data.get("cautions") or []:      # 점검 항목은 번호로만 받아, 화면이 원래 문장을 보여 준다(지어낸 문장 차단)
        if isinstance(c, dict) and c.get("id") in pick and isinstance(c.get("idx"), int) and 0 <= c["idx"] < npit.get(c["id"], 0):
            if {"id": c["id"], "idx": c["idx"]} not in cautions:
                cautions.append({"id": c["id"], "idx": c["idx"]})
    return jsonify({"success": True, "procedure_ids": pick,
                    "summary": _sec_clean_str(data.get("summary"), 300),
                    "uncovered": _sec_clean_str(data.get("uncovered"), 200),
                    "reasons": reasons,
                    "facts": [_sec_clean_str(x, 80) for x in (data.get("facts") or []) if isinstance(x, str)][:8],
                    "questions": [_sec_clean_str(x, 120) for x in (data.get("questions") or []) if isinstance(x, str)][:4],
                    "cautions": cautions[:4],
                    "provider": _sec_ai_provider()})


# ── 문서 초안 → 한글(.hwpx) ────────────────────────────────────────────────
# 기관 서식이 있으면 secretary/template.hwpx(첫 문단의 쪽 설정·글꼴을 그대로 씀), 없으면 내장 최소 서식.
SEC_HWPX_TEMPLATE = os.path.join(SEC_DIR, "template.hwpx")


def _sec_hwpx_base() -> bytes | None:
    if os.path.exists(SEC_HWPX_TEMPLATE):
        with open(SEC_HWPX_TEMPLATE, "rb") as f:
            return f.read()
    try:
        import hwpx_base
        return base64.b64decode(hwpx_base.BASE_HWPX_B64)
    except Exception:
        return None


def _sec_xesc(s) -> str:
    return (str(s or "").replace("&", "&amp;").replace("<", "&lt;")
            .replace(">", "&gt;").replace('"', "&quot;"))


def _sec_hwpx_para(text: str, char_pr: str = "0", size: int = 1000) -> str:
    run = f'<hp:run charPrIDRef="{char_pr}">' + (f"<hp:t>{_sec_xesc(text)}</hp:t>" if text else "") + "</hp:run>"
    return ('<hp:p id="0" paraPrIDRef="0" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0">' + run +
            f'<hp:linesegarray><hp:lineseg textpos="0" vertpos="0" vertsize="{size}" textheight="{size}" '
            f'baseline="{int(size * 0.85)}" spacing="600" horzpos="0" horzsize="47628" flags="393216"/>'
            '</hp:linesegarray></hp:p>')


def _sec_hwpx_build(title: str, text: str) -> bytes:
    base = _sec_hwpx_base()
    if not base:
        raise RuntimeError("HWPX 기본 서식을 찾을 수 없습니다.")
    zin = zipfile.ZipFile(_io.BytesIO(base), "r")
    sec = zin.read("Contents/section0.xml").decode("utf-8", "ignore")
    m = re.search(r"<hs:sec\b[^>]*>", sec)
    if not m:
        raise RuntimeError("HWPX 서식의 본문 구조를 읽지 못했습니다.")
    body = sec[m.end():]
    pi = body.find("<hp:p")
    pj = body.find("</hp:p>", pi) + len("</hp:p>")
    first = re.sub(r"<hp:t>.*?</hp:t>", "<hp:t></hp:t>", body[pi:pj], flags=re.S)   # 쪽 설정(secPr) 문단만 유지
    lines = str(text or "").replace("\r\n", "\n").split("\n")
    if title and lines and lines[0].strip() == title.strip():
        lines = lines[1:]
    paras = ([_sec_hwpx_para(title, "3", 1300), _sec_hwpx_para("")] if title else [])
    paras += [_sec_hwpx_para(ln.rstrip()) for ln in lines]
    new_sec = sec[:m.end()] + first + "".join(paras) + "</hs:sec>"
    out = _io.BytesIO()
    zout = zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED)
    zout.writestr(zipfile.ZipInfo("mimetype"), "application/hwp+zip", compress_type=zipfile.ZIP_STORED)
    for n in zin.namelist():
        if n in ("mimetype", "Preview/PrvImage.png"):
            continue
        if n == "Contents/section0.xml":
            zout.writestr(n, new_sec.encode("utf-8"))
        elif n == "Preview/PrvText.txt":
            zout.writestr(n, (title + "\n" + text)[:1000].encode("utf-8"))
        else:
            zout.writestr(n, zin.read(n))
    zout.close(); zin.close()
    return out.getvalue()


@app.route("/api/secretary/draft/hwpx", methods=["POST"])
def secretary_draft_hwpx():
    """문서 초안(텍스트) → 한글(.hwpx) 파일. 줄마다 한 문단."""
    body = request.get_json(silent=True) or request.form or {}      # 화면은 폼 전송(파일명 유지), JSON 도 받음
    title = _sec_clean_str(body.get("title"), 80)
    text = re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f]", "", str(body.get("text") or ""))[:20000]
    if not text.strip():
        return jsonify({"success": False, "error": "초안 내용이 비어 있습니다."}), 400
    try:
        data = _sec_hwpx_build(title, text)
    except Exception as e:
        return jsonify({"success": False, "error": f"한글 파일을 만들지 못했습니다: {e}"}), 500
    fname = re.sub(r'[\\/:*?"<>|]+', "", title or "초안")[:60] + ".hwpx"
    return Response(data, mimetype="application/hwp+zip",
                    headers={"Content-Disposition": 'attachment; filename="draft.hwpx"; '
                                                    "filename*=UTF-8''" + quote(fname)})


# ══════════════════════════════════════════════════════════════════════════
# ② 결재 전 사전 감사 — 규칙 감사(항상) + AI 감사(키가 있을 때)
#   규칙 감사: 기한 경과·임박, 숙박비 상한, 증빙 누락·기간 밖·결제수단, 초안 필수 기재사항
#   AI 감사: 절차·사실관계·초안을 '제공한 조문'과 대조. 근거는 제공한 조문 목록(enum)에서만 고른다.
# ══════════════════════════════════════════════════════════════════════════
_SEC_AUDIT_DEFAULT = {
    # 「여비업무 처리지침」 국내 숙박비 상한(제2호) — 기관 설정 audit.lodging_caps 로 바꿀 수 있다
    "lodging_caps": [{"name": "서울특별시", "cap": 100000}, {"name": "광역시·제주", "cap": 80000},
                     {"name": "그 밖의 지역", "cap": 70000}],
    "lodging_extra_ratio": 0.3,
    "lodging_basis": [{"reg": "여비업무 처리지침", "q": "상한액: 서울특별시"}, {"reg": "여비규정", "art": "15"}],
    "card_basis": {"reg": "여비규정", "art": "8"},
    "trip_procs": ["domestic-trip", "training"],
    # 초안별로 비면 반려되는 칸(근거 포함)
    "draft_required": {
        "card-evidence": {"fields": ["purpose", "date", "place", "reason", "target"],
                          "basis": {"reg": "법인카드 운영요령", "art": "12"}},
        "trip-report": {"fields": ["purpose", "content"], "basis": {"reg": "복무규정", "art": "8"}},
    },
}


def _sec_audit_cfg() -> dict:
    cfg = dict(_SEC_AUDIT_DEFAULT)
    cfg.update((_sec_config().get("audit") or {}))
    return cfg


def _sec_ref_text(r: dict, limit: int = 1500) -> tuple[str, str]:
    """근거 참조 → (표시 이름, 조문 본문). 우리 기관 규정으로 해석해 찾는다."""
    m, _ = _sec_resolve_reg(r.get("reg", ""))
    if not m:
        return "", ""
    title = m.get("title", "")
    if r.get("art"):
        hit = _sec_art(title, r["art"])
        if hit:
            return f"{title} 제{hit[1]}조", re.sub(r"\s+", " ", hit[3])[:limit]
        return "", ""
    if r.get("q"):
        text = _sec_reg_text(title)
        ql = _norm_key(r["q"])
        for ln in text.split("\n"):
            if ql in _norm_key(ln):
                return f"{title} · {r['q']}", re.sub(r"\s+", " ", ln)[:limit]
    return "", ""


def _sec_won(n) -> str:
    try:
        return f"{int(n):,}"
    except (TypeError, ValueError):
        return "0"


def _sec_audit_rules(p: dict, case: dict, today: str) -> list:
    """결정적 규칙 감사. [{id, severity, title, detail, basis, fix, source:'rule'}]"""
    out = []
    ac = _sec_audit_cfg()
    dates = case.get("dates") or {}
    checks = {str(k) for k, v in (case.get("checks") or {}).items() if v}

    def add(fid, sev, title, detail, basis=None, fix=""):
        if basis and not _sec_resolve_reg(basis.get("reg", ""))[0]:
            basis = None                          # 우리 기관에 없는 규정이면 근거 버튼을 달지 않는다
        out.append({"id": fid, "severity": sev, "title": title, "detail": detail,
                    "basis": basis, "fix": fix, "source": "rule"})

    def addd(base, n):
        try:
            return (datetime.strptime(base, "%Y-%m-%d") + timedelta(days=n)).strftime("%Y-%m-%d")
        except ValueError:
            return ""

    # 1) 단계 기한 — 지났거나 이틀 안
    for i, s in enumerate(p.get("steps") or []):
        dl = s.get("deadline") or {}
        base = dates.get(dl.get("ref", ""))
        if not base or str(i) in checks:
            continue
        due = addd(base, int(dl.get("days") or 0))
        if not due:
            continue
        b = (s.get("basis") or [None])[0]
        if due < today and not s.get("optional"):
            add(f"due-{i}", "high", f"{i + 1}단계 기한이 지났습니다({due})", s["t"], b,
                "지금 처리할 수 있는지 담당 부서에 먼저 확인하고, 늦어진 사유를 남겨 두세요.")
        elif today <= due <= addd(today, 2):
            add(f"soon-{i}", "medium", f"{i + 1}단계 기한이 {due}입니다", s["t"], b, "기한 안에 처리하세요.")

    rs = [r for r in (case.get("receipts") or []) if isinstance(r, dict)]
    trip = p.get("id") in ac["trip_procs"]
    # 2) 숙박비 상한(국내 출장)
    if trip:
        caps = sorted((c for c in ac["lodging_caps"] if isinstance(c, dict) and c.get("cap")),
                      key=lambda c: -int(c["cap"]))
        top = caps[0] if caps else None
        ratio = float(ac.get("lodging_extra_ratio") or 0)
        lb = (ac.get("lodging_basis") or [None])[0]
        for r in rs:
            if r.get("kind") != "숙박" or not r.get("amount"):
                continue
            nights = max(1, int(r.get("nights") or 1))
            per = int(r["amount"]) // nights
            region = next((c for c in caps if c.get("name") == r.get("region")), None)
            name = r.get("vendor") or "숙박 영수증"
            if region:
                cap = int(region["cap"])
                if per > cap * (1 + ratio):
                    add(f"lodge-{r.get('id')}", "high", f"{name}: 1박 {_sec_won(per)}원 — 상한·추가지급 한도 초과",
                        f"{region['name']} 상한 {_sec_won(cap)}원, 추가지급 한도 {_sec_won(cap * (1 + ratio))}원을 넘습니다. 초과분은 본인 부담입니다.",
                        lb, "초과분을 빼고 정산하세요.")
                elif per > cap:
                    add(f"lodge-{r.get('id')}", "medium", f"{name}: 1박 {_sec_won(per)}원 — {region['name']} 상한 {_sec_won(cap)}원 초과",
                        f"업무상 부득이하면 상한의 {int(ratio * 100)}% 안에서 추가지급을 받을 수 있습니다(출장 마친 다음 날부터 1주일 안에 별도 신청).",
                        lb, "부득이한 사유와 세부 내역을 붙여 추가지급을 신청하거나, 초과분을 빼고 정산하세요.")
            elif top and per > int(top["cap"]):
                add(f"lodge-{r.get('id')}", "high" if per > int(top["cap"]) * (1 + ratio) else "medium",
                    f"{name}: 1박 {_sec_won(per)}원 — 가장 높은 상한({top['name']} {_sec_won(top['cap'])}원)도 넘음",
                    "어느 지역이든 상한을 넘는 금액입니다. 숙박 지역을 지정하면 정확히 계산합니다.", lb,
                    "초과분 본인 부담 또는 추가지급 신청 여부를 정하세요.")
            elif caps and per > int(caps[-1]["cap"]):
                add(f"lodge-{r.get('id')}", "low", f"{name}: 1박 {_sec_won(per)}원 — 지역에 따라 상한 초과",
                    " · ".join(f"{c['name']} {_sec_won(c['cap'])}원" for c in caps) + ". 숙박 지역을 지정해 확인하세요.", lb)
    # 3) 증빙 — 결제수단·누락·기간 밖
    if p.get("id") in ("domestic-trip", "overseas-trip", "corp-card", "event"):
        non = [r for r in rs if r.get("payment") in ("개인카드", "현금")]
        if non:
            add("pay", "medium", f"법인카드가 아닌 결제 {len(non)}건",
                ", ".join((r.get("vendor") or "증빙") for r in non[:4]) + " — 법인카드를 쓰지 못한 특별한 사유가 필요합니다.",
                ac.get("card_basis"), "사유를 정산 신청서(또는 메모)에 적으세요.")
    if trip or p.get("id") == "overseas-trip":
        if rs and not any(r.get("kind") == "운임" for r in rs):
            add("no-fare", "medium", "운임 증빙이 없습니다", "승차권·항공권 등 운임 증빙을 확인하세요.",
                {"reg": "여비규정", "art": "8"})
        s, e = dates.get("start"), dates.get("end")
        if s and e and s < e and rs and not any(r.get("kind") == "숙박" for r in rs):
            add("no-lodge", "low", "숙박 증빙이 없습니다", "1박 이상 출장입니다. 자가·친지집 숙박이면 사유를 적어 두세요.",
                (ac.get("lodging_basis") or [None])[0])
        if s and e:
            for r in rs:
                d = r.get("date") or ""
                if d and (d < addd(s, -1) or d > addd(e, 1)):
                    add(f"out-{r.get('id')}", "medium", f"{r.get('vendor') or '증빙'}: 출장 기간 밖 이용일({d})",
                        f"출장 기간 {s} ~ {e}와 맞지 않습니다.", None, "날짜를 확인하거나 이 증빙을 빼세요.")
    # 4) 초안 필수 기재사항
    for key, rule in (ac.get("draft_required") or {}).items():
        vals = (case.get("draft_values") or {}).get(key)
        if not isinstance(vals, dict):
            continue
        miss = [f for f in rule.get("fields", []) if not str(vals.get(f) or "").strip()]
        if miss:
            add(f"draft-{key}", "high" if key == "card-evidence" else "medium",
                f"초안 필수 항목 {len(miss)}개가 비었습니다", "빈 항목: " + ", ".join(miss), rule.get("basis"),
                "초안을 열어 빈 칸을 채우세요.")
    return out


_SEC_AUDIT_SYSTEM = (
    "당신은 한국 공공기관의 내부 감사관입니다. 서무 담당자가 결재를 올리기 전에, 처리 내용이 '제공된 조문'에 맞는지 점검합니다. "
    "반드시 제공된 조문과 절차에 근거해서만 지적하고, 제공되지 않은 규정·금액·기한을 지어내지 마세요. "
    "근거가 되는 조문은 basis 에서 고르고, 제공된 조문으로 판단할 수 없으면 basis 를 '없음'으로 두고 severity 는 low 로 하세요. "
    "이미 확인된 항목(규칙 감사)과 같은 내용은 다시 쓰지 마세요. 실제 문제가 없으면 findings 를 비우세요. "
    "각 지적은 담당자가 바로 고칠 수 있게 짧고 구체적인 한국어로 씁니다."
)


@app.route("/api/secretary/audit", methods=["POST"])
def secretary_audit():
    """결재 전 사전 감사. 처리 건의 사실관계(날짜·체크·증빙·초안)를 절차·조문과 대조한다."""
    body = request.get_json(silent=True) or {}
    p = _sec_clean_proc(body.get("procedure") or {})
    if not p or p.get("hidden"):
        return jsonify({"success": False, "error": "절차 정보가 올바르지 않습니다."}), 400
    case = body.get("case") if isinstance(body.get("case"), dict) else {}
    today = str(body.get("today") or "")
    if not re.match(r"^\d{4}-\d{2}-\d{2}$", today):
        today = datetime.now(_KST).strftime("%Y-%m-%d")
    rules = _sec_audit_rules(p, case, today)
    result = {"success": True, "findings": rules, "ai_used": False, "ai_error": "", "summary": ""}

    if body.get("ai") and _sec_ai_provider():
        if not _sec_ai_rate_ok():
            result["ai_error"] = "요청이 너무 많아 AI 감사는 건너뛰었습니다."
        else:
            refs, seen = [], set()
            for _, r in _sec_proc_refs(p):
                k = (r.get("reg"), r.get("art"), r.get("q"))
                if k in seen or ("label" in r and not r.get("art") and not r.get("q")):
                    continue
                seen.add(k)
                name, text = _sec_ref_text(r)
                if name and text and name not in {x[0] for x in refs}:
                    refs.append((name, text, r))
                if len(refs) >= 14:
                    break
            for c in (_sec_audit_cfg().get("lodging_basis") or []):
                name, text = _sec_ref_text(c)
                if name and text and name not in {x[0] for x in refs}:
                    refs.append((name, text, c))
            keys = [x[0] for x in refs] + ["없음"]
            facts = {
                "기준일": case.get("dates") or {},
                "완료한 단계": sorted(int(k) + 1 for k, v in (case.get("checks") or {}).items()
                                 if v and str(k).isdigit()),
                "증빙": [{k: r.get(k) for k in ("date", "end_date", "amount", "vendor", "kind", "payment",
                                               "nights", "region", "route", "items") if r.get(k)}
                       for r in (case.get("receipts") or [])[:20] if isinstance(r, dict)],
                "메모": _sec_clean_str(case.get("note"), 400),
                "오늘": today,
            }
            drafts = {k: _sec_clean_str(v, 3000) for k, v in list((case.get("drafts") or {}).items())[:4]}
            text = ("[절차]\n" + json.dumps({"title": p["title"], "steps": [s["t"] + (f" ({s['when']})" if s.get("when") else "")
                                                                          for s in p["steps"]],
                                              "pitfalls": [x["t"] for x in p.get("pitfalls", [])]}, ensure_ascii=False)
                    + "\n\n[제공된 조문]\n" + "\n".join(f"- {n}: {t}" for n, t, _ in refs)
                    + "\n\n[처리 사실관계]\n" + json.dumps(facts, ensure_ascii=False)
                    + "\n\n[작성한 초안]\n" + (json.dumps(drafts, ensure_ascii=False) if drafts else "(없음)")
                    + "\n\n[이미 확인된 항목(규칙 감사)]\n" + "\n".join("- " + f["title"] for f in rules))
            schema = {
                "type": "object",
                "properties": {
                    "findings": {"type": "array", "items": {
                        "type": "object",
                        "properties": {
                            "severity": {"type": "string", "enum": ["high", "medium", "low"]},
                            "title": {"type": "string"},
                            "detail": {"type": "string"},
                            "basis": {"type": "string", "enum": keys},
                            "fix": {"type": "string"},
                        },
                        "required": ["severity", "title", "detail", "basis", "fix"],
                        "additionalProperties": False}},
                    "summary": {"type": "string"},
                },
                "required": ["findings", "summary"],
                "additionalProperties": False,
            }
            try:
                data = _sec_ai_json(_SEC_AUDIT_SYSTEM, text, schema, effort="medium")
                by_name = {n: r for n, _, r in refs}
                for i, f in enumerate((data.get("findings") or [])[:12]):
                    if not isinstance(f, dict) or not _sec_clean_str(f.get("title")):
                        continue
                    b = by_name.get(f.get("basis"))
                    sev = f.get("severity") if f.get("severity") in ("high", "medium", "low") else "low"
                    if not b:
                        sev = "low"                     # 근거 조문이 없는 지적은 참고 수준으로만
                    result["findings"].append({
                        "id": f"ai-{i}", "severity": sev, "title": _sec_clean_str(f.get("title"), 120),
                        "detail": _sec_clean_str(f.get("detail"), 400), "fix": _sec_clean_str(f.get("fix"), 200),
                        "basis": {k: v for k, v in (b or {}).items() if k in ("reg", "art", "q")} or None,
                        "source": "ai"})
                result["ai_used"] = True
                result["summary"] = _sec_clean_str(data.get("summary"), 300)
            except _SecAIError as e:
                result["ai_error"] = str(e)
    order = {"high": 0, "medium": 1, "low": 2}
    result["findings"].sort(key=lambda f: order.get(f["severity"], 3))
    result["counts"] = {k: sum(1 for f in result["findings"] if f["severity"] == k) for k in order}
    return jsonify(result)


# ══════════════════════════════════════════════════════════════════════════
# ③ 규정 개정 영향 분석 — 이전 개정본과 조문 단위로 비교해, 영향받는 절차 단계와 고칠 안을 제시한다
#   이전본: 로컬은 업로드 때 보관한 regulations/.backup, GitHub 배포는 개정 직전 커밋
#   제안: 규칙(조문 번호 이동·기한 일수 변경·조문 삭제) + AI(키가 있을 때, 단계 문장 갱신안)
#   적용은 관리자가 화면에서 골라 기관 층으로 저장(저장 시점 개정 정보가 기록되어 '재확인' 알림이 사라짐)
# ══════════════════════════════════════════════════════════════════════════
def _sec_prev_reg_text(m: dict, idx: int = 0) -> tuple[str, str]:
    """manifest 항목의 이전 개정본 평문과 개정 라벨. 없으면 ('', '')."""
    hist = m.get("history") or []
    if idx >= len(hist):
        return "", ""
    h = hist[idx] or {}
    label = h.get("revision") or (h.get("entry") or {}).get("revision") or "이전 개정"
    html = ""
    if h.get("backup"):
        path = os.path.join(REG_BACKUP_DIR, os.path.basename(h["backup"]), "index.html")
        try:
            with open(path, encoding="utf-8", errors="replace") as f:
                html = f.read()
        except OSError:
            html = ""
    if not html and _gh_enabled() and idx == 0:
        ref = _gh_prev_commit(f"regulations/{m.get('slug')}/index.html")
        data = _gh_file(f"regulations/{m.get('slug')}/index.html", ref) if ref else None
        html = data.decode("utf-8", "replace") if data else ""
    if not html and idx == 0:
        html = _sec_git_prev(f"regulations/{m.get('slug')}/index.html")
    if not html:
        return "", label
    import reg_chunks
    return reg_chunks.html_to_text(html), label


def _sec_git_prev(path: str) -> str:
    """로컬 git 저장소(온프레미스 등)에서 '내규 등록/개정' 커밋 직전의 파일 내용. 실패하면 ''."""
    import subprocess
    root = os.path.dirname(os.path.abspath(__file__))
    if not os.path.isdir(os.path.join(root, ".git")):
        return ""
    try:
        log = subprocess.run(["git", "log", "--format=%H %s", "-n", "10", "--", path], cwd=root,
                             capture_output=True, text=True, timeout=10).stdout.splitlines()
        for ln in log:
            sha, _, msg = ln.partition(" ")
            if msg.startswith(("내규 등록:", "내규 개정:")):
                r = subprocess.run(["git", "show", f"{sha}^:{path}"], cwd=root,
                                   capture_output=True, timeout=10)
                return r.stdout.decode("utf-8", "replace") if r.returncode == 0 else ""
    except Exception:
        pass
    return ""


def _sec_arts(text: str) -> dict:
    import reg_chunks
    out = {}
    for a in reg_chunks.split_articles(text):
        if not a["boiler"] and a["no"] not in out:
            out[a["no"]] = {"title": a["art_title"], "body": a["body"]}
    return out


_SEC_DAYS_RE = re.compile(r"(\d+)\s*(일|주일|개월)\s*(?:이내|안|전|까지|내)")


def _sec_day_nums(t: str) -> list:
    out = []
    for n, u in _SEC_DAYS_RE.findall(t or ""):
        n = int(n)
        out.append(n * 7 if u == "주일" else n * 30 if u == "개월" else n)
    return out


def _sec_days_repl(t: str, d0: int, nd: int) -> str:
    """문장 속 'd0일'·'(d0/7)주일' → 새 일수."""
    rep = f"{nd // 7}주일" if nd % 7 == 0 and nd < 28 else f"{nd}일"
    t = re.sub(rf"(?<!\d){d0}\s*일", rep, t or "")
    if d0 % 7 == 0:
        t = re.sub(rf"(?<!\d){d0 // 7}\s*주일", rep, t)
    return t


def _sec_sent_diff(a: str, b: str) -> list:
    """바뀐 문장만 [{'old','new'}] (최대 6개)."""
    import difflib
    sa = [x.strip() for x in re.split(r"(?<=[.다])\s+|(?=[①-⑳])", a or "") if x.strip()]
    sb = [x.strip() for x in re.split(r"(?<=[.다])\s+|(?=[①-⑳])", b or "") if x.strip()]
    out = []
    for op, i1, i2, j1, j2 in difflib.SequenceMatcher(None, sa, sb, autojunk=False).get_opcodes():
        if op != "equal":
            out.append({"old": " ".join(sa[i1:i2])[:400], "new": " ".join(sb[j1:j2])[:400]})
    return out[:6]


def _sec_reg_diff(old: str, new: str) -> dict:
    import difflib
    A, B = _sec_arts(old), _sec_arts(new)
    norm = lambda s: re.sub(r"\s+|<[^>]*>", "", s or "")   # noqa: E731 — 개정 표시(<개정 …>)·공백 차이는 무시
    changed, added, removed, moved = {}, [], [], {}
    for no, a in A.items():
        b = B.get(no)
        if b and norm(a["body"]) == norm(b["body"]):
            continue
        # 같은 번호가 없거나 내용이 크게 다르면 → 다른 번호로 옮겨 갔는지 본다(조문 신설·삭제로 번호가 밀린 경우)
        best, score = None, 0.0
        for no2, b2 in B.items():
            if no2 == no:
                continue
            r = difflib.SequenceMatcher(None, norm(a["body"])[:1500], norm(b2["body"])[:1500], autojunk=False).ratio()
            if r > score:
                best, score = no2, r
        same = difflib.SequenceMatcher(None, norm(a["body"])[:1500], norm(b["body"])[:1500], autojunk=False).ratio() if b else 0
        if best and score >= 0.85 and score > same + 0.1 and a["title"] == B[best]["title"]:
            moved[no] = best
            if norm(a["body"]) != norm(B[best]["body"]):
                changed[no] = {"to": best, "title": a["title"], "old": a["body"], "new": B[best]["body"],
                               "sents": _sec_sent_diff(a["body"], B[best]["body"])}
        elif b:
            changed[no] = {"to": no, "title": b["title"], "old": a["body"], "new": b["body"],
                           "sents": _sec_sent_diff(a["body"], b["body"])}
        else:
            removed.append({"no": no, "title": a["title"]})
    targets = set(moved.values()) | {c["to"] for c in changed.values()}
    for no, b in B.items():
        if no not in A and no not in targets:
            added.append({"no": no, "title": b["title"]})
    return {"changed": changed, "moved": moved, "added": added, "removed": removed}


def _sec_line_with(text: str, q: str) -> str:
    ql = _norm_key(q)
    return next((re.sub(r"\s+", " ", ln).strip() for ln in (text or "").split("\n") if ql and ql in _norm_key(ln)), "")


def _sec_impact(m: dict, old: str, new: str, procs: list) -> dict:
    """procs: [(layer, p)]. 영향받는 절차 단계와 규칙 기반 제안."""
    diff = _sec_reg_diff(old, new)
    title_key = _norm_key(m.get("title", ""))
    removed = {x["no"] for x in diff["removed"]}
    items = []
    for layer, p in procs:
        if p.get("hidden"):
            continue
        hits = []
        locs = [("step", i, s, b) for i, s in enumerate(p.get("steps") or []) for b in (s.get("basis") or [])]
        locs += [("pitfall", i, pf, b) for i, pf in enumerate(p.get("pitfalls") or []) for b in (pf.get("basis") or [])]
        locs += [("form", i, s, s["form"]) for i, s in enumerate(p.get("steps") or []) if s.get("form")]
        for where, i, obj, r in locs:
            mm, _ = _sec_resolve_reg(r.get("reg", ""))
            if not mm or _norm_key(mm.get("title", "")) != title_key:
                continue
            hit = {"where": where, "i": i, "text": obj.get("t", ""), "ref": r, "kind": "", "proposals": []}
            art = str(r.get("art") or "")
            if where == "form":
                continue
            if art and art in diff["moved"]:
                hit["kind"] = "moved"
                hit["proposals"].append({"type": "art", "from": art, "to": diff["moved"][art],
                                         "why": f"제{art}조 내용이 제{diff['moved'][art]}조로 옮겨졌습니다."})
            if art and art in removed:
                hit["kind"] = "removed"
            if art and art in diff["changed"]:
                c = diff["changed"][art]
                hit["kind"] = hit["kind"] or "changed"
                hit["sents"] = c["sents"]
                # 이전 조문에서 사라진 기한 일수 ↔ 새로 생긴 일수(순서대로 짝) → 기한·문장 갱신 제안
                on, nn = _sec_day_nums(c["old"]), _sec_day_nums(c["new"])
                gone = list(dict.fromkeys(x for x in on if x not in nn))
                fresh = list(dict.fromkeys(x for x in nn if x not in on))
                pairs = list(zip(gone, fresh))
                dl = obj.get("deadline") if where == "step" else None
                if dl and dl.get("days") is not None:
                    d0 = abs(int(dl["days"]))
                    nd = next((n for o, n in pairs if o == d0), None)
                    if d0 and nd is not None:
                        nd = -nd if int(dl["days"]) < 0 else nd
                        hit["proposals"].append({"type": "days", "from": int(dl["days"]), "to": nd,
                                                 "why": f"조문의 기한이 {d0}일 → {abs(nd)}일로 바뀌었습니다."})
                for fld in ("t", "when"):
                    t0 = obj.get(fld, "")
                    t2 = t0
                    for o, n in pairs:
                        t2 = _sec_days_repl(t2, o, n)
                    if t0 and t2 != t0:
                        hit["proposals"].append({"type": "text" if fld == "t" else "when", "from": t0, "to": t2,
                                                 "why": "문장 속 일수를 개정 조문에 맞춥니다." if fld == "t"
                                                 else "기한 안내 문구도 함께 고칩니다."})
            if not art and r.get("q"):
                lo, ln = _sec_line_with(old, r["q"]), _sec_line_with(new, r["q"])
                if lo != ln:
                    hit["kind"] = "changed" if ln else "removed"
                    hit["sents"] = [{"old": lo[:400], "new": ln[:400]}]
            if hit["kind"]:
                hits.append(hit)
        if hits:
            items.append({"id": p["id"], "title": p.get("title", ""), "icon": p.get("icon", ""), "layer": layer, "hits": hits})
    # 사전 감사 기준(숙박비 상한 등)이 이 규정을 근거로 쓰면 함께 알린다
    audit = []
    for c in (_sec_audit_cfg().get("lodging_basis") or []):
        mm, _ = _sec_resolve_reg(c.get("reg", ""))
        if mm and _norm_key(mm.get("title", "")) == title_key:
            lo = _sec_line_with(old, c["q"]) if c.get("q") else ""
            ln = _sec_line_with(new, c["q"]) if c.get("q") else ""
            a = str(c.get("art") or "")
            if (c.get("q") and lo != ln) or (a and (a in diff["changed"] or a in removed or a in diff["moved"])):
                audit.append({"ref": c, "old": lo, "new": ln})
    out = {k: v for k, v in diff.items() if k != "changed"}
    out["changed"] = [{"no": k, **{x: v[x] for x in ("to", "title", "sents")}} for k, v in diff["changed"].items()]
    out["procedures"] = items
    out["audit"] = audit
    return out


_SEC_IMPACT_SYSTEM = (
    "당신은 공공기관 내규 담당자입니다. 규정이 개정되어, 그 규정을 근거로 하는 업무 절차 단계 문장을 고쳐야 하는지 판단합니다. "
    "반드시 제공된 '개정 전/후 조문'에 근거해서만 판단하고, 조문에 없는 내용을 지어내지 마세요. "
    "고칠 필요가 없으면 그 단계는 결과에 넣지 마세요. 새 문장은 원래 문장의 말투·길이를 유지하고, 바뀐 기한·대상·금액만 반영합니다."
)


@app.route("/api/secretary/impact")
def secretary_impact():
    """규정 개정 영향 분석. ?reg=규정명[&h=이력 순번][&ai=1]"""
    name = (request.args.get("reg") or "").strip()
    m, _ = _sec_resolve_reg(name)
    if not m:
        return jsonify({"success": False, "error": "규정을 찾을 수 없습니다."}), 404
    try:
        h = max(0, min(19, int(request.args.get("h") or 0)))
    except ValueError:
        h = 0
    old, label = _sec_prev_reg_text(m, h)
    if not old:
        why = ("이전 개정본 원문을 찾지 못했습니다(보관본이 없음)." if label
               else "비교할 이전 개정본이 없습니다 — 화면(/upload)으로 개정본을 올리면 이전본이 보관되어 비교할 수 있습니다.")
        return jsonify({"success": False, "error": why}), 404
    new = _sec_reg_text(m["title"])
    common = _sec_read_json(SEC_COMMON_PATH, {"procedures": []}).get("procedures", [])
    org = _sec_org_load().get("procedures", [])
    org_ids = {p["id"] for p in org}
    procs = [("org", p) for p in org] + [("common", p) for p in common if p["id"] not in org_ids]
    res = _sec_impact(m, old, new, procs)
    res.update({"success": True, "reg": m["title"], "from": label, "to": m.get("revision", ""),
                "ai_used": False, "ai_error": ""})

    hits = [(it, hit) for it in res["procedures"] for hit in it["hits"] if hit["where"] == "step"]
    if request.args.get("ai") == "1" and hits and _sec_ai_provider():
        if not _sec_ai_rate_ok():
            res["ai_error"] = "요청이 너무 많아 AI 제안은 건너뛰었습니다."
        else:
            keys = [f"{it['id']}#{hit['i']}" for it, hit in hits][:30]
            arts = "\n".join(f"- 제{c['no']}조({c['title']}){' → 제' + c['to'] + '조' if c['to'] != c['no'] else ''}\n"
                             + "\n".join(f"  개정 전: {s['old']}\n  개정 후: {s['new']}" for s in c["sents"])
                             for c in res["changed"])[:12000]
            q_changes = "\n".join(f"- {hit['ref'].get('q')}: {s['old']} → {s['new']}"
                                  for _, hit in hits if hit["ref"].get("q") for s in hit.get("sents", []))
            steps = "\n".join(f"- [{it['id']}#{hit['i']}] {hit['text']} (근거: {hit['ref'].get('reg')} "
                              f"{'제' + str(hit['ref'].get('art')) + '조' if hit['ref'].get('art') else hit['ref'].get('q', '')})"
                              for it, hit in hits[:30])
            text = (f"[규정] {m['title']} ({label} → {m.get('revision', '')})\n\n[바뀐 조문]\n{arts}\n{q_changes}\n\n"
                    f"[영향받는 절차 단계]\n{steps}")
            schema = {"type": "object", "properties": {
                "updates": {"type": "array", "items": {"type": "object", "properties": {
                    "key": {"type": "string", "enum": keys},
                    "new_text": {"type": "string"},
                    "reason": {"type": "string"}},
                    "required": ["key", "new_text", "reason"], "additionalProperties": False}}},
                "required": ["updates"], "additionalProperties": False}
            try:
                data = _sec_ai_json(_SEC_IMPACT_SYSTEM, text, schema, effort="medium")
                by = {f"{it['id']}#{hit['i']}": hit for it, hit in hits}
                for u in (data.get("updates") or [])[:30]:
                    hit = by.get(u.get("key"))
                    nt = _sec_clean_str(u.get("new_text"), 300)
                    if not hit or not nt or nt == hit["text"]:
                        continue
                    hit["proposals"] = [x for x in hit["proposals"] if x["type"] != "text"]
                    hit["proposals"].append({"type": "text", "from": hit["text"], "to": nt, "ai": True,
                                             "why": _sec_clean_str(u.get("reason"), 200)})
                res["ai_used"] = True
            except _SecAIError as e:
                res["ai_error"] = str(e)
    res["counts"] = {"articles": len(res["changed"]) + len(res["moved"]) + len(res["removed"]) + len(res["added"]),
                     "procedures": len(res["procedures"]),
                     "proposals": sum(len(h["proposals"]) for it in res["procedures"] for h in it["hits"])}
    return jsonify(res)


# ══════════════════════════════════════════════════════════════════════════
# ④ 기관 집단 지식 — 담당자들이 처리한 건의 '익명 숫자'를 모아 다음 담당자에게 돌려준다
#   모으는 것: 완료까지 걸린 일수, 기한을 넘긴 단계, 사전 감사에서 걸린 항목 종류(정해진 목록),
#             담당자가 '기관에 공유'를 직접 고른 반려 사유 문장. 이름·금액·메모·초안 내용은 모으지 않는다.
#   저장소: Upstash Redis(=Vercel KV) REST 가 설정되면 그곳, 아니면 서버 로컬 파일(쓰기 가능할 때)
#   통계는 표본이 insights.min_n(기본 3)건 이상일 때만 보여 준다.
# ══════════════════════════════════════════════════════════════════════════
SEC_INS_FILE = os.environ.get("SECRETARY_INSIGHTS_FILE", "").strip() or os.path.join(SEC_DIR, "insights.json")
_SEC_KV_URL = (os.environ.get("UPSTASH_REDIS_REST_URL") or os.environ.get("KV_REST_API_URL") or "").strip().rstrip("/")
_SEC_KV_TOKEN = (os.environ.get("UPSTASH_REDIS_REST_TOKEN") or os.environ.get("KV_REST_API_TOKEN") or "").strip()
_SEC_INS_LOCK = threading.Lock()
_SEC_INS_HITS: dict = {}
_SEC_AUDIT_KINDS = ("due", "soon", "lodge", "pay", "no-fare", "no-lodge", "out", "draft")


def _sec_ins_cfg() -> dict:
    c = {"enabled": True, "min_n": 3}
    c.update(_sec_config().get("insights") or {})
    return c


def _sec_ins_backend() -> str:
    if not _sec_ins_cfg().get("enabled", True):
        return ""
    if _SEC_KV_URL and _SEC_KV_TOKEN:
        return "redis"
    d = os.path.dirname(SEC_INS_FILE) or "."
    if (os.path.exists(SEC_INS_FILE) and os.access(SEC_INS_FILE, os.W_OK)) or \
       (not os.path.exists(SEC_INS_FILE) and os.access(d, os.W_OK)):
        return "file"
    return ""


def _sec_kv(cmds: list) -> list:
    """해시 명령 묶음 실행. cmds: [["HINCRBY", key, field, n] | ["HGETALL", key] | ["HDEL", key, field] | ["KEYS", pattern]]"""
    be = _sec_ins_backend()
    if be == "redis":
        r = _SESSION.post(f"{_SEC_KV_URL}/pipeline", json=cmds, timeout=8,
                          headers={"Authorization": f"Bearer {_SEC_KV_TOKEN}"})
        r.raise_for_status()
        out = []
        for x, c in zip(r.json(), cmds):
            v = x.get("result")
            if c[0] == "HGETALL" and isinstance(v, list):      # [f1, v1, f2, v2 …] → dict
                v = {v[i]: v[i + 1] for i in range(0, len(v) - 1, 2)}
            out.append(v)
        return out
    if be != "file":
        raise RuntimeError("집단 지식 저장소가 없습니다.")
    with _SEC_INS_LOCK:
        db = _sec_read_json(SEC_INS_FILE, {}) or {}
        out, dirty = [], False
        for c in cmds:
            op, key = c[0], c[1]
            h = db.setdefault(key, {}) if op == "HINCRBY" else db.get(key, {})
            if op == "HINCRBY":
                h[c[2]] = int(h.get(c[2], 0)) + int(c[3]); out.append(h[c[2]]); dirty = True
            elif op == "HGETALL":
                out.append(dict(h))
            elif op == "HDEL":
                out.append(1 if h.pop(c[2], None) is not None else 0); dirty = True
            elif op == "KEYS":
                pre = key.rstrip("*")
                out.append([k for k in db if k.startswith(pre)])
        if dirty:
            tmp = SEC_INS_FILE + ".tmp"
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(db, f, ensure_ascii=False)
            os.replace(tmp, SEC_INS_FILE)
        return out


def _sec_ins_rate_ok() -> bool:
    ip = _client_ip()
    now = time.time()
    hits = [t for t in _SEC_INS_HITS.get(ip, []) if now - t < 3600]
    if len(hits) >= 60:
        _SEC_INS_HITS[ip] = hits
        return False
    _SEC_INS_HITS[ip] = hits + [now]
    if len(_SEC_INS_HITS) > 5000:
        _SEC_INS_HITS.clear()
    return True


_SEC_PII = [(re.compile(r"(?<!\d)\d{2,3}[-. ]?\d{3,4}[-. ]?\d{4}(?!\d)"), "○○○"),             # 전화번호
            (re.compile(r"(?<!\d)\d{6}[- ]?\d{7}(?!\d)"), "○○○"),                              # 주민번호
            (re.compile(r"[\w.+-]+@[\w-]+\.[\w.]+"), "○○○"),                           # 메일
            (re.compile(r"\d[\d,]{3,}\s*원"), "○○원"),                                 # 금액
            (re.compile(r"(?<![가-힣])(?!담당|해당|회계|소속|부서|감사|관계|업무|총괄|계약|예산|인사|출장|정산|결재)[가-힣]{2,3}\s?(?=(?:주무관|사무관|대리|주임|선임|책임|님|씨)(?![가-힣]{2}))"), "○○○ ")]


def _sec_scrub(t: str) -> str:
    t = _sec_clean_str(t, 200)
    for rx, rep in _SEC_PII:
        t = rx.sub(rep, t)
    return re.sub(r"\s+", " ", t).strip()


def _sec_pid_ok(pid: str) -> bool:
    return bool(_SEC_ID_RE.match(pid or "")) and len(pid) <= 48


@app.route("/api/secretary/insights/event", methods=["POST"])
def secretary_insights_event():
    """익명 사건 기록. {type:'done'|'reject', procedure, days?, late?:[단계], ontime?:[단계], audit?:[종류], text?}"""
    if not _sec_ins_backend():
        return jsonify({"success": False, "error": "집단 지식 저장소가 설정되지 않았습니다."}), 503
    if not _sec_ins_rate_ok():
        return jsonify({"success": False, "error": "요청이 너무 많습니다."}), 429
    b = request.get_json(silent=True) or {}
    pid = str(b.get("procedure") or "")
    if not _sec_pid_ok(pid):
        return jsonify({"success": False, "error": "절차 id 가 올바르지 않습니다."}), 400
    key = f"sec:ins:{pid}"
    cmds = []
    if b.get("type") == "done":
        cmds.append(["HINCRBY", key, "n", 1])
        try:
            days = int(b.get("days"))
            if 0 <= days <= 400:
                cmds.append(["HINCRBY", key, f"d:{min(days, 120)}", 1])
        except (TypeError, ValueError):
            pass
        idx = lambda xs: sorted({int(x) for x in (xs or []) if str(x).isdigit() and int(x) < 40})  # noqa: E731
        for i in idx(b.get("late")):
            cmds += [["HINCRBY", key, f"late:{i}", 1], ["HINCRBY", key, f"due:{i}", 1]]
        for i in idx(b.get("ontime")):
            cmds.append(["HINCRBY", key, f"due:{i}", 1])
        for k in sorted({str(x) for x in (b.get("audit") or []) if str(x) in _SEC_AUDIT_KINDS}):
            cmds.append(["HINCRBY", key, f"au:{k}", 1])
    elif b.get("type") == "reject":
        t = _sec_scrub(b.get("text"))
        if len(t) < 4:
            return jsonify({"success": False, "error": "반려 사유가 너무 짧습니다."}), 400
        cmds.append(["HINCRBY", f"sec:rj:{pid}", t, 1])
    else:
        return jsonify({"success": False, "error": "type 이 올바르지 않습니다."}), 400
    try:
        _sec_kv(cmds)
    except Exception as e:
        print(f"[secretary] 집단 지식 기록 실패: {e}")
        return jsonify({"success": False, "error": "기록하지 못했습니다."}), 502
    return jsonify({"success": True})


def _sec_ins_summary(h: dict, rj: dict, min_n: int) -> dict:
    h = {k: int(v) for k, v in (h or {}).items() if str(v).lstrip("-").isdigit()}
    n = h.get("n", 0)
    out = {"n": n, "enough": n >= min_n, "reasons": sorted(({"t": k, "c": int(v)} for k, v in (rj or {}).items()),
                                                          key=lambda x: -x["c"])[:8]}
    if n < min_n:
        return out
    hist = sorted((int(k[2:]), v) for k, v in h.items() if k.startswith("d:"))
    tot = sum(v for _, v in hist)

    def pct(q):
        acc = 0
        for d, v in hist:
            acc += v
            if acc >= q * tot:
                return d
        return None
    if tot >= min_n:
        out["days"] = {"median": pct(0.5), "p80": pct(0.8), "n": tot}
    steps = []
    for k, v in h.items():
        if k.startswith("due:") and v >= min_n:
            i = int(k[4:])
            steps.append({"i": i, "late": h.get(f"late:{i}", 0), "n": v, "rate": round(h.get(f"late:{i}", 0) / v, 2)})
    out["late"] = sorted((s for s in steps if s["late"]), key=lambda s: -s["rate"])[:3]
    out["audit"] = sorted(({"k": k[3:], "c": v} for k, v in h.items() if k.startswith("au:")), key=lambda x: -x["c"])[:4]
    return out


@app.route("/api/secretary/insights")
def secretary_insights():
    """?procedure=id → 그 절차의 집단 지식. 없으면 전체 요약(관리 화면용)."""
    be = _sec_ins_backend()
    min_n = max(1, int(_sec_ins_cfg().get("min_n") or 3))
    if not be:
        return jsonify({"success": True, "available": False, "min_n": min_n})
    pid = request.args.get("procedure") or ""
    try:
        if pid:
            if not _sec_pid_ok(pid):
                return jsonify({"success": False, "error": "절차 id 가 올바르지 않습니다."}), 400
            h, rj = _sec_kv([["HGETALL", f"sec:ins:{pid}"], ["HGETALL", f"sec:rj:{pid}"]])
            return jsonify({"success": True, "available": True, "min_n": min_n, "backend": be,
                            "procedure": pid, **_sec_ins_summary(h, rj, min_n)})
        keys = (_sec_kv([["KEYS", "sec:ins:*"]])[0] or []) + (_sec_kv([["KEYS", "sec:rj:*"]])[0] or [])
        pids = sorted({k.split(":", 2)[2] for k in keys if k.count(":") >= 2})[:200]
        res = _sec_kv([c for p in pids for c in (["HGETALL", f"sec:ins:{p}"], ["HGETALL", f"sec:rj:{p}"])]) if pids else []
        items = {p: _sec_ins_summary(res[2 * i], res[2 * i + 1], min_n) for i, p in enumerate(pids)}
        return jsonify({"success": True, "available": True, "min_n": min_n, "backend": be, "procedures": items})
    except Exception as e:
        print(f"[secretary] 집단 지식 조회 실패: {e}")
        return jsonify({"success": True, "available": False, "min_n": min_n, "error": "저장소에 연결하지 못했습니다."})


@app.route("/api/secretary/insights/reason", methods=["DELETE"])
def secretary_insights_reason_delete():
    """공유된 반려 사유 삭제(관리자) — 부적절한 문장 정리, 또는 점검 항목으로 올린 뒤 정리."""
    ok, why = _upload_authorized()
    if not ok:
        return jsonify({"success": False, "error": why}), 401
    b = request.get_json(silent=True) or {}
    pid, t = str(b.get("procedure") or ""), str(b.get("text") or "")
    if not _sec_pid_ok(pid) or not t:
        return jsonify({"success": False, "error": "procedure·text 가 필요합니다."}), 400
    try:
        n = _sec_kv([["HDEL", f"sec:rj:{pid}", t]])[0]
    except Exception:
        return jsonify({"success": False, "error": "저장소에 연결하지 못했습니다."}), 502
    return jsonify({"success": True, "deleted": int(n or 0)})


# ══════════════════════════════════════════════════════════════════════════
# 브라우저 확장 배포
#   /api/secretary/extension/info · extension.zip : 이 서버 주소와 기관 ERP 주소를 넣은 확장 배포본
#   /api/secretary/erp/meta     : 확장의 결재 전 점검이 쓰는 절차·반려 점검 항목
#   (ERP 화면 규칙·칸 매핑 /api/secretary/erp/profiles 는 'ERP 맞춤' 기능과 함께 삭제)
#   확장 페이지(chrome-extension://)가 부르므로 이 경로들만 CORS 를 연다(공개 정보 + 저장은 관리자 토큰).
# ══════════════════════════════════════════════════════════════════════════


@app.after_request
def _sec_ext_cors(resp):
    if request.path.startswith(("/api/secretary/erp/", "/api/secretary/extension", "/api/secretary/diag")):
        resp.headers["Access-Control-Allow-Origin"] = "*"
        resp.headers["Access-Control-Allow-Headers"] = "Content-Type, X-Upload-Token"
        resp.headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS"
        resp.headers["Access-Control-Max-Age"] = "600"
    return resp


def _sec_public_origin() -> str:
    proto = (request.headers.get("X-Forwarded-Proto") or request.scheme or "https").split(",")[0].strip()
    host = (request.headers.get("X-Forwarded-Host") or request.host or "").split(",")[0].strip()
    return f"{proto}://{host}" if host else ""


def _sec_ext_hosts() -> list:
    import extension_build
    hosts = (_sec_config().get("erp") or {}).get("hosts") or []
    return [h for h in (extension_build.origin_pattern(x) for x in hosts) if h]


@app.route("/api/secretary/extension/info")
def secretary_extension_info():
    import extension_build
    man = extension_build.manifest()
    return jsonify({"success": True, "version": man.get("version", ""), "name": man.get("name", ""),
                    "server": _sec_public_origin(),
                    "erp_hosts": _sec_ext_hosts() or man["content_scripts"][0]["matches"]})


@app.route("/api/secretary/extension.zip")
def secretary_extension_zip():
    """이 서무비서 주소와 기관 ERP 주소를 넣은 확장 배포본. 압축을 풀면 secretary-extension 폴더 하나."""
    import extension_build
    server = _sec_public_origin()
    if not (server.startswith("https://") or re.match(r"^http://(localhost|127\.0\.0\.1)(:\d+)?$", server)):
        server = ""                                   # http 운영 주소는 넣지 않고 사용자가 설정
    org = (_sec_config().get("org") or {})
    svc = (_sec_config().get("service") or {})
    name = f"{org.get('abbr') or org.get('short') or ''} {svc.get('title') or '서무비서'}".strip()
    try:
        data, man = extension_build.build_zip(server, _sec_ext_hosts(), name)
    except ValueError as e:
        return jsonify({"success": False, "error": str(e)}), 400
    resp = app.response_class(data, mimetype="application/zip")
    resp.headers["Content-Disposition"] = f"attachment; filename=\"secretary-extension-{man['version']}.zip\""
    resp.headers["Cache-Control"] = "no-store"
    return resp


SEC_DIAG_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "diag")


@app.route("/api/secretary/diag", methods=["POST", "OPTIONS"])
def secretary_diag_upload():
    """확장 '진단 센터'의 진단 보고서(동작 기록) 받기 — 실제 ERP 시험 뒤 화면 감지 규칙·상신 버튼·편집기 넣기를 고치는 데 쓴다.
    입력값(본문)은 확장이 애초에 기록하지 않으며, 관리자 토큰이 있어야 저장된다."""
    if request.method == "OPTIONS":
        return ("", 204)
    ok, why = _upload_authorized()
    if not ok:
        return jsonify({"success": False, "error": why}), 401
    raw = request.get_data(cache=False, as_text=True) or ""
    if len(raw) > 3_000_000:
        return jsonify({"success": False, "error": "진단 보고서가 너무 큽니다(3MB 초과). '기록 지우기' 후 다시 시험해 주세요."}), 413
    try:
        body = json.loads(raw)
    except ValueError:
        return jsonify({"success": False, "error": "JSON 형식이 아닙니다."}), 400
    if not isinstance(body, dict) or body.get("kind") != "secretary-diag" or not isinstance(body.get("log"), list):
        return jsonify({"success": False, "error": "서무비서 진단 보고서가 아닙니다."}), 400
    stamp = datetime.now(timezone(timedelta(hours=9))).strftime("%Y%m%d-%H%M%S")
    name = f"{stamp}-{base64.b32encode(os.urandom(5)).decode().lower()}.json"
    body["received"] = _now_kst()
    payload = json.dumps(body, ensure_ascii=False, indent=1) + "\n"
    try:
        if _gh_enabled():
            # 배포 가지가 아니라 진단 전용 가지에 — 보고서마다 재배포되거나 배포본에 섞이지 않게
            sha = _gh_commit_files({f"diag/{name}": payload}, f"서무비서 진단 보고서 {stamp} ({len(body['log'])}건)",
                                   branch=SEC_DIAG_BRANCH)
            where = f"저장소의 '{SEC_DIAG_BRANCH}' 가지에 올렸습니다({sha[:7]})."
        else:
            where = _sec_save_repo_file(f"diag/{name}", os.path.join(SEC_DIAG_DIR, name), payload, "")
    except OSError:
        return jsonify({"success": False, "error": _SEC_READONLY_MSG}), 500
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 502
    return jsonify({"success": True, "path": f"diag/{name}", "message": where})


def _sec_alio_status():
    """scripts/alio_sync.mjs 결과 요약: 확인일, ALIO 기준 개정·신규 규정."""
    d = _sec_read_json(os.path.join(SEC_DIR, "alio_status.json"), None)
    if not isinstance(d, dict):
        return None
    items = [{"title": str(x.get("title", ""))[:80], "status": x.get("status", ""),
              "alio": str(x.get("alioDate", ""))[:20], "ours": str(x.get("ours", ""))[:40]}
             for x in (d.get("items") or []) if isinstance(x, dict) and x.get("status") in ("revised", "new")][:80]
    return {"checked": str(d.get("checked", ""))[:25], "org": str(d.get("org", ""))[:40],
            "alio": d.get("alio", 0), "current": d.get("current", 0), "items": items}


def _sec_tx(text: str, cfg: dict) -> str:
    """절차 문장의 [[erp]] 같은 자리표시 → 기관 명칭(화면의 tx() 와 같음)."""
    terms = {**_SEC_CFG_DEFAULT["terms"], **{k: v for k, v in (cfg.get("terms") or {}).items() if v}}
    return re.sub(r"\[\[(\w+)\]\]", lambda m: terms.get(m.group(1), m.group(0)), str(text or ""))


@app.route("/api/secretary/erp/meta")
def secretary_erp_meta():
    """확장용: 절차·반려 점검 항목(결재 전 점검)과 초안 서식 목록."""
    common = _sec_read_json(SEC_COMMON_PATH, {"procedures": [], "drafts": {}})
    org = _sec_org_load()
    drafts = dict(common.get("drafts") or {}); drafts.update(org.get("drafts") or {})
    procs = {p["id"]: p for p in common.get("procedures", [])}
    procs.update({p["id"]: p for p in org.get("procedures", [])})
    cfg = _sec_config()
    return jsonify({"success": True,
                    "drafts": [{"key": k, "title": d.get("title", k), "fields": [{"k": f.get("k"), "l": f.get("l")} for f in d.get("fields") or []]}
                               for k, d in drafts.items()],
                    "procedures": [{"id": p["id"], "title": p.get("title", ""), "icon": p.get("icon", ""),
                                    "q": (p.get("triggers") or [p.get("title", "")])[0],
                                    # 결재 전 점검(ERP 상신 버튼)용 반려 점검 항목과 근거
                                    "pitfalls": [{"t": _sec_tx(x.get("t", ""), cfg),
                                                  "basis": [{k: b.get(k) for k in ("reg", "art", "q") if b.get(k)} for b in (x.get("basis") or [])][:2]}
                                                 for x in (p.get("pitfalls") or [])][:12],
                                    "drafts": [s.get("draft") for s in (p.get("steps") or []) if s.get("draft")]}
                                   for p in procs.values() if not p.get("hidden")],
                    "erp_hosts": _sec_ext_hosts(), "org": (cfg.get("org") or {}).get("name", "")})


# ══════════════════════════════════════════════════════════════════════════
# 한글 서식 작성(kordoc) — 로컬·내부 서버: node forms/cli.mjs 를 불러 쓴다.
#   Vercel 에서는 같은 경로(/api/secretary/forms/*)를 Node 함수 api/forms.mjs 가 받는다(vercel.json).
#   node 나 kordoc 이 없으면 status 가 available:false 이고, 화면은 기존 내장 .hwpx 초안을 쓴다.
# ══════════════════════════════════════════════════════════════════════════
_FORMS_CLI = os.path.join(os.path.dirname(os.path.abspath(__file__)), "forms", "cli.mjs")


def _forms_node() -> str:
    import shutil
    node = shutil.which("node")
    root = os.path.dirname(os.path.abspath(__file__))
    if node and os.path.isfile(_FORMS_CLI) and os.path.isdir(os.path.join(root, "node_modules", "kordoc")):
        return node
    return ""


@app.route("/api/secretary/forms/<action>", methods=["GET", "POST"])
def secretary_forms(action):
    import subprocess
    if action not in ("status", "generate", "gian", "inspect", "fill"):
        return jsonify({"success": False, "error": "알 수 없는 요청입니다."}), 404
    node = _forms_node()
    if action == "status":
        return jsonify({"success": True, "available": bool(node), "engine": "kordoc" if node else ""})
    if request.method != "POST":
        return jsonify({"success": False, "error": "POST 로 요청하세요."}), 405
    if not node:
        return jsonify({"success": False, "error": "서버에 한글 서식 엔진(kordoc)이 설치되어 있지 않습니다."}), 503
    if (request.content_length or 0) > 8 * 1024 * 1024:
        return jsonify({"success": False, "error": "요청이 너무 큽니다."}), 413
    body = request.get_json(silent=True) or {}
    try:
        p = subprocess.run([node, _FORMS_CLI], input=json.dumps({"action": action, "body": body}),
                           capture_output=True, text=True, timeout=90, cwd=os.path.dirname(_FORMS_CLI))
        out = json.loads(p.stdout or "{}")
    except subprocess.TimeoutExpired:
        return jsonify({"success": False, "error": "서식 작성 시간이 초과되었습니다."}), 504
    except Exception as e:
        print(f"[forms] 실행 실패: {e}")
        return jsonify({"success": False, "error": "서식을 만들지 못했습니다."}), 500
    if not out.get("ok"):
        if p.stderr:
            print(f"[forms] {p.stderr[:2000]}")
        return jsonify({"success": False, "error": out.get("error") or "서식을 만들지 못했습니다."}), int(out.get("status") or 500)
    if not out.get("data"):
        return jsonify({"success": True, **(out.get("report") or {})})
    name = re.sub(r'[\\/:*?"<>|\r\n]', "", str(body.get("filename") or "서식"))[:80] or "서식"
    resp = app.response_class(base64.b64decode(out["data"]), mimetype="application/hwp+zip")
    resp.headers["Content-Disposition"] = f"attachment; filename=\"form.hwpx\"; filename*=UTF-8''{quote(name)}.hwpx"
    resp.headers["X-Form-Report"] = quote(json.dumps(out.get("report") or {}, ensure_ascii=False))
    resp.headers["Access-Control-Expose-Headers"] = "X-Form-Report, Content-Disposition"
    return resp


# ── 실행 ─────────────────────────────────────────────────────────────────────
PORT = int(os.environ.get("PORT", 5100))

if __name__ == "__main__":
    url = f"http://localhost:{PORT}"
    print("=" * 50)
    print("  🗂  KOAT 서무비서")
    print(f"  🔗  {url}")
    print("  종료: Ctrl+C")
    print("=" * 50)
    threading.Timer(1.2, lambda: webbrowser.open(url)).start()
    app.run(host="0.0.0.0", port=PORT, debug=False)
