# Auto Config Implementation - Key Learnings

**Date:** March 2, 2026  
**Feature:** Auto Configuration with NAT Support

---

## Critical Implementation Patterns

### 1. Always Work with rawYaml for Config Modifications

**The Problem:**
- Backend entity types don't match actual YAML structure
- Example: Backend UPF entity has `session[].subnet[].addr` but YAML is `session[].subnet`
- Modifying entity properties doesn't translate to correct YAML

**The Solution:**
```typescript
// ✅ CORRECT - Modify rawYaml directly
const raw = configs.upf.rawYaml as any;
raw.upf.session = [
  { subnet: '10.45.0.0/16', gateway: '10.45.0.1' },
  { subnet: '2001:db8:cafe::/48', gateway: '2001:db8:cafe::1' }
];
configs.upf.rawYaml = raw;
await configRepo.saveUpf(configs.upf);

// ❌ WRONG - Don't modify entity structures
configs.upf.session = [...]; // This won't work!
```

**Why:**
- Config repository save methods use `rawYaml` passthrough
- The repository doesn't transform entity types back to YAML
- Comments and structure are preserved in rawYaml

---

### 2. Frontend Config Structure is Nested

**The Problem:**
- API returns: `{ mme: { logger: {}, global: {}, mme: {...} } }`
- Not: `{ mme: { gummei: [...] } }`

**The Solution:**
```typescript
// ✅ CORRECT - Access nested structure
const mmeConfig = (configs.mme as any)?.mme;
const plmn = mmeConfig?.gummei?.[0]?.plmn_id;

// ❌ WRONG
const plmn = configs.mme?.gummei?.[0]?.plmn_id; // undefined!
```

**Pattern for all services:**
```typescript
const serviceConfig = (configs[serviceName] as any)?.[serviceName];
```

---

### 3. Handle Array PLMN IDs

**The Problem:**
- Backend entity: `plmn_id: PlmnId | PlmnId[]`
- YAML can have either single object or array
- Need to handle both cases

**The Solution:**
```typescript
// ✅ CORRECT - Check if array
const plmnId = raw.mme.gummei[0].plmn_id;
const plmn = Array.isArray(plmnId) ? plmnId[0] : plmnId;

// Only update if different (preserves YAML anchors)
if (plmn && (plmn.mcc !== input.mcc || plmn.mnc !== input.mnc)) {
  if (Array.isArray(plmnId)) {
    raw.mme.gummei[0].plmn_id = [{ mcc: input.mcc, mnc: input.mnc }];
  } else {
    raw.mme.gummei[0].plmn_id = { mcc: input.mcc, mnc: input.mnc };
  }
}
```

---

### 4. Preserve YAML Anchors and Aliases

**The Problem:**
- Existing configs use YAML anchors: `guami: &a1 [...]` and `tai: *a1`
- `JSON.parse(JSON.stringify(obj))` loses anchors
- Deep cloning expands all aliases, making huge diffs

**The Solution:**
```typescript
// ✅ CORRECT - Only modify if value changed
if (raw.amf.guami && raw.amf.guami.length > 0) {
  const currentPlmn = raw.amf.guami[0].plmn_id;
  if (currentPlmn && (currentPlmn.mcc !== input.mcc || currentPlmn.mnc !== input.mnc)) {
    raw.amf.guami[0].plmn_id = { mcc: input.mcc, mnc: input.mnc };
  }
}

// ❌ WRONG - Always modify (breaks anchors)
raw.amf.guami[0].plmn_id = { mcc: input.mcc, mnc: input.mnc };
```

---

### 5. Session Pool YAML Format

**The Problem:**
- Backend entity has nested structure: `session[].subnet[].addr`
- Actual YAML is flat: `session[].subnet`

**The Correct Format:**
```yaml
# ✅ CORRECT - Flat structure
session:
  - subnet: 10.45.0.0/16
    gateway: 10.45.0.1
  - subnet: 2001:db8:cafe::/48
    gateway: 2001:db8:cafe::1

# ❌ WRONG - Nested addr arrays
session:
  - subnet:
      - addr: 10.45.0.0/16
```

**TypeScript:**
```typescript
// ✅ CORRECT
raw.upf.session = [
  { subnet: input.ipv4Subnet, gateway: input.ipv4Gateway },
  { subnet: input.ipv6Subnet, gateway: input.ipv6Gateway }
];

// ❌ WRONG
raw.upf.session = [
  { subnet: [{ addr: input.ipv4Subnet }] }
];
```

---

### 6. Preview Method Duplication

**Pattern:**
The preview method duplicates the exact same transformation logic as execute():

