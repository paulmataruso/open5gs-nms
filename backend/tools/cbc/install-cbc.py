#!/usr/bin/env python3
"""Install a private, pinned OsmoCBC with explicit TAI support. Never sends messages."""
import argparse
import fcntl
import hashlib
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import tarfile
import time
import urllib.request

PREFIX = Path('/opt/open5gs-nms-cbc')
STATE = Path('/var/lib/open5gs-nms/cbc')
UNIT = 'open5gs-nms-cbc.service'
SOURCES = [
    ('libosmocore', 'aca2c724ae94f3b4b6dba8cb16a6ddc57e405c65', 'd33928414bbfe089ab3b544a49121b5f45f76f41881c11bbc89066f0a94c60f5', '1.9.0'),
    ('libosmo-netif', 'fd2eaea8246f8125cb526b0d2f248546fdbf1221', 'b73fac0d3df5c21e983af56b1fd41c967a8e4d981d4eeb51f8b0fe286b35a251', '1.4.0'),
    ('osmo-cbc', '311673c36507f63a2bdc2d5990063cb6b15b6522', '5592b2711e1c290bb063de6e9ec56cb7aa8d90f40739a7e0d5f117ce30832a5f', '0.4.2'),
]

def run(*args, cwd=None, env=None):
    subprocess.run(args, cwd=cwd, env=env, check=True, timeout=900)

