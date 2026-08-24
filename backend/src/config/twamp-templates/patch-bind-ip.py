#!/usr/bin/env python3
"""Patches github.com/ncode/twamp's vendored source to support binding the
outbound TWAMP-Control TCP connection and the test-session UDP socket to a
specific local IP, driven by the TWAMP_BIND_IP env var (see twamp-client.go's
-bind-ip flag, which sets it before calling into the library).

Why a source patch: the library's own public API (ClientConfig,
TestSessionConfig) has no LocalAddr-equivalent field — confirmed by reading
client.go's Connect() (builds its own net.Dialer internally) and
test_session.go's Start() (resolves ":port" with no host, i.e. wildcard
bind). There's no way to inject a local bind address without either forking
or patching. This host is multi-homed (several RAN-facing subnets on
different interfaces) — without an explicit bind IP, the OS's default route
selection isn't guaranteed to pick the interface that actually reaches a
given reflector.

Exact-string-match-and-replace, loud abort (non-zero exit) if a pattern
isn't found — so a future upstream version bump that changes these exact
lines fails Install with a clear error instead of silently leaving
TWAMP_BIND_IP non-functional.
"""
import sys


def patch(path, replacements):
    with open(path, 'r') as f:
        content = f.read()
    for old, new in replacements:
        if old not in content:
            print(f'ERROR: expected pattern not found in {path}:\n{old!r}', file=sys.stderr)
            sys.exit(1)
        content = content.replace(old, new, 1)
    with open(path, 'w') as f:
        f.write(content)
    print(f'Patched {path}')


patch('vendor/github.com/ncode/twamp/client/client.go', [
    (
        '\t"net"\n\t"sort"\n',
        '\t"net"\n\t"os"\n\t"sort"\n',
    ),
    (
        '\tdialer := net.Dialer{Timeout: c.config.Timeout}\n',
        '\tdialer := net.Dialer{Timeout: c.config.Timeout}\n'
        '\tif bindIP := os.Getenv("TWAMP_BIND_IP"); bindIP != "" {\n'
        '\t\tdialer.LocalAddr = &net.TCPAddr{IP: net.ParseIP(bindIP)}\n'
        '\t}\n',
    ),
])

patch('vendor/github.com/ncode/twamp/client/test_session.go', [
    (
        '\t"math"\n\t"net"\n\t"strconv"\n',
        '\t"math"\n\t"net"\n\t"os"\n\t"strconv"\n',
    ),
    (
        '\taddr, err := net.ResolveUDPAddr("udp", fmt.Sprintf(":%s", strconv.Itoa(int(ts.config.SenderPort))))\n',
        '\taddr, err := net.ResolveUDPAddr("udp", net.JoinHostPort(os.Getenv("TWAMP_BIND_IP"), strconv.Itoa(int(ts.config.SenderPort))))\n',
    ),
])