```typescript
async preview(input: AutoConfigInput): Promise<PreviewResult> {
  const configs = await this.configRepo.loadAll();
  const diffs: Record<string, string> = {};

  // Apply same transformations as execute()
  const original = configs.mme.rawYaml;
  const modified = JSON.parse(JSON.stringify(original));
  
  // ... same modifications as execute() ...
  
  const diff = createPatch(original, modified);
  diffs['mme'] = diff;
  
  return { success: true, diffs };
}
```

**Why:**
- Safety: Preview doesn't save anything
- Accuracy: User sees exactly what execute() will do
- Maintainability: Keep both in sync when logic changes

---

### 7. NAT Configuration Commands

**Implementation:**
```typescript
if (input.configureNAT) {
  const natInterface = input.natInterface || 'ogstun';
  
  // Enable IP forwarding
  await hostExecutor.executeCommand('sysctl', ['-w', 'net.ipv4.ip_forward=1']);
  await hostExecutor.executeCommand('sysctl', ['-w', 'net.ipv6.conf.all.forwarding=1']);
  await hostExecutor.executeCommand('sysctl', ['-p', '/etc/sysctl.conf']);
  
  // IPv4 NAT
  await hostExecutor.executeCommand('iptables', [
    '-t', 'nat', '-A', 'POSTROUTING',
    '-s', input.sessionPoolIPv4Subnet,
    '!', '-o', natInterface,
    '-j', 'MASQUERADE'
  ]);
  
  // IPv6 NAT
  await hostExecutor.executeCommand('ip6tables', [
    '-t', 'nat', '-A', 'POSTROUTING',
    '-s', input.sessionPoolIPv6Subnet,
    '!', '-o', natInterface,
    '-j', 'MASQUERADE'
  ]);
  
  // Allow traffic
  await hostExecutor.executeCommand('iptables', [
    '-I', 'INPUT', '-i', natInterface, '-j', 'ACCEPT'
  ]);
}
```

**Show Preview:**
```typescript
<div className="bg-nms-surface-2 border border-nms-border rounded-md p-4">
  <h3>Commands that will be executed:</h3>
  <pre>
    sysctl -w net.ipv4.ip_forward=1
    sysctl -w net.ipv6.conf.all.forwarding=1
    sysctl -p /etc/sysctl.conf
    iptables -t nat -A POSTROUTING -s {subnet} ! -o {interface} -j MASQUERADE
    ip6tables -t nat -A POSTROUTING -s {subnet} ! -o {interface} -j MASQUERADE
    iptables -I INPUT -i {interface} -j ACCEPT
  </pre>
</div>
```

---

## Common Mistakes to Avoid

### ❌ Don't Use Entity Types for Modifications
```typescript
// WRONG - Entity types don't match YAML
configs.upf.session = [{ subnet: [...] }];
```

### ❌ Don't Assume Frontend Structure
```typescript
// WRONG - Missing nested layer
const plmn = configs.mme.gummei[0].plmn_id;
```

### ❌ Don't Ignore Array Possibilities
```typescript
// WRONG - Could be array
const plmn = raw.mme.gummei[0].plmn_id;
const mcc = plmn.mcc; // Crashes if plmn is array!
```

### ❌ Don't Always Modify (Breaks Anchors)
```typescript
// WRONG - Modifies even if value unchanged
raw.amf.guami[0].plmn_id = { mcc, mnc };
```

### ❌ Don't Create Wrong YAML Structure
```typescript
// WRONG - Nested addr arrays
session: [{ subnet: [{ addr: '...' }] }]
```

---

## Testing Checklist

- [ ] Preview shows correct YAML diff for each service
- [ ] Apply creates backup before changes
- [ ] Services restart in correct order
- [ ] YAML structure matches Open5GS format exactly
- [ ] YAML anchors preserved when values unchanged
- [ ] NAT commands execute successfully (if enabled)
- [ ] Form loads current values from Open5GS
- [ ] Works with both array and single PLMN IDs
- [ ] IPv4 and IPv6 session pools configured correctly

---

## Files Modified

**Backend:**
- `backend/src/application/use-cases/auto-config.ts` - Complete rewrite
- `backend/src/interfaces/rest/auto-config-controller.ts` - Preview endpoint

**Frontend:**
- `frontend/src/pages/AutoConfigPage.tsx` - NAT UI, load current values
- `frontend/src/components/DiffViewer.tsx` - YAML diff viewer
- `frontend/src/api/index.ts` - Preview API, type definitions

---

## Documentation Updated

- `CLAUDE.md` - Development log with implementation details
- `PROJECT_DOCUMENTATION.md` - Feature documentation
- `AUTO_CONFIG_LEARNINGS.md` - This file

---

**Key Takeaway:** Always work with rawYaml, understand nested frontend structure, handle arrays, preserve YAML anchors, and duplicate transformation logic for preview safety.
