import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import test from "node:test";

const clientSource = fs.readFileSync(
  new URL("../client/figma_mcp_client.py", import.meta.url),
  "utf8",
);

test("MCP client retries local Windows socket-buffer exhaustion with structured logs", () => {
  assert.match(clientSource, /MCP_SOCKET_BUFFER_RETRY_ATTEMPTS = 6/);
  assert.match(clientSource, /def _is_socket_buffer_exhaustion\(error: BaseException\) -> bool:/);
  assert.match(clientSource, /getattr\(reason, "winerror", None\) == 10055/);
  assert.match(clientSource, /LOGGER\.warn\("MCP request hit local socket-buffer exhaustion; retrying"/);
  assert.match(clientSource, /time\.sleep\(MCP_SOCKET_BUFFER_RETRY_DELAY_SECONDS \* attempt\)/);
});

test("MCP client retries a transient WinError 10055 before failing the request", () => {
  const output = execFileSync("python", ["-c", `
import importlib.util
import urllib.error
from pathlib import Path

client_path = Path.cwd() / "client" / "figma_mcp_client.py"
spec = importlib.util.spec_from_file_location("figma_mcp_client_under_test", client_path)
client = importlib.util.module_from_spec(spec)
spec.loader.exec_module(client)

attempts = []
delays = []

class LocalSocketError(OSError):
    winerror = 10055

class Response:
    headers = {}
    def read(self):
        return b"{}"
    def __enter__(self):
        return self
    def __exit__(self, exc_type, exc, tb):
        return False

def urlopen(*args, **kwargs):
    attempts.append(1)
    if len(attempts) == 1:
        raise urllib.error.URLError(LocalSocketError("socket buffer exhausted"))
    return Response()

client.urllib.request.urlopen = urlopen
client.time.sleep = delays.append
payload, session_id = client._post_http_json("http://127.0.0.1:32130/mcp", {"method": "test"})
assert payload == {}
assert session_id == ""
assert len(attempts) == 2
assert delays == [client.MCP_SOCKET_BUFFER_RETRY_DELAY_SECONDS]
print("ok")
`], { cwd: new URL("..", import.meta.url), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  assert.equal(output.trim(), "ok");
});
