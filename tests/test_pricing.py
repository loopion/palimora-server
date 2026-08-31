from decimal import Decimal
from app import pricing


def test_packs_match_spec():
    assert pricing.get("starter").credits == 300
    assert pricing.get("starter").amount_eur == Decimal("29.00")
    assert pricing.get("chercheur").credits == 1500
    assert pricing.get("archiviste").amount_eur == Decimal("399.00")
    sub = pricing.get("atelier")
    assert sub.kind == "subscription"
    assert sub.credits == 500


def test_catalogue_serialisable():
    cat = {c["id"]: c for c in pricing.catalogue()}
    assert set(cat) == {"starter", "chercheur", "archiviste", "atelier"}
    assert cat["starter"]["price_per_page"] == round(29.0 / 300, 4)
    assert cat["atelier"]["interval"] == "month"


def test_reverse_lookup(monkeypatch):
    monkeypatch.setitem(pricing._price_ids(), "starter", "price_abc")
    assert pricing.pack_by_price_id("price_abc").id == "starter"
    assert pricing.pack_by_price_id("nope") is None
