# V1SU Database Analyzer Website

Static-site package for the SUBS Visualizer v45 Offline v2. The root page is a
two-entry hub for the short-circuit and electrical-life databases.

- `SC-Database/` opens the existing short-circuit waveform analyzer.
- `EE-Database/` opens the electrical-life and TDMS analyzer.

## Required files

The application expects these browser libraries under `libs/`:

- `plotly.min.js`
- `xlsx.full.min.js`
- `sql-wasm.js`

The page also loads `exper-browser.js`, the browser-side EXPer adapter. It accepts
multiple `.csv`, `.xlsx`, `.xls`, `.sqlite`, `.sqlite3`, `.db`, `.db3`, `.001`,
`.pnrf`, and `.tdms` files, normalizes them to time/U2/I1 series, optionally
extracts a DC or AC short-circuit interval, and exports the imported series as a
merged CSV or SQLite file.

## EE-Database subpage

Open `EE-Database/` from the GitHub Pages site. It loads
`data/ELECTRICAL_LIFE_DATABASE.sqlite`, the dedicated electrical-life database,
and accepts electrical-life imports from SQLite (`.sqlite`, `.sqlite3`, `.db`,
`.db3`), Excel (`.xlsx`, `.xls`), CSV, and TDMS files locally in the browser.
Excel workbooks may contain separate operations and waveform sheets; CSV imports
use long-form rows with sample, operation, time, current, and voltage columns.
Imported records can be merged with the bundled database or viewed separately.
The page applies the validated EXPer TDMS workflow: discard the first second,
detect the rated-current fall and zero-to-supply voltage rise, retain the 5 ms
pre/post event window (or 20 ms after the fall when current does not settle),
reset time, offset voltage to zero, show comparison metrics and dual-axis
waveforms, and export CSV/SQLite.
No source file is uploaded.

The SQLite WASM binary is embedded in `SC-Database/index.html`, but the SQL.js
JavaScript loader is still required.

These third-party files are intentionally not fabricated or downloaded by this package. Copy the exact tested versions from the current working `libs` folder into this repository before deployment.

## Publish with GitHub Pages

1. Copy the three tested library files into `libs/`.
2. Commit all files to the `main` branch.
3. In the repository settings, open **Pages**.
4. Select **GitHub Actions** as the source, if this option is enabled by the enterprise administrator.
5. Run the workflow **Deploy static site to GitHub Pages**, or push to `main`.
6. Read the deployed URL from the workflow summary.

## Local check

Serve the repository root over HTTP (e.g. `python -m http.server`) and open
`SC-Database/` so the built-in `data/II&III_SC_DATABASE.sqlite` auto-loads.
Opening the file directly (`file://`) shows the interface but the built-in data does not
auto-load due to browser fetch restrictions on local files — upload a file manually there.

## Privacy model

The current application reads and processes selected EXPer source files and SQLite files in the browser. It has no upload endpoint or server-side processing.

## Important

A public repository and a public Pages site are separate settings. On an enterprise GitHub instance, external public access may be disabled by organization or appliance policy. Confirm the effective visibility with the repository administrator before sharing the URL outside the company.

## Update notes

### 2026-09-08

- Added browser-side EXPer import and merge in `exper-browser.js`.
- CSV/Excel imports support named time, voltage, and current columns as well as the existing
  five-column waveform template. Multiple files can be merged with the built-in SQLite data
  and exported as `EXPer_merged_waveforms.sqlite` or CSV.
- `.001` files use the EXPer fixed layout: 384-byte header, four signed-int16 blocks, 100000
  samples, 0.02 ms spacing, current scale 3.89625 and voltage scale 1.01.
- Standard numeric TDMS files with a `waveform` group and `wf_increment` metadata are supported
  in the browser. DAQmx-scaled or unsupported TDMS data should use native EXPer Python.
- `.pnrf` files have a direct raw-ADC browser fallback for visualization. The calibrated
  Perception DLL adapter remains available through `EXPer/exper_convert.py`; GitHub Pages cannot
  execute PowerShell, .NET interop, or native Perception DLLs.
- Added DC/AC interval controls. DC uses the 20 A baseline-centred return rule; AC uses the
  first 100 A pulse and retains the 0.8 ms tail.

### 2026-08-27

- Bundled the `II&III_SC_DATABASE.sqlite` waveform set directly into the site under `data/`.
- The page now auto-loads this built-in database over HTTP(S) on page load, so the full
  series set appears with no manual upload. Manual upload of Excel/SQLite is still supported
  and replaces the built-in set when used.
- The bundled file is a `VACUUM`-compacted copy of the source database (53 manifest tables,
  including the SUBS26AA6073 event table and 265 browser series). Compacting keeps the
  browser database near 26 MB while preserving the waveform data.
- Auto-load requires HTTP(S) hosting; in `file://` mode (opened directly in a browser) the
  fetch of the data file is blocked by the browser, so the built-in set does not load there —
  use manual upload instead.

### 2026-08-06

- Renamed the website and browser title to **V1SU**.
- Added a full-screen dark-green `#0A2F24` entrance section.
- As the user scrolls, the entrance contracts into a persistent dark-green top navigation bar.
- `V1SU` moves to the top center and scales down to **20 pt**.
- The analysis interface is progressively revealed during scrolling.
- The visible heading `V1SU Analyzer — Excel + SQLite` was removed from the page.
- The visible `Updated I²t & energy` explanation was removed from the page. The retained algorithm note is recorded below for release traceability:

  > Auto I²t detects **start** as the onset of a sudden dU/dt rise. After start, dU/dt must stay positive, continuously increase, and reach **300 V/ms**. It detects **end** as a later sudden dU/dt rise. After end, dU/dt must stay positive, continuously increase, and reach **800 V/ms**. U must first enter **300–500 V** within **end + 0.1 ms**.

- Shortened `Import Excel / SQLite & select` to **Import**.
- HUD remains collapsed by default and shows only the `+` control when collapsed.

### 2026-08-25

- Changed the analysis workspace from a two-column layout to a single vertical workflow.
- Moved the complete **Import** and **Series** area above the **Charts** area.
- The page now reads from top to bottom in this order: Import, Series, Charts, and I²t & energy.
- Set the Plotly chart paper, plotting area, legend, and chart containers to transparent backgrounds.
- Added automatic high-contrast chart styling for day and night modes.
- Day mode uses dark-green axis lines, labels, titles, and ticks.
- Night mode uses white axis lines, labels, titles, and ticks.
- Grid lines use the approved life-green or light-green palette according to the active theme.

### 2026-08-25 corrective release

- Restored the single-column vertical browsing layout.
- Removed Plotly method interception and all global SVG fill overrides.
- Restored visible chart traces and WebGL layers.
- Day mode Plotly backgrounds are set natively to white `#FFFFFF`.
- Day mode axis values and axis titles are set natively to dark green `#0A2F24`.
- Night mode remains dark green with white labels.

