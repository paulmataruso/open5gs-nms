import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { XMLValidator, XMLParser } from 'fast-xml-parser';
import { defaultIfcXml } from '../ims-controller';
import { smscYamlCfg, VECTORCORE_SMSC_SIP_ADDRESS } from '../vectorcore-smsc-controller';

/**
 * Two generators that decide where an SMS actually goes, neither previously
 * tested: the iFC template PyHSS serves to S-CSCF, and the VectorCore SMSC's
 * own config.
 *
 * The iFC has caused three confirmed-live outages, each of which looks like
 * nothing at all in the generated file:
 *
 *   - A Jinja variable written bare (`{{ imsi }}` rather than
 *     `{{ iFC_vars.imsi }}`) renders as the EMPTY STRING, because PyHSS
 *     renders with `template.render(iFC_vars=...)` and Jinja2's default for an
 *     undefined variable is empty, not an error. That produced
 *     `<PrivateID>@domain</PrivateID>` and the whole SAA was rejected by
 *     Kamailio's XML schema validator.
 *   - Building the domain from `{{ iFC_vars.scscf_realm }}` bakes the literal
 *     string "None" into a subscriber's identity, because PyHSS's own
 *     Update_Serving_CSCF() nulls that column on every deregister. The domain
 *     is a generate-time literal for exactly this reason.
 *   - `<IMSAddressOfRecord>` does not exist in CxDataType_Rel7.xsd; the child
 *     of PublicIdentity must be `<Identity>` or the SAA is rejected with
 *     "This element is not expected."
 *
 * And one that is a trap for a future tidy-up rather than a past outage: in
 * VectorCore mode the REGISTER iFC uses a LITERAL ip:port while the MESSAGE
 * iFC beside it uses the `smsc.<domain>` FQDN. Those look like an
 * inconsistency worth unifying. They are not: that FQDN's DNS record is
 * kamailio-smsc's address, not VectorCore's, so unifying them silently
 * misroutes every forwarded REGISTER -- and with VectorCore's own
 * registration cache then empty, every message parks in WAIT_TIMER with
 * deferred_reason "sgd_lookup" forever.
 */

const IMS_SRC = fs.readFileSync(path.resolve(__dirname, '../ims-controller.ts'), 'utf-8');
const DOMAIN = 'ims.mnc001.mcc001.3gppnetwork.org';

const parser = new XMLParser({ ignoreAttributes: false, parseTagValue: false });

/** Just the shape these tests read; the real document has far more. */
interface ParsedSpt { Method?: string }
interface ParsedIfc {
  Priority: string;
  TriggerPoint: { SPT: ParsedSpt[] | ParsedSpt };
  ApplicationServer: { ServerName: string };
}
interface ParsedIfcDoc {
  IMSSubscription: { ServiceProfile: { InitialFilterCriteria: ParsedIfc[] | ParsedIfc } };
}

const parseIfc = (xml: string): ParsedIfcDoc => parser.parse(xml) as ParsedIfcDoc;
const criteriaOf = (xml: string): ParsedIfc[] | ParsedIfc =>
  parseIfc(xml).IMSSubscription.ServiceProfile.InitialFilterCriteria;

