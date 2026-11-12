#!/usr/bin/env python3
"""Prepare/activate an Open5GS build with the native MME operator interface.

No service is changed by --check, --install-dependencies or --build.
--activate explicitly restarts only the MME and rolls its unit override back
if activation fails. Use in a maintenance window; it is not a session transfer.
"""
import argparse
import datetime
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import socket
import sys
import tempfile
import time

MARKER = b"S1 release and load-balancing TAU requested"
PACKAGES = ["build-essential", "meson", "ninja-build", "cmake", "pkg-config",
            "bison", "flex", "python3", "python3-yaml", "python3-setuptools",
            "libyaml-dev", "libmongoc-dev", "libbson-dev", "libgnutls28-dev",
            "libgcrypt20-dev", "libssl-dev", "libsctp-dev", "libidn-dev",
            "libmicrohttpd-dev", "libnghttp2-dev", "libtalloc-dev", "libcares-dev"]


def run(args, **kwargs):
    return subprocess.run(args, check=True, **kwargs)


def verified_binary(prefix):
    binary = prefix / "bin/open5gs-mmed"
    if not binary.is_file() or not os.access(binary, os.X_OK):
        raise RuntimeError("Compiled MME is missing: " + str(binary))
    if MARKER not in binary.read_bytes():
        raise RuntimeError("Selected MME lacks the native operator implementation")
    return binary


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    modes = parser.add_mutually_exclusive_group(required=True)
    modes.add_argument("--check", action="store_true")
    modes.add_argument("--install-dependencies", action="store_true")
    modes.add_argument("--build", action="store_true")
    modes.add_argument("--activate", action="store_true")
    parser.add_argument("--source", type=Path)
    parser.add_argument("--prefix", type=Path, default=Path("/opt/open5gs-ha"))
    parser.add_argument("--jobs", type=int, default=2, choices=range(1, 5))
    args = parser.parse_args()
    prefix = args.prefix.resolve()
    if not re.fullmatch(r"/[A-Za-z0-9_/.-]+", str(prefix)) or str(prefix) in ("/", "/usr", "/usr/local", "/opt/open5gs"):
        raise RuntimeError("Use a separate absolute installation prefix, e.g. /opt/open5gs-ha")
    if args.check:
        print(json.dumps({"root": os.geteuid() == 0,
                          "tools": {t: shutil.which(t) for t in ("gcc", "meson", "ninja", "pkg-config", "python3", "ssh", "systemctl")},
                          "operator_binary": (prefix / "bin/open5gs-mmed").is_file(),
                          "operator_socket": Path("/run/open5gs-mme-operator/control.sock").exists()}, indent=2))
        return
    if os.geteuid() != 0:
        raise RuntimeError("This action requires root")
    if args.install_dependencies:
        if not shutil.which("apt-get"):
            raise RuntimeError("Automatic dependency installation supports Debian/Ubuntu with apt-get")
        run(["apt-get", "update"])
        run(["apt-get", "install", "-y", "--no-install-recommends", *PACKAGES],
            env={**os.environ, "DEBIAN_FRONTEND": "noninteractive"})
        return
    if args.build:
        if not args.source:
            raise RuntimeError("--build requires --source pointing to the reviewed Open5GS checkout")
        source = args.source.resolve()
        if not (source / "src/mme/mme-operator.c").is_file():
            raise RuntimeError("Source checkout does not contain native MME operator control")
        for tool in ("meson", "ninja", "gcc", "pkg-config"):
            if not shutil.which(tool):
                raise RuntimeError("Missing " + tool + "; run --install-dependencies first")
        build = source / "build-nms-operator"
        if (build / "meson-private/coredata.dat").exists():
            options = json.loads(subprocess.check_output(["meson", "introspect", "--buildoptions", str(build)], text=True))
            configured = {o["name"]: o["value"] for o in options}
            if configured.get("prefix") != str(prefix) or configured.get("sysconfdir") != str(prefix / "etc"):
                raise RuntimeError("Existing build uses different install paths; choose a fresh source checkout")
        else:
            run(["meson", "setup", str(build), str(source), "--buildtype=release",
                 "--prefix=" + str(prefix), "--sysconfdir=" + str(prefix / "etc"),
                 "--localstatedir=" + str(prefix / "var")])
        run(["meson", "compile", "-C", str(build), "-j", str(args.jobs)])
        run(["meson", "test", "-C", str(build), "--suite", "unit", "--print-errorlogs"])
        run(["meson", "install", "-C", str(build), "--no-rebuild"], env={k:v for k,v in os.environ.items() if k != "DESTDIR"})
        print(json.dumps({"prepared_binary": str(verified_binary(prefix)), "activated": False}))
        return
    binary = verified_binary(prefix)
    if not Path("/etc/open5gs/mme.yaml").is_file():
        raise RuntimeError("Existing MME configuration /etc/open5gs/mme.yaml is missing")
    run(["systemctl", "show", "open5gs-mmed.service", "--property=ExecStart"], stdout=subprocess.PIPE)
    directory = Path("/etc/systemd/system/open5gs-mmed.service.d")
    directory.mkdir(parents=True, exist_ok=True)
    target = directory / "90-nms-operator.conf"
    previous = target.read_bytes() if target.exists() else None
    backup = Path("/var/backups/open5gs-nms") / ("mme-operator-" + datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%S%fZ"))
    backup.mkdir(parents=True, mode=0o700)
    if previous is not None:
        (backup / target.name).write_bytes(previous)
    override = ("[Service]\nExecStart=\nExecStart=" + str(binary) + " -c /etc/open5gs/mme.yaml\n"
                "Environment=OPEN5GS_MME_OPERATOR_SOCKET=/run/open5gs-mme-operator/control.sock\n"
                "RuntimeDirectory=open5gs-mme-operator\nRuntimeDirectoryMode=0700\n")
    fd, name = tempfile.mkstemp(dir=directory, prefix=".operator-")
    try:
        with os.fdopen(fd, "w") as stream:
            stream.write(override)
            stream.flush()
            os.fsync(stream.fileno())
        os.chmod(name, 0o644)
        os.replace(name, target)
        run(["systemctl", "daemon-reload"])
        run(["systemctl", "restart", "open5gs-mmed.service"])
        run(["systemctl", "is-active", "--quiet", "open5gs-mmed.service"])
        deadline = time.monotonic() + 30
        ready = False
        while time.monotonic() < deadline:
            try:
                with tempfile.TemporaryDirectory(prefix="check-mme-operator-") as client_dir:
                    with socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM) as client:
                        client.settimeout(1)
                        client.bind(client_dir + "/client.sock")
                        client.connect("/run/open5gs-mme-operator/control.sock")
                        client.send(b'{"operation":"capabilities"}')
                        reply = json.loads(client.recv(4096))
                        ready = reply.get("ok") is True and reply.get("protocol") == 1
                if ready:
                    break
            except (OSError, ValueError):
                pass
            time.sleep(0.5)
        if not ready:
            raise RuntimeError("MME operator did not become ready within 30 seconds")
    except Exception:
        if previous is None:
            target.unlink(missing_ok=True)
        else:
            target.write_bytes(previous)
        run(["systemctl", "daemon-reload"])
        run(["systemctl", "restart", "open5gs-mmed.service"])
        raise
    finally:
        Path(name).unlink(missing_ok=True)
    print(json.dumps({"activated_binary": str(binary), "backup": str(backup), "service": "open5gs-mmed.service"}))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
