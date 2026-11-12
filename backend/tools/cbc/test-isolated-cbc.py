#!/usr/bin/env python3
"""Run with unshare --net; only loopback interfaces may exist. No real RAN is reachable."""
import json
import os
from pathlib import Path
import socket
import subprocess
import tempfile
import threading
import time
import urllib.request
import urllib.error

assert os.geteuid() == 0
assert {link['ifname'] for link in json.loads(subprocess.check_output(['ip', '-j', 'link']))} == {'lo'}, 'Run in an isolated network namespace'
subprocess.run(['ip', 'link', 'set', 'lo', 'up'], check=True)
base = 'http://127.0.0.1:12345/api/ecbe/v1/'
env = dict(os.environ, LD_LIBRARY_PATH='/opt/open5gs-nms-cbc/lib')

with tempfile.TemporaryDirectory(prefix='cbc-wire-test-') as temp:
    directory = Path(temp)
    listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM, socket.IPPROTO_SCTP)
    listener.settimeout(20)
    listener.bind(('127.0.0.2', 29168))
    listener.listen(1)
    failures = []

    def mock_mme():
        try:
            connection, _ = listener.accept()
            connection.settimeout(20)
            with connection:
                for procedure in range(2):
                    data = connection.recv(4096)
                    assert data
                    (directory / ('write.bin' if procedure == 0 else 'stop.bin')).write_bytes(data)
                    # Standard accepted response fixture, IDs match this isolated message.
                    reply = bytearray.fromhex('2000001400000300050002002b000b000241700001000100')
                    reply[1] = procedure
                    reply[11:13] = (4380).to_bytes(2, 'big')
                    reply[17:19] = (16385).to_bytes(2, 'big')
                    connection.sendall(reply)
        except Exception as exc:
            failures.append(exc)

    worker = threading.Thread(target=mock_mme, daemon=True)
    worker.start()
    config = directory / 'cbc.cfg'
    config.write_text(Path('/etc/open5gs-nms/cbc.cfg').read_text())
    log = (directory / 'cbc.log').open('w+')
    process = subprocess.Popen(['/opt/open5gs-nms-cbc/bin/osmo-cbc', '-c', str(config)], env=env, stdout=log, stderr=log)
    try:
        for _ in range(50):
            try:
                urllib.request.urlopen(base + 'nms-capabilities', timeout=1).close()
                break
            except Exception:
                time.sleep(.1)
        else:
            raise RuntimeError('Isolated CBC did not start')
        message = {'cbe_name': 'isolated-test', 'category': 'normal', 'repetition_period': 30, 'num_of_bcast': 1,
                   'scope': {'scope_tais': [{'plmn': '00101', 'tac': 1}, {'plmn': '001001', 'tac': 257}]},
                   'smscb_message': {'message_id': 4380, 'serial_nr': {'serial_nr_encoded': 16385},
                                     'payload': {'payload_decoded': {'character_set': 'ucs2', 'data_utf8': 'Isolated test'}}}}
        for bad in [[], [{'plmn': 'invalid', 'tac': 1}], [{'plmn': '00101', 'tac': 65536}]]:
            wrong = dict(message, scope={'scope_tais': bad})
            try:
                urllib.request.urlopen(urllib.request.Request(base + 'message', data=json.dumps(wrong).encode(), headers={'Content-Type': 'application/json'}), timeout=5)
                raise AssertionError('Invalid scope was accepted')
            except urllib.error.HTTPError as exc:
                assert exc.code == 400
        request = urllib.request.Request(base + 'message', data=json.dumps(message).encode(), headers={'Content-Type': 'application/json'})
        with urllib.request.urlopen(request, timeout=20) as response:
            assert 200 <= response.status < 300
        with urllib.request.urlopen(urllib.request.Request(base + 'message/4380', method='DELETE'), timeout=20) as response:
            assert 200 <= response.status < 300
        worker.join(timeout=5)
        assert not worker.is_alive() and not failures, failures
        subprocess.run(['/tmp/check-tai-wire', str(directory / 'write.bin'), str(directory / 'stop.bin')], env=env, check=True)
        print('Invalid REST scopes refused; real CBC write/stop exchange passed in loopback-only namespace')
    finally:
        process.terminate()
        process.wait(timeout=5)
        listener.close()
        if failures:
            log.seek(0)
            print(log.read()[-4000:])
        log.close()
