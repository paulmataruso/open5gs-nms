import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';

const execFileAsync = promisify(execFile);

// Same read-only mount every SAS route already uses (docker-compose.yml:
// backend's own ./nginx/certs:/etc/nginx/certs:ro) -- fine for reads.
const CERT_DIR_RO = '/etc/nginx/certs';
const NGINX_CONTAINER = 'open5gs-nms-nginx';
const HOST_ROOT = '/proc/1/root';

// The backend's own mount above is read-only, so writes go through the
// real host path instead (HOST_ROOT convention used everywhere else in
// this codebase for host file access) -- resolved via `docker inspect`
// rather than hardcoded, since this repo can be cloned to any path on the
// host. Cached for the life of the process; the mount source can't change
// without a container recreate, which would restart this process too.
let cachedCertDirHost: string | null = null;
async function resolveCertDirHost(): Promise<string> {
  if (cachedCertDirHost) return cachedCertDirHost;
  const { stdout } = await execFileAsync('docker', [
    'inspect', NGINX_CONTAINER,
    '--format', '{{range .Mounts}}{{.Destination}}={{.Source}}\n{{end}}',
  ]);
  const line = stdout.split('\n').find(l => l.startsWith('/etc/nginx/certs='));
  if (!line) throw new Error('could not resolve nginx certs mount source via docker inspect -- is the nginx container running?');
  cachedCertDirHost = `${HOST_ROOT}${line.slice('/etc/nginx/certs='.length).trim()}`;
  return cachedCertDirHost;
}

// Real host IPs only -- excludes loopback and this project's own internal-
// only interfaces (dummy-* per-NF loopback aliases, ogstun*/apn-* UE data
// plane TUNs, docker0) since a radio would never actually reach the SAS
// endpoint through any of those, only through a real physical/tagged NIC.
// The backend runs with network_mode:host (docker-compose.yml), so this
// sees the host's real interfaces directly -- no nsenter needed for the
// read. Almost every deployment is multi-homed (confirmed live 2026-09-27:
// this host alone has a management NIC and a separate RAN-facing one), and
// most radios are pointed at the SAS server by IP, not FQDN, so surfacing
// every real candidate here (not just whichever one the default route
// prefers) is what setup-sas-cert.sh's own initial seed and this module's
// regenerate-leaf default now both build the SAN from.
const EXCLUDE_IFACE = /^(lo|docker\d*|br-|veth|ogstun|apn-|dummy-)/;
export async function getHostIps(): Promise<string[]> {
  const { stdout } = await execFileAsync('ip', ['-4', '-o', 'addr', 'show']);
  const ips: string[] = [];
  for (const line of stdout.split('\n')) {
    const m = /^\d+:\s+(\S+)\s+inet\s+(\d+\.\d+\.\d+\.\d+)\//.exec(line);
    if (!m) continue;
    const [, iface, ip] = m;
    if (EXCLUDE_IFACE.test(iface)) continue;
    ips.push(ip);
  }
  return ips;
}

async function reloadNginx(): Promise<void> {
  // Config-test before reload, same care-before-acting shape as every
  // other "apply then verify" action in this codebase -- a bad cert pair
  // would otherwise take the live SAS endpoint down for every already-
  // connected radio, not just fail silently for the one being reconfigured.
  await execFileAsync('docker', ['exec', NGINX_CONTAINER, 'nginx', '-t']);
  await execFileAsync('docker', ['exec', NGINX_CONTAINER, 'nginx', '-s', 'reload']);
}

interface CertInfo {
  subject: string;
  issuer: string;
  notBefore: string;
  notAfter: string;
  daysRemaining: number;
  san: string[];
}

async function readCertInfo(certPath: string): Promise<CertInfo> {
  const { stdout: subject } = await execFileAsync('openssl', ['x509', '-in', certPath, '-noout', '-subject', '-nameopt', 'RFC2253']);
  const { stdout: issuer } = await execFileAsync('openssl', ['x509', '-in', certPath, '-noout', '-issuer', '-nameopt', 'RFC2253']);
  const { stdout: dates } = await execFileAsync('openssl', ['x509', '-in', certPath, '-noout', '-startdate', '-enddate']);
  const { stdout: sanRaw } = await execFileAsync('openssl', ['x509', '-in', certPath, '-noout', '-ext', 'subjectAltName']).catch(() => ({ stdout: '' }));

  const notBefore = /notBefore=(.+)/.exec(dates)?.[1]?.trim() ?? '';
  const notAfter = /notAfter=(.+)/.exec(dates)?.[1]?.trim() ?? '';
  const daysRemaining = notAfter ? Math.floor((new Date(notAfter).getTime() - Date.now()) / 86400000) : 0;
  // openssl's `-ext subjectAltName` DISPLAY format ("IP Address:x.x.x.x")
  // differs from the `-extfile`/config-file INPUT format it itself requires
  // ("IP:x.x.x.x") for the exact same SAN type — confirmed live 2026-10-02
  // via the API regression suite's sas module: regenerateSasLeaf() reuses
  // this parsed list as the default SAN when refreshing an already-existing
  // leaf (its own "plain no-args call just refreshes it unchanged"
  // contract), and feeding "IP Address:" straight into a fresh -extfile
  // is a real, 100%-reproducible openssl error ("unsupported option...
  // name=IP Address") on every such refresh once any cert on this host has
  // ever had a real IP in its SAN — i.e. every regeneration after the
  // first. DNS: entries aren't affected (display and input format match).
  const san = sanRaw.split(',')
    .map(s => s.trim())
    .filter(s => s && !s.startsWith('X509v3'))
    .map(s => s.startsWith('IP Address:') ? `IP:${s.slice('IP Address:'.length)}` : s);

  return {
    subject: subject.replace(/^subject=/, '').trim(),
    issuer: issuer.replace(/^issuer=/, '').trim(),
    notBefore, notAfter, daysRemaining, san,
  };
}

