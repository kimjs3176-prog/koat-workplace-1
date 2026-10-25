"""서무비서 API — 정상 응답, 잘못된 입력, 관리 저장 권한, AI 키 취급."""
import json
import time

import pytest

from conftest import api_server


def test_procedures_and_config(client):
    r = client.get("/api/secretary/procedures")
    assert r.status_code == 200
    d = r.get_json()
    assert len(d["common"]["procedures"]) >= 21
    assert client.get("/api/secretary/config").status_code == 200


def test_basis_lookup(client):
    r = client.get("/api/secretary/basis", query_string={"reg": "복무규정", "art": "16"})
    d = r.get_json()
    assert d["success"] and ("시간외" in d["text"] or "근무" in d["text"])


@pytest.mark.parametrize("path,body", [
    ("/api/secretary/audit", [1]),
    ("/api/secretary/audit", {"procedure": {"id": "x", "steps": []}, "case": {"dates": [1], "receipts": [{"amount": "abc"}]}}),
    ("/api/secretary/insights/event", [1]),
    ("/api/secretary/check", {"procedures": "x"}),
])
def test_bad_input_is_400_not_500(client, path, body):
    r = client.post(path, data=json.dumps(body), content_type="application/json")
    assert r.status_code == 400, r.data[:200]
    assert r.get_json()["success"] is False


def test_admin_save_needs_token_from_other_pc(remote):
    r = remote.post("/api/secretary/org", data=json.dumps({"procedures": []}), content_type="application/json")
    assert r.status_code == 401


def test_frame_policy_on_html(client):
    r = client.get("/")
    assert "frame-ancestors" in r.headers.get("Content-Security-Policy", "")


def test_form_index_reads_all_bracket_styles():
    labels = {(f["reg"], f["label"]): f["title"] for f in api_server._reg_forms_index()}
    assert ("공용차량관리규칙", "별지 제3호 서식") in labels          # 〔별지 …〕 괄호
    assert "운행" in labels[("공용차량관리규칙", "별지 제1호 서식")].replace(" ", "")   # 결재란 아래 실제 서식명
    assert all("한다" not in t for t in labels.values())               # 본문 문장이 서식명으로 들어가지 않음


def test_gemini_key_goes_in_header_not_url(monkeypatch):
    seen = {}

    class Resp:
        status_code = 200
        text = ""
        def json(self):
            return {"candidates": [{"content": {"parts": [{"text": "{\"ok\": true}"}]}}]}

    def fake_post(url, **kw):
        seen["url"], seen["headers"], seen["params"] = url, kw.get("headers") or {}, kw.get("params")
        return Resp()

    monkeypatch.setattr(api_server.req_lib, "post", fake_post)
    with api_server.app.test_request_context(headers={"X-AI-Key": "AIzaTESTKEY0123456789", "X-AI-Provider": "gemini"}):
        out = api_server._sec_ai_json("sys", "text", {"type": "object"})
    assert out == {"ok": True}
    assert "AIzaTESTKEY" not in seen["url"] and not seen["params"]
    assert seen["headers"].get("x-goog-api-key") == "AIzaTESTKEY0123456789"


def test_broken_ai_json_is_clean_error(monkeypatch):
    class Resp:
        status_code = 200
        text = ""
        def json(self):
            return {"candidates": [{"content": {"parts": [{"text": "앞말 {깨진: json} 뒷말"}]}}]}
    monkeypatch.setattr(api_server.req_lib, "post", lambda url, **kw: Resp())
    with api_server.app.test_request_context(headers={"X-AI-Key": "AIzaTESTKEY0123456789", "X-AI-Provider": "gemini"}):
        with pytest.raises(api_server._SecAIError):
            api_server._sec_ai_json("sys", "text", {"type": "object"})


def test_insights_min_n_bad_value_does_not_break(client, monkeypatch):
    """설정의 최소 인원이 숫자가 아니어도('3명') 핵심 API 가 멈추지 않는다."""
    real = api_server._sec_config
    monkeypatch.setattr(api_server, "_sec_config", lambda force=False: {**real(force), "insights": {"min_n": "3명"}})
    assert api_server._sec_ins_cfg()["min_n"] == 3
    assert client.get("/api/secretary/procedures").status_code == 200
    assert client.get("/api/secretary/insights").status_code == 200


