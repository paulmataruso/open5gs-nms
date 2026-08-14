// Builds strongSwan from source for the Security Gateway module, instead of installing
// the distro's strongswan-swanctl/charon-systemd packages. This exists because of a real,
// confirmed-live conflict: VectorCore ePDG (the VoWiFi module's own IKEv2 responder)
// already owns UDP 500/4500 bound to its own specific address, and the distro-packaged
// charon only ships the socket-default plugin, which unconditionally binds the IPv4
// *wildcard* address (0.0.0.0:500) — colliding with ePDG's specific bind and leaving
// charon with no IPv4 socket at all ("unable to bind socket: Address already in use" /
// "could not open IPv4 socket, IPv4 disabled", confirmed live 2026-08-12). The
// `socket-dynamic` plugin looked like the fix but isn't — traced through its own source
// (socket_dynamic_socket.c): it opens zero sockets at startup and only binds one lazily
// when charon itself *sends* from a specific source address, so it can never receive an
// unsolicited inbound IKE_SA_INIT from a radio it hasn't talked to yet. The actual fix is
// a small, surgical patch to socket-default's own open_socket() (in
// socket_default_socket.c): when the SECGW_BIND_ADDR environment variable is set, bind
// that specific address instead of the wildcard — sidestepping the collision with ePDG
// entirely, since the two daemons then hold non-overlapping specific-address sockets.
// Same live-verified-then-baked-in workflow this project already uses for VoWiFi's own
// uplink/half-open-reaper fixes in vowifi-build.ts.

export const STRONGSWAN_VERSION = '5.9.13';
// Bumped whenever this file's build steps or the socket_default_socket.c patch change —
// same reasoning as vowifi-build.ts's VECTORCORE_PATCH_REV.
export const SECGW_PATCH_REV = 1;

export const SECGW_BUILD_WORKDIR = '/opt/strongswan-src';
export const SECGW_INSTALL_PREFIX = '/opt/strongswan';
export const SECGW_CHARON_BIN = `${SECGW_INSTALL_PREFIX}/sbin/charon-systemd`;
export const SECGW_SWANCTL_BIN = `${SECGW_INSTALL_PREFIX}/sbin/swanctl`;

// Real, single-line find-and-replace of the C statement — deliberately built with
// ONLY real newlines (never `\n` escape sequences) in this TS template literal, per
// the hard-won lesson in vowifi-build.ts: a JS template literal silently drops a
// backslash in front of any character that isn't a recognized escape, and even where
// `\n`/`\t` ARE recognized escapes, using them here would mean this outer TS template
// literal converts them into real newline/tab bytes on disk — which then breaks the
// *inner* Python single-quoted string literals below (an unescaped raw newline inside
// a Python '...' string is a SyntaxError). Every line break and indent below is a
// literal keystroke, not an escape sequence, so nothing here is at risk of that bug.
function socketDefaultPatchScript(): string {
  return `python3 - <<'PYEOF'
path = '${SECGW_BUILD_WORKDIR}/strongswan-${STRONGSWAN_VERSION}/src/libcharon/plugins/socket_default/socket_default_socket.c'
src = open(path).read()
src = src.replace('#include <netinet/in.h>', '''#include <netinet/in.h>
#include <arpa/inet.h>''', 1)
needle = 'addr.sin.sin_addr.s_addr = htonl(INADDR_ANY);'
assert src.count(needle) == 1, f'expected exactly 1 match of the INADDR_ANY line, found {src.count(needle)}'
replacement = '''{
                const char *secgw_bind = getenv("SECGW_BIND_ADDR");
                if (secgw_bind && inet_pton(AF_INET, secgw_bind, &addr.sin.sin_addr) == 1)
                {
                    DBG1(DBG_NET, "binding IPv4 socket to %s (SECGW_BIND_ADDR) instead of wildcard", secgw_bind);
                }
                else
                {
                    addr.sin.sin_addr.s_addr = htonl(INADDR_ANY);
                }
            }'''
src = src.replace(needle, replacement, 1)
open(path, 'w').write(src)
print('socket_default_socket.c patched OK (SECGW_PATCH_REV ${SECGW_PATCH_REV})')
PYEOF`;
}

