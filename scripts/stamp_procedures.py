"""서무비서 절차에 근거 규정의 '확인 당시 개정 정보'를 기록한다.

    python scripts/stamp_procedures.py            # secretary/procedures.json(공통 절차)
    python scripts/stamp_procedures.py --check    # 기록하지 않고 호환성 점검만 출력(CI용, 문제 있으면 종료코드 1)

절차를 원문과 대조해 검토한 뒤 실행하세요. 이후 규정이 개정·재업로드되면
화면에 '근거 규정 개정됨 — 재확인 필요'가 표시됩니다. 기관 절차(org.json)는 화면에서 저장할 때 자동 기록됩니다.
"""
import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
import api_server as A  # noqa: E402


def main():
    check = "--check" in sys.argv
    path = A.SEC_COMMON_PATH
    with open(path, encoding="utf-8") as f:
        data = json.load(f)
    forms = A._sec_forms_set()
    bad = 0
    for p in data.get("procedures", []):
        if not check:
            p.pop("verified", None)
            A._sec_stamp(p)
        st = A._sec_proc_status(p, forms)
        if st["missing"] or st["stale"] or st["approx"]:
            bad += 1
            print(f"✗ {p['id']}: 연결 안 됨 {st['missing']} · 근사 {st['approx']} · 개정 {st['stale']}")
        else:
            print(f"✓ {p['id']}")
    if not check:
        with open(path, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=1)
            f.write("\n")
        print(f"기록 완료: {path}")
    if check and bad:
        sys.exit(1)


if __name__ == "__main__":
    main()
