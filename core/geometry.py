from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Any, Dict, List, Tuple


@dataclass
class BendResult:
    field: str
    angle_deg: float
    allowance_mm: float


def _as_float(value: Any, default: float = 0.0) -> float:
    try:
        if value is None or value == "":
            return default
        return float(str(value).replace(",", "."))
    except (TypeError, ValueError):
        return default


def bend_allowance(angle_deg: float, radius_mm: float, thickness_mm: float, k_factor: float) -> float:
    """Compensation théorique par pli.

    À remplacer/compléter avec vos tables atelier quand elles sont connues.
    """
    angle_rad = math.radians(abs(angle_deg))
    return angle_rad * (radius_mm + k_factor * thickness_mm)


def material_lookup(catalogue: Dict[str, Any], material_id: str) -> Dict[str, Any]:
    for material in catalogue.get("materials", []):
        if material.get("id") == material_id or material.get("label") == material_id:
            return material
    return catalogue.get("materials", [{}])[0]


def article_lookup(catalogue: Dict[str, Any], gamme_id: str, article_id: str) -> Dict[str, Any]:
    for gamme in catalogue.get("gammes", []):
        if gamme.get("id") == gamme_id:
            for article in gamme.get("articles", []):
                if article.get("id") == article_id:
                    return article
    raise KeyError(f"Article introuvable: {gamme_id}/{article_id}")


def build_profile_points(article: Dict[str, Any], values: Dict[str, Any]) -> List[Tuple[float, float]]:
    """Construit une polyligne de section indicative pour l'aperçu.

    Les longueurs viennent de geometry.segments. Les angles pliA/pliB... font tourner
    la direction. Ce n'est pas un calcul de fibre neutre certifié, c'est une preview.
    """
    geom = article.get("geometry", {})
    segments = geom.get("segments", [])
    bends = geom.get("bends", [])
    turn_signs = geom.get("turn_signs", [1] * len(bends))

    x, y = 0.0, 0.0
    direction = 0.0
    points: List[Tuple[float, float]] = [(x, y)]

    for idx, seg_name in enumerate(segments):
        length = _as_float(values.get(seg_name), 0.0)
        x += length * math.cos(math.radians(direction))
        y += length * math.sin(math.radians(direction))
        points.append((x, y))
        if idx < len(bends):
            raw = _as_float(values.get(bends[idx]), 90.0)
            # Pour une preview intuitive: pli de 90 -> rotation de 90°.
            # Si votre convention est différente, ajuster ici ou dans le JSON.
            sign = turn_signs[idx] if idx < len(turn_signs) else 1
            direction += sign * raw
    return points


def calculate(catalogue: Dict[str, Any], payload: Dict[str, Any]) -> Dict[str, Any]:
    material_id = payload.get("material") or catalogue.get("default_material")
    thickness = _as_float(payload.get("thickness"), 1.0)
    qty = int(_as_float(payload.get("quantity"), 1))
    gamme_id = payload.get("gamme")
    article_id = payload.get("article")
    values: Dict[str, Any] = payload.get("values", {}) or {}

    article = article_lookup(catalogue, gamme_id, article_id)
    material = material_lookup(catalogue, material_id)

    k_factor = _as_float(payload.get("k_factor"), _as_float(material.get("k_factor"), 0.42))
    radius = _as_float(payload.get("radius"), thickness * _as_float(material.get("default_radius_factor"), 1.0))

    geom = article.get("geometry", {})
    segments = geom.get("segments", [])
    bends = geom.get("bends", [])

    segment_lengths = [_as_float(values.get(seg), 0.0) for seg in segments]
    segment_sum = sum(segment_lengths)

    bend_results: List[BendResult] = []
    bend_sum = 0.0
    for bend_name in bends:
        angle = _as_float(values.get(bend_name), 90.0)
        ba = bend_allowance(angle, radius, thickness, k_factor)
        bend_results.append(BendResult(field=bend_name, angle_deg=angle, allowance_mm=ba))
        bend_sum += ba

    flat_width = segment_sum + bend_sum
    length = _as_float(values.get("Lg"), _as_float(values.get("longueur"), 0.0))
    area_mm2 = flat_width * length
    density = _as_float(material.get("density_kg_m3"), 7850.0)
    # mm³ -> m³ = 1e-9
    weight_one = area_mm2 * thickness * 1e-9 * density
    weight_total = weight_one * qty

    # Positions lignes de plis dans le développé: cumul segments + demi BA.
    bend_positions = []
    cursor = 0.0
    for idx, seg in enumerate(segments[:-1]):
        cursor += _as_float(values.get(seg), 0.0)
        ba = bend_results[idx].allowance_mm if idx < len(bend_results) else 0.0
        bend_positions.append({
            "field": bends[idx] if idx < len(bends) else f"pli{idx+1}",
            "position_mm": cursor + ba / 2.0,
            "angle_deg": bend_results[idx].angle_deg if idx < len(bend_results) else 90.0,
            "allowance_mm": ba,
        })
        cursor += ba

    warnings: List[str] = []
    limits = article.get("limits", {})
    if length and limits.get("max_length") and length > float(limits["max_length"]):
        warnings.append(f"Longueur {length:.0f} mm supérieure à la limite {limits['max_length']} mm.")
    if limits.get("max_flat_width") and flat_width > float(limits["max_flat_width"]):
        warnings.append(f"Développé {flat_width:.1f} mm supérieur à la largeur maxi {limits['max_flat_width']} mm.")
    if limits.get("min_flat_width") and flat_width < float(limits["min_flat_width"]):
        warnings.append(f"Développé {flat_width:.1f} mm inférieur à la largeur mini {limits['min_flat_width']} mm.")

    return {
        "article_title": article.get("title", article_id),
        "article_id": article_id,
        "gamme_id": gamme_id,
        "material": material.get("label", material_id),
        "material_ref": payload.get("material_ref"),
        "thickness_mm": thickness,
        "quantity": qty,
        "radius_mm": radius,
        "k_factor": k_factor,
        "length_mm": length,
        "segments": [{"field": name, "length_mm": segment_lengths[i]} for i, name in enumerate(segments)],
        "bends": [br.__dict__ for br in bend_results],
        "bend_positions": bend_positions,
        "flat_width_mm": flat_width,
        "developed_area_m2_one": area_mm2 / 1_000_000,
        "developed_area_m2_total": area_mm2 * qty / 1_000_000,
        "weight_kg_one": weight_one,
        "weight_kg_total": weight_total,
        "profile_points": build_profile_points(article, values),
        "warnings": warnings,
        "notes": article.get("geometry", {}).get("notes", "")
    }