def test_local_admin_not_behind_proxy(client):
    """토큰이 없는 서버: 같은 PC 프록시(X-Real-IP 등)를 거친 127.0.0.1 요청은 '이 컴퓨터'로 보지 않는다."""
    r = client.post("/api/secretary/config", json={"config": {"org": {"name": "x"}}}, headers={"X-Real-IP": "10.9.9.9"})
    assert r.status_code == 401


def test_upload_delete_without_slug_is_json_400(client):
    """slug 없는 폼 요청도 HTML 415 가 아니라 JSON 400 으로."""
    r = client.post("/api/regs/upload/delete", data={"x": "1"})
    assert r.status_code == 400 and r.is_json


def test_upload_limit_matches_announced(client):
    assert api_server.app.config["MAX_CONTENT_LENGTH"] >= api_server.REG_UPLOAD_MAX_MB * 1024 * 1024


def test_save_conflict_409(client):
    """화면이 불러온 판(base)과 저장된 판이 다르면 덮어쓰지 않는다(파일은 바뀌지 않음)."""
    r = client.post("/api/secretary/config", json={"config": {"org": {"name": "x"}}, "base": "1999-01-01 00:00"})
    assert r.status_code == 409 and r.get_json()["conflict"]
    r = client.post("/api/secretary/org", json={"procedures": [], "base": "1999-01-01 00:00"})
    assert r.status_code == 409


def test_ask_search_only_without_ai(client):
    """AI 키가 없으면 관련 조문만(답은 내지 않음)."""
    d = client.post("/api/secretary/ask", json={"q": "경조사 휴가 며칠"}).get_json()
    assert d["success"] and d["mode"] == "search" and not d["found"] and d["candidates"]
    assert any(c["reg"] == "복무규정" for c in d["candidates"])


def test_ask_ai_answer_requires_verified_quote(client, monkeypatch):
    """AI 답은 인용문이 실제 조문에 있을 때만 보여 준다(지어낸 인용이면 답을 감춘다)."""
    monkeypatch.setattr(api_server, "_sec_ai_provider", lambda: "claude")
    q = "경조사 휴가 며칠"
    items = api_server._sec_related_items(q, n=14, semantic=False)
    real = next(x for x in items if x["reg"] == "복무규정" and x["art"] == "34")
    sentence = real["text"][40:100].replace("하 고는", "하고는")   # 조문 안 문장(띄어쓰기 차이는 무시하고 확인)
    calls = {}

    def fake(system, text, schema, image=None, effort="low"):
        ids = schema["properties"]["citations"]["items"]["properties"]["id"]["enum"]
        aid = next(i for i in ids if f"[{i}] 「복무규정」 제34조" in text)
        return {"found": True, "answer": calls.get("answer", "결혼 5일 등입니다."), "caution": "",
                "citations": [{"id": aid, "quote": calls.get("quote", sentence)}]}
    monkeypatch.setattr(api_server, "_sec_ai_json", fake)
    d = client.post("/api/secretary/ask", json={"q": q}).get_json()
    assert d["mode"] == "ai" and d["found"] and d["answer"]
    assert d["citations"][0]["verified"] and d["citations"][0]["art"] == "34"
    calls["quote"] = "본인 결혼 시 30일의 특별휴가를 준다"           # 조문에 없는 문장
    d = client.post("/api/secretary/ask", json={"q": q}).get_json()
    assert not d["found"] and not d["answer"] and d["candidates"]
    calls["quote"] = "제"                                             # 짧은 조각은 확인으로 치지 않음
    assert not client.post("/api/secretary/ask", json={"q": q}).get_json()["found"]


def test_erp_profile_preset_and_custom():
    """ERP 규칙 = 일반 + 고른 묶음 + 기관 맞춤(맞춤 화면 규칙이 앞). 잘못된 규칙은 저장 전에 걸러진다."""
    clean = api_server._sec_clean_erp_rules({
        "preset": "douzone", "submit_words": ["결재상신", "", "  "],
        "screen_rules": [{"by": "url", "match": "/hr/trip/", "proc": "domestic-trip", "q": "출장 가요"},
                         {"by": "title", "match": "([", "proc": "domestic-trip"},          # 정규식 오류 → 버림
                         {"by": "title", "match": "휴가", "proc": "No Such!"}],              # 절차 id 꼴 아님 → 버림
        "skip_paths": ["/mail/", "(("], "labels": {"start": ["출장일자"], "bogus": ["x"]}})
    assert clean["preset"] == "douzone" and clean["submit_words"] == ["결재상신"]
    assert [r["match"] for r in clean["screen_rules"]] == ["/hr/trip/"] and clean["skip_paths"] == ["/mail/"]
    assert clean["labels"] == {"start": ["출장일자"]}
    prof = api_server._sec_erp_profile({"erp": clean})
    assert prof["screen_rules"][0]["match"] == "/hr/trip/"                     # 기관 맞춤이 먼저
    assert "결재상신" in prof["submit_words"] and "/mail2?/" in prof["skip_paths"]   # 일반 묶음도 함께
    assert not any("koat" in r["match"] for r in prof["screen_rules"])        # 다른 기관에는 KOAT 주소 규칙이 없다
    assert "출장일자" in prof["labels"]["start"]


