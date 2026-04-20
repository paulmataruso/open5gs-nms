# Open5GS NMS - Claude Development Log

## Project Status: v1.2.1 — MME SGs-AP Fix

---

## Session: 2026-04-20 — MME SGs-AP Configuration Fix

### Problem
MME would not start after applying SGs-AP config via the NMS UI.

### Root Causes Found

**1. Wrong `map` structure (YAML corruption)**
The editor built `map` as an array:
```yaml
# WRONG — what NMS was producing
sgsap:
  client:
    - address: msc.open5gs.org
      map:
        - tai:
            ...
          lai:
            ...
```
Open5GS MME requires `map` as a plain object:
```yaml
# CORRECT
sgsap:
  client:
    - address: 1.1.1.1
      map:
        tai:
          plmn_id:
            mcc: 315
            mnc: 010
          tac: 1
        lai:
          plmn_id:
            mcc: 315
            mnc: 010
          lac: 1
```
This caused Open5GS MME to abort at startup with:
`[mme] FATAL: mme_context_parse_config: Assertion 'rv == OGS_OK' failed`

**2. Broken JSX in MmeEditor.tsx**
The file had import statements and code fragments inside JSX return blocks, plus a dangling `{(() => { ); })()}` IIFE. The entire SGs-AP section was non-functional.

**3. DNS resolution at MME startup (Open5GS behaviour — not a bug)**
Open5GS MME calls `getaddrinfo()` synchronously during config parse. If a hostname doesn't resolve, it fatals. An IP (even unreachable) always works — MME starts and logs a warning on connect failure.

### Files Changed

- `frontend/src/components/config/editors/MmeEditor.tsx`
  - Full rewrite of SGs-AP section with correct `map` object structure
  - Added `defaultMap()` factory
  - Added `hasRealMap` / `mapVal()` — TAI/LAI fields show grey placeholders when empty, white text when populated
  - Added hostname warning banner (yellow) when user enters an FQDN
  - Removed broken JSX/IIFE fragments

- `backend/src/domain/entities/mme-config.ts`
  - Added `sgsap` field to `MmeConfig` interface with `map` typed as object (not array)

- `frontend/src/data/tooltips/mme.ts`
  - Updated `sgsap_server_address` tooltip to explain DNS-at-startup behaviour

### Key Patterns / Learnings

**Open5GS SGs-AP map is an object, not an array:**
```typescript
// CORRECT shape
const defaultMap = () => ({
  tai: { plmn_id: { mcc: '001', mnc: '01' }, tac: 1 },
  lai: { plmn_id: { mcc: '001', mnc: '01' }, lac: 1 },
});
```

**Use `hasRealMap` to distinguish saved data from UI defaults:**
```typescript
const hasRealMap = !isFirstAndEmpty && actualClient.map != null;
const mapVal = (val: any) => hasRealMap ? (val ?? '') : '';
// Pass mapVal() to FieldWithTooltip value — empty string = grey placeholder
```

**MME hostname vs IP behaviour:**
- IP address (any, including unreachable): MME starts, connect warning logged — fine
- Unresolvable hostname: MME calls `getaddrinfo()` at parse time, aborts fatally
- Resolvable hostname: works fine
- NMS now shows a yellow warning when a hostname is detected in the address field

---

## Session: 2026-03-02 — Auto Config & Topology

### Auto Config Feature - Complete Implementation

**NEW FEATURE:** One-click automated Open5GS configuration with NAT setup support.

**What it does:**
- Configure 4G PLMN (MCC/MNC for MME)
- Configure 5G PLMN (MCC/MNC for AMF)
- Set network IPs (S1-MME, SGW-U GTP-U, AMF NGAP, UPF GTP-U)
- Configure UE session pools (IPv4/IPv6 subnets and gateways)
- Optional NAT configuration with iptables

**Key Features:**
1. **Preview Before Apply** — Toggle between Summary view and YAML Diff view
2. **Load Current Values** — Pre-populates form fields with actual Open5GS values
3. **NAT Configuration (Optional)** — iptables MASQUERADE rules with preview

**Files Modified:**
- `backend/src/application/use-cases/auto-config.ts`
- `backend/src/interfaces/rest/auto-config-controller.ts`
- `frontend/src/pages/AutoConfigPage.tsx`
- `frontend/src/components/DiffViewer.tsx`
- `frontend/src/api/index.ts`

### Topology — gNodeB Repositioned
gNodeB moved from 700x1100 to 2400x700. N2 interface simplified to clean horizontal line.

**Files Modified:** `frontend/src/components/topology/TopologyPage.tsx`

---

## Key Implementation Patterns

### Working with Open5GS Configs

**ALWAYS use rawYaml for modifications:**
```typescript
// ✅ CORRECT
const raw = configs.mme.rawYaml as any;
raw.mme.gummei[0].plmn_id = { mcc: '315', mnc: '010' };
await configRepo.saveMme({ ...configs.mme, rawYaml: raw });

// ❌ WRONG
configs.mme.gummei[0].plmn_id = { mcc: '315', mnc: '010' };
```

**Frontend config structure is nested:**
```typescript
// ✅ CORRECT
const mmeConfig = (configs.mme as any)?.mme;

// ❌ WRONG
const mmeConfig = configs.mme;
```

**SGs-AP map is an object, not an array** (see session 2026-04-20 above)

**MCC/MNC must stay as strings** — `ensureNumericTypes()` in the repo explicitly skips `mcc`, `mnc`, `sd` keys to preserve leading zeros (e.g. `010`)

### nsenter / is-active timing
The backend uses `nsenter -t 1 -m -u -i -p systemctl is-active <unit>` to check service status. This can return a non-zero exit (logged as error) if the service is in `failed` state — `nsenter` itself errors rather than returning `"failed"`. The apply workflow treats this as non-fatal and continues. Always verify actual service state with `journalctl -u <unit>` if the NMS reports unexpected failure.

---

**Last Updated:** 2026-04-20
**Current Version:** v1.2.1
