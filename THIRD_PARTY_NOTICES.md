# Third-Party Notices

**Open5GS NMS** is copyright (C) 2026 Paul Mataruso and licensed under the **GNU Affero General Public License v3.0 (AGPL-3.0)**.
See the [LICENSE](LICENSE) file for the full license text.

This project makes use of the following third-party software. We are grateful to the authors and contributors of these projects.

---

<img src="https://github.com/osmocom.png" width="28" height="28" align="left" style="margin-right: 8px;">

## pysim / suci-keytool.py

**Copyright (C) 2024 Harald Welte <laforge@osmocom.org>**
**Copyright (C) 2009-2024 Sylvain Munaut, Harald Welte, Philipp Maier, Supreeth Herle, and contributors**

- **Source:** https://gitea.osmocom.org/sim-card/pysim
- **License:** GNU General Public License v2.0 (GPL-2.0)
- **Usage:** The `suci-keytool.py` script from pysim's `contrib/` directory is used inside the NMS backend Docker container for generating and extracting SUCI home network keypairs (Profile A / Profile B) for 5G subscriber concealment.

The full GPL-2.0 license text is available at: https://www.gnu.org/licenses/old-licenses/gpl-2.0.html

---

<img src="https://github.com/osmocom.png" width="28" height="28" align="left" style="margin-right: 8px;">

## pyosmocom

**Copyright (C) 2009-2024 Osmocom contributors**

- **Source:** https://gitea.osmocom.org/osmocom/pyosmocom
- **PyPI:** https://pypi.org/project/pyosmocom/
- **License:** GNU General Public License v2.0 (GPL-2.0)
- **Usage:** Python utility library required by suci-keytool.py. Provides the `osmocom.utils` module used for byte/hex conversion.

---

<img src="https://github.com/open5gs.png" width="28" height="28" align="left" style="margin-right: 8px;">

## Open5GS

**Copyright (C) 2019-2024 by Sukchan Lee <acetcom@gmail.com> and contributors**

- **Source:** https://github.com/open5gs/open5gs
- **Website:** https://open5gs.org
- **License:** GNU Affero General Public License v3.0 (AGPL-3.0)
- **Usage:** This NMS is designed to manage, configure, and monitor Open5GS 4G EPC and 5G SA core network functions. Open5GS itself is not bundled with this project — it must be installed separately on the host system.

The full AGPL-3.0 license text is available at: https://www.gnu.org/licenses/agpl-3.0.html

---

<img src="https://github.com/vectorcore-mobile.png" width="28" height="28" align="left" style="margin-right: 8px;">

## VectorCore ePDG, VectorCore AAA, VectorCore MMSC