export interface SasPkiStatus {
  root: CertInfo | null;
  leaf: CertInfo | null;
  hostIps: string[];
}

export async function getSasPkiStatus(): Promise<SasPkiStatus> {
  const rootPath = path.join(CERT_DIR_RO, 'sas.crt');
  const leafPath = path.join(CERT_DIR_RO, 'sas-leaf.crt');
  return {
    hostIps: await getHostIps().catch(() => []),
    root: fs.existsSync(rootPath) ? await readCertInfo(rootPath) : null,
    leaf: fs.existsSync(leafPath) ? await readCertInfo(leafPath) : null,
  };
}

function subjectFor(cn: string): string {
  return `/C=US/ST=CBRS/L=Private/O=Open5GS NMS/CN=${cn}`;
}

// Regenerates ONLY the leaf/server cert, re-signed by whatever root CA is
// already on disk -- low blast radius, doesn't invalidate any radio that's
// already installed the root as its trust anchor. Any field left
// unspecified is carried forward from the CURRENT leaf (its existing CN,
// its existing SAN list, a fresh 3650-day validity) so a plain no-args
// call just refreshes it unchanged -- this is the "sane defaults, change
// later" behavior the SAS page's Certificates tab relies on.
export async function regenerateSasLeaf(opts: { cn?: string; san?: string[]; days?: number } = {}): Promise<SasPkiStatus> {
  const dir = await resolveCertDirHost();
  const rootCert = path.join(dir, 'sas.crt');
  const rootKey = path.join(dir, 'sas.key');
  if (!fs.existsSync(rootCert) || !fs.existsSync(rootKey)) {
    throw new Error('no root CA on disk yet -- run nginx/setup-sas-cert.sh once first, or regenerate the root CA instead');
  }

  const current = fs.existsSync(path.join(CERT_DIR_RO, 'sas-leaf.crt'))
    ? await readCertInfo(path.join(CERT_DIR_RO, 'sas-leaf.crt'))
    : null;
  const cn = opts.cn ?? (current ? /CN=([^,]+)/.exec(current.subject)?.[1] ?? 'sas.local' : 'sas.local');
  const san = opts.san && opts.san.length > 0
    ? opts.san
    : current?.san.length
      ? current.san
      : [...(await getHostIps().catch(() => [])).map(ip => `IP:${ip}`), 'DNS:sas.local', 'DNS:localhost'];
  const days = opts.days ?? 3650;

  const leafKey = path.join(dir, 'sas-leaf.key');
  const leafCert = path.join(dir, 'sas-leaf.crt');
  const leafCsr = path.join(dir, 'sas-leaf.csr');
  const extfile = path.join(dir, '.sas-leaf-ext.cnf');

  await execFileAsync('openssl', [
    'req', '-newkey', 'rsa:4096', '-keyout', leafKey, '-out', leafCsr, '-nodes',
    '-subj', subjectFor(cn),
  ]);

  fs.writeFileSync(extfile,
    `subjectAltName=${san.join(',')}\nbasicConstraints=CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n`);

  await execFileAsync('openssl', [
    'x509', '-req', '-in', leafCsr,
    '-CA', rootCert, '-CAkey', rootKey, '-CAcreateserial',
    '-out', leafCert, '-days', String(days), '-extfile', extfile,
  ]);

  fs.rmSync(leafCsr, { force: true });
  fs.rmSync(extfile, { force: true });
  fs.rmSync(path.join(dir, 'sas.srl'), { force: true });

  fs.writeFileSync(path.join(dir, 'sas-fullchain.crt'),
    fs.readFileSync(leafCert, 'utf-8') + fs.readFileSync(rootCert, 'utf-8'));

  await reloadNginx();
  return getSasPkiStatus();
}

// Regenerates the ROOT CA itself -- real blast radius: any radio that
// already installed the CURRENT root as its trust anchor (e.g. a Nokia
// AirScale's "Install CBRS vendor chain") will reject the new one until
// it's re-installed there too. Cascades into regenerating the leaf as
// well (a leaf signed by a now-deleted root is a broken chain), reusing
// the leaf's existing CN/SAN unless also overridden here. Callers MUST
// pass confirm:true -- this is a deliberate, explicit-opt-in action, not
// something a route should ever trigger as a side effect of something
// else.
export async function regenerateSasRoot(opts: { cn?: string; days?: number; confirm: boolean; leafCn?: string; leafSan?: string[] }): Promise<SasPkiStatus> {
  if (!opts.confirm) {
    throw new Error('root CA regeneration requires confirm:true -- this invalidates trust on any radio that already installed the current root');
  }
  const dir = await resolveCertDirHost();
  const rootKey = path.join(dir, 'sas.key');
  const rootCert = path.join(dir, 'sas.crt');
  const cn = opts.cn ?? 'Open5GS NMS SAS Root CA';
  const days = opts.days ?? 3650;

  await execFileAsync('openssl', [
    'req', '-x509', '-newkey', 'rsa:4096', '-keyout', rootKey, '-out', rootCert,
    '-days', String(days), '-nodes', '-subj', subjectFor(cn),
    '-addext', 'basicConstraints=critical,CA:TRUE,pathlen:0',
    '-addext', 'keyUsage=critical,keyCertSign,cRLSign',
  ]);

  fs.writeFileSync(path.join(dir, 'sas.pem'), fs.readFileSync(rootCert, 'utf-8'));

  // Cascade: the leaf must be re-signed by the new root, since its old
  // signature no longer chains to anything on disk.
  return regenerateSasLeaf({ cn: opts.leafCn, san: opts.leafSan, days });
}
