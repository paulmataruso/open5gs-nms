import * as yaml from 'js-yaml';
import { updateSmfImsSession, removeSmfImsSession } from '../../../interfaces/rest/ims-controller';

// Reproduces a user-reported smf.yaml corruption (2026-10-11). Their config
// routes a DNN to a specific UPF — a normal Open5GS feature — which puts a
// `dnn: ims` line inside pfcp.client.upf[] as well as inside smf.session[].
// updateSmfImsSession() searched for the FIRST /^\s+dnn:\s*ims\s*$/ anywhere in
// the file, matched the UPF one, and from there walked out to the whole
// document and filtered it down to just subnet/gateway/dnn lines — destroying
// everything else, including the entire sbi block. The GUI then reported
// "SMF has no NRF or SCP client configured under sbi.client", which is a
// symptom, not the cause.
const USER_CONFIG = `logger:
  file:
    path: /var/log/open5gs/smf.log
  level: info
global:
  max:
    ue: 1024
parameter:
  no_ipv4v6_local_addr_in_packet_filter: true
smf:
  sbi:
    server:
      - address: 127.0.0.4
        port: 7777
        advertise: smf.5gc.mnc001.mcc001.3gppnetwork.org:7777
    client:
      scp:
        - uri: http://scp.5gc.mnc001.mcc001.3gppnetwork.org:7777
  pfcp:
    server:
      - address: 10.233.188.3
      - address: 127.0.0.4
    client:
      upf:
        - address: 10.233.188.4
          dnn: ims
          tac: 1
        - address: 10.233.187.1
          tac: 2
  gtpc:
    server:
      - address: 127.0.0.4
  gtpu:
    server:
      - address: 127.0.0.4
  metrics:
    server:
      - address: 127.0.0.4
        port: 9090
  session:
    - subnet: 10.46.0.0/16
      gateway: 10.46.0.1
      dnn: ims
      dns:
        - 10.46.0.1
    - subnet: 10.45.0.0/16
      gateway: 10.45.0.1
      dnn: internet
  dns:
    - 10.45.0.1
    - 2001:4860:4860::8888
    - 2001:4860:4860::8844
  p-cscf:
    - 10.46.0.1
  mtu: 1360
  freeDiameter: /etc/freeDiameter/smf.conf
`;

describe('updateSmfImsSession with a per-UPF dnn route', () => {
  const out = () => updateSmfImsSession(USER_CONFIG, '10.46.0.1');

  it('produces valid YAML', () => {
    expect(() => yaml.load(out())).not.toThrow();
  });

  it('keeps the sbi block, which is what the GUI complained about losing', () => {
    const d = yaml.load(out()) as any;
    expect(d.smf.sbi?.client?.scp?.[0]?.uri)
      .toBe('http://scp.5gc.mnc001.mcc001.3gppnetwork.org:7777');
    expect(d.smf.sbi?.server?.[0]?.advertise)
      .toBe('smf.5gc.mnc001.mcc001.3gppnetwork.org:7777');
  });

  it('keeps the per-UPF dnn route it must not have touched', () => {
    const d = yaml.load(out()) as any;
    const upf = d.smf.pfcp?.client?.upf;
    expect(upf).toHaveLength(2);
    expect(upf[0]).toMatchObject({ address: '10.233.188.4', dnn: 'ims', tac: 1 });
    expect(upf[1]).toMatchObject({ address: '10.233.187.1', tac: 2 });
  });

  it('keeps every other top-level and smf-level key', () => {
    const d = yaml.load(out()) as any;
    expect(d.logger?.level).toBe('info');
    expect(d.global?.max?.ue).toBe(1024);
    expect(d.parameter?.no_ipv4v6_local_addr_in_packet_filter).toBe(true);
    expect(d.smf.pfcp?.server).toHaveLength(2);
    expect(d.smf.gtpc?.server?.[0]?.address).toBe('127.0.0.4');
    expect(d.smf.gtpu?.server?.[0]?.address).toBe('127.0.0.4');
    expect(d.smf.metrics?.server?.[0]?.port).toBe(9090);
    expect(d.smf.mtu).toBe(1360);
    expect(d.smf.freeDiameter).toBe('/etc/freeDiameter/smf.conf');
    expect(d.smf.dns).toEqual(['10.45.0.1', '2001:4860:4860::8888', '2001:4860:4860::8844']);
  });

  it('still does its actual job: the ims session gets dns, and p-cscf is set', () => {
    const d = yaml.load(out()) as any;
    const ims = d.smf.session.find((s: any) => s.dnn === 'ims');
    expect(ims).toBeDefined();
    expect(ims.subnet).toBe('10.46.0.0/16');   // the operator's own value, preserved
    expect(ims.gateway).toBe('10.46.0.1');
    expect(ims.dns).toEqual(['10.46.0.1']);
    expect(d.smf['p-cscf']).toEqual(['10.46.0.1']);
  });

  it('leaves the non-ims session entry alone', () => {
    const d = yaml.load(out()) as any;
    const inet = d.smf.session.find((s: any) => s.dnn === 'internet');
    expect(inet).toMatchObject({ subnet: '10.45.0.0/16', gateway: '10.45.0.1' });
  });

  it('is idempotent — a second Configure changes nothing', () => {
    const once = out();
    expect(updateSmfImsSession(once, '10.46.0.1')).toBe(once);
  });
  // removeSmfImsSession() carried the identical wrong-match, and ends in a bare
  // splice-delete rather than a replace — so the same cascade deleted almost the
  // whole file. IMS Remove would have emptied smf.yaml on this config.
  describe('removeSmfImsSession on the same config', () => {
    const out = () => removeSmfImsSession(USER_CONFIG);

    it('produces valid YAML', () => {
      expect(() => yaml.load(out())).not.toThrow();
    });

    it('does not empty the file — sbi, pfcp and the rest survive', () => {
      const d = yaml.load(out()) as any;
      expect(d.smf.sbi?.client?.scp?.[0]?.uri).toContain('scp.5gc');
      expect(d.smf.pfcp?.client?.upf).toHaveLength(2);
      expect(d.smf.gtpu?.server?.[0]?.address).toBe('127.0.0.4');
      expect(d.smf.mtu).toBe(1360);
      expect(d.logger?.level).toBe('info');
    });

    it('removes only the ims session, keeping internet and the per-UPF route', () => {
      const d = yaml.load(out()) as any;
      expect(d.smf.session.map((x: any) => x.dnn)).toEqual(['internet']);
      // The per-UPF dnn: ims is a routing rule, not a session — it must stay.
      expect(d.smf.pfcp.client.upf[0].dnn).toBe('ims');
    });
  });
});
