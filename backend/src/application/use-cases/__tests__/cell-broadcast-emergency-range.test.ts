import { sendSchema, emergencyMessageIdRange, EMERGENCY_MESSAGE_ID_RANGES } from '../cell-broadcast';

/**
 * 3GPP TS 23.041 reserves specific message-ID ranges for public emergency
 * alerting, and a HANDSET decides how to alarm from the message identifier
 * itself -- not from any category field this code sends. So message ID 4370 is
 * a Presidential Alert that most handsets will not let the user silence.
 *
 * As submitted, `messageId` was `min(0).max(65535)` with nothing else, so on a
 * network with real attached subscribers one mistyped digit was
 * indistinguishable from an ordinary broadcast. These ranges are deliberately
 * not rejected outright -- deliberately testing alert delivery is legitimate on
 * a lab PLMN -- but they need their own acknowledgement so that reaching one
 * takes a distinct action rather than the same keystrokes.
 */
const base = {
  requestId: '00000000-0000-4000-8000-000000000000',
  text: 'test', areas: [{ plmn: '00101', tac: 1 }],
  messageId: 1000, serialNumber: 0, confirm: true as const,
};

describe('ordinary message IDs are unaffected', () => {
  it.each([0, 1, 1000, 4351, 4360, 4400, 65535])('accepts %i with no acknowledgement', id => {
    expect(sendSchema.safeParse({ ...base, messageId: id }).success).toBe(true);
  });

  it('still rejects an out-of-range id', () => {
    expect(sendSchema.safeParse({ ...base, messageId: 65536 }).success).toBe(false);
    expect(sendSchema.safeParse({ ...base, messageId: -1 }).success).toBe(false);
  });
});

describe('reserved emergency ranges need their own acknowledgement', () => {
  // Boundaries of each reserved block, plus the Presidential Alert itself.
  it.each([4352, 4355, 4359, 4370, 4371, 4380, 4399])('refuses %i without acknowledgeEmergencyAlert', id => {
    const r = sendSchema.safeParse({ ...base, messageId: id });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues.some(i => i.path.includes('messageId'))).toBe(true);
      expect(r.error.issues.some(i => /23\.041/.test(i.message))).toBe(true);
    }
  });

  it.each([4352, 4370, 4399])('accepts %i once explicitly acknowledged', id => {
    expect(sendSchema.safeParse({ ...base, messageId: id, acknowledgeEmergencyAlert: true }).success).toBe(true);
  });

  it('names the Presidential Alert specifically, since it cannot be silenced', () => {
    const r = sendSchema.safeParse({ ...base, messageId: 4370 });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues.some(i => /Presidential/.test(i.message))).toBe(true);
  });

  it('does NOT let the ordinary confirm flag stand in for the acknowledgement', () => {
    // confirm:true is already required for every send, so it cannot be what
    // distinguishes an emergency broadcast from a routine one.
    expect(sendSchema.safeParse({ ...base, messageId: 4370, confirm: true }).success).toBe(false);
  });

  it('rejects acknowledgeEmergencyAlert:false explicitly rather than ignoring it', () => {
    expect(sendSchema.safeParse({ ...base, messageId: 4370, acknowledgeEmergencyAlert: false }).success).toBe(false);
  });

  it('keeps the schema strict, so an unknown field is still refused', () => {
    expect(sendSchema.safeParse({ ...base, somethingElse: 1 }).success).toBe(false);
  });
});

describe('the range table itself', () => {
  it('covers exactly the TS 23.041 reserved blocks', () => {
    expect(emergencyMessageIdRange(4351)).toBeUndefined();
    expect(emergencyMessageIdRange(4352)?.label).toMatch(/ETWS/);
    expect(emergencyMessageIdRange(4359)?.label).toMatch(/ETWS/);
    expect(emergencyMessageIdRange(4360)).toBeUndefined();
    expect(emergencyMessageIdRange(4370)?.label).toMatch(/Presidential/);
    expect(emergencyMessageIdRange(4399)?.label).toMatch(/CMAS/);
    expect(emergencyMessageIdRange(4400)).toBeUndefined();
  });

  it('has no overlapping or inverted entries', () => {
    for (const r of EMERGENCY_MESSAGE_ID_RANGES) expect(r.from).toBeLessThanOrEqual(r.to);
    const sorted = [...EMERGENCY_MESSAGE_ID_RANGES].sort((a, b) => a.from - b.from);
    for (let i = 1; i < sorted.length; i++) expect(sorted[i].from).toBeGreaterThan(sorted[i - 1].to);
  });
});
