import httpx
from app import kraken


class _Capture:
    def __init__(self):
        self.last = None

    def handler(self, request: httpx.Request) -> httpx.Response:
        self.last = request.content
        return httpx.Response(200, json={"job_id": "j1"})


def test_model_paths_sent_as_form_fields():
    cap = _Capture()
    client = httpx.Client(transport=httpx.MockTransport(cap.handler))
    kraken.submit_ocr(client, b"bytes", ".png",
                      seg_model_path="/m/seg.mlmodel", rec_model_path="/m/rec.mlmodel")
    body = cap.last.decode("latin-1")
    assert 'name="seg_model_path"' in body and "/m/seg.mlmodel" in body
    assert 'name="rec_model_path"' in body and "/m/rec.mlmodel" in body


def test_no_model_fields_when_none():
    cap = _Capture()
    client = httpx.Client(transport=httpx.MockTransport(cap.handler))
    kraken.submit_ocr(client, b"bytes", ".png")
    body = cap.last.decode("latin-1")
    assert "seg_model_path" not in body
    assert "rec_model_path" not in body
    assert 'name="file"' in body