describe('defaultIfcXml -- the iFC PyHSS serves', () => {
  const inline = defaultIfcXml(DOMAIN);
  const vectorcore = defaultIfcXml(DOMAIN, VECTORCORE_SMSC_SIP_ADDRESS);

  it('is well-formed XML in both delivery modes', () => {
    expect(XMLValidator.validate(inline)).toBe(true);
    expect(XMLValidator.validate(vectorcore)).toBe(true);
  });

  it('prefixes every Jinja variable with iFC_vars', () => {
    // A bare `{{ imsi }}` renders empty and gets the SAA rejected, with no
    // error anywhere in the template itself.
    for (const cfg of [inline, vectorcore]) {
      const vars = Array.from(cfg.matchAll(/\{\{\s*([^}]+?)\s*\}\}/g), (m) => m[1]);
      expect(vars.length).toBeGreaterThan(0);
      for (const v of vars) expect(v).toMatch(/^iFC_vars\./);
    }
  });

  it('never renders the domain from scscf_realm, which is nulled on deregister', () => {
    for (const cfg of [inline, vectorcore]) {
      expect(cfg).not.toContain('scscf_realm');
      // The literal is present instead, in all three identities.
      expect(cfg.match(new RegExp(DOMAIN.replace(/\./g, '\\.'), 'g'))?.length).toBeGreaterThanOrEqual(3);
    }
  });

  it('names the PublicIdentity child Identity, as the Rel7 schema requires', () => {
    for (const cfg of [inline, vectorcore]) {
      expect(cfg).not.toContain('IMSAddressOfRecord');
      expect(cfg).toMatch(/<PublicIdentity>\s*<BarringIndication>0<\/BarringIndication>\s*<Identity>/);
    }
  });

  it('declares the three identities a subscriber is reachable by', () => {
    // Registration uses the IMSI form and dialling the MSISDN, so both have
    // to be present or one of the two paths has no public identity at all.
    const ids = Array.from(inline.matchAll(/<Identity>([^<]+)<\/Identity>/g), (m) => m[1]);
    expect(ids).toEqual([
      `sip:{{ iFC_vars.msisdn }}@${DOMAIN}`,
      'tel:{{ iFC_vars.msisdn }}',
      `sip:{{ iFC_vars.imsi }}@${DOMAIN}`,
    ]);
  });

  it('routes MESSAGE to the SMSC FQDN, and only that, in inline mode', () => {
    const servers = Array.from(inline.matchAll(/<ServerName>([^<]+)<\/ServerName>/g), (m) => m[1]);
    expect(servers).toEqual([`sip:smsc.${DOMAIN}:7090`]);
    // One iFC, so no REGISTER trigger exists to forward anything.
    expect(inline).not.toContain('<Method>REGISTER</Method>');
  });

  it('adds a REGISTER iFC in VectorCore mode, by LITERAL ip:port', () => {
    // The trap: the MESSAGE iFC beside it uses smsc.<domain>, whose DNS
    // record is kamailio-smsc's address rather than VectorCore's. Unifying
    // the two on that FQDN misroutes every forwarded REGISTER.
    const { ip, port } = VECTORCORE_SMSC_SIP_ADDRESS;
    const servers = Array.from(vectorcore.matchAll(/<ServerName>([^<]+)<\/ServerName>/g), (m) => m[1]);
    expect(servers).toContain(`sip:${ip}:${port}`);
    expect(servers).toContain(`sip:smsc.${DOMAIN}:7090`);
    // Specifically: the REGISTER server is NOT the FQDN.
    const registerIfc = vectorcore.slice(vectorcore.indexOf('<Method>REGISTER</Method>'));
    const registerServer = /<ServerName>([^<]+)<\/ServerName>/.exec(registerIfc)?.[1];
    expect(registerServer).toBe(`sip:${ip}:${port}`);
    expect(registerServer).not.toContain('smsc.');
  });

  it('gives the REGISTER iFC a lower Priority than the MESSAGE one', () => {
    // Evaluation order comes from the Priority ELEMENT, not document order --
    // TS 29.228 evaluates ascending by Priority wherever the block sits. And
    // here the two disagree: the REGISTER iFC is appended after the MESSAGE
    // one, so the file reads 20 then 10. Asserted by reading each criterion's
    // own method and priority together, so this cannot be "fixed" by shuffling
    // the blocks, and so a real priority inversion is still caught.
    const ifcs = criteriaOf(vectorcore) as ParsedIfc[];
    const priorityOf = (method: string): number => {
      const match = ifcs.find((f) => {
        const spts = Array.isArray(f.TriggerPoint.SPT) ? f.TriggerPoint.SPT : [f.TriggerPoint.SPT];
        return spts.some((s) => s.Method === method);
      });
      expect(match).toBeDefined();
      return Number(match!.Priority);
    };
    expect(priorityOf('REGISTER')).toBe(10);
    expect(priorityOf('MESSAGE')).toBe(20);
    expect(priorityOf('REGISTER')).toBeLessThan(priorityOf('MESSAGE'));
    // Document order really is the other way round, which is why the above
    // does not read positionally.
    expect(ifcs.map((f) => Number(f.Priority))).toEqual([20, 10]);
  });

  it('parses to two filter criteria in VectorCore mode and one otherwise', () => {
    const one = criteriaOf(inline);
    const two = criteriaOf(vectorcore);
    expect(Array.isArray(one)).toBe(false);
    expect(Array.isArray(two)).toBe(true);
    expect((two as unknown[]).length).toBe(2);
  });

  it('is written by Configure every run, so a deployed-file patch cannot hold', () => {
    // Why the fix is in the template and not applied to the host copy: this
    // project rewrites the iFC on every plain Configure, so patching the
    // deployed file re-introduces whatever the template still says.
    expect(IMS_SRC).toMatch(/defaultIfcXml\(imsDomain,[^)]*\), 'utf-8'\)/);
  });
});

