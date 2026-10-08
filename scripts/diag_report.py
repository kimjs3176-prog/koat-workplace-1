#!/usr/bin/env python3
"""서무비서 확장 진단 보고서(.json) 요약 — 실제 ERP 시험 뒤 무엇을 고칠지 뽑아낸다.

    python scripts/diag_report.py diag/20261008-101500-abcd.json   # 보고서 하나
    python scripts/diag_report.py diag/                              # 폴더의 보고서 전부

보는 것
  1) 사용자 메모(시험하면서 남긴 '여기서 안 됨' 같은 말)와 오류
  2) 화면 인식: 어떤 화면을 무슨 업무로 알아봤는지 / 못 알아본 화면의 제목·문구 → SEC_RULES 추가 후보
  3) 결재 전 점검: 눌린 버튼 이름 중 가로채지 못한 '상신·결재' 류 → guard.js SUBMIT 추가 후보
  4) 칸 채우기: 프레임별 채운 칸·못 찾은 칸과 찾은 방법(sel/id/name/label/editor)
  5) 스냅샷: 프레임 구조(같은 출처 여부·편집기), 칸 목록, 버튼, 편집기·화면 라이브러리 단서
"""
import json
import os
import re
import sys
from collections import Counter, defaultdict

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SUBMIT = re.compile(r"^(결재\s*)?상신(하기)?$|결재\s*(요청|올리기|올림|상신)|^기안\s*완료$|^(제출|신청|승인\s*요청)(하기)?$|^결재\s*하기$")


def load_rules():
    """extension/config.js 의 SEC_RULES 정규식(자바스크립트 → 파이썬 근사)."""
    try:
        src = open(os.path.join(ROOT, "extension", "config.js"), encoding="utf-8").read()
    except OSError:
        return []
    out = []
    for m in re.finditer(r'\[/(.+?)/\s*,\s*"([^"]+)"\s*,\s*"([^"]+)"\]', src):
        try:
            out.append((re.compile(m.group(1)), m.group(2), m.group(3)))
        except re.error:
            pass
    return out


def hm(e):
    return (e.get("t") or "")[11:19]


def h(title):
    print(f"\n## {title}")