**Copyright (C) Stacy Vinson ([svinson1121](https://github.com/svinson1121)) and the [VectorCore Mobile](https://github.com/vectorcore-mobile) project**

- **Source:** https://github.com/vectorcore-mobile/vectorcore-ePDG, https://github.com/vectorcore-mobile/vectorcore-aaa, https://github.com/vectorcore-mobile/vectorcore-mmsc
- **License:** vectorcore-ePDG and vectorcore-mmsc are Apache License 2.0; vectorcore-aaa is GNU Affero General Public License v3.0 (AGPL-3.0) (vectorcore-aaa is itself derived from the Osmocom `osmo-epdg` project — see that repository's own `NOTICE.md` for upstream Osmocom attribution).
- **Usage:** This NMS builds all three components from source on the host (vendored, not bundled — cloned and compiled during the VoWiFi and MMS modules' own Install/Configure steps) to provide the VoWiFi (ePDG/AAA, SWu/SWm/S2b/Swx) and MMS (MM1/MM3/MM4/MM7 MMSC) backends. Sincere thanks to Stacy Vinson and the VectorCore Mobile project for this work.

The full Apache-2.0 license text is available at: https://www.apache.org/licenses/LICENSE-2.0
The full AGPL-3.0 license text is available at: https://www.gnu.org/licenses/agpl-3.0.html

---

<img src="https://github.com/herlesupreeth.png" width="28" height="28" align="left" style="margin-right: 8px;">

## docker_open5gs (reference)

**Copyright (C) Supreeth Herle and contributors**

- **Source:** https://github.com/herlesupreeth/docker_open5gs
- **License:** GNU General Public License v3.0 (GPL-3.0)
- **Usage:** Used as architectural reference for Docker-based Open5GS deployments. No code from this project is directly bundled in the NMS.

---

<img src="https://github.com/clientIO.png" width="28" height="28" align="left" style="margin-right: 8px;">

## JointJS

**Copyright (C) 2013-2024 client IO s.r.o.**

- **Source:** https://github.com/clientIO/joint
- **Website:** https://jointjs.com
- **License:** Mozilla Public License 2.0 (MPL-2.0)
- **Usage:** Used in the frontend for rendering the interactive 4G/5G network topology diagram.

The full MPL-2.0 license text is available at: https://www.mozilla.org/en-US/MPL/2.0/

---

<img src="https://github.com/facebook.png" width="28" height="28" align="left" style="margin-right: 8px;">

## React

**Copyright (C) Meta Platforms, Inc. and affiliates**

- **Source:** https://github.com/facebook/react
- **License:** MIT License
- **Usage:** Frontend UI library.

---

<img src="https://github.com/vitejs.png" width="28" height="28" align="left" style="margin-right: 8px;">

## Vite

**Copyright (C) 2019-present, Yuxi (Evan) You and Vite contributors**

- **Source:** https://github.com/vitejs/vite
- **License:** MIT License
- **Usage:** Frontend build tool and development server.

---

<img src="https://github.com/tailwindlabs.png" width="28" height="28" align="left" style="margin-right: 8px;">

## Tailwind CSS

**Copyright (C) Tailwind Labs, Inc.**

- **Source:** https://github.com/tailwindlabs/tailwindcss
- **License:** MIT License
- **Usage:** Utility-first CSS framework used for frontend styling.

---

<img src="https://github.com/expressjs.png" width="28" height="28" align="left" style="margin-right: 8px;">

## Express

**Copyright (C) 2009-2014 TJ Holowaychuk, 2013-2014 Roman Shtylman, 2014-2015 Douglas Christopher Wilson**

- **Source:** https://github.com/expressjs/express
- **License:** MIT License
- **Usage:** Node.js web framework used for the backend REST API.

---

<img src="https://github.com/mongodb.png" width="28" height="28" align="left" style="margin-right: 8px;">

## MongoDB

**Copyright (C) MongoDB, Inc.**

- **Website:** https://www.mongodb.com
- **License:** Server Side Public License v1 (SSPL-1.0)
- **Usage:** Database used to store Open5GS subscriber data. Not bundled — must be installed separately on the host system or run as a Docker container.

---

<img src="https://github.com/prometheus.png" width="28" height="28" align="left" style="margin-right: 8px;">

## Prometheus

**Copyright (C) The Prometheus Authors**

- **Source:** https://github.com/prometheus/prometheus
- **License:** Apache License 2.0
- **Usage:** Metrics collection and storage for Open5GS NF monitoring. Runs as an optional Docker container alongside the NMS.

---

<img src="https://github.com/grafana.png" width="28" height="28" align="left" style="margin-right: 8px;">

## Grafana

**Copyright (C) Grafana Labs**

- **Website:** https://grafana.com
- **License:** GNU Affero General Public License v3.0 (AGPL-3.0)
- **Usage:** Metrics visualization and dashboarding for Open5GS monitoring. Runs as an optional Docker container alongside the NMS.

---

<img src="https://github.com/genieacs.png" width="28" height="28" align="left" style="margin-right: 8px;">

## GenieACS

**Copyright (C) GenieACS contributors**

- **Source:** https://github.com/genieacs/genieacs
- **Website:** https://genieacs.com
- **License:** GNU Affero General Public License v3.0 (AGPL-3.0)
- **Usage:** TR-069 Auto Configuration Server (ACS) used for provisioning Baicells eNodeBs via the CWMP protocol. Runs as a Docker container alongside the NMS using the `drumsergio/genieacs` image. The NMS communicates with GenieACS via its Northbound Interface (NBI) REST API on port 7557.
- **Docker Image:** https://hub.docker.com/r/drumsergio/genieacs

The full AGPL-3.0 license text is available at: https://www.gnu.org/licenses/agpl-3.0.html

---

<img src="https://github.com/Legrandin.png" width="28" height="28" align="left" style="margin-right: 8px;">

## pycryptodomex

**Copyright (C) 2013-2024 Legrandin and contributors**

- **Source:** https://github.com/Legrandin/pycryptodome
- **PyPI:** https://pypi.org/project/pycryptodomex/
- **License:** BSD 2-Clause / Public Domain
- **Usage:** Python cryptography library required by suci-keytool.py for ECC key generation (X25519, secp256r1).

---

## Additional Node.js Dependencies

The following npm packages are used under MIT or compatible licenses. Full license texts are available in the respective `node_modules` directories or on npmjs.com.

| Package | License | Purpose |
|---|---|---|
| `pino` | MIT | Structured logging |
| `better-sqlite3` | MIT | SQLite authentication database |
| `js-yaml` | MIT | YAML parsing and serialization |
| `mongoose` | MIT | MongoDB ODM |
| `helmet` | MIT | Express security headers |
| `express-rate-limit` | MIT | API rate limiting |
| `lucide-react` | ISC | UI icon library |
| `recharts` | MIT | Data visualization charts |
| `clsx` | MIT | Conditional CSS class utility |
| `react-hot-toast` | MIT | Toast notifications |
| `zustand` | MIT | Frontend state management |
| `cmd2` | MIT | CLI framework (pysim dependency) |

---

*This notices file is provided for informational purposes. The presence of a project in this list does not imply endorsement by the respective copyright holders.*

*Last updated: August 2026*
