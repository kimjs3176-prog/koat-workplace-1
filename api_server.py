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
        return (True, "")
    tok = (request.form.get("token") or request.headers.get("X-Upload-Token") or "").strip()
    if tok == REG_UPLOAD_TOKEN:
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


def _gh_commit_files(files: dict, message: str, deletes=None):
    """여러 파일을 한 커밋으로 반영. files={경로: bytes|str}, deletes=[경로].

    Git Data API(blob→tree→commit→ref)로 원자적으로 커밋한다.
    Contents API를 파일마다 호출하면 커밋이 쪼개지고 중간 실패 시 상태가 깨진다.
    """
    ref = _gh("GET", f"/git/ref/heads/{GITHUB_BRANCH}")
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
    _gh("PATCH", f"/git/refs/heads/{GITHUB_BRANCH}",
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
        "token_required": bool(REG_UPLOAD_TOKEN),
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
        url = (f"https://generativelanguage.googleapis.com/v1beta/models"
               f"/{model}:embedContent?key={api_key}")
        body = {"model": f"models/{model}",
                "content": {"parts": [{"text": text}]},
                "taskType": "RETRIEVAL_QUERY"}
        if dim:
            body["outputDimensionality"] = dim
        r = _SESSION.post(url, timeout=15, json=body)
        if r.status_code != 200:
            print(f"[vec] 질의 임베딩 실패({r.status_code})")
            return None
        return r.json()["embedding"]["values"]
    except Exception as e:
        print(f"[vec] 질의 임베딩 오류: {e}")
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
    """사용자 Gemini 키 — 헤더(X-Gemini-Key) 우선, 없으면 서버 키.

    F02: URL 쿼리로 키를 받지 않는다. 쿼리 파라미터는 접근 로그·관측 시스템에
    남을 수 있어, 사용자별 키는 요청 헤더로만 전달받는다.
    """
    return (request.headers.get("X-Gemini-Key")
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
        "admin": {"token_required": bool(REG_UPLOAD_TOKEN) or _gh_enabled(),
                  "github": _gh_enabled()},
    })


@app.route("/api/secretary/check", methods=["POST"])
def secretary_check():
    """절차 목록(개인 절차·가져올 절차 팩)의 호환성 점검 — 저장하지 않는다."""
    body = request.get_json(silent=True) or {}
    procs = body.get("procedures")
    if not isinstance(procs, list) or len(procs) > 300:
        return jsonify({"success": False, "error": "procedures 목록(최대 300건)이 필요합니다."}), 400
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
