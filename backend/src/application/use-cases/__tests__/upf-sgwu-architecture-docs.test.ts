import * as fs from 'fs';
import * as path from 'path';

// Guards two documentation facts about the Open5GS data plane that, if wrong,
// lead an operator to design the wrong remote U-plane topology.
//
// Verified against Open5GS's own source (/home/paulmataruso/open5gs):
//  - src/upf/gtp-path.c has 9 ogs_tun calls; all 11 files in src/sgwu/ have
//    zero. The UPF is the session anchor; the SGW-U is a pure GTP-U relay.
//  - Stock upf.yaml.in has a `session:` block (UE pool + tun); sgwu.yaml.in has
//    none at all.
//  - src/smf/ holds BOTH n4-handler.c (5G) and s5c-handler.c (4G S5-C), so SMF
//    is SMF + PGW-C in one binary — but UPF is PGW-U only, NOT a combined
//    SGW-U + PGW-U.
//  - src/sgwc/s5c-handler.c:298 shows SGW-C learning PGW-U's S5-U F-TEID over
//    S5-C and installing it into the SGW-U, which is why a wrong GTP-U address
//    fails silently in the data plane with a healthy control plane.

const ED = path.resolve(__dirname, '../../../../../frontend/src/components/config/editors');
const read = (f: string) => fs.readFileSync(path.join(ED, f), 'utf-8');

describe('UPF / SGW-U architecture in the editors', () => {
  const upf = read('UpfEditor.tsx');
  const sgwu = read('SgwuEditor.tsx');

  it('never claims the UPF is a combined SGW-U + PGW-U', () => {
    // It said exactly this, which inverts the architecture: it implies no
    // SGW-U is needed for 4G, when 4G traffic in fact reaches the UPF through
    // one.
    expect(upf).not.toMatch(/acts as the combined SGW-U/);
    expect(upf).not.toMatch(/is the combined SGW-U/);
  });

  it('says the UPF is PGW-U and that 4G reaches it via the SGW-U', () => {
    expect(upf).toMatch(/PGW-U/);
    expect(upf).toMatch(/eNB → SGW-U → UPF/);
    expect(upf).toMatch(/gNB → UPF/);
  });

  it('both remote flows warn about the other end of the S5-U pair', () => {
    // The step most likely to be missed when moving either node, because its
    // failure mode is invisible from the control plane.
    expect(upf).toMatch(/127\.0\.0\.6/);          // the SGW-U's loopback GTP-U bind
    expect(sgwu).toMatch(/127\.0\.0\.7/);         // the UPF's loopback GTP-U bind
    for (const src of [upf, sgwu]) {
      expect(src).toMatch(/gtpu\.server/);
      expect(src).toMatch(/S5-U/);
      expect(src).toMatch(/PFCP coming up is not evidence/);
    }
  });

  it('the UPF flow states that moving it affects both generations', () => {
    expect(upf).toMatch(/affects <span className="font-semibold">both<\/span> generations/);
  });

  it('the UPF remote flow opens GTP-U, not just PFCP', () => {
    // Moving the UPF means gNBs and the SGW-U both need UDP/2152 to it.
    expect(upf).toMatch(/ufw allow 2152\/udp/);
  });
});
