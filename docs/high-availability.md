# High Availability

The High Availability module manages an active-active LTE/EPC deployment:
real MME/eNodeB/UE inventory, neighboring-MME configuration and operator-requested
UE load rebalancing. It uses the same core configuration workflow as Configuration.
Each core remains an independent active node. There is no hypervisor dependency.

## Core inventory

The local MME and PGW-C/SMF metrics endpoints are read from the installed YAML.
Add other cores with their names and metrics origins. For SSH-managed cores,
metrics are read on that host, so the listener can remain on loopback. Without
SSH, metrics origins must be directly reachable from the NMS host.

The module queries `/enb-info`, `/ue-info` and `/pdu-info`, follows the endpoint's
pagination, and reports unavailable/incomplete inventory explicitly. It joins
PDN bindings across the configured PGW/SMF anchors: moving the serving MME does
not imply moving the PGW that owns an existing UE address.

The radio table displays the eNodeB name reported in S1 Setup, its global
identity, SCTP peer, PLMN, supported tracking areas and S1 association state.
Existing NMS radio nicknames are retained alongside the reported name. UE rows
show the serving core, radio, registration/connection state, all known APN/IP
bindings and the MME's PDN details. No subscriber or radio rows are fabricated.

Core profiles and relocation operations persist in the NMS SQLite database.
Administrative actions use the existing authenticated/admin-only REST surface
and audit log. SSH uses the host's existing identities, `BatchMode=yes` and
`StrictHostKeyChecking=yes`; this module never disables host-key verification
or installs SSH authorization keys.

## Open5GS support

Inter-MME mobility requires an Open5GS build containing the S10 implementation
and compatible SGW/PGW components for the chosen relocation path. The MME editor
checks both the running image and the binary selected for the next service
restart. Adding NMS settings does not add protocol handlers to a stock MME.

The native operator interface additionally requires the
[MME operator branch](https://github.com/cecrevier/open5gs/tree/feature/mme-operator-rebalance).
It is disabled unless `OPEN5GS_MME_OPERATOR_SOCKET` is configured. Its local Unix
socket lives in a private service-owned directory, has mode 0600, and checks
Linux sender credentials. Requests are queued into the MME FSM, not executed
from an HTTP metrics thread. There is no unauthenticated mutating metrics API.

The installer prepares a separate Open5GS installation prefix. Dependencies,
building and activation are separate operations:

```sh
python3 backend/tools/install-mme-operator.py --check
sudo python3 backend/tools/install-mme-operator.py --install-dependencies
sudo python3 backend/tools/install-mme-operator.py --build \
  --source /path/to/reviewed/open5gs --prefix /opt/open5gs-ha
```

Building installs beneath the selected prefix, including configuration templates
under that prefix, and does not overwrite `/etc/open5gs` or restart live services.
Activate the MME during a maintenance window:

```sh
sudo python3 backend/tools/install-mme-operator.py --activate --prefix /opt/open5gs-ha
```

Activation creates a backed-up systemd override for `open5gs-mmed.service`,
configures `/run/open5gs-mme-operator/control.sock` in a private runtime directory,
and restarts only the MME. It waits for the native capabilities response and
restores the previous override if startup fails. This restart can disconnect
UEs; activation itself is not a session migration. Upgrade other EPC components
consistently when using S10 SGW relocation; the MME activation command does not
replace their running binaries.

For remote operations, install the operator-enabled MME on the source host and
configure that core's SSH host/user in NMS. The SSH account must already have
access to the private operator socket and the metrics listeners. Do not expose
the Unix socket as a public TCP service.

## Relocating an existing UE

Select a registered, connected UE and a target core, then request relocation.
The request concerns the UE context and its PDN connections together, not one
independently movable APN. Both MMEs must report a completed S1 association with
the same global eNodeB, and the baseline APN/IP bindings must be known.
Both native interfaces must also report distinct, unambiguous runtime GUMMEIs,
a usable target capacity and reciprocal S10 routes. These checks use the running
MMEs rather than assuming that saved configuration has already been applied.

The source MME initiates Release Access Bearers and, after gateway acceptance,
S1 release with cause **load balancing TAU required**, following TS 23.401
§4.3.7.3. This preserves the PDN context rather than deleting the session or
sending a NAS Detach. The UE performs a TAU, the eNodeB selects an MME according
to its pool configuration, and S10 supports context retrieval at the target.

**The O+M request does not force an arbitrary target MME in the radio.** Configure
the pool's S1 associations and selection policy to steer toward the chosen
target. NMS treats that target as the expected destination and verifies what
actually happened. A connected inter-eNodeB S1 handover is a radio-initiated
procedure; this button does not manufacture Handover Required signaling.

The native operation refuses idle, unregistered, busy or insecure UE contexts,
missing S10 peers, active voice/video bearers and priority/emergency contexts.
Active voice mobility requires radio-coordinated handover instead of this
maintenance release procedure. It does not migrate a failed PGW or IMS server.

Acceptance means **requested**, not completed. NMS confirms completion only
after the source no longer reports the UE registered, the selected target does,
and all baseline APN/IP bindings and original PGW control-plane tunnel identifiers
remain unchanged. A new attachment reusing a static IP does not satisfy this
continuity check. If delivery is uncertain,
the operation is marked unknown and is not automatically retried. Native
request IDs suppress duplicate dispatch within the MME's bounded request cache.
Unconfirmed operations time out after two minutes and retain their diagnostic
details. Core removal is refused while it has pending operations.

## Validation boundaries

NMS tests exercise real inventory mapping, radio-name correlation, SSH command
construction, preconditions, persistent operation state, uncertain delivery and
source/target registration plus PDN-address checks. Open5GS unit tests exercise
the production operator parser, eligibility, standard release dispatch and Unix
credential transport. Deployment qualification must additionally exercise the
actual RAN/MME pool, HSS, gateways and IMS: request acceptance alone proves none
of those end-to-end outcomes.

References: [TS 23.401](https://www.etsi.org/deliver/etsi_ts/123400_123499/123401/19.04.00_60/ts_123401v190400p.pdf)
§4.3.7.3 (MME load rebalancing), §5.3.3.1 (inter-MME TAU),
§5.5.1.2.2 (S1 handover), and the
[S10 implementation](https://github.com/open5gs/open5gs/pull/5019).