// Full install script — apt build toolchain only (no strongswan-swanctl/charon-systemd
// runtime packages at all; we build and install our own binaries+plugins entirely under
// SECGW_INSTALL_PREFIX, so nothing at runtime depends on the distro packages). Re-fetches
// a clean source tree on every run (wipes SECGW_BUILD_WORKDIR first) so the patch above
// always applies cleanly, matching vowifi-build.ts's own clean-checkout-each-run
// convention. Streamed synchronously to the browser (unlike VoWiFi's detached+polled
// build) — a strongSwan build is a few minutes, well within nginx's 1800s streaming
// timeout for this route.
export function buildSecgwScript(): string {
  return `set -e
echo "==STEP:apt_build_deps=="
DEBIAN_FRONTEND=noninteractive apt-get update
DEBIAN_FRONTEND=noninteractive apt-get install -y build-essential autoconf automake libtool pkg-config bison flex libssl-dev libgmp-dev libsystemd-dev curl python3

echo "==STEP:fetch_source=="
rm -rf ${SECGW_BUILD_WORKDIR}
mkdir -p ${SECGW_BUILD_WORKDIR}
cd ${SECGW_BUILD_WORKDIR}
curl -fsSL -o strongswan-${STRONGSWAN_VERSION}.tar.bz2 https://download.strongswan.org/strongswan-${STRONGSWAN_VERSION}.tar.bz2
tar xjf strongswan-${STRONGSWAN_VERSION}.tar.bz2

echo "==STEP:patch_socket_default=="
${socketDefaultPatchScript()}

echo "==STEP:clean_previous_install=="
# Real bug found live (2026-08-13): "make install" only adds/overwrites the files the
# CURRENT ./configure produces — it never removes files a PREVIOUSLY, differently-
# configured install left behind. A stale libstrongswan-socket-dynamic.so (from an
# earlier build that had --enable-socket-dynamic instead of the patched socket-default)
# survived every subsequent rebuild, and since both plugins register the same socket_t
# feature, charon silently activated the stale one (loaded first) — meaning zero
# listening sockets, the exact same symptom as the wildcard-bind bug this whole patch
# exists to fix, just from a different cause. Wiping the install prefix (not just the
# source workdir) before every install guarantees only the CURRENT configure's plugin
# set can ever be on disk. The socket-dynamic.conf drop-in lives under --sysconfdir
# (/etc/strongswan.d), outside the install prefix, so it needs its own explicit removal
# — never wipe /etc/strongswan.d wholesale, that also holds legitimate distro-shipped
# defaults for plugins this build still uses.
rm -rf ${SECGW_INSTALL_PREFIX}
rm -f /etc/strongswan.d/charon/socket-dynamic.conf

echo "==STEP:configure=="
cd ${SECGW_BUILD_WORKDIR}/strongswan-${STRONGSWAN_VERSION}
./configure --prefix=${SECGW_INSTALL_PREFIX} --sysconfdir=/etc \\
  --enable-openssl --enable-vici --enable-swanctl \\
  --enable-socket-default --disable-socket-dynamic \\
  --enable-kernel-netlink --enable-updown --enable-systemd

echo "==STEP:build=="
make -j$(nproc)

echo "==STEP:install=="
make install

echo "==STEP:swanctl_symlink=="
if [ ! -L /usr/sbin/swanctl ]; then
  if [ -f /usr/sbin/swanctl ]; then
    mv /usr/sbin/swanctl /usr/sbin/swanctl.apt-orig
  fi
  ln -sf ${SECGW_SWANCTL_BIN} /usr/sbin/swanctl
fi

echo "==STEP:done=="
`;
}
