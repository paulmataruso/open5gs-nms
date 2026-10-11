// SEPP (N32 roaming) — sepp-controller.ts, mounted at /api/sepp, 4 routes.
// generate-certs/peer-cert only write TLS material to disk (openssl req /
// writeFile) — neither restarts SEPP itself nor touches any live N32 peer
// connection (confirmed by reading the source: no nsenter systemctl call
// anywhere in this file). This instance has no SEPP cert material yet
// (GET /cert → exists:false), so there's no existing roaming trust
// relationship this could disturb.
import { assertOk, pass, fail } from '../lib/test-case.mjs';

export const MODULE = 'sepp';

export const CASES = [
  {
    name: 'GET /cert and /peer-cert (read-only)',
    async run({ client }) {
      const certRes = await client.get('/api/sepp/cert');
      assertOk(certRes, 'GET /api/sepp/cert');
      if (typeof certRes.data?.exists !== 'boolean') return fail('response missing boolean "exists"', certRes.data);
      const peerRes = await client.get('/api/sepp/peer-cert');
      assertOk(peerRes, 'GET /api/sepp/peer-cert');
      return pass(`own cert exists=${certRes.data.exists}; peer cert exists=${peerRes.data.exists}`);
    },
  },
  {
    name: 'POST /generate-certs — writes TLS material, never restarts SEPP or touches a live peer',
    async run({ client }) {
      const missingFqdnRes = await client.post('/api/sepp/generate-certs', {});
      if (missingFqdnRes.status !== 400) return fail(`expected HTTP 400 for a missing fqdn, got ${missingFqdnRes.status}`);

      const res = await client.post('/api/sepp/generate-certs', { fqdn: 'sepp.epc.mnc001.mcc001.3gppnetwork.org' });
      assertOk(res, 'POST /api/sepp/generate-certs');
      if (!res.data?.cert?.includes('BEGIN CERTIFICATE')) return fail('response missing a PEM "cert"', res.data);

      const afterRes = await client.get('/api/sepp/cert');
      if (!afterRes.data?.exists) return fail('GET /cert still reports exists:false right after generating one');

      return pass('cert generated and confirmed present; missing-fqdn case correctly rejected (400)');
    },
  },
  {
    name: 'POST /peer-cert — saves a pasted peer cacert, input validation',
    async run({ client }) {
      const notPemRes = await client.post('/api/sepp/peer-cert', { cert: 'not a real cert' });
      if (notPemRes.status !== 400) return fail(`expected HTTP 400 for a non-PEM string, got ${notPemRes.status}`);

      // Reuse our own just-generated cert as a stand-in "peer" cert — this
      // route only validates PEM shape, not which CA issued it, and saving
      // our own cert here doesn't affect SEPP's own identity cert at all
      // (a separate file).
      const ownCertRes = await client.get('/api/sepp/cert');
      if (!ownCertRes.data?.exists) return fail('expected a cert to already exist from the previous case');

      const res = await client.post('/api/sepp/peer-cert', { cert: ownCertRes.data.cert });
      assertOk(res, 'POST /api/sepp/peer-cert');

      const afterRes = await client.get('/api/sepp/peer-cert');
      if (!afterRes.data?.exists || afterRes.data.cert !== ownCertRes.data.cert) {
        return fail('peer cert not correctly persisted/read back');
      }

      return pass('peer cert saved and read back correctly; non-PEM input correctly rejected (400)');
    },
  },
];
