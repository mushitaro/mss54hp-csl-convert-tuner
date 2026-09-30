# Third-party notices and data provenance

This file records what this project depends on, what it is derived from, and which of those things
are in this repository versus kept off it — and why. It follows the same approach as
[E46M3 /// MONITORING](https://github.com/mushitaro/E46M3-Monitoring/blob/main/THIRD-PARTY-NOTICES.md).

**This is a record of facts, not legal advice.** The provenance questions in §3 are judgement calls
that have to be made deliberately, not inherited by accident.

The project's own code is MIT (`LICENSE`). Nothing below is relicensed by that.

---

## 1. Runtime dependencies (shipped in the app)

Ordinary npm packages, all permissively licensed. See `package.json` and `package-lock.json` for
exact versions.

| Package | License |
|---|---|
| next, react, react-dom | MIT |
| tailwindcss, @tailwindcss/postcss | MIT |
| plotly.js, react-plotly.js | MIT |
| papaparse | MIT |
| framer-motion | MIT |
| clsx, tailwind-merge | MIT |
| lucide-react | ISC |
| Inter, JetBrains Mono (via `next/font`, self-hosted in the build) | SIL Open Font License 1.1 |

The production app talks to the DME over Web Serial / WebUSB and makes one network request of its
own: the update check, to its own origin. The **WORKS** build additionally sends sessions and
diagnostic records to its own origin, behind the owner gate (see README, "The WORKS build").

Development-only tools (`wrangler`, `eslint`, `typescript`, `@cloudflare/workers-types`) are not
shipped.

---

## 2. Protocol and calibration knowledge

The DS2 protocol handling and the calibration addresses are ports of work the community published —
credited by name in `README.md` §Credits and in the app's own credits dialog:

- **karter16 — MSS54 DS2 Tool** (<https://github.com/karter16/MSS54-DS2-Tool-Public>): the files
  that port it say so at the top. Neither its source nor its binary is in this repository.
- **karter16 — `CSL_0401_Karter16_v3_6_publish.xdf`** (TunerPro definition): the calibration
  addresses and scalings in `src/lib/ecu-items/` and `src/config/constants.ts` trace back to it.
  **The XDF itself is not in this repository**, and no third-party XDF is — `.xdf` files are
  refused by `scripts/check-public-tree.mjs`.
- **karter16 — the 0401 disassembly notes** (<https://github.com/karter16/CSL_0401_Binary_Disassembly_Notes>):
  `public/data/calibration-graph.json` is vendored from that project's graph by
  `scripts/sync-calibration-catalog.mjs`, which strips the calibration VALUES decoded from a
  reference image and keeps the structure (names, addresses, formulas, links).

---

## 3. What is in this repository, and what is not

### 3.1 Not in this repository

| What | Why |
|---|---|
| BMW program images, bootloaders, SP-Daten, full DME/EEPROM dumps | BMW's, not ours to redistribute |
| Third-party XDFs | their authors', not ours to redistribute |
| Real vehicles' data from the SYNC store (VIN, BINs, logs) | the owners'. D1 dumps go to `archive/`, which is gitignored |
| `public/data/calibration-decomp.json` on the public `main` and `preview` branches | Ghidra's decompiled C of the 0401 program — text derived from BMW firmware. The WORKS build serves it to signed-in owners; both published branches leave it out (`NOT_FOR_MAIN` and `NOT_FOR_PUBLIC` in `scripts/release-scope.mjs`), and the app falls back to quoted names without it |
| `.dev.vars`, `.env*`, tokens, `.wrangler/`, local databases | secrets and local state |

`scripts/check-public-tree.mjs` refuses these by extension, name and content (including anything
shaped like a real BMW M VIN) from `.githooks/pre-commit`, from CI, and before every release and
every publication of the `preview` branch.

### 3.2 In this repository, deliberately

Each is listed in `.public-tree-allow` with the same reason:

- **`public/mock/csl-0401-community-patch-v1.partial.bin`** — the CSL 0401 Community Patch v1
  partial, published openly by the E46 M3 community. PRACTICE serves it as a simulated DME, so the
  tool can be learnt with no car and no cable.
- **`scripts/fixtures/session-920-base.bin`** — the 64 KB calibration partial of one recorded
  session on the developer's own car, the fixture three verify suites run against. It carries no VIN
  as text. It is left off the public `preview` branch; whether `main` keeps it is an open decision.
  The suites skip without it.

### 3.3 BMW / Bosch Funktionsrahmen

Quoted by section number in `docs/ecu-logic/`. The documents themselves are not in this repository.