def test_erp_meta_and_zip_carry_profile(client):
    import io, zipfile
    d = client.get("/api/secretary/erp/meta").get_json()
    assert d["erp"]["preset"] == "koat" and any("/koat/bt/" in r["match"] for r in d["erp"]["screen_rules"])
    z = zipfile.ZipFile(io.BytesIO(client.get("/api/secretary/extension.zip").data))
    cfg = z.read("secretary-extension/config.js").decode()
    assert "SEC_PROFILE_DEFAULT = {" in cfg and "/koat/bt/" in cfg
    assert client.get("/api/secretary/erp/presets").get_json()["presets"]["sap"]["verified"] is False


def test_related_items_find_the_right_article():
    """규정 질의응답의 조문 찾기(키워드) — 흔한 물음에서 답이 든 조문이 위 5개 안에."""
    cases = {"반차 쓰면 연차 몇 개 차감돼?": ("복무규정", "31"), "경조사 휴가 며칠": ("복무규정", "34"),
             "병가 며칠 넘으면 진단서 필요해?": ("복무규정", "33"), "숙박비 상한 얼마야": ("여비규정", "15"),
             "육아휴직 몇 번 나눠 쓸 수 있어?": ("인사규정", "55"), "선물 받으면 신고해야 하나요": ("임직원 행동강령", "20"),
             "연차 저축 가능해?": ("복무규정", "29"), "출장 다녀오면 정산은 언제까지 해야 하나요": ("여비규정", "8")}
    for q, want in cases.items():
        top = [(x["reg"], x["art"]) for x in api_server._sec_related_items(q, n=8, semantic=False)[:5]]
        assert want in top, (q, top)



def test_ask_rejects_numbers_not_in_cited_article(client, monkeypatch):
    """인용이 맞아도 답의 숫자가 근거 조문에 없으면(지어낸 일수) 답을 감춘다."""
    monkeypatch.setattr(api_server, "_sec_ai_provider", lambda: "claude")
    q = "경조사 휴가 며칠"
    real = next(x for x in api_server._sec_related_items(q, n=14, semantic=False) if x["art"] == "34")

    def fake(system, text, schema, image=None, effort="low"):
        ids = schema["properties"]["citations"]["items"]["properties"]["id"]["enum"]
        aid = next(i for i in ids if f"[{i}] 「복무규정」 제34조" in text)
        return {"found": True, "answer": "결혼하면 365일 쉽니다.", "caution": "", "citations": [{"id": aid, "quote": real["text"][40:100]}]}
    monkeypatch.setattr(api_server, "_sec_ai_json", fake)
    d = client.post("/api/secretary/ask", json={"q": q}).get_json()
    assert not d["found"] and "숫자" in d["note"]


def test_erp_regex_rejects_nested_repeats():
    # 반복을 겹친 정규식은 긴 화면 제목에서 ERP 탭을 멈춘다 — 저장 단계에서 버린다
    ok = api_server._sec_rx_ok
    assert not ok(r"^(\s*\S+)*\s*신청서$") and not ok(r"(a+)+") and not ok(r"(a{1,3})*")
    assert ok(r"^/erp/(trip|travel)/apply") and ok(r"출장\s*(신청|정산)") and ok(r"(출장|여비)+정산")


def test_audit_config_tolerates_hand_edited_numbers(monkeypatch):
    base = api_server._sec_config()
    monkeypatch.setattr(api_server, "_sec_config", lambda *a, **k: {**base, "audit": {
        "lodging_caps": [{"name": "서울", "cap": "100,000"}, {"name": "기타", "cap": "7만"}, {"name": "x", "cap": "?"}],
        "lodging_extra_ratio": "30%", "trip_procs": "domestic-trip", "draft_required": {"a": "b"}}})
    c = api_server._sec_audit_cfg()
    assert [x["cap"] for x in c["lodging_caps"]] == [100000, 70000]
    assert c["lodging_extra_ratio"] == pytest.approx(0.3)
    assert isinstance(c["trip_procs"], list) and c["draft_required"] == {}


