#!/usr/bin/env python3
"""Install codec tools locally; build the pinned, official ETSI EVS reference.

No third-party codec source is redistributed in this repository. Keep the
original source/readme alongside the installed binary in the persistent volume.
"""
import hashlib
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import urllib.request
import zipfile

URL = 'https://www.etsi.org/deliver/etsi_ts/126400_126499/126443/18.00.00_60/ts_126443v180000p0.zip'
SHA256 = '5cd59413e9bf252e54cb753a1467ec7947925030481b182f503a18eadb9441dc'
DEST = Path(os.environ.get('UE_CODEC_DIR', str(Path.cwd() / 'data/ue-codecs')))


def run(args, **kwargs):
    subprocess.run(args, check=True, timeout=240, **kwargs)


def unpack(data, destination):
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        if sum(info.file_size for info in archive.infolist()) > 150_000_000:
            raise RuntimeError('Codec archive is too large')
        for name in archive.namelist():
            target = (destination / name).resolve()
            if not target.is_relative_to(destination.resolve()):
                raise RuntimeError('Unsafe codec archive path')
        archive.extractall(destination)


def main():
    DEST.mkdir(parents=True, exist_ok=True)
    # A second installer process (e.g. another backend) must not race the build.
    import fcntl
    with (DEST / 'install.lock').open('w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        packages = [] if shutil.which('ffmpeg') else ['ffmpeg']
        if not (DEST / 'EVS_dec').is_file():
            packages += [p for p, binary in [('gcc', 'gcc'), ('make', 'make')] if not shutil.which(binary)]
            if not Path('/usr/include/stdlib.h').exists():
                packages += ['libc6-dev']
        if packages:
            env = dict(os.environ, DEBIAN_FRONTEND='noninteractive')
            run(['apt-get', 'update'], env=env)
            run(['apt-get', 'install', '-y', '--no-install-recommends', *packages], env=env)
        if not (DEST / 'EVS_dec').is_file():
            cached = DEST / 'official-source.zip'
            if cached.is_file() and hashlib.sha256(cached.read_bytes()).hexdigest() == SHA256:
                data = cached.read_bytes()
            else:
                data = subprocess.check_output(['curl', '--silent', '--show-error', '--fail', '--location', '--max-time', '60', '--max-filesize', '10000000', '--proto', '=https', URL], timeout=70)
            if hashlib.sha256(data).hexdigest() != SHA256:
                raise RuntimeError('Official EVS archive checksum mismatch')
            with tempfile.TemporaryDirectory(prefix='build-', dir=DEST) as temporary:
                folder = Path(temporary)
                unpack(data, folder)
                source_archive = folder / '26443-i00-ANSI-C_source_code.zip'
                unpack(source_archive.read_bytes(), folder / 'source')
                source = folder / 'source/c-code'
                run(['make', '-j2', 'EVS_dec'], cwd=source)
                # Atomic replacement: a failed build cannot replace a good decoder.
                shutil.copy2(source / 'EVS_dec', DEST / 'EVS_dec.new')
                (DEST / 'EVS_dec.new').chmod(0o755)
                os.replace(DEST / 'EVS_dec.new', DEST / 'EVS_dec')
                shutil.copy2(source / 'readme.txt', DEST / 'EVS-readme.txt')
                (DEST / 'official-source.zip').write_bytes(data)
                (DEST / 'source.json').write_text(json.dumps({'url': URL, 'sha256': SHA256}))
        print('UE audio codec tools installed')


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
