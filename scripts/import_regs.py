"""기관 내규를 폴더째 일괄 등록한다(다른 기관 도입 첫 단계).

    python scripts/import_regs.py ./내규폴더              # 폴더 안 문서를 모두 등록(같은 규정명은 개정본으로 교체)
    python scripts/import_regs.py ./내규폴더 --reset      # 기존 규정을 모두 지우고 새로 등록(새 기관 시작)
    python scripts/import_regs.py ./내규폴더 --dry-run    # 등록할 목록만 확인

파일명 규칙: "규정명(개정 정보).hwpx" — 예) 여비규정(2025년도 3월 일부개정).hwpx
지원 형식: .hwpx .docx .html .htm .txt .pdf (한글 .hwp 는 한글에서 .hwpx 로 저장한 뒤 올리세요)

화면의 /upload 와 같은 변환·저장 로직을 그대로 쓰며, 로컬 파일에 씁니다.
등록 뒤에는 git commit·push 로 배포본에 반영하고, 의미 검색을 쓰려면
scripts/build_embeddings.py 로 색인을 다시 만드세요.
"""
import io
import os
import shutil
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
# 로컬 파일에 쓰도록 GitHub 커밋 경로는 끈다(대량 등록을 커밋 수백 개로 만들지 않기 위함)
for k in ("GITHUB_TOKEN", "GITHUB_REPO"):
    os.environ.pop(k, None)
os.environ.pop("REG_UPLOAD_TOKEN", None)

import api_server as A  # noqa: E402

EXTS = {".hwpx", ".docx", ".html", ".htm", ".txt", ".pdf"}


def reset():
    """기존 규정·목록·의미검색 색인을 비운다(새 기관 시작)."""
    reg_dir = A.REG_DIR
    for name in os.listdir(reg_dir):
        p = os.path.join(reg_dir, name)
        if os.path.isdir(p):
            shutil.rmtree(p)
    with open(A.REG_MANIFEST_PATH, "w", encoding="utf-8") as f:
        f.write("[]\n")
    for vec in ("regulations_vectors.bin", "regulations_vectors.json"):
        p = os.path.join(ROOT, vec)
        if os.path.exists(p):
            os.remove(p)
    A._REG_MANIFEST = None
    print("기존 규정·목록·의미검색 색인을 비웠습니다.")


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    if not args or not os.path.isdir(args[0]):
        print(__doc__)
        sys.exit(2)
    folder = args[0]
    files = sorted(f for f in os.listdir(folder)
                   if os.path.splitext(f)[1].lower() in EXTS and not f.startswith("."))
    skipped = sorted(f for f in os.listdir(folder) if f.lower().endswith(".hwp"))
    print(f"등록 대상 {len(files)}건" + (f" · 건너뜀(.hwp, .hwpx 로 변환 필요) {len(skipped)}건" if skipped else ""))
    if "--dry-run" in sys.argv:
        for f in files:
            print("  -", f)
        for f in skipped:
            print("  × (.hwpx 로 변환 필요)", f)
        return
    if "--reset" in sys.argv:
        reset()
    client = A.app.test_client()
    ok = fail = 0
    for f in files:
        with open(os.path.join(folder, f), "rb") as fh:
            raw = fh.read()
        r = client.post("/api/regs/upload", data={"file": (io.BytesIO(raw), f)},
                        content_type="multipart/form-data")
        d = r.get_json(silent=True) or {}
        if r.status_code == 200 and d.get("success"):
            ok += 1
            e = d.get("entry") or {}
            warn = f" ⚠ {d['warning']}" if d.get("warning") else ""
            print(f"  ✓ {e.get('title')} ({e.get('revision') or '개정 정보 없음'}){warn}")
        else:
            fail += 1
            print(f"  ✗ {f}: {d.get('error') or r.status_code}")
    A._REG_MANIFEST = None
    print(f"완료: 성공 {ok} · 실패 {fail}. 총 등록 규정 {len(A._load_reg_manifest())}건")
    print("다음: 화면 [규정·절차 관리 › 호환성 점검·규정명 매핑]에서 절차와 규정 연결을 확인하세요.")
    if fail:
        sys.exit(1)


if __name__ == "__main__":
    main()
