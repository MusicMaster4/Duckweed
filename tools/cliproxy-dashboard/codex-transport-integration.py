"""Verify Codex streaming, steering and stopping through an isolated CLIProxy."""
import base64
import json
import os
from pathlib import Path
import queue
import shutil
import socket
import stat
import struct
import zlib
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import yaml

large_history = "--large-history" in sys.argv

root = Path(tempfile.mkdtemp(prefix="cliproxy-codex-http-test-"))
pending_requests = queue.Queue()
requests = []
shutdown = threading.Event()
fixture_usage = {"input_tokens": 1000, "input_tokens_details": {"cached_tokens": 800},
                 "output_tokens": 100, "output_tokens_details": {"reasoning_tokens": 40}, "total_tokens": 1100}
fixture_last = {"inputTokens": 1000, "cachedInputTokens": 800, "cacheWriteInputTokens": 0,
                "outputTokens": 100, "reasoningOutputTokens": 40, "totalTokens": 1100}


class Upstream(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_GET(self):
        # HTTP policy must apply even when an existing client still uses a
        # downstream WebSocket. No upgrade may reach the upstream provider.
        requests.append({"websocket": self.headers.get("Upgrade")})
        self.send_error(400, "WebSocket transport is not supported by this fixture")

    def do_POST(self):
        body = self.rfile.read(int(self.headers.get("Content-Length", 0)))
        requests.append({"path": self.path, "bytes": len(body)})
        text = body.decode()
        response_id = "fixture-response-" + str(len(requests))
        item = {"id": "fixture-message-" + str(len(requests)), "type": "message", "role": "assistant", "status": "completed",
                "content": [{"type": "output_text", "text": "HTTP_STREAM_OK", "annotations": []}]}
        response = {"id": response_id, "object": "response", "status": "completed", "model": "gpt-6.1-sol", "output": [item],
                    "usage": fixture_usage}
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.end_headers()

        def emit(frame):
            self.wfile.write(("data: " + json.dumps(frame) + "\n\n").encode())
            self.wfile.flush()

        try:
            emit({"type": "response.created", "response": {**response, "status": "in_progress", "output": [], "usage": None}})
            if "WAIT_FOR_CONTROL" in text and "FINISH_HTTP" not in text:
                release = threading.Event()
                pending_requests.put(release)
                # HTTP steering is applied after the in-flight response settles.
                while not release.wait(0.1) and not shutdown.is_set():
                    self.wfile.write(b": keepalive\n\n")
                    self.wfile.flush()
                if shutdown.is_set():
                    return
            for frame in [
                {"type": "response.output_item.added", "output_index": 0, "item": {**item, "status": "in_progress", "content": []}},
                {"type": "response.content_part.added", "item_id": item["id"], "output_index": 0, "content_index": 0,
                 "part": {"type": "output_text", "text": "", "annotations": []}},
                {"type": "response.output_text.delta", "item_id": item["id"], "output_index": 0, "content_index": 0, "delta": "HTTP_STREAM_OK"},
                {"type": "response.output_text.done", "item_id": item["id"], "output_index": 0, "content_index": 0, "text": "HTTP_STREAM_OK"},
                {"type": "response.content_part.done", "item_id": item["id"], "output_index": 0, "content_index": 0, "part": item["content"][0]},
                {"type": "response.output_item.done", "output_index": 0, "item": item},
                {"type": "response.completed", "response": response},
            ]:
                emit(frame)
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            pass


upstream = ThreadingHTTPServer(("127.0.0.1", 0), Upstream)
threading.Thread(target=upstream.serve_forever, daemon=True).start()
with socket.socket() as reservation:
    reservation.bind(("127.0.0.1", 0))
    port = reservation.getsockname()[1]
base = f"http://127.0.0.1:{port}"
(root / "auth").mkdir()
config = {"host": "127.0.0.1", "port": port, "auth-dir": str(root / "auth"), "api-keys": ["fixture-client"],
          "remote-management": {"allow-remote": False, "secret-key": "fixture-management", "disable-control-panel": True},
          "request-retry": 0,
          "codex-api-key": [{"api-key": "fixture-upstream", "websockets": False, "base-url": f"http://127.0.0.1:{upstream.server_port}",
                             "models": [{"name": "gpt-6.1-sol"}]}]}
(root / "config.yaml").write_text(yaml.safe_dump(config), encoding="utf-8")
proxy_binary = Path(os.environ.get("CLIPROXY_BIN", str(Path(os.environ["LOCALAPPDATA"]) / "Programs/CLIProxyAPI/cli-proxy-api.exe")))
# Match Duckweed's managed server when available, rather than its older npm shim.
installed = list((Path.home() / ".codex/packages/app-server-daemon/releases").glob("*/bin/codex.exe"))
codex_binary = os.environ.get("CODEX_BIN") or (str(max(installed, key=lambda p: p.stat().st_mtime)) if installed else shutil.which("codex"))
creationflags = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0
proxy = subprocess.Popen([str(proxy_binary), "-config", str(root / "config.yaml")], cwd=root,
                         stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, creationflags=creationflags)
codex = None
frames = []
incoming = queue.Queue()
next_id = 0


def wait_for(predicate, timeout=20, after=0):
    deadline = time.monotonic() + timeout
    while True:
        for frame in frames[after:]:
            if predicate(frame):
                return frame
        try:
            frames.append(incoming.get(timeout=max(0.01, deadline - time.monotonic())))
        except queue.Empty:
            raise AssertionError("Timed out waiting for Codex: " + json.dumps(frames[-8:]))
        if time.monotonic() >= deadline:
            raise AssertionError("Timed out waiting for Codex: " + json.dumps(frames[-8:]))


def rpc(method, params):
    global next_id
    next_id += 1
    codex.stdin.write(json.dumps({"id": next_id, "method": method, "params": params}) + "\n")
    codex.stdin.flush()
    result = wait_for(lambda f: f.get("id") == next_id)
    assert "error" not in result, result
    return result["result"]


def start_turn(thread, text):
    result = rpc("turn/start", {"threadId": thread, "input": [{"type": "text", "text": text}]})
    return result["turn"]["id"]


def completed(turn):
    event = wait_for(lambda f: f.get("method") == "turn/completed" and f.get("params", {}).get("turn", {}).get("id") == turn)
    assert event["params"]["turn"]["status"] == "completed", {"event": event, "requests": requests}
    assert any(f.get("method") == "item/completed" and f.get("params", {}).get("turnId") == turn
               and f["params"].get("item", {}).get("text") == "HTTP_STREAM_OK" for f in frames)


try:
    for attempt in range(60):
        try:
            request = urllib.request.Request(base + "/v1/models", headers={"Authorization": "Bearer fixture-client"})
            with urllib.request.urlopen(request, timeout=1):
                break
        except Exception:
            if proxy.poll() is not None:
                raise RuntimeError("Isolated proxy exited before startup")
            time.sleep(0.1)
    codex_home = root / "codex"
    codex_home.mkdir()
    (codex_home / "config.toml").write_text(f'''model = "gpt-6.1-sol"
model_provider = "cliproxy"
model_reasoning_effort = "low"
[model_providers.cliproxy]
name = "CLIProxy fixture"
base_url = "{base}/v1"
wire_api = "responses"
env_key = "CLIPROXY_FIXTURE_TOKEN"
supports_websockets = true
[features]
apps = false
multi_agent = false
''', encoding="utf-8")
    codex = subprocess.Popen([codex_binary, "app-server", "--listen", "stdio://"], cwd=root,
                             env={**os.environ, "CODEX_HOME": str(codex_home), "CLIPROXY_FIXTURE_TOKEN": "fixture-client"},
                             stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True,
                             encoding="utf-8", creationflags=creationflags)

    def read_frames():
        for line in codex.stdout:
            try:
                incoming.put(json.loads(line))
            except json.JSONDecodeError:
                pass

    threading.Thread(target=read_frames, daemon=True).start()
    rpc("initialize", {"clientInfo": {"name": "duckweed_http_fixture", "version": "0.1.0"}, "capabilities": {"experimentalApi": True}})
    codex.stdin.write('{"method":"initialized","params":{}}\n')
    codex.stdin.flush()
    thread = rpc("thread/start", {"cwd": str(root), "approvalPolicy": "never", "sandbox": "read-only"})["thread"]["id"]
    completed(start_turn(thread, "Reply HTTP_STREAM_OK."))
    if large_history:
        # Valid random PNGs simulate the image-heavy conversation from the bug.
        # Invalid image bytes would be omitted by Codex before reaching the API.
        def png_chunk(kind, data):
            return struct.pack("!I", len(data)) + kind + data + struct.pack("!I", zlib.crc32(kind + data))
        pixels = b"".join(b"\0" + os.urandom(1024 * 3) for _ in range(1024))
        png = b"\x89PNG\r\n\x1a\n" + png_chunk(b"IHDR", struct.pack("!2I5B", 1024, 1024, 8, 2, 0, 0, 0)) + png_chunk(b"IDAT", zlib.compress(pixels)) + png_chunk(b"IEND", b"")
        image_url = "data:image/png;base64," + base64.b64encode(png).decode()
        turn = rpc("turn/start", {"threadId": thread, "input": [{"type": "text", "text": "Reply HTTP_STREAM_OK."}] +
            [{"type": "image", "url": image_url} for _ in range(10)]})["turn"]["id"]
        completed(turn)
    # Existing Duckweed tabs reload their provider settings after unsubscribe/resume.
    if not large_history:
        subprocess.run(["node", str(Path(__file__).with_name("configure-codex-transport.cjs")), str(codex_home / "config.toml")],
                       check=True, stdout=subprocess.DEVNULL, creationflags=creationflags)
        rpc("thread/unsubscribe", {"threadId": thread})
        rpc("thread/resume", {"threadId": thread})
    completed(start_turn(thread, "Reply HTTP_STREAM_OK."))
    steer_thread = rpc("thread/start", {"cwd": str(root), "approvalPolicy": "never", "sandbox": "read-only"})["thread"]["id"]
    turn = start_turn(steer_thread, "WAIT_FOR_CONTROL")
    release = pending_requests.get(timeout=15)
    before_steer = len(requests)
    rpc("turn/steer", {"threadId": steer_thread, "expectedTurnId": turn, "input": [{"type": "text", "text": "FINISH_HTTP. Reply HTTP_STREAM_OK."}]})
    release.set()
    completed(turn)
    assert len(requests) > before_steer, "Steered input must reach the provider"
    turn = start_turn(thread, "WAIT_FOR_CONTROL")
    pending_requests.get(timeout=15)
    rpc("turn/interrupt", {"threadId": thread, "turnId": turn})
    stopped = wait_for(lambda f: f.get("method") == "turn/completed" and f.get("params", {}).get("turn", {}).get("id") == turn)
    assert stopped["params"]["turn"]["status"] == "interrupted", stopped
    completed(start_turn(thread, "FINISH_HTTP. Reply HTTP_STREAM_OK."))
    assert requests and all("websocket" not in request for request in requests), requests
    if large_history:
        assert max(request["bytes"] for request in requests) > 28 * 1024 * 1024, "Large history was not sent to the provider: " + json.dumps(requests)
    # Verify the real proxy preserves the Responses subsets and the installed
    # app-server exposes inclusive input/output both live and in its rollouts.
    usage_frames = [f["params"]["tokenUsage"] for f in frames if f.get("method") == "thread/tokenUsage/updated"]
    assert usage_frames, "Codex did not report token usage"
    for usage in usage_frames:
        assert usage["last"] == fixture_last, usage
        total = usage["total"]
        calls = total["inputTokens"] // 1000
        assert calls > 0 and total == {k: v * calls for k, v in fixture_last.items()}, usage
    rollout_events = []
    for path in (codex_home / "sessions").rglob("*.jsonl"):
        for line in path.read_text(encoding="utf-8").splitlines():
            if '"token_count"' not in line:
                continue
            info = json.loads(line).get("payload", {}).get("info")
            if info:
                rollout_events.append(info)
    assert rollout_events, "Codex did not persist usage"
    for info in rollout_events:
        last = info["last_token_usage"]
        assert last["input_tokens"] == 1000 and last["cached_input_tokens"] == 800, info
        assert last["output_tokens"] == 100 and last["reasoning_output_tokens"] == 40, info
        assert last["total_tokens"] == 1100, info
    assert all(frame.get("method") != "error" for frame in frames), frames
    print(json.dumps({"codexHttpStreaming": "passed", "reloadExistingThread": "not-run" if large_history else "passed",
                      "largeHistory": "passed" if large_history else "not-run", "steering": "passed",
                      "interrupt": "passed", "continueAfterInterrupt": "passed", "usagePreserved": "passed", "providerRequests": len(requests),
                      "largestRequestBytes": max(request.get("bytes", 0) for request in requests), "codexBinary": str(codex_binary)}))

finally:
    shutdown.set()
    for process in [codex, proxy]:
        if process and process.poll() is None:
            if os.name == "nt":
                subprocess.run(["taskkill", "/PID", str(process.pid), "/T", "/F"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, creationflags=creationflags)
            else:
                process.terminate()
            process.wait(timeout=10)
    upstream.shutdown()
    upstream.server_close()
    assert root.resolve().parent == Path(tempfile.gettempdir()).resolve()
    assert root.name.startswith("cliproxy-codex-http-test-")
    def remove_readonly(function, target, error):
        assert Path(target).resolve().is_relative_to(root.resolve())
        os.chmod(target, stat.S_IWRITE)
        for attempt in range(50):
            try:
                function(target)
                return
            except PermissionError as locked:
                if getattr(locked, 'winerror', None) != 32 or attempt == 49:
                    raise
                # A Git helper may still be releasing the temporary plugin clone.
                time.sleep(0.1)

    shutil.rmtree(root, onexc=remove_readonly)
