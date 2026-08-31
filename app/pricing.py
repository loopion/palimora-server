"""Credit catalogue — the single source of truth for what a pack contains.
Stripe is authoritative for the amount actually charged; the amounts here are
for display and sanity checks only."""
from dataclasses import dataclass
from decimal import Decimal
from typing import Literal

from .config import settings


@dataclass(frozen=True)
class Pack:
    id: str
    kind: Literal["one_shot", "subscription"]
    credits: int
    amount_eur: Decimal
    label: str


PACKS: dict[str, Pack] = {
    "starter": Pack("starter", "one_shot", 300, Decimal("29.00"), "Starter"),
    "chercheur": Pack("chercheur", "one_shot", 1500, Decimal("119.00"), "Chercheur"),
    "archiviste": Pack("archiviste", "one_shot", 6000, Decimal("399.00"), "Archiviste"),
    "atelier": Pack("atelier", "subscription", 500, Decimal("39.00"), "Atelier"),
}


def _price_ids() -> dict:
    return settings.stripe_price_ids


def get(pack_id: str) -> Pack | None:
    return PACKS.get(pack_id)


def pack_by_price_id(price_id: str) -> Pack | None:
    if not price_id:
        return None
    for pack_id, pid in _price_ids().items():
        if pid and pid == price_id:
            return PACKS.get(pack_id)
    return None


def catalogue() -> list[dict]:
    out = []
    for p in PACKS.values():
        entry = {
            "id": p.id,
            "kind": p.kind,
            "credits": p.credits,
            "amount_eur": float(p.amount_eur),
            "price_per_page": round(float(p.amount_eur) / p.credits, 4),
            "label": p.label,
            "stripe_price_id": _price_ids().get(p.id, ""),
        }
        if p.kind == "subscription":
            entry["interval"] = "month"
        out.append(entry)
    return out
