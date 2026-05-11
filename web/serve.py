#!/usr/bin/env python3
"""Tiny HTTPS static-file server for the Web Bluetooth client.

Web Bluetooth refuses to run on plain ``http://`` for any origin other
than localhost. To make the page reachable from phones / other machines
on your LAN, we have to serve it over TLS. A self-signed cert is good
enough — every browser will let you click through the warning, after
which the page is treated as a secure context and ``navigator.bluetooth``
becomes available.

Usage:
    python3 serve.py                # 0.0.0.0:8443, autodetects LAN IP
    python3 serve.py --port 9443
    python3 serve.py --host 127.0.0.1
"""
from __future__ import annotations

import argparse
import http.server
import os
import socket
import ssl
import subprocess
import sys
from pathlib import Path


HERE = Path(__file__).resolve().parent
CERT = HERE / "dev-cert.pem"
KEY  = HERE / "dev-key.pem"


def lan_ip() -> str:
    """Best-effort: address used to reach the default gateway."""
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.settimeout(0.5)
        s.connect(("1.1.1.1", 80))
        return s.getsockname()[0]
    except OSError:
        return "127.0.0.1"
    finally:
        s.close()


def ensure_cert() -> None:
    """Generate a self-signed cert if one doesn't already exist."""
    if CERT.exists() and KEY.exists():
        return
    print("[serve] generating self-signed cert (one-time)...")
    # SAN includes localhost + the current LAN IP so the same cert works
    # from both. Browsers care about SAN, not CN.
    ip = lan_ip()
    cnf = HERE / "_openssl.cnf"
    cnf.write_text(f"""
[req]
default_bits = 2048
prompt = no
default_md = sha256
distinguished_name = dn
req_extensions = req_ext
x509_extensions = req_ext

[dn]
CN = pi-ble-config-dev

[req_ext]
subjectAltName = @alt_names

[alt_names]
DNS.1 = localhost
IP.1  = 127.0.0.1
IP.2  = {ip}
""")
    try:
        subprocess.run(
            [
                "openssl", "req", "-x509", "-nodes",
                "-days", "825",                 # iOS caps trust at 825d
                "-newkey", "rsa:2048",
                "-keyout", str(KEY),
                "-out", str(CERT),
                "-config", str(cnf),
                "-extensions", "req_ext",
            ],
            check=True,
        )
    finally:
        cnf.unlink(missing_ok=True)
    os.chmod(KEY, 0o600)
    print(f"[serve] wrote {CERT.name} and {KEY.name}")


class QuietHandler(http.server.SimpleHTTPRequestHandler):
    # Log a single tidy line per request instead of the default verbose format.
    def log_message(self, fmt, *args):
        sys.stderr.write(f"[serve] {self.address_string()} - {fmt % args}\n")


class QuietThreadingHTTPServer(http.server.ThreadingHTTPServer):
    """ThreadingHTTPServer that doesn't print a traceback every time the
    browser drops an idle TLS connection.

    Chrome opens speculative TLS sockets it sometimes never sends a request
    on, then closes them. The stock server logs that as a multi-line
    BrokenPipeError / ConnectionResetError traceback, which clutters the
    output without telling us anything we don't already know.
    """

    _silent = (BrokenPipeError, ConnectionResetError, ConnectionAbortedError, ssl.SSLError)

    def handle_error(self, request, client_address):
        exc = sys.exc_info()[1]
        if isinstance(exc, self._silent):
            return  # swallow — these are normal for browser preconnects
        super().handle_error(request, client_address)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--host", default="0.0.0.0", help="bind address (default: 0.0.0.0)")
    ap.add_argument("--port", type=int, default=8443, help="bind port (default: 8443)")
    args = ap.parse_args()

    os.chdir(HERE)
    ensure_cert()

    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    ctx.load_cert_chain(certfile=CERT, keyfile=KEY)

    httpd = QuietThreadingHTTPServer((args.host, args.port), QuietHandler)
    httpd.socket = ctx.wrap_socket(httpd.socket, server_side=True)

    ip = lan_ip()
    print()
    print("  serving pi-ble-config web UI over HTTPS")
    print(f"    local:   https://localhost:{args.port}")
    print(f"    LAN:     https://{ip}:{args.port}")
    print()
    print("  first visit on each device: accept the self-signed cert warning")
    print("  (it's the cert in this directory — dev-cert.pem)")
    print()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n[serve] bye")
    return 0


if __name__ == "__main__":
    sys.exit(main())