def test_reg_diff_finds_inserted_article_that_took_an_old_number():
    words = ["출장", "휴가", "물품", "행사", "계약", "회계", "감사"]
    old = "\n".join(f"제{i}조(조문{i}) {w}에 관한 사항은 {w} 담당 부서가 {w} 계획을 세워 처리하고 {w} 결과를 보고한다." for i, w in enumerate(words, 1))
    new = old.replace("제7조(조문7)", "제8조(조문7)").replace("제6조(조문6)", "제7조(조문6)").replace("제5조(조문5)", "제6조(조문5)")
    new = new.replace("제6조(조문5)", "제5조(신설 조문) 직원은 새로 정한 기한 안에 그 결과를 부서장에게 보고하여야 한다.\n제6조(조문5)")
    d = api_server._sec_reg_diff(old, new)
    assert d["moved"] == {"5": "6", "6": "7", "7": "8"}
    assert [a["no"] for a in d["added"]] == ["5"]


def test_regulation_files_get_script_blocking_csp(client):
    slug = api_server._load_reg_manifest()[0]["slug"]
    r = client.get(f"/regulations/{slug}/index.html")
    assert r.status_code == 200 and "script-src 'none'" in r.headers["Content-Security-Policy"]
    out = api_server._sanitize_html('<svg/onload=alert(1)><a href=javascript:alert(1)>x</a><p class="a"onclick="b">ok</p>')
    assert "onload" not in out and "javascript" not in out and "onclick" not in out and 'class="a"' in out


def test_check_rejects_too_many_reg_names(client):
    procs = [{"id": f"p{i}", "title": "t", "steps": [{"t": "s", "basis": [{"reg": f"없는규정{i}-{k}"} for k in range(6)]}]} for i in range(80)]
    r = client.post("/api/secretary/check", json={"procedures": procs})
    assert r.status_code == 400


def test_manifest_reload_when_another_worker_writes(tmp_path, monkeypatch):
    # 다른 작업자가 manifest 를 고쳐 쓰면 다시 읽는다(옛 사본으로 덮어써 등록을 지우지 않게)
    man = api_server._load_reg_manifest()
    stamp = api_server._REG_MANIFEST_STAMP
    monkeypatch.setattr(api_server, "_REG_MANIFEST_STAMP", (0, 0))
    api_server._SEC_RESOLVE_CACHE[("x", "")] = (None, "")
    assert api_server._load_reg_manifest() == man
    assert api_server._REG_MANIFEST_STAMP == stamp and not api_server._SEC_RESOLVE_CACHE


def test_ai_draft_lines_must_cite_sources(client, monkeypatch):
    # AI 문서 초안: 줄마다 근거 자료가 있어야 하고, 자료에 없는 숫자·겹치는 말이 없는 줄은 채우지 않는다
    monkeypatch.setattr(api_server, "_sec_ai_provider", lambda: "claude")
    monkeypatch.setattr(api_server, "_sec_ai_rate_ok", lambda: True)
    monkeypatch.setattr(api_server, "_sec_ai_json", lambda *a, **k: {"lines": [
        {"text": "- 스마트팜 실증사업 추진 현황 협의함", "src": ["S1"]},
        {"text": "참석자 12명과 예산 3억 원 확정", "src": ["S1"]},        # 자료에 없는 숫자
        {"text": "향후 일정 논의", "src": []},                               # 근거 없음
        {"text": "우주 정거장 견학", "src": ["S2"]},                          # 자료와 겹치는 말 없음
    ], "missing": ["협의 결과(합의 사항)"]})
    r = client.post("/api/secretary/ai/draft", json={"draft": "출장결과보고서", "field": "주요 내용",
                                                     "fields": {"출장지": "세종"},
                                                     "sources": [{"kind": "이 건 메모", "text": "세종 농식품부 방문, 스마트팜 실증사업 추진 현황 협의"},
                                                                 {"kind": "일정", "text": "세종 출장 10월 5일"}]})
    d = r.get_json()
    assert d["success"] and [x["ok"] for x in d["lines"]] == [True, False, False, False]
    assert d["lines"][0]["text"] == "스마트팜 실증사업 추진 현황 협의함"           # 줄머리 기호 정리
    assert "숫자" in d["lines"][1]["why"] and d["sources"][0] == {"id": "S1", "kind": "이 건 메모"}
    assert client.post("/api/secretary/ai/draft", json={"draft": "x", "field": "y", "sources": []}).status_code == 400


