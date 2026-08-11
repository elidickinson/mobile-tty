#!/usr/bin/env python3
"""Static server for the probe that also accepts metric reports.

POST /report  ->  appends one JSON line to reports.jsonl
GET  /reports ->  returns the log (so it can be read from anywhere)
"""
import json
import sys
from datetime import datetime
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

HERE = Path(__file__).parent
LOG = HERE / "reports.jsonl"


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=str(HERE), **kw)

    def do_POST(self):
        if self.path != "/report":
            self.send_error(404)
            return
        body = self.rfile.read(int(self.headers.get("Content-Length", 0)))
        record = json.loads(body)
        record["at"] = datetime.now().isoformat(timespec="seconds")
        with LOG.open("a") as fh:
            fh.write(json.dumps(record) + "\n")
        print(f"[report] {record.get('tag', '?')} kb={record.get('keyboard')} "
              f"grid={record.get('grid13')}", flush=True)
        self.send_response(204)
        self.end_headers()

    def do_GET(self):
        if self.path == "/reports":
            data = LOG.read_bytes() if LOG.exists() else b""
            self.send_response(200)
            self.send_header("Content-Type", "text/plain; charset=utf-8")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            return
        super().do_GET()

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, *a):
        pass


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8099
    print(f"probe server on :{port}  (reports -> {LOG})", flush=True)
    ThreadingHTTPServer(("0.0.0.0", port), Handler).serve_forever()
