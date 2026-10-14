"""기본 탑재 절차(secretary/procedures.json)의 형식·근거 연결 점검."""
import json
import os

import pytest

from conftest import ROOT, api_server

PROCS = json.load(open(os.path.join(ROOT, "secretary", "procedures.json"), encoding="utf-8"))
MANIFEST = {m["title"]: m for m in json.load(open(os.path.join(ROOT, "regulations_manifest.json"), encoding="utf-8"))}


def test_schema():
    jsonschema = pytest.importorskip("jsonschema")
    schema = json.load(open(os.path.join(ROOT, "secretary", "schema", "procedures.schema.json"), encoding="utf-8"))
    jsonschema.validate(PROCS, schema)


def test_ids_and_step_keys_unique():
    ids = [p["id"] for p in PROCS["procedures"]]
    assert len(ids) == len(set(ids))
    for p in PROCS["procedures"]:
        keys = [s.get("k") for s in p["steps"]]
        assert all(keys), f"{p['id']}: 단계 키(k) 없음"
        assert len(keys) == len(set(keys)), f"{p['id']}: 단계 키 중복"


@pytest.mark.parametrize("p", PROCS["procedures"], ids=lambda p: p["id"])
def test_deadline_refs_and_drafts(p):
    dates = {d["k"] for d in p.get("dates") or []}
    for s in p["steps"]:
        dl = s.get("deadline")
        if dl:
            assert dl["ref"] in dates, f"{p['id']}: 기한 기준일 {dl['ref']} 이 dates 에 없음"
        if s.get("draft"):
            assert s["draft"] in PROCS["drafts"], f"{p['id']}: 초안 {s['draft']} 없음"
        act = s.get("act")
        if act and act.get("k") == "proc":
            assert act["id"] in {x["id"] for x in PROCS["procedures"]}


@pytest.mark.parametrize("p", PROCS["procedures"], ids=lambda p: p["id"])
def test_verified_revisions_match_manifest(p):
    for reg, rev in (p.get("verified") or {}).items():
        if isinstance(rev, str):
            assert reg in MANIFEST, f"{p['id']}: 등록되지 않은 규정 {reg}"
            assert MANIFEST[reg].get("revision") == rev, f"{p['id']}: {reg} 개정 표기 불일치 — 원문 확인 후 갱신"


def test_every_basis_and_form_resolves(client):
    """모든 절차의 근거 조문·서식이 등록 규정에 연결된다(호환성 점검과 같은 기준)."""
    d = client.get("/api/secretary/procedures?fresh=1").get_json()
    bad = {k: v.get("missing") for k, v in d["status"].items() if k.startswith("common:") and not v.get("ok")}
    assert not bad, bad