def test_ai_output_monthly_report(client, monkeypatch, tmp_path):
    # AI 결과를 사람이 처리한 숫자(만듦·확인·고침·버림, 낸 문서)를 월별로 모은다 — 판단을 바꾸면 앞 상태를 뺀다
    monkeypatch.setattr(api_server, "SEC_INS_FILE", str(tmp_path / "ins.json"))
    monkeypatch.setattr(api_server, "_SEC_KV_URL", "")
    ev = lambda **b: client.post("/api/secretary/insights/event", json={"type": "ai", **b})   # noqa: E731
    assert ev(kind="receipt", st="made", n=3).status_code == 200     # 영수증은 한 요청에 한 건만(익명 숫자 부풀리기 방지)
    ev(kind="receipt", st="made"); ev(kind="receipt", st="made")
    ev(kind="audit", st="made", n=99)                              # 감사 지적은 한 번에 12건까지
    ev(kind="receipt", st="ok"); ev(kind="receipt", st="ok")
    ev(kind="receipt", st="pending", prev="ok")                 # 확인 취소
    ev(kind="receipt", st="rejected")
    ev(kind="draft", st="made"); ev(kind="draft", st="edited")
    ev(kind="output", st="ai"); ev(kind="output", st="plain")
    assert ev(kind="receipt", st="bogus").status_code == 400 and ev(kind="x", st="made").status_code == 400
    d = client.get("/api/secretary/insights/ai").get_json()
    m = d["months"][0]
    assert d["available"] and m["receipt"] == {"made": 3, "ok": 1, "edited": 0, "rejected": 1, "pending": 1}
    assert m["draft"]["edited"] == 1 and m["draft"]["pending"] == 0 and m["output"] == {"plain": 1, "ai": 1}
    assert m["audit"]["made"] == 12


def test_draft_field_ai_flag_kept_in_data():
    procs = api_server._sec_read_json(api_server.SEC_COMMON_PATH, {})
    assert any(f.get("ai") for f in procs["drafts"]["trip-report"]["fields"])


def test_ai_draft_line_needs_most_content_words_in_source():
    # 한 낱말만 겹친다고 근거로 보지 않는다 — '세종'만 같고 '승인·예산 확보'는 자료에 없는 줄은 채우지 않는다
    src = "세종 농식품부 방문, 스마트팜 실증사업 추진 현황 협의"
    ok = api_server._sec_draft_line_ok
    assert ok("스마트팜 실증사업 추진 현황 협의함", src, "")[0]
    assert ok("농식품부 방문하여 실증사업 현황 확인", src, "")[0]
    bad = ok("세종 사업 최종 승인 및 예산 확보 완료", src, "")
    assert not bad[0] and "승인" in bad[1]
    assert not ok("관련 협의 진행", src, "")[0]                     # 틀 말뿐인 줄


def test_ai_review_counts_in_month_result_was_made(client, monkeypatch, tmp_path):
    # 지난달에 만든 AI 결과를 이번 달에 확인하면 지난달 숫자에 더한다(지난달 '대기'가 줄어든다). 엉뚱한 달은 이번 달로
    monkeypatch.setattr(api_server, "SEC_INS_FILE", str(tmp_path / "ins.json"))
    monkeypatch.setattr(api_server, "_SEC_KV_URL", "")
    monkeypatch.setattr(api_server, "_sec_ai_month", lambda: "2026-11")
    ev = lambda **b: client.post("/api/secretary/insights/event", json={"type": "ai", **b})   # noqa: E731
    ev(kind="receipt", st="made", month="2026-10")
    ev(kind="receipt", st="ok", month="2026-10")
    ev(kind="receipt", st="made", month="2031-01")              # 미래 달 → 이번 달
    months = {m["month"]: m for m in client.get("/api/secretary/insights/ai").get_json()["months"]}
    assert months["2026-10"]["receipt"]["ok"] == 1 and months["2026-10"]["receipt"]["pending"] == 0
    assert months["2026-11"]["receipt"]["made"] == 1 and "2031-01" not in months


