def test_stripe_settings_from_env(monkeypatch):
    monkeypatch.setenv("STRIPE_SECRET_KEY", "sk_test_x")
    monkeypatch.setenv("STRIPE_WEBHOOK_SECRET", "whsec_x")
    monkeypatch.setenv("STRIPE_PRICE_STARTER", "price_s")
    import importlib
    from app import config
    importlib.reload(config)
    assert config.settings.stripe_enabled is True
    assert config.settings.stripe_price_ids["starter"] == "price_s"
    assert config.settings.stripe_tax_enabled is True  # default


def test_stripe_disabled_without_secret(monkeypatch):
    monkeypatch.delenv("STRIPE_SECRET_KEY", raising=False)
    monkeypatch.delenv("STRIPE_WEBHOOK_SECRET", raising=False)
    import importlib
    from app import config
    importlib.reload(config)
    assert config.settings.stripe_enabled is False
