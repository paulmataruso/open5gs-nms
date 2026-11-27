# Cell Broadcast

The LTE Cell Broadcast module provides an OsmoCBC service, an administrator
console and a scoped integration API. Its path is NMS → OsmoCBC → SBc-AP → MME
→ S1AP → eNodeB. It does not send per-subscriber SMS or use IMS.

## Areas and zone labels

Routing uses **TAI = PLMN + TAC**. Preserve MCC/MNC leading zeros: `00101` and
`001001` are different PLMNs. The UI and API accept TAC as a decimal integer
between 0 and 65535. MME inventory reports TAC in hexadecimal; NMS converts it
and displays both representations.

A named zone contains one or more TAI pairs. Select several zones and/or direct
TAIs for a message. The final union is deduplicated and must contain 1–16 pairs;
larger selections are refused rather than truncated. Names are local display
labels, not radio configuration. Editing/removing a label does not change the
scope already stored with a submitted message.

Every cell belonging to a selected TAI is in scope, including cells that later
join it. The current eNodeB inventory is displayed as a preview, not a permanent
list of individual recipients. A selected TAI must currently have at least one
connected eNodeB before NMS submits the request.

## Installation

Choose **Cell Broadcast → Check / install OsmoCBC**. Installation runs as an
audited background job on the NMS host, with a single-install lock. It checks for
a compatible existing CBC and retains it. Otherwise it installs missing build
dependencies on Debian/Ubuntu and builds checksum-pinned official sources:
libosmocore 1.9.0, libosmo-netif 1.4.0 and OsmoCBC 0.4.2.

Private libraries/binaries are installed under `/opt/open5gs-nms-cbc`, without
replacing system Osmocom libraries. The bundled reviewed patch adds a bounded
`scope_tais` REST input and encodes the standard SBc-AP List-of-TAIs on both
write and stop requests. Upstream OsmoCBC's PLMN-only REST interface cannot
provide this targeting on its own.

The service is `open5gs-nms-cbc.service`; configuration is
`/etc/open5gs-nms/cbc.cfg`. REST listens on `127.0.0.1:12345`, VTY on loopback,
and the default SBc-AP client connects to `127.0.0.2:29168`. Service operations
are available in the module. The installer preserves an existing managed
configuration and does not restart the MME or submit any message.

Automatic installation requires Python 3.12+, apt and access to the official
source archives/package repositories. Downloaded archives are checked against
embedded SHA-256 hashes before extraction. Build directories, download caches
and installation markers persist under `/var/lib/open5gs-nms/cbc`.

## Open5GS dependency

Use the companion SBc-AP integration build, including explicit TAI forwarding
in **both** S1AP Write-Replace-Warning and Kill requests. NMS checks the running
MME image for its routing capability marker, rather than assuming that saved
configuration or an installed file is already active.

Configure the compatible MME with:

```yaml
mme:
  sbcap:
    server:
      - address: 127.0.0.2
        port: 29168
```

Activate MME binary/configuration changes during maintenance; a restart can
disconnect existing UE contexts. The CBC installer does not upgrade Open5GS.
The eNodeB must implement the requested PWS/Cell Broadcast procedure. This
module currently exposes text-based LTE CBS/CMAS messages using UCS-2; it does
not expose ETWS primary warnings or 5G AMF/N50 operation.

## Sending and stopping

Enter text, select zones/TAIs, and review the resolved scope and message
identifiers before confirming. Text is limited to 615 UCS-2 characters;
supplementary Unicode characters are refused. Broadcast count is bounded to
1–100. The default message ID is 4380, a CMAS test category; handset display
depends on the category, device settings and radio support.

History distinguishes `submitting`, `accepted`, `rejected`, `unknown`,
`stopping` and `stopped`. Acceptance by CBC does not prove handset reception.
There is no automatic resend. A UUID identifies one immutable submission;
retrying that UUID returns its recorded result. Reusing it with changed input
is refused. Message IDs cannot overlap while a request remains pending,
accepted or uncertain. Stop requests use the original CBC message identity and
stored scope, not a newly resolved zone definition.

## Integration API

An administrator creates a named API key restricted to one or more saved zones.
The secret is displayed once and stored only as a SHA-256 hash. Revoke it in
the UI at any time. The API accepts it only through `Authorization: Bearer`.
Zone edits update the key's authorized scope; removing a zone removes its
authorization. Direct TAI selection must be within the union of authorized
zones. An integration may list/stop only its own submitted messages.

```http
GET /api/cell-broadcast/v1/zones
Authorization: Bearer <key>
```

```http
POST /api/cell-broadcast/v1/messages
Authorization: Bearer <key>
Content-Type: application/json

{
  "requestId": "8a381af5-d247-45d3-b2eb-7b7467033565",
  "zoneIds": ["<zone UUID>", "<another zone UUID>"],
  "areas": [{"plmn": "00101", "tac": 1}],
  "text": "Maintenance test",
  "messageId": 4380,
  "serialNumber": 16385,
  "repetitionPeriod": 30,
  "broadcasts": 3,
  "confirm": true
}
```

`areas` and `zoneIds` can each be omitted, but their resolved union cannot be
empty. A successful HTTP submission returns 202 and the persisted operation
state. Check that state; 202 alone is not proof of delivery.

```http
GET /api/cell-broadcast/v1/messages
Authorization: Bearer <key>

POST /api/cell-broadcast/v1/messages/<request UUID>/stop
Authorization: Bearer <key>
```

Administrative endpoints are under `/api/cell-broadcast`, protected by both
the existing authenticated session middleware and `requireAdmin`. External
requests have separate scoped-key authentication and a 20 requests/minute rate
limit. Audit entries record the actor and operation, excluding key secrets and
message text.

## References and attribution

- [TS 23.041](https://www.3gpp.org/dynareport/23041.htm): CBS architecture.
- [TS 29.168](https://www.3gpp.org/dynareport/29168.htm): SBc-AP.
- [TS 36.413](https://www.3gpp.org/dynareport/36413.htm): S1AP warning area.
- [OsmoCBC](https://github.com/osmocom/osmo-cbc), with its existing AGPL notices.
- Open5GS SBc-AP contributions by Mirko Kovačević and Arnaud DJOUM,
  [#4822](https://github.com/open5gs/open5gs/pull/4822) and
  [#4864](https://github.com/open5gs/open5gs/pull/4864).

Qualification requires a compatible RAN and handsets. Unit tests and isolated
protocol checks do not certify emergency alert delivery.
