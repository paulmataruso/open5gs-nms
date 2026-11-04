# FRR eigrpd Dangling `adv_router` Patch

The second of this project's two eigrpd patches. The first
([crash-guard](frr-eigrpd-crash-guard-patch.md)) stops `eigrpd` aborting; this one stops
it corrupting its own topology and installing a broken route afterwards.

Applies to `frr-10.6.1`. The diff lives at
[`backend/src/config/frr-patches/frr-eigrpd-dangling-adv-router.patch`](../backend/src/config/frr-patches/frr-eigrpd-dangling-adv-router.patch)
and is applied automatically by the FRR Source Build for that tag.

## The symptom

`show ip eigrp topology` grows extra "successors" for a prefix, with next hops that are
not any real neighbour and that **change on every recompute** — `32.75.128.75`,
`128.42.216.139`, `0.0.0.0`, `5.0.0.0`, `33.0.0.0`, `81.0.0.0`, `0.10.0.0`,
`32.75.32.23` across occurrences. The specific value is never diagnostic.

Sometimes the kernel route table stays clean and nothing is wrong. Sometimes a route is
installed through a nexthop with **no gateway** (`ip nexthop show` reads
`id N dev ens20 scope host`, no `via`), which the kernel treats as on-link: under ECMP
hashing some flows resolve and others blackhole. That is the state in which radios go
unreachable while the router looks healthy, and it is why "some things work" is the usual
first report.

## The cause

`eigrp_topology_neighbor_down()` does not delete a dead neighbour's route descriptors. It
hands each one to DUAL as a max-metric update and relies on the resulting state
transition to remove it. `eigrp_nbr_delete()` then frees the neighbour unconditionally.
Any descriptor whose removal transition did not happen is left holding a dangling
`adv_router`.

Two things then read that freed pointer:

- `show_ip_eigrp_route_descriptor()` prints `te->adv_router->src`, which is where the
  changing garbage addresses come from, and
- `eigrp_zebra_route_add()` does `if (te->adv_router->src.s_addr)` and falls to
  `NEXTHOP_TYPE_IFINDEX` when it reads zero — **this is the gateway-less nexthop**, built
  directly out of freed memory.

A skipped transition is not hypothetical on this deployment: the crash-guard patch
deliberately skips the FSM transition when a prefix has no feasible successor, which is
precisely the transition that would have removed the descriptor. The guard converts a
crash into this.

Measured, 2026-11-03: a single `clear ip eigrp neighbors` left **46** descriptors
referencing the freed neighbour and produced **16 of 29** prefixes corrupt — the same
shape seen in production.

## The fix

Four parts.

**Neutralise, don't remove** (`eigrp_topology.c`, called from `eigrp_nbr_delete()`). Every
descriptor still naming the dying neighbour has `adv_router` set to `NULL`, its metrics
set to `EIGRP_MAX_METRIC`, and its successor flags cleared. `EIGRP_MAX_METRIC` is what
makes it inert using the daemon's own existing rules rather than a new special case:
`eigrp_topology_update_node_flags()` will not flag a max-metric entry as a successor, and
`show_ip_eigrp_route_descriptor()` returns early on one.

Removing the descriptor outright was tried first and is wrong. The peer re-advertises
nothing after an interface flap, so the prefix is lost for good — measured as 29 prefixes
dropping to 13 with no recovery short of restarting `frr`. An interim version skipped the
purge while the interface was going down to dodge that, which then left the flap's own
descriptors dangling and surfaced them later anyway (flap followed by a clear: 16 corrupt
prefixes and three ECMP routes for one destination). Neutralising removes the need for
that asymmetry.

At most one inert descriptor is kept per prefix, so repeated adjacency churn cannot grow
the table without bound, and never the last entry.

**Never install a gateway-less nexthop** (`eigrp_zebra.c`). A descriptor with no
advertising router describes no reachable next hop, so it is skipped instead of being
handed to zebra. This is the belt to the above braces: it forecloses the blackhole even
if some path we have not measured leaves a bad descriptor behind.

