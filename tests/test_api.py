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
