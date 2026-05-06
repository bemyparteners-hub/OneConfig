from __future__ import annotations

from pathlib import Path
from typing import Any, Dict


def _fmt(value: float) -> str:
    return f"{value:.3f}".rstrip("0").rstrip(".")


def _line(x1: float, y1: float, x2: float, y2: float, layer: str = "0") -> str:
    return f"0\nLINE\n8\n{layer}\n10\n{_fmt(x1)}\n20\n{_fmt(y1)}\n30\n0\n11\n{_fmt(x2)}\n21\n{_fmt(y2)}\n31\n0\n"


def _text(x: float, y: float, text: str, height: float = 12.0, layer: str = "TEXT") -> str:
    safe = text.replace("\n", " ")[:240]
    return f"0\nTEXT\n8\n{layer}\n10\n{_fmt(x)}\n20\n{_fmt(y)}\n30\n0\n40\n{_fmt(height)}\n1\n{safe}\n"


def create_developed_dxf(result: Dict[str, Any], values: Dict[str, Any], out_dir: Path) -> Path:
    out_dir.mkdir(parents=True, exist_ok=True)
    rep = str(values.get("rep") or result.get("article_id") or "piece").replace("/", "-")
    filename = f"{rep}_{result.get('article_id', 'piece')}_{int(result.get('length_mm') or 0)}.dxf"
    path = out_dir / filename

    length = float(result.get("length_mm") or 0)
    width = float(result.get("flat_width_mm") or 0)
    margin = max(20.0, width * 0.05)

    dxf = []
    dxf.append("0\nSECTION\n2\nHEADER\n9\n$INSUNITS\n70\n4\n0\nENDSEC\n")
    dxf.append("0\nSECTION\n2\nTABLES\n0\nTABLE\n2\nLAYER\n70\n3\n")
    for layer in ["CONTOUR", "PLIS", "TEXT"]:
        dxf.append(f"0\nLAYER\n2\n{layer}\n70\n0\n62\n7\n6\nCONTINUOUS\n")
    dxf.append("0\nENDTAB\n0\nENDSEC\n")
    dxf.append("0\nSECTION\n2\nENTITIES\n")

    # Contour extérieur développé
    dxf.append(_line(0, 0, length, 0, "CONTOUR"))
    dxf.append(_line(length, 0, length, width, "CONTOUR"))
    dxf.append(_line(length, width, 0, width, "CONTOUR"))
    dxf.append(_line(0, width, 0, 0, "CONTOUR"))

    # Lignes de pliage horizontales
    for bend in result.get("bend_positions", []):
        y = float(bend["position_mm"])
        dxf.append(_line(0, y, length, y, "PLIS"))
        dxf.append(_text(length + margin, y - 4, f"{bend['field']} {bend['angle_deg']:.1f} deg", 8, "TEXT"))

    dxf.append(_text(0, width + margin, f"{result.get('article_title')} - dev {_fmt(width)} mm - Lg {_fmt(length)} mm", 12, "TEXT"))
    dxf.append(_text(0, width + margin + 18, f"Matiere {result.get('material')} - ep {result.get('thickness_mm')} - qte {result.get('quantity')}", 10, "TEXT"))
    dxf.append("0\nENDSEC\n0\nEOF\n")
    path.write_text("".join(dxf), encoding="utf-8")
    return path
