import importlib

import pytest

from app import config as _config


@pytest.fixture(autouse=True)
def _restore_config():
    """test bodies call importlib.reload(app.config), which permanently rebinds
    app.config.settings. Reload once more on teardown (conftest env is restored
    by then) so the mutation cannot leak into other test files."""
    yield
    importlib.reload(_config)


def test_stripe_settings_from_env(monkeypatch):
    monkeypatch.setenv("STRIPE_SECRET_KEY", "sk_test_x")
    monkeypatch.setenv("STRIPE_WEBHOOK_SECRET", "whsec_x")
    monkeypatch.setenv("STRIPE_PRICE_STARTER", "price_s")
    import importlib
    from app import config
    importlib.reload(config)
    assert config.settings.stripe_enabled is True
    assert config.settings.stripe_price_ids["starter"] == "price_s"
    assert config.settings.stripe_tax_enabled is False  # default (franchise-de-TVA)


def test_stripe_disabled_without_secret(monkeypatch):
    monkeypatch.delenv("STRIPE_SECRET_KEY", raising=False)
    monkeypatch.delenv("STRIPE_WEBHOOK_SECRET", raising=False)
    import importlib
    from app import config
    importlib.reload(config)
    assert config.settings.stripe_enabled is False


def test_zz_reload_pollution_does_not_escape():
    """Runs last in this file (name sorts last). The autouse fixture must have
    reloaded app.config back to the conftest env after every prior test, so the
    disabled-Stripe state from test_stripe_disabled_without_secret cannot leak."""
    from app import config
    assert config.settings.stripe_enabled is True