def report(path, r):
    log = r.get("log") or []
    print(f"# 진단 보고서: {os.path.basename(path)}")
    print(f"- 만든 때 {r.get('created', '')} / 확장 {r.get('version', '')} / 기록 {len(log)}건")
    s = r.get("settings") or {}
    print(f"- 서버 {s.get('server') or '(없음)'} / ERP 주소 {s.get('erpHosts') or '(없음)'} / "
          f"결재 전 점검 {s.get('guard')} / 자동 안내 {s.get('autoAsk')}")
    for f in r.get("findings") or []:                 # 진단 센터의 자동 진단(1.4.0+)
        print(f"- 자동 진단[{f.get('sev')}] {f.get('title')}")
    if log:
        print(f"- 기간 {log[0].get('t', '')[:19]} ~ {log[-1].get('t', '')[:19]}")
    by = Counter(e.get("ev") for e in log)
    print("- 사건 수: " + ", ".join(f"{k} {v}" for k, v in by.most_common(20)))

    h("1. 사용자 메모")
    notes = [e for e in log if e.get("ev") == "note"]
    for e in notes:
        print(f"- {hm(e)} {(e.get('d') or {}).get('text', '')}  ({e.get('page', '')})")
    if not notes:
        print("- (없음)")

    h("2. 오류·실패")
    bad = [e for e in log if e.get("ev") in ("error", "frames.error")
           or (isinstance(e.get("d"), dict) and e["d"].get("ok") is False)]
    for e in bad[:60]:
        print(f"- {hm(e)} [{e.get('src')}] {e.get('ev')} {json.dumps(e.get('d'), ensure_ascii=False)[:240]}")
    if not bad:
        print("- (없음)")

    h("3. 화면 인식")
    rules = load_rules()
    seen = Counter()
    for e in log:
        if e.get("ev") == "detect":
            d = e.get("d") or {}
            ctx = d.get("ctx") or {}
            seen[(ctx.get("q") or ctx.get("label") or json.dumps(ctx, ensure_ascii=False)[:60], d.get("by"), d.get("hit"))] += 1
    for (q, by_, hit), n in seen.most_common(30):
        print(f"- 인식 {n}회: '{q}' ← {by_} (맞은 문구: {hit})")
    ign = [e for e in log if e.get("ev") == "context.ignored"]
    if ign:
        print(f"- 덜 구체적이라 무시한 인식 {len(ign)}회(정상 동작일 수 있음)")
    nones = [e for e in log if e.get("ev") == "detect.none" and (e.get("d") or {}).get("texts")]
    if nones:
        print("\n못 알아본 화면(문구를 보고 SEC_RULES 나 화면 규칙을 추가):")
    words = Counter()
    for e in nones:
        d = e.get("d") or {}
        texts = d.get("texts") or []
        print(f"- {hm(e)} {e.get('page', '')} {d.get('frame', '')} {d.get('url', '')}")
        for t in texts[:12]:
            print(f"    · {t}")
        for t in texts:
            for w in re.findall(r"[가-힣]{2,}", t):
                words[w] += 1
    if words:
        cand = [w for w, _ in words.most_common(40) if not any(rx.search(w) for rx, _, _ in rules)]
        print("  자주 보인 낱말(기존 규칙에 안 걸리는 것): " + ", ".join(cand[:20]))

    h("4. 결재 전 점검(버튼)")
    btn = Counter()
    for e in log:
        if e.get("ev") == "button":
            d = e.get("d") or {}
            btn[(d.get("label"), bool(d.get("submit")))] += 1
    for (label, sub), n in btn.most_common(40):
        mark = "가로챔" if sub else "통과(SUBMIT 아님)"
        print(f"- '{label}' {n}회 — {mark}")
    miss = sorted({lab for (lab, sub) in btn if not sub and lab and re.search(r"상신|결재|기안|제출", lab)})
    if miss:
        print("  ⚠ 상신 버튼일 수 있는데 가로채지 않은 이름 → guard.js SUBMIT 에 추가 검토: " + ", ".join(miss))
    for ev in ("guard.show", "guard.continue", "guard.cancel"):
        n = by.get(ev, 0)
        if n:
            print(f"- {ev} {n}회")
    if not btn:
        print("- 버튼 기록 없음(상신·결재 류 버튼을 누르지 않았거나 ERP 에 확장이 붙지 않음)")

    h("5. 초안 넣기")
    fills = [e for e in log if e.get("ev") == "fillmap"]
    for e in fills:
        d = e.get("d") or {}
        print(f"- {hm(e)} 화면 '{d.get('screen')}' {'(시험)' if d.get('test') else ''} 채움 {d.get('filled')} / 못 찾음 {d.get('missing')}")
        for f in d.get("perFrame") or []:
            how = f.get("how") or {}
            if how:
                print(f"    [{f.get('path') or '(최상위)'}] " + "; ".join(f"{k}={v}" for k, v in how.items()))
    ins = [e for e in log if e.get("ev") in ("insert", "erp.insert")]
    okn = sum(1 for e in ins if (e.get("d") or {}).get("ok"))
    if ins:
        print(f"- 한 칸 넣기/초안 넣기 {len(ins)}회(성공 표시 {okn})")
    focus = Counter()
    for e in log:
        if e.get("ev") == "focus":
            d = e.get("d") or {}
            focus[(d.get("frame") or "", d.get("label"), d.get("kind"))] += 1
    if focus:
        print("- 사용자가 누른 입력란(프레임 / 이름 / 종류):")
        for (fr, lab, kind), n in focus.most_common(25):
            print(f"    · {fr or '(최상위)'} / {lab or '(이름 없음)'} / {kind} ×{n}")
    if not fills and not ins:
        print("- (없음)")

    h("6. 화면 구조 스냅샷")
    snaps = [e for e in log if e.get("ev") == "snapshot"]
    for e in snaps:
        d = e.get("d") or {}
        print(f"\n### {hm(e)} {d.get('title', '')}  {d.get('page', '')}")
        if d.get("context"):
            print(f"- 인식: {json.dumps(d['context'], ensure_ascii=False)[:160]}")
        for fr in d.get("frames") or []:
            if not isinstance(fr, dict):
                continue
            print(f"- 프레임 [{fr.get('path') or '(최상위)'}] {fr.get('title', '')} {fr.get('url', '')}")
            if fr.get("headings"):
                print(f"    제목 후보: {' | '.join(fr['headings'][:8])}")
            flds = fr.get("fields") or []
            if flds:
                print(f"    칸 {len(flds)}개: " + ", ".join(f"{x.get('label') or '?'}({x.get('kind')}{'#' + x['id'] if x.get('id') else ''})" for x in flds[:30]))
            for f in fr.get("iframes") or []:
                print(f"    iframe id={f.get('id')!r} name={f.get('name')!r} src={f.get('src')} 같은출처={f.get('sameOrigin')} "
                      f"designMode={f.get('designMode')} 편집={f.get('editable')} {f.get('w')}x{f.get('h')}")
            if fr.get("buttons"):
                print("    버튼: " + ", ".join(b.get("t", "") for b in fr["buttons"][:40]))
            if fr.get("scriptHints"):
                print("    라이브러리 단서: " + ", ".join(fr["scriptHints"]))
            print(f"    contenteditable {fr.get('contentEditable')}, form {fr.get('forms')}, script {fr.get('scripts')}")
    if not snaps:
        print("- (스냅샷 없음 — 진단 센터의 '📸 화면 구조 기록'을 화면마다 눌러 주세요)")

    h("7. 확장이 붙은 프레임")
    loads = defaultdict(set)
    for e in log:
        if e.get("ev") == "load":
            d = e.get("d") or {}
            loads[e.get("page", "")].add(f"{d.get('frame') or '(최상위)'} {d.get('url', '')}{' designMode' if d.get('designMode') else ''}")
    for page, fr in list(loads.items())[:20]:
        print(f"- {page}")
        for x in sorted(fr)[:15]:
            print(f"    · {x}")
    if not loads:
        print("- (없음 — ERP 주소가 확장 설정에 맞는지, 확장이 설치·활성인지 확인)")


def main(argv):
    if len(argv) < 2:
        print(__doc__)
        return 1
    target = argv[1]
    files = ([os.path.join(target, f) for f in sorted(os.listdir(target)) if f.endswith(".json")]
             if os.path.isdir(target) else [target])
    for i, f in enumerate(files):
        with open(f, encoding="utf-8") as fh:
            r = json.load(fh)
        if r.get("kind") != "secretary-diag":
            print(f"(건너뜀: {f} 는 진단 보고서가 아님)")
            continue
        if i:
            print("\n" + "=" * 70 + "\n")
        report(f, r)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