interface SmscCfg {
  smpp: { server: { address: string; port: number } };
  sip: { address: string; port: number; fqdn: string; transport: string };
  diameter: { address: string; port: number; local_fqdn: string; local_realm: string };
  database: { driver: string; dsn: string };
  api: { address: string; port: number };
  log: { file: string };
}

describe('smscYamlCfg -- what VectorCore SMSC actually binds', () => {
  const cfg = yaml.load(smscYamlCfg(DOMAIN)) as SmscCfg;

  it('binds SIP exactly where S-CSCF is told to route', () => {
    // VECTORCORE_SMSC_SIP_ADDRESS is what ims-controller.ts imports for its
    // ROUTE_SMS_TO_VECTORCORE defines and for the REGISTER iFC above. If this
    // file ever hardcodes its own address, SMS stops with both sides looking
    // correctly configured in isolation.
    expect(cfg.sip.address).toBe(VECTORCORE_SMSC_SIP_ADDRESS.ip);
    expect(cfg.sip.port).toBe(VECTORCORE_SMSC_SIP_ADDRESS.port);
  });

  it('keeps the protocol listeners on loopback and only the admin API public', () => {
    // Same split, and the same reasoning, as the MMS MM1 proxy: the SPA has
    // no auth of its own, the protocol ports have no business being reachable.
    expect(cfg.smpp.server.address).toBe('127.0.0.1');
    expect(cfg.diameter.address).toBe('127.0.0.1');
    expect(cfg.api.address).toBe('0.0.0.0');
  });

  it('does not take osmo-msc\'s own SMPP port', () => {
    // 2775 is osmo-msc's listener, which the MMS module's ESME connects to.
    expect(cfg.smpp.server.port).not.toBe(2775);
    expect(cfg.smpp.server.port).toBe(2776);
  });

  it('gives each listener its own port', () => {
    const ports = [cfg.smpp.server.port, cfg.sip.port, cfg.diameter.port, cfg.api.port];
    expect(new Set(ports).size).toBe(ports.length);
  });

  it('derives both Diameter identities from the one domain it is given', () => {
    // A realm that disagrees with the peer's is the same failure class as the
    // OCS/SMF mismatch: the connection is refused at CEA with both ends
    // individually looking right.
    expect(cfg.diameter.local_fqdn).toBe(`smsc.${DOMAIN}`);
    expect(cfg.diameter.local_realm).toBe(DOMAIN);
    expect(cfg.sip.fqdn).toBe(`smsc.${DOMAIN}`);
  });

  it('uses absolute paths, because the shipped unit sets no WorkingDirectory', () => {
    // A relative path resolves against systemd's default cwd, "/".
    expect(cfg.database.dsn.startsWith('/')).toBe(true);
    expect(cfg.log.file.startsWith('/')).toBe(true);
  });

  it('follows the domain it is given rather than a baked-in one', () => {
    const other = yaml.load(smscYamlCfg('ims.example.test')) as SmscCfg;
    expect(other.diameter.local_realm).toBe('ims.example.test');
    expect(other.sip.fqdn).toBe('smsc.ims.example.test');
    expect(other.sip.address).toBe(VECTORCORE_SMSC_SIP_ADDRESS.ip);
  });
});