def install():
    if os.geteuid() != 0:
        raise RuntimeError('Root is required')
    STATE.mkdir(parents=True, exist_ok=True, mode=0o700)
    with (STATE / 'install.lock').open('w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        marker = PREFIX / 'tai-scope-v1.json'
        patch_file = Path(__file__).with_name('osmo-cbc-tai.patch')
        patch_hash = hashlib.sha256(patch_file.read_bytes()).hexdigest()
        installed = json.loads(marker.read_text()) if marker.exists() else {}
        if installed.get('patch_sha256') == patch_hash and (PREFIX / 'bin/osmo-cbc').exists():
            print('OsmoCBC with TAI support is already installed; existing configuration retained')
            return
        # Never replace or stop an independently managed CBC service.
        try:
            with urllib.request.urlopen('http://127.0.0.1:12345/api/ecbe/v1/nms-capabilities', timeout=2) as r:
                if json.load(r).get('scope_tais') is True and not marker.exists():
                    print('A compatible CBC is already available; retained its installation')
                    return
        except Exception:
            pass
        if not shutil.which('apt-get'):
            raise RuntimeError('Automatic installation currently supports Debian/Ubuntu')
        env = dict(os.environ, DEBIAN_FRONTEND='noninteractive')
        run('apt-get', '-o', 'DPkg::Lock::Timeout=180', 'update', env=env)
        run('apt-get', '-o', 'DPkg::Lock::Timeout=180', 'install', '-y', '--no-install-recommends',
            'build-essential', 'autoconf', 'automake', 'libtool', 'pkg-config', 'git', 'patch',
            'libtalloc-dev', 'libgnutls28-dev', 'libpcsclite-dev', 'libusb-1.0-0-dev',
            'libsctp-dev', 'libmnl-dev', 'libulfius-dev', 'libjansson-dev', 'liborcania-dev',
            'libsystemd-dev', 'liburing-dev', 'ca-certificates', env=env)
        PREFIX.mkdir(parents=True, exist_ok=True)
        env.update(PKG_CONFIG_PATH=str(PREFIX / 'lib/pkgconfig'),
                   LD_LIBRARY_PATH=str(PREFIX / 'lib'), PATH=str(PREFIX / 'bin') + ':' + env['PATH'])
        for name, revision, checksum, version in SOURCES:
            source = STATE / (name + '-' + revision)
            if name == 'osmo-cbc' and installed.get('patch_sha256') != patch_hash:
                (source / '.nms-installed').unlink(missing_ok=True)
            if not (source / '.nms-installed').exists():
                cache = STATE / (name + '.tgz')
                if not cache.exists() or hashlib.sha256(cache.read_bytes()).hexdigest() != checksum:
                    with urllib.request.urlopen('https://codeload.github.com/osmocom/' + name + '/tar.gz/' + revision, timeout=90) as r:
                        data = r.read(32 * 1024 * 1024 + 1)
                    if len(data) > 32 * 1024 * 1024 or hashlib.sha256(data).hexdigest() != checksum:
                        raise RuntimeError('Source checksum mismatch: ' + name)
                    cache.write_bytes(data)
                if source.exists():
                    shutil.rmtree(source)  # Only the installer-owned pinned source directory.
                with tarfile.open(fileobj=io.BytesIO(cache.read_bytes()), mode='r:gz') as archive:
                    archive.extractall(STATE, filter='data')
                (source / '.tarball-version').write_text(version + '\n')
                if name == 'osmo-cbc':
                    run('patch', '--batch', '--forward', '-p1', '-i', str(Path(__file__).with_name('osmo-cbc-tai.patch')), cwd=source)
                run('autoreconf', '-fi', cwd=source, env=env)
                run('./configure', '--prefix=' + str(PREFIX), '--libdir=' + str(PREFIX / 'lib'), '--disable-doxygen', cwd=source, env=env)
                run('make', '-j2', cwd=source, env=env)
                run('make', 'check', cwd=source, env=env)
                run('make', 'install', cwd=source, env=env)
                (source / '.nms-installed').touch()
        config = Path('/etc/open5gs-nms/cbc.cfg')
        config.parent.mkdir(parents=True, exist_ok=True)
        if not config.exists():
            config.write_text('''log stderr
 logging level all notice
cbc
 unknown-peers reject
 ecbe
  local-ip 127.0.0.1
  local-port 12345
 cbsp
  local-ip 127.0.0.1
  local-port 48049
 sbcap
  local-ip 127.0.0.1
  local-port 29168
 peer sbcap local-mme
  mode client
  remote-ip 127.0.0.2
  remote-port 29168
''')
            config.chmod(0o644)
        # A distinct service leaves any pre-existing distribution OsmoCBC untouched.
        if subprocess.run(['id', '-u', 'open5gs-cbc'], capture_output=True).returncode:
            run('useradd', '--system', '--home-dir', '/nonexistent', '--shell', '/usr/sbin/nologin', 'open5gs-cbc')
        unit = Path('/etc/systemd/system/' + UNIT)
        if unit.exists():
            shutil.copy2(unit, STATE / 'previous.service')
        unit.write_text('''[Unit]
Description=Open5GS NMS Cell Broadcast Centre (OsmoCBC)
After=network.target
[Service]
Type=simple
User=open5gs-cbc
Environment=LD_LIBRARY_PATH=/opt/open5gs-nms-cbc/lib
ExecStart=/opt/open5gs-nms-cbc/bin/osmo-cbc -c /etc/open5gs-nms/cbc.cfg
Restart=on-failure
RestartSec=5
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=strict
ProtectHome=yes
IPAddressDeny=any
IPAddressAllow=localhost
[Install]
WantedBy=multi-user.target
''')
        run('systemctl', 'daemon-reload')
        # No MME restart or message submission is performed by installation.
        run('systemctl', 'enable', UNIT)
        run('systemctl', 'restart', UNIT)
        for attempt in range(20):
            try:
                with urllib.request.urlopen('http://127.0.0.1:12345/api/ecbe/v1/nms-capabilities', timeout=2) as r:
                    if json.load(r).get('scope_tais') is True:
                        break
            except Exception:
                pass
            time.sleep(1)
        else:
            raise RuntimeError('CBC did not become ready; inspect journalctl -u ' + UNIT)
        marker.write_text(json.dumps({'scope_tais': True, 'patch_sha256': patch_hash, 'sources': SOURCES}))
        print('Installed OsmoCBC; REST bound to loopback. Configure compatible MME SBc-AP before sending.')

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--install', action='store_true')
    args = parser.parse_args()
    try:
        if args.install:
            install()
        else:
            print(json.dumps({'managedBinary': (PREFIX / 'bin/osmo-cbc').exists(), 'systemBinary': shutil.which('osmo-cbc')}))
    except Exception as exc:
        raise SystemExit(str(exc))
