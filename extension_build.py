"""서무비서 브라우저 확장 배포본(zip) 만들기 — 배포 페이지(/api/secretary/extension.zip)와 scripts/build_extension.py 가 함께 쓴다.

기관의 서무비서 주소·ERP 주소를 manifest·config.js 에 넣어, 사용자가 따로 설정하지 않아도 바로 쓰게 한다.
"""
import io, json, os, re, zipfile

ROOT = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(ROOT, "extension")


def origin_pattern(u: str) -> str:
    """'kerp.koat.or.kr' · 'https://kerp.koat.or.kr/gw/x.do' → 'https://kerp.koat.or.kr/*'"""
    u = (u or "").strip().rstrip("/")
    if not u:
        return ""
    if not re.match(r"^https?://", u):
        u = "https://" + u
    m = re.match(r"^(https?://[A-Za-z0-9.\-]+(?::\d+)?)(?:/|$)", u)
    return (m.group(1) + "/*") if m else ""


def manifest() -> dict:
    with open(os.path.join(SRC, "manifest.json"), encoding="utf-8") as f:
        return json.load(f)


def build_zip(server: str = "", erps=None, name: str = "", version: str = "") -> tuple[bytes, dict]:
    server = (server or "").strip().rstrip("/")
    if server and not re.match(r"^https://", server) and not re.match(r"^http://(localhost|127\.0\.0\.1)(:\d+)?$", server):
        raise ValueError("서무비서 주소는 https 여야 합니다.")
    man = manifest()
    pats = [p for p in (origin_pattern(x) for x in (erps or [])) if p]
    pats = list(dict.fromkeys(pats)) or man["content_scripts"][0]["matches"]
    man["host_permissions"] = pats
    man["content_scripts"][0]["matches"] = pats
    if server:
        # 서무비서 웹 화면: 확장 설치 표시·기한 전달(marker.js)
        man["content_scripts"].append({"matches": [server + "/*"], "js": ["marker.js"], "run_at": "document_start"})
    if name:
        man["name"] = name[:45]
        man["short_name"] = name[:12]
    if version:
        if not re.match(r"^\d+(\.\d+){0,3}$", version):
            raise ValueError("버전 형식: 1.0.1")
        man["version"] = version
    with open(os.path.join(SRC, "config.js"), encoding="utf-8") as f:
        cfg = f.read()
    cfg = re.sub(r'server: "[^"]*"', "server: " + json.dumps(server), cfg, count=1)
    cfg = re.sub(r"erpHosts: \[[^\]]*\]", "erpHosts: " + json.dumps(pats), cfg, count=1)
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        for base, _, files in os.walk(SRC):
            for fn in sorted(files):
                full = os.path.join(base, fn)
                rel = os.path.relpath(full, SRC).replace(os.sep, "/")
                if rel.startswith(".") or rel.endswith(".md"):
                    continue
                arc = "secretary-extension/" + rel            # 압축을 풀면 폴더 하나로 — '폴더 선택'이 쉽도록
                if rel == "manifest.json":
                    z.writestr(arc, json.dumps(man, ensure_ascii=False, indent=2) + "\n")
                elif rel == "config.js":
                    z.writestr(arc, cfg)
                else:
                    z.write(full, arc)
    return buf.getvalue(), man
