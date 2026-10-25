"""서무비서 브라우저 확장(크롬·엣지) 기관 배포본 만들기.

    python scripts/build_extension.py --server https://secretary.koat.or.kr \\
        [--erp https://kerp.koat.or.kr] [--erp https://gw.example.go.kr] [--name "KOAT 서무비서"] [--version 1.0.1]

dist/secretary-extension-<버전>.zip 을 만든다. 서무비서 화면의 '🧩 ERP 확장' 탭에서도 같은 zip 을 바로 받을 수 있다.
"""
import argparse, os, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
from extension_build import build_zip  # noqa: E402


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--server", default="", help="서무비서 주소(https)")
    ap.add_argument("--erp", action="append", default=[], help="ERP·그룹웨어 주소(여러 번 가능)")
    ap.add_argument("--name", default="", help="확장 이름(기본: manifest 값)")
    ap.add_argument("--version", default="", help="버전(예: 1.0.1)")
    ap.add_argument("--out", default=os.path.join(ROOT, "dist"))
    a = ap.parse_args()
    # 기관 설정의 ERP 화면 규칙(바탕 묶음 + 기관 맞춤)도 넣는다 — 웹 화면에서 받는 zip 과 같게(서버에 닿기 전에도 동작)
    try:
        from api_server import _sec_erp_profile
        profile = _sec_erp_profile()
    except Exception as e:  # noqa: BLE001 — 규칙 없이도 기본 규칙으로 동작하므로 알리고 계속
        print(f"! 기관 ERP 화면 규칙을 읽지 못해 기본 규칙만 넣습니다: {e}", file=sys.stderr)
        profile = None
    try:
        data, man = build_zip(a.server, a.erp, a.name, a.version, profile=profile)
    except ValueError as e:
        raise SystemExit(str(e))
    os.makedirs(a.out, exist_ok=True)
    path = os.path.join(a.out, f"secretary-extension-{man['version']}.zip")
    with open(path, "wb") as f:
        f.write(data)
    print(f"✓ {path}")
    print(f"  서무비서 주소: {a.server or '(사용자가 설정)'}")
    print(f"  ERP 주소: {', '.join(man['host_permissions'])}")


if __name__ == "__main__":
    main()