def test_ai_report_rejects_inconsistent_counts(client, monkeypatch, tmp_path):
    # 만든 적 없는 결과의 '확인'·없는 판단의 되돌리기는 받지 않는다 — 사용률이 100%를 넘는 꾸민 숫자가 쌓이지 않게
    monkeypatch.setattr(api_server, "SEC_INS_FILE", str(tmp_path / "ins.json"))
    monkeypatch.setattr(api_server, "_SEC_KV_URL", "")
    ev = lambda **b: client.post("/api/secretary/insights/event", json={"type": "ai", **b})   # noqa: E731
    assert ev(kind="draft", st="ok").status_code == 409                       # 만든 것 없음
    assert ev(kind="draft", st="made").status_code == 200
    assert ev(kind="draft", st="ok").status_code == 200
    assert ev(kind="draft", st="ok").status_code == 409                       # 1건 만들고 2번 확인
    assert ev(kind="draft", st="pending", prev="rejected").status_code == 409 # 없는 판단 되돌리기
    assert ev(kind="draft", st="rejected", prev="ok").status_code == 200      # 판단 바꾸기
    m = client.get("/api/secretary/insights/ai").get_json()["months"][0]["draft"]
    assert m == {"made": 1, "ok": 0, "edited": 0, "rejected": 1, "pending": 0}


def test_ai_audit_finding_id_follows_title_and_bad_src_drops_line(client, monkeypatch):
    # AI 지적 id 는 순서가 아니라 제목 — 다시 감사해 순서가 바뀌어도 같은 지적은 같은 id
    monkeypatch.setattr(api_server, "_sec_ai_provider", lambda: "claude")
    monkeypatch.setattr(api_server, "_sec_ai_rate_ok", lambda: True)
    proc = json.loads(json.dumps(api_server._sec_read_json(api_server.SEC_COMMON_PATH, {})["procedures"][0]))

    def run(titles):
        monkeypatch.setattr(api_server, "_sec_ai_json", lambda *a, **k: {"summary": "", "findings": [
            {"severity": "low", "title": t, "detail": "", "basis": "x", "fix": ""} for t in titles]})
        d = client.post("/api/secretary/audit", json={"procedure": proc, "case": {}, "ai": True}).get_json()
        return {f["title"]: f["id"] for f in d["findings"] if f["source"] == "ai"}
    a, b = run(["가 지적", "나 지적"]), run(["나 지적", "가 지적"])
    assert a == b and len(set(a.values())) == 2
    # AI 초안: 출처를 숫자·객체로 돌려줘도 요청 전체가 실패하지 않고 그 줄만 근거 없음
    monkeypatch.setattr(api_server, "_sec_ai_json", lambda *a, **k: {"lines": [
        {"text": "스마트팜 실증사업 협의", "src": 1}, {"text": "스마트팜 실증사업 협의", "src": [{"x": 1}]},
        {"text": "스마트팜 실증사업 협의", "src": ["S1"]}], "missing": []})
    r = client.post("/api/secretary/ai/draft", json={"draft": "출장결과보고서", "field": "주요 내용",
                                                     "sources": [{"kind": "메모", "text": "스마트팜 실증사업 협의"}]})
    assert r.status_code == 200 and [x["ok"] for x in r.get_json()["lines"]] == [False, False, True]


def test_ai_report_check_is_atomic_under_concurrent_requests(monkeypatch, tmp_path):
    # 1건 만든 결과에 '확인' 10건이 동시에 와도 1건만 받는다(검사와 기록을 같은 잠금 안에서)
    import threading as th
    monkeypatch.setattr(api_server, "SEC_INS_FILE", str(tmp_path / "ins.json"))
    monkeypatch.setattr(api_server, "_SEC_KV_URL", "")
    monkeypatch.setattr(api_server, "_sec_ins_rate_ok", lambda *a, **k: True)
    real = api_server._sec_kv

    def slow(cmds):                       # 읽은 뒤 잠깐 쉬어 경합을 일부러 만든다
        out = real(cmds)
        if cmds and cmds[0][0] == "HGETALL":
            time.sleep(0.02)
        return out
    monkeypatch.setattr(api_server, "_sec_kv", slow)
    app = api_server.app
    with app.test_client() as c:
        assert c.post("/api/secretary/insights/event", json={"type": "ai", "kind": "draft", "st": "made"}).status_code == 200
    codes = []

    def go():
        with app.test_client() as c:
            codes.append(c.post("/api/secretary/insights/event", json={"type": "ai", "kind": "draft", "st": "ok"}).status_code)
    ts = [th.Thread(target=go) for _ in range(10)]
    [t.start() for t in ts]
    [t.join() for t in ts]
    assert sorted(codes) == [200] + [409] * 9
    with app.test_client() as c:
        assert c.get("/api/secretary/insights/ai").get_json()["months"][0]["draft"]["ok"] == 1
