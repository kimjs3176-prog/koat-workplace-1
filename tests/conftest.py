"""서무비서 시험 공통 — 저장소 루트를 import 경로에 넣고, 외부 연동(GitHub·AI 키)을 끈 상태로 앱을 띄운다."""
import os
import sys

import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
for k in ("GITHUB_TOKEN", "GITHUB_REPO", "REG_UPLOAD_TOKEN", "ANTHROPIC_API_KEY", "GEMINI_API_KEY",
          "SECRETARY_OPEN_ADMIN", "VERCEL", "TRUST_PROXY"):
    os.environ.pop(k, None)

import api_server  # noqa: E402


@pytest.fixture()
def client():
    api_server.app.config["TESTING"] = True
    with api_server.app.test_client() as c:
        yield c


@pytest.fixture()
def remote(client):
    """다른 PC에서 들어온 요청처럼(127.0.0.1 이 아닌 주소)."""
    class R:
        def post(self, *a, **kw):
            kw.setdefault("environ_base", {"REMOTE_ADDR": "10.1.2.3"})
            return client.post(*a, **kw)
    return R()
