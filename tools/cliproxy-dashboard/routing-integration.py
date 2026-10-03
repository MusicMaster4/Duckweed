"""Exercise the installed proxy's routing against an isolated local upstream."""
import json
import hashlib
import os
from pathlib import Path
import shutil
import socket
import subprocess
import tempfile
import threading
import time
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import yaml

root = Path(tempfile.mkdtemp(prefix="cliproxy-routing-test-"))
exhaust_a = False
requests = []


class Upstream(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_POST(self):
        self.rfile.read(int(self.headers.get("Content-Length", 0)))
        account = self.headers.get("Authorization", "").removeprefix("Bearer fixture-")
        requests.append(account)
        if account == "A" and exhaust_a:
            self.send_response(429)
            self.send_header("Content-Type", "application/json")
            self.send_header("Retry-After", "60")
            self.end_headers()
            self.wfile.write(json.dumps({"error": {"type": "usage_limit_reached", "message": "Fixture quota exhausted"}}).encode())
            return
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.end_headers()
        response = {"id": "fixture-response", "object": "response", "status": "completed", "model": "gpt-6.1-sol",
                    "output": [{"id": "fixture-message", "type": "message", "role": "assistant", "status": "completed",
                                "content": [{"type": "output_text", "text": "FIXTURE_OK", "annotations": []}]}],
                    "usage": {"input_tokens": 1, "output_tokens": 1, "total_tokens": 2}}
        for frame in [{"type": "response.created", "response": {**response, "status": "in_progress", "output": []}},
                      {"type": "response.completed", "response": response}]:
            self.wfile.write(("data: " + json.dumps(frame) + "\n\n").encode())


upstream = ThreadingHTTPServer(("127.0.0.1", 0), Upstream)
threading.Thread(target=upstream.serve_forever, daemon=True).start()
with socket.socket() as reservation:
    reservation.bind(("127.0.0.1", 0))
    port = reservation.getsockname()[1]
base = f"http://127.0.0.1:{port}"
(root / "auth").mkdir()
config = {"host": "127.0.0.1", "port": port, "auth-dir": str(root / "auth"), "api-keys": ["fixture-client"],
          "remote-management": {"allow-remote": False, "secret-key": "fixture-management", "disable-control-panel": True},
          "routing": {"strategy": "fill-first", "session-affinity": True, "session-affinity-ttl": "168h"},
          "request-retry": 1, "max-retry-interval": 1,
          "codex-api-key": [{"api-key": f"fixture-{name}", "base-url": f"http://127.0.0.1:{upstream.server_port}",
                             "priority": priority, "models": [{"name": "gpt-6.1-sol"}]} for name, priority in [("A", 2), ("B", 1)]]}
(root / "config.yaml").write_text(yaml.safe_dump(config), encoding="utf-8")
binary = Path(os.environ.get("CLIPROXY_BIN", str(Path(os.environ["LOCALAPPDATA"]) / "Programs/CLIProxyAPI/cli-proxy-api.exe")))
process = subprocess.Popen([str(binary), "-config", str(root / "config.yaml")], cwd=root,
                           stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                           creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0)


def call(path, data=None, admin=False, session=None):
    headers = {"Authorization": "Bearer " + ("fixture-management" if admin else "fixture-client"), "Content-Type": "application/json"}
    if session:
        headers["Session-Id"] = session
    request = urllib.request.Request(base + path, data=json.dumps(data).encode() if data is not None else None, headers=headers)
    with urllib.request.urlopen(request, timeout=15) as response:
        return response.read()


def respond(session):
    start = len(requests)
    result = call("/v1/responses", {"model": "gpt-6.1-sol", "stream": True, "store": False,
                                  "input": [{"role": "user", "content": "Reply FIXTURE_OK."}]}, session=session)
    assert b"response.completed" in result and b"FIXTURE_OK" in result
    return requests[start:]


try:
    for attempt in range(60):
        try:
            call("/v1/models")
            break
        except Exception:
            if process.poll() is not None:
                raise RuntimeError("Isolated proxy exited before startup")
            time.sleep(0.1)
    assert respond("existing-thread") == ["A"]
    assert respond("existing-thread") == ["A"]
    exhaust_a = True
    assert respond("existing-thread") == ["A", "B"], "Quota failure must switch to the next account"
    exhaust_a = False
    identity = f"codex-api-key:http://127.0.0.1:{upstream.server_port}+fixture-A"
    index_a = hashlib.sha256(identity.encode()).hexdigest()[:16]
    call("/v8/management/routing/cooldown/reset", {"auth_index": index_a}, admin=True)
    assert respond("existing-thread") == ["B"], "An existing thread must keep its replacement account"
    assert respond("new-thread") == ["A"], "A new thread must use the highest available priority"
    print(json.dumps({"realProxyRouting": "passed", "affinity": "passed", "quotaFailover": "passed", "priorityRecovery": "passed"}))
finally:
    process.terminate()
    process.wait(timeout=10)
    upstream.shutdown()
    upstream.server_close()
    assert root.resolve().parent == Path(tempfile.gettempdir()).resolve()
    assert root.name.startswith("cliproxy-routing-test-")
    shutil.rmtree(root)
