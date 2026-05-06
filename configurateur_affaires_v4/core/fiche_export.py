from __future__ import annotations

from datetime import datetime
from html import escape
from pathlib import Path
from typing import Any, Dict


def create_fiche_html(result: Dict[str, Any], values: Dict[str, Any], out_dir: Path) -> Path:
    out_dir.mkdir(parents=True, exist_ok=True)
    rep = str(values.get("rep") or result.get("article_id") or "piece").replace("/", "-")
    filename = f"fiche_{rep}_{result.get('article_id', 'piece')}.html"
    path = out_dir / filename

    def row(label: str, value: Any, unit: str = "") -> str:
        return f"<tr><th>{escape(label)}</th><td>{escape(str(value))} {escape(unit)}</td></tr>"

    segment_rows = "".join(row(s["field"], f"{s['length_mm']:.2f}", "mm") for s in result.get("segments", []))
    bend_rows = "".join(row(b["field"], f"{b['angle_deg']:.2f}° / BA {b['allowance_mm']:.2f}", "mm") for b in result.get("bends", []))
    pos_rows = "".join(row(p["field"], f"{p['position_mm']:.2f}", "mm depuis bord") for p in result.get("bend_positions", []))
    warning_html = "".join(f"<li>{escape(w)}</li>" for w in result.get("warnings", [])) or "<li>Aucune alerte.</li>"

    html = f"""<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<title>Fiche atelier - {escape(rep)}</title>
<style>
body {{ font-family: Arial, sans-serif; margin: 28px; color: #111; }}
.header {{ display: flex; justify-content: space-between; border-bottom: 2px solid #222; padding-bottom: 12px; margin-bottom: 18px; }}
h1 {{ margin: 0; font-size: 24px; }}
h2 {{ font-size: 16px; margin-top: 24px; border-bottom: 1px solid #ccc; padding-bottom: 6px; }}
table {{ border-collapse: collapse; width: 100%; margin: 8px 0 16px 0; }}
th, td {{ border: 1px solid #ccc; padding: 7px 9px; text-align: left; }}
th {{ width: 220px; background: #f4f6f8; }}
.badge {{ display: inline-block; padding: 4px 8px; border: 1px solid #999; border-radius: 4px; }}
.note {{ color: #555; font-size: 13px; }}
@media print {{ button {{ display: none; }} body {{ margin: 12mm; }} }}
</style>
</head>
<body>
<button onclick="window.print()">Imprimer / PDF</button>
<div class="header">
  <div>
    <h1>Fiche atelier</h1>
    <div class="note">Générée le {datetime.now().strftime('%d/%m/%Y %H:%M')}</div>
  </div>
  <div><strong>{escape(result.get('article_title', ''))}</strong><br><span class="badge">Rep : {escape(rep)}</span></div>
</div>

<h2>Commande</h2>
<table>
{row('Article', result.get('article_title', ''))}
{row('Matière', result.get('material', ''))}
{row('Épaisseur', f"{result.get('thickness_mm', 0):.2f}", 'mm')}
{row('Quantité', result.get('quantity', 1))}
{row('Longueur Lg', f"{result.get('length_mm', 0):.2f}", 'mm')}
</table>

<h2>Calculs</h2>
<table>
{row('Développé', f"{result.get('flat_width_mm', 0):.2f}", 'mm')}
{row('Surface unitaire', f"{result.get('developed_area_m2_one', 0):.4f}", 'm²')}
{row('Surface totale', f"{result.get('developed_area_m2_total', 0):.4f}", 'm²')}
{row('Poids unitaire', f"{result.get('weight_kg_one', 0):.3f}", 'kg')}
{row('Poids total', f"{result.get('weight_kg_total', 0):.3f}", 'kg')}
{row('Rayon calcul', f"{result.get('radius_mm', 0):.2f}", 'mm')}
{row('K-factor', result.get('k_factor', ''))}
</table>

<h2>Dimensions saisies</h2>
<table>{segment_rows}</table>

<h2>Plis</h2>
<table>{bend_rows}</table>

<h2>Positions des lignes de pliage dans le développé</h2>
<table>{pos_rows}</table>

<h2>Alertes</h2>
<ul>{warning_html}</ul>

<p class="note">Note : les compensations de pli sont théoriques. À recaler avec vos tables atelier matière/épaisseur/outillage.</p>
</body>
</html>"""
    path.write_text(html, encoding="utf-8")
    return path
