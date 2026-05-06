from __future__ import annotations

import json
import mimetypes
import threading
import webbrowser
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Dict

from core.geometry import calculate
from core.dxf_export import create_developed_dxf
from core.fiche_export import create_fiche_html

ROOT = Path(__file__).parent.resolve()
STATIC = ROOT
DATA = ROOT / "data"
GENERATED = ROOT / "generated"
CATALOGUE_PATH = DATA / "catalogue.json"


def load_catalogue() -> Dict[str, Any]:
    return json.loads(CATALOGUE_PATH.read_text(encoding="utf-8"))


class Handler(BaseHTTPRequestHandler):
    server_version = "ConfigurateurAffaires/0.2"

    def _send_json(self, payload: Any, status: int = 200) -> None:
        raw = json.dumps(payload, ensure_ascii=False, indent=2).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def _read_json(self) -> Dict[str, Any]:
        size = int(self.headers.get("Content-Length", "0") or "0")
        if not size:
            return {}
        return json.loads(self.rfile.read(size).decode("utf-8"))

    def _serve_file(self, path: Path) -> None:
        if not path.exists() or not path.is_file():
            self.send_error(404, "Fichier introuvable")
            return
        ctype = mimetypes.guess_type(str(path))[0] or "application/octet-stream"
        raw = path.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def do_GET(self) -> None:
        parsed = urllib.parse.urlparse(self.path)
        path = urllib.parse.unquote(parsed.path)
        if path == "/api/catalogue":
            self._send_json(load_catalogue())
            return
        if path.startswith("/generated/"):
            rel = path.lstrip("/")
            self._serve_file(ROOT / rel)
            return
        if path == "/" or path == "":
            self._serve_file(STATIC / "index.html")
            return
        target = STATIC / path.lstrip("/")
        self._serve_file(target)

    def do_POST(self) -> None:
        try:
            payload = self._read_json()
            catalogue = load_catalogue()
            if self.path == "/api/calculate":
                self._send_json(calculate(catalogue, payload))
                return
            if self.path == "/api/export/dxf":
                result = calculate(catalogue, payload)
                p = create_developed_dxf(result, payload.get("values", {}), GENERATED / "dxf")
                self._send_json({"url": "/generated/dxf/" + p.name, "filename": p.name})
                return
            if self.path == "/api/export/fiche":
                result = calculate(catalogue, payload)
                p = create_fiche_html(result, payload.get("values", {}), GENERATED / "fiches")
                self._send_json({"url": "/generated/fiches/" + p.name, "filename": p.name})
                return
            self.send_error(404, "API inconnue")
        except Exception as exc:  # noqa: BLE001 - prototype local
            self._send_json({"error": str(exc)}, status=500)


def run(host: str = "127.0.0.1", port: int = 8000) -> None:
    url = f"http://{host}:{port}"
    print("=" * 60)
    print(f"Configurateur lancé : {url}")
    print("Ne pas ouvrir index.html directement si vous voulez les exports serveur.")
    print("=" * 60)
    threading.Timer(0.7, lambda: webbrowser.open(url)).start()
    ThreadingHTTPServer((host, port), Handler).serve_forever()


if __name__ == "__main__":
    run()
