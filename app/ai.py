"""AI-assisted correction (OpenAI-compatible chat API), ported from the Palimora
iOS OpenAIProvider prompt — with the glossary actually injected this time.

Implemented with httpx + manual SSE parsing: some OpenAI-compatible routers
(9router) emit non-standard SSE that breaks the official SDK's parser, and
streaming is the only mode that reliably carries content through them."""
import json
import re

import httpx

from .config import settings

SYSTEM_PROMPT = (
    "Tu es un expert en archivistique et en paléographie spécialisé dans les documents "
    "historiques français. Tu corriges les transcriptions OCR/HTR de manuscrits anciens : "
    "corrige les erreurs de reconnaissance (caractères confondus, mots coupés, accents), "
    "l'orthographe évidente et applique la normalisation du glossaire fourni. "
    "NE PARAPHRASE JAMAIS : conserve la langue, la ponctuation et la structure d'origine du "
    "texte transcrit. Ne commente pas le contenu. Réponds STRICTEMENT en JSON : "
    '[{"originalText": "...", "suggestedText": "...", "explanation": "...", "confidenceScore": 0.95}] '
    "avec une entrée par correction proposée, et [] si aucune correction n'est nécessaire."
)


def _glossary_block(entries: list) -> str:
    if not entries:
        return ""
    lines = ["Glossaire à respecter (forme normalisée → à utiliser):"]
    for e in entries:
        aliases = ", ".join(e.aliases or []) or "-"
        norm = e.normalized_form or e.term
        lines.append(f"- {e.term} (alias: {aliases}) → {norm} — {e.note}".rstrip(" —"))
    return "\n".join(lines)


def _stream_completion(messages: list[dict]) -> str:
    payload = {"model": settings.openai_model, "messages": messages,
               "temperature": 0.1, "stream": True}
    headers = {"Authorization": f"Bearer {settings.openai_api_key}",
               "Content-Type": "application/json"}
    content = ""
    with httpx.stream("POST", f"{settings.openai_base_url}/chat/completions",
                      json=payload, headers=headers, timeout=600) as resp:
        if resp.status_code != 200:
            body = resp.read().decode(errors="replace")[:300]
            raise RuntimeError(f"Provider IA a répondu {resp.status_code}: {body}")
        for line in resp.iter_lines():
            line = line.strip()
            if not line.startswith("data: "):
                continue
            data = line[6:]
            if data == "[DONE]":
                break
            try:
                chunk = json.loads(data)
            except json.JSONDecodeError:
                continue
            for choice in chunk.get("choices", []):
                piece = (choice.get("delta") or {}).get("content")
                if piece:
                    content += piece
    return content


def suggest_corrections(text: str, glossary_entries: list = ()) -> list[dict]:
    """Returns a list of {originalText, suggestedText, explanation, confidenceScore}."""
    if not settings.openai_api_key:
        raise RuntimeError("Correction IA non configurée (OPENAI_API_KEY manquant)")
    user_content = f"Texte transcrit à corriger :\n\"\"\"\n{text[:8000]}\n\"\"\""
    glossary = _glossary_block(list(glossary_entries))
    if glossary:
        user_content += f"\n\n{glossary}"
    raw = _stream_completion([
        {"role": "system", "content": SYSTEM_PROMPT},
        {"role": "user", "content": user_content},
    ])
    return _parse_suggestions(raw)


def _parse_suggestions(raw: str) -> list[dict]:
    """Extract the JSON array even when the model wraps it in prose/fences."""
    match = re.search(r"\[.*\]", raw, re.DOTALL)
    if not match:
        return []
    try:
        data = json.loads(match.group(0))
    except json.JSONDecodeError:
        return []
    out = []
    for item in data if isinstance(data, list) else []:
        if not isinstance(item, dict):
            continue
        original = str(item.get("originalText", "")).strip()
        suggested = str(item.get("suggestedText", "")).strip()
        if not original or not suggested or original == suggested:
            continue
        out.append({
            "originalText": original,
            "suggestedText": suggested,
            "explanation": str(item.get("explanation", "")).strip(),
            "confidenceScore": float(item.get("confidenceScore", 0) or 0),
        })
    return out
