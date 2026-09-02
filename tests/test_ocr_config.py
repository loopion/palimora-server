from app.config import _parse_kraken_models


def test_parses_label_seg_rec_entries():
    raw = "défaut=/models/seg.mlmodel|/models/rec.mlmodel,rapide=/models/seg.mlmodel|/models/rec-fast.mlmodel"
    out = _parse_kraken_models(raw)
    assert out == [
        {"key": "défaut", "seg_path": "/models/seg.mlmodel", "rec_path": "/models/rec.mlmodel"},
        {"key": "rapide", "seg_path": "/models/seg.mlmodel", "rec_path": "/models/rec-fast.mlmodel"},
    ]


def test_empty_or_unset_is_empty_list():
    assert _parse_kraken_models("") == []
    assert _parse_kraken_models("   ") == []


def test_malformed_entries_are_skipped_not_fatal(capsys):
    raw = "good=/a|/b,noequalsign,missingpipe=/only-one,blank=|,=/x|/y"
    out = _parse_kraken_models(raw)
    assert out == [{"key": "good", "seg_path": "/a", "rec_path": "/b"}]
    assert "KRAKEN_MODELS" in capsys.readouterr().out  # warned


def test_first_equals_wins_so_paths_may_contain_equals():
    out = _parse_kraken_models("k=/models/a=1.mlmodel|/models/b.mlmodel")
    assert out == [{"key": "k", "seg_path": "/models/a=1.mlmodel", "rec_path": "/models/b.mlmodel"}]


def test_label_over_40_chars_skipped():
    long = "x" * 41
    assert _parse_kraken_models(f"{long}=/a|/b") == []
