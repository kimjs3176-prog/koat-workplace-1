"""서무비서 브라우저 확장(크롬·엣지) 기관 배포본 만들기.

    python scripts/build_extension.py --server https://secretary.koat.or.kr \\
        [--erp https://kerp.koat.or.kr] [--erp https://gw.example.go.kr] [--name "KOAT 서무비서"] [--version 1.0.1]

dist/secretary-extension-<버전>.zip 을 만든다. 압축을 풀어 '압축해제된 확장 프로그램 로드'로 시험하거나,
그대로 Chrome 웹 스토어·Edge 추가 기능(비공개/조직 게시)에 올린다.
--server 를 넣으면 사용자가 설정하지 않아도 그 주소로 열린다. --erp 로 준 주소는 기본 권한에 포함된다.
"""
import argparse, io, json, os, re, zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "extension")


def origin_pattern(u: str) -> str:
    u = u.strip().rstrip("/")
    if not re.match(r"^https?://", u):
        u = "https://" + u
    m = re.match(r"^(https?://[^/]+)", u)
    if not m:
        raise SystemExit(f"주소를 읽지 못했습니다: {u}")
    return m.group(1) + "/*"


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--server", default="", help="서무비서 주소(https)")
    ap.add_argument("--erp", action="append", default=[], help="ERP·그룹웨어 주소(여러 번 가능)")
    ap.add_argument("--name", default="", help="확장 이름(기본: manifest 값)")
    ap.add_argument("--version", default="", help="버전(예: 1.0.1)")
    ap.add_argument("--out", default=os.path.join(ROOT, "dist"))
    a = ap.parse_args()

    server = a.server.strip().rstrip("/")
    if server and not re.match(r"^https://", server) and not re.match(r"^http://(localhost|127\.0\.0\.1)", server):
        raise SystemExit("--server 는 https 주소여야 합니다.")
    man = json.load(open(os.path.join(SRC, "manifest.json"), encoding="utf-8"))
    erps = [origin_pattern(x) for x in a.erp] or man["content_scripts"][0]["matches"]
    man["host_permissions"] = erps
    man["content_scripts"][0]["matches"] = erps
    if a.name:
        man["name"] = a.name
        man["short_name"] = a.name[:12]
    if a.version:
        if not re.match(r"^\d+(\.\d+){0,3}$", a.version):
            raise SystemExit("--version 형식: 1.0.1")
        man["version"] = a.version

    cfg = open(os.path.join(SRC, "config.js"), encoding="utf-8").read()
    cfg = re.sub(r'server: "[^"]*"', f"server: {json.dumps(server)}", cfg, count=1)
    cfg = re.sub(r"erpHosts: \[[^\]]*\]", "erpHosts: " + json.dumps(erps), cfg, count=1)

    os.makedirs(a.out, exist_ok=True)
    path = os.path.join(a.out, f"secretary-extension-{man['version']}.zip")
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
        for base, _, files in os.walk(SRC):
            for f in sorted(files):
                full = os.path.join(base, f)
                rel = os.path.relpath(full, SRC).replace(os.sep, "/")
                if rel == "manifest.json":
                    z.writestr(rel, json.dumps(man, ensure_ascii=False, indent=2) + "\n")
                elif rel == "config.js":
                    z.writestr(rel, cfg)
                else:
                    z.write(full, rel)
    print(f"✓ {path}")
    print(f"  서무비서 주소: {server or '(사용자가 설정)'}")
    print(f"  ERP 주소: {', '.join(erps)}")


if __name__ == "__main__":
    main()
