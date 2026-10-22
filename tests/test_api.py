"""서무비서 API — 정상 응답, 잘못된 입력, 관리 저장 권한, AI 키 취급."""
import json

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
