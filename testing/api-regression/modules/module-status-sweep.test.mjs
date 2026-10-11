// Broad, read-only sweep: every module that exposes a GET /status endpoint
// gets hit once, confirming it responds with a well-formed JSON body
// instead of crashing (500) or hanging. Purely additive coverage — makes
// no changes, needs no revert, safe to run on any instance including a
// live production one. This is NOT a substitute for the deeper per-module
// mutation tests (create a thing, edit it, verify, revert) that live in
// their own modules/*.test.mjs files — it's the fast, wide net that catches
// "this module's status endpoint itself is broken" even before a deeper
// test for that module exists.
import { pass, fail } from '../lib/test-case.mjs';

export const MODULE = 'module-status-sweep';

// path -> API mount prefix, from index.ts's app.use(...) calls.
const STATUS_ENDPOINTS = {
  'asterisk-2g': '/api/asterisk-2g/status',
  'bind': '/api/bind/status',
  'chrony': '/api/chrony/status',
  'dns-migration': '/api/dns-migration/status',
  'frr-source-build': '/api/frr/source-build/status',
  'gsm': '/api/gsm/status',
  'hnbgw': '/api/hnbgw/status',
  'ims': '/api/ims/status',
  'kamailio-source-build': '/api/kamailio/source-build/status',
  'mms': '/api/mms/status',
  'ocs': '/api/ocs/status',
  'plmn-migration': '/api/plmn-migration/status',
  'pstn': '/api/pstn/status',
  'qci-hw-test': '/api/validation/qci-hw-test/status',
  'qci-validation': '/api/validation/qci/status',
  'rtpengine-source-build': '/api/rtpengine/source-build/status',
  'secgw': '/api/secgw/status',
  'sms': '/api/sms/status',
  'snmp': '/api/snmp/status',
  'speedtest': '/api/speedtest/status',
  'swu-emulator': '/api/swu-emulator/status',
  'syslog': '/api/syslog/status',
  'twamp': '/api/twamp/status',
  'ue-block': '/api/ue-block/status',
  'vectorcore-smsc': '/api/vectorcore-smsc/status',
  'volte-validation': '/api/validation/volte/status',
  'vowifi': '/api/vowifi/status',
  'vowifi-validation': '/api/validation/vowifi/status',
};

export const CASES = Object.entries(STATUS_ENDPOINTS).map(([name, endpoint]) => ({
  name: `GET ${endpoint}`,
  async run({ client }) {
    const res = await client.get(endpoint);
    if (res.status >= 500) {
      return fail(`HTTP ${res.status}`, res.data);
    }
    if (res.data === null || res.data?.__nonJsonBody !== undefined) {
      return fail('non-JSON or empty response body', res.data);
    }
    return pass(`HTTP ${res.status}`);
  },
}));