**Re-state routes when an adjacency comes up** (`eigrp_packet.c`). Fixes a separate,
pre-existing failure measured on both the patched and unpatched binaries: after the
transit interface flaps, zebra keeps the EIGRP route in its RIB but never installs it
(`Status: Changed`, `Flags: None`, no kernel route), because the nexthop it still points
at lost its gateway while the link was down. The peer re-advertises nothing and the
recomputed metric is unchanged, so DUAL never re-issues the route and zebra is never asked
again. One forced re-add when an adjacency reaches full state builds a fresh nexthop and
the route installs.

**Skip DUAL during process teardown** (`eigrpd.c`, `eigrp_structs.h`,
`eigrp_neighbor.c`). Taken from upstream [FRRouting/frr#23827](https://github.com/FRRouting/frr/pull/23827),
which is **open** against master at the time of writing. It adds an `eigrp->finishing`
flag so a neighbour deleted on a later interface does not run DUAL over routes pointing at
an instance freed earlier in the same loop. Upstream's PR fixes teardown only and leaves
the steady-state neighbour-down path above untouched, which is why the rest of this patch
is ours.

## Verification

Reproduction is on demand, which is what makes this patch testable at all — the
production occurrences were days apart and non-deterministic.

```bash
# Reproduce (pre-patch): 16 of 29 prefixes go corrupt
vtysh -c "clear ip eigrp neighbors"; sleep 15
vtysh -c "show ip eigrp topology" | grep successors | grep -v "1 successors" | wc -l

# Post-patch, the same command reports 0, and the log says what it removed
journalctl -u frr | grep "NMS dangling-adv_router"
```

Results on this deployment, 12 mixed cycles of neighbour clears, single and double link
flaps, and flap-then-clear combinations:

| | pre-patch | post-patch |
|---|---|---|
| corrupt prefixes after a neighbour clear | 16 of 29 | 0 |
| prefixes retained after a link flap | 29 | 29 |
| kernel route for `10.0.2.0/24` after a flap | missing | installed |
| gateway-less nexthops in use by a route | observed | 0 |
| crashes | 0 | 0 |

The route table's md5 was byte-identical before and after a three-cycle neighbour-clear
run, so the neutralise path does not disturb a healthy table.

One cosmetic leftover is expected and harmless: a flap can leave an **orphaned**
gateway-less nexthop object (`id N dev ens20 scope host`) that no route references.
`eigrp-health.ts` resolves each route's `nhid` to its leaf rows precisely so that an
unreferenced one is not reported as a fault.

## Deploying it

The FRR Source Build page applies both patches for tag `frr-10.6.1`. For a manual
incremental rebuild, follow the procedure in
[the crash-guard doc](frr-eigrpd-crash-guard-patch.md#building-and-deploying-it) — the same
two traps apply: stop `frr` before installing, and install `eigrpd/.libs/eigrpd`, the real
~1.2 MB ELF, not the libtool wrapper script.

Confirm what is actually deployed, rather than what the repo contains:

```bash
strings /usr/lib/frr/eigrpd | grep -c "frr#943 crash-guard"      # crash-guard
strings /usr/lib/frr/eigrpd | grep -c "NMS dangling-adv_router"  # this patch
```

Both must be non-zero. `backup-restart-usecase.ts`'s `checkFrrCrashGuard()` automates
exactly this check for both patches, and reports each one missing separately — a build
predating either produces a binary that passes a single-marker check while missing the
other.

## What this does not fix

The **trigger** is still unexplained. Across seven occurrences the recurring precursor is
`Unknown TLV type: 0x0103` from a peer this deployment does not administer, and nothing
here explains why that peer's traffic drives `eigrpd` into the skip path. This patch
removes the consequences; it does not close the question.

The underlying FIFO/FILO ordering defect in EIGRP's DUAL implementation — which the
upstream maintainer acknowledged as incompletely fixed in 2017 and which is why a prefix
can have entries with no successor flagged at all — is also untouched. Fixing that means
tracing every path that touches successor-flag state across the whole EIGRP
implementation.

Because the trigger is open, `EigrpHealthGuard`
(`backend/src/application/use-cases/frr/eigrp-health-guard.ts`) watches the kernel route
table for the two traffic-affecting signatures regardless of cause and restarts `frr` to
repair them, with a cooldown, a cap, and a refusal to act on a corrupt topology alone or
on an eigrpd missing the crash-guard patch.
