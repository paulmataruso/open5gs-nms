# FRR eigrpd Crash-Guard Patch

A hand-built patch that stops a long-standing, upstream-unfixed FRR bug from crashing
the entire `eigrpd` process — and with it, every EIGRP-learned route on the host —
whenever it fires. Applied on top of the from-source FRR 10.6.1 build already produced
by this project's **L3 Routing → Reinstall (Source)** feature.

Patch file: [`docs/patches/frr-eigrpd-crash-guard.patch`](patches/frr-eigrpd-crash-guard.patch)
(a real `git diff` against `eigrpd/eigrp_fsm.c` at the `frr-10.6.1` tag — apply directly
with `git apply`, see below).

## The bug

Upstream tracking: [FRRouting/frr#943](https://github.com/FRRouting/frr/issues/943),
opened 2017, closed the same month based on one maintainer's test topology no longer
reproducing it — but the maintainer's own words on the fix that closed it:

> "This should improve behavior somewhat. Things are still wrong though. The FIFO is
> actually being used as a FILO in some places which makes it wrong still."

That partial fix has shipped in every FRR release since, including 10.6.1. The
underlying inconsistency was never actually resolved — it's a ~9-year-old, maintainer-
acknowledged-incomplete bug in EIGRP's DUAL finite state machine.

**Where it lives:** `eigrpd/eigrp_fsm.c` has six FSM event handlers that each call
`eigrp_topology_get_successor(prefix)` and then assume the result is non-NULL:

```c
struct list *
eigrp_topology_get_successor(struct eigrp_prefix_descriptor *table_node)
{
	struct list *successors = list_new();
	struct eigrp_route_descriptor *data;
	struct listnode *node1, *node2;

	for (ALL_LIST_ELEMENTS(table_node->entries, node1, node2, data)) {
		if (data->flags & EIGRP_ROUTE_DESCRIPTOR_SUCCESSOR_FLAG) {
			listnode_add(successors, data);
		}
	}

	/*
	 * If we have no successors return NULL
	 */
	if (!successors->count) {
		list_delete(&successors);
		successors = NULL;
	}

	return successors;
}
```

`NULL` here is a **real, reachable state** — a prefix can have topology-table entries
with none of them currently flagged as the successor (exactly the FIFO/FILO ordering
issue the 2017 fix left unresolved) — not memory corruption. Yet the original code in
each of the six call sites was:

```c
struct list *successors = eigrp_topology_get_successor(prefix);
struct eigrp_route_descriptor *ne;

assert(successors); // If this is NULL we have shit the bed, fun huh?

ne = listnode_head(successors);
```

`assert()` calls `abort()` on failure. Since this fires on **external, untrusted
network input** (a peer's EIGRP Update packet, not an internal programming invariant),
a disproportionate failure mode results: the entire `eigrpd` process dies, `zebra`
immediately withdraws every EIGRP-learned route from the RIB (confirmed:
`client 34 disconnected 31 eigrp routes removed from the rib` in `journalctl -u frr`),
and every S1AP/N2 association riding on that routing (i.e. every connected radio) drops
within seconds. `watchfrr` normally restarts `eigrpd` within a second or two, but the
routing blackhole during that window is enough to tear down live SCTP associations —
confirmed three times on this deployment (2026-07-12, then twice more within 21 minutes
on 2026-07-15), with different external triggers each time (a dummy-interface change,
and later a brand-new EIGRP neighbor adjacency forming elsewhere on the network) — this
bug can be triggered by events entirely outside this host's control.

**Tried and disproven as a fix:** an inbound `distribute-list` filtering the implicated
prefix out of EIGRP processing does *not* prevent the crash — the assertion fires
inside raw per-TLV packet/FSM processing (`eigrp_read → eigrp_update_receive →
eigrp_fsm_event → eigrp_fsm_event_nq_fcn`), which runs before any distribute-list
filtering point. Confirmed live: applying the filter and forcing a neighbor resync via
`clear ip eigrp neighbors` reproduced the exact same crash immediately.

## The fix

Not a fix for the true root cause (the FIFO/FILO topology-table ordering issue) — that
would mean tracing every code path that touches successor-flag state across the whole
EIGRP DUAL implementation, real multi-day work for someone else's edge case. Instead:
turn the crash into a handled, logged, recoverable case. When
`eigrp_topology_get_successor()` returns `NULL` in a context that used to `assert()`,
log a warning identifying the prefix and skip just that one state transition — DUAL
gets another chance to re-evaluate the same prefix on the next update/query cycle
instead of the whole process dying.

Example (`eigrp_fsm_event_nq_fcn`, the function that actually crashed in every observed
incident on this deployment):

```c
int eigrp_fsm_event_nq_fcn(struct eigrp_fsm_action_message *msg)
{
	struct eigrp *eigrp = msg->eigrp;
	struct eigrp_prefix_descriptor *prefix = msg->prefix;
	struct list *successors = eigrp_topology_get_successor(prefix);
	struct eigrp_route_descriptor *ne;

	if (!successors) {
		/*
		 * NMS crash-guard (frr#943): a Non Query FSM event can fire for a
		 * prefix that currently has no feasible successor (topology-table
		 * entries exist but none carry the SUCCESSOR flag yet). This used
		 * to hit assert(successors) and abort the whole eigrpd process,
		 * withdrawing every EIGRP-learned route. Treat it as "no route
		 * available for this prefix right now" instead of crashing — DUAL
		 * will re-evaluate it on the next update/query cycle.
		 */
		zlog_warn(
			"EIGRP AS: %d Non-Query event for prefix %pFX with no feasible successor — skipping active transition instead of asserting (frr#943 crash-guard)",
			eigrp->AS, &prefix->destination);
		return 1;
	}

	ne = listnode_head(successors);
	prefix->state = EIGRP_FSM_STATE_ACTIVE_1;
	// ... unchanged ...
```

The other five call sites (`eigrp_fsm_event_q_fcn`, `eigrp_fsm_event_lr`,
`eigrp_fsm_event_dinc`, `eigrp_fsm_event_lr_fcs`, `eigrp_fsm_event_lr_fcn`,
`eigrp_fsm_event_qact` — six total including the one above) get the identical guard.
Two of them (`eigrp_fsm_event_lr`, `eigrp_fsm_event_lr_fcs`) have the `assert()` nested
inside an `if (prefix->state == ...)` block whose surrounding function must keep running
afterward regardless — for those, the guard skips only the reply/successor lookup
(logs and falls through to an `else`), not the whole function:

```c
if (prefix->state == EIGRP_FSM_STATE_ACTIVE_3) {
	struct list *successors = eigrp_topology_get_successor(prefix);

	if (!successors) {
		/* NMS crash-guard (frr#943) — see eigrp_fsm_event_nq_fcn() above */
		zlog_warn(
			"EIGRP AS: %d Local Reply for prefix %pFX with no feasible successor — skipping reply instead of asserting (frr#943 crash-guard)",
			eigrp->AS, &prefix->destination);
	} else {
		ne = listnode_head(successors);
		eigrp_send_reply(ne->adv_router, prefix);
		list_delete(&successors);
	}
}
```

Full diff: [`docs/patches/frr-eigrpd-crash-guard.patch`](patches/frr-eigrpd-crash-guard.patch).

## Building and deploying it

Uses the exact same from-source build tree the NMS's own "Reinstall (Source)" FRR
feature already produces (see `backend/src/application/use-cases/frr-source-build.ts`,
`backend/src/interfaces/rest/frr-source-build-controller.ts`) — a real git checkout of
`FRRouting/frr` at the `frr-10.6.1` tag, already configured (`./configure` already run,
`Makefile`/`config.status` present), on the host at `/opt/frr-build/frr`.

```bash
# 1. Apply the patch to the existing build tree (skip if already applied)
cd /opt/frr-build/frr
git apply /path/to/docs/patches/frr-eigrpd-crash-guard.patch

# 2. Incremental rebuild — only eigrp_fsm.o recompiles and eigrpd relinks,
#    not a full FRR rebuild
make -j"$(nproc)" eigrpd/eigrpd

# 3. Stop frr BEFORE installing the new binary — overwriting a running
#    process's executable fails with "Text file busy"
systemctl stop frr

# 4. Install the REAL binary, not the libtool wrapper script.
#    `eigrpd/eigrpd` in the build tree is a small shell-script wrapper
#    (~6KB) that sets up library paths and execs the actual binary —
#    the real ~1.2MB ELF binary is at eigrpd/.libs/eigrpd. Installing the
#    wrapper by mistake leaves watchfrr stuck retrying with no process
#    running at all. Confirm with `file` before trusting either path:
install -m 755 -o root -g root eigrpd/.libs/eigrpd /usr/lib/frr/eigrpd

# 5. Start frr and verify
systemctl start frr
systemctl status frr        # should show "FRR Operational"
vtysh -c "show ip eigrp neighbor"   # neighbor should re-form
```

Back up `/etc/frr/{frr.conf,daemons,vtysh.conf}` and the current
`/usr/lib/frr/eigrpd` binary before doing this on a live host — restoring both is a
straight file copy + `systemctl restart frr`.

## Verification

Tested against a real, deliberately-triggered occurrence of this exact crash before
this patch existed (`clear ip eigrp neighbors` reliably reproduced it on the unpatched
binary during earlier diagnosis). Since deploying the patched binary: `eigrpd` has run
continuously with **zero crashes and zero assertion hits** — confirmed by process
uptime (`ps -o etime` on the `eigrpd` PID shows continuous runtime since the patch was
installed, no restart in between) across more than 12 hours as of this writing, versus
three crashes in under three days beforehand.

## Known limitations

- Does not fix the actual root cause — the FIFO/FILO topology-table ordering
  inconsistency the 2017 upstream fix left unresolved. A prefix that hits this path
  simply misses one state transition and gets picked up on the next cycle, rather than
  the whole daemon dying — a large improvement in blast radius, not a correctness fix.
- Purely local to this deployment — not submitted upstream to FRR. If FRR ever properly
  fixes frr#943's root cause in a later release, this patch becomes unnecessary (and
  the from-source build should just move to that release instead).
- If a future FRR upgrade re-clones/re-checks-out the source tree at a newer tag, this
  patch will need to be re-applied (and re-verified it still applies cleanly — line
  numbers in `eigrp_fsm.c` may have shifted) before rebuilding.
