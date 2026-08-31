def test_catalogue_public_shape(client):
    r = client.get("/api/billing/catalogue")
    assert r.status_code == 200
    body = r.json()
    assert {p["id"] for p in body["packs"]} == {"starter", "chercheur", "archiviste", "atelier"}
    assert body["publishable_key"] == "pk_test_dummy"


def test_status_requires_auth(client):
    assert client.get("/api/billing/status").status_code == 401


def test_status_shape(client, db):
    from tests.conftest import make_user, auth_headers
    u = make_user(db, credits=42)
    r = client.get("/api/billing/status", headers=auth_headers(db, u))
    assert r.status_code == 200
    body = r.json()
    assert body["credit_balance"] == 42
    assert body["subscription"] is None
    assert body["purchases"] == []
