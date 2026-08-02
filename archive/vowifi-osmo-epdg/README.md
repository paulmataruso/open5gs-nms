# Archived: osmo-epdg + strongswan-epdg VoWiFi backend

Archived 2026-08-01, replaced by the VectorCore ePDG backend (see
`docs/vectorcore-epdg-integration-plan.md` and `PROJECT_STATE.md` §9/§5).

**Why this was replaced**: real UE VoWiFi registration never completed on
this stack. Two real, confirmed root causes were found and fixed this
project (duplicate-IP PDN session collision; an osmo-epdg crash bug that
silently took down the whole ePDG while `systemctl` still reported it
healthy), but the deeper registration-stall symptom (phone never sends an
authenticated REGISTER after the first 401 challenge) remained unresolved.
Rather than continue debugging two vendored, from-source third-party
components (Erlang `osmo-epdg` + a patched C `strongswan-epdg` fork), the
decision was made to fully replace the stack with `vectorcore-ePDG` (Go,
single binary, native XDP/eBPF dataplane, no out-of-tree kernel module).

**This is a stash, not dead code** — if VectorCore ePDG also fails to
resolve real VoWiFi registration, or a regression is found in it, this is
the last known-working (for IKEv2/EAP-AKA/tunnel establishment — SIP
registration itself never completed on either stack) version of the
osmo-epdg-based backend, including:

- All local source patches to `osmo-epdg`'s Erlang source (see
  `OSMO_EPDG_PATCH_REV` history in `vowifi-build.ts` — 5 patches,
  including the SWx static-IP fix, the APN-scoping/duplicate-IP fix, and
  the stale-session crash-guard fix).
- The fwmark/nftables/policy-routing scheme built the same day this stack
  was archived (see `vowifi-controller.ts`'s `EPDG_TUN_INTERFACE` section).

**To restore**: `git mv` these three files back to their original paths
(`backend/src/application/use-cases/vowifi-build.ts`,
`backend/src/interfaces/rest/vowifi-controller.ts`,
`frontend/src/pages/VoWiFiPage.tsx`, `frontend/src/api/vowifi.ts`), and
revert whatever the VectorCore backend changed in `pcap.ts` and
`plmn-migration-usecase.ts` back to importing from this file's exports
(`configureVowifi`, `loadState`, `VowifiConfigureError`).
