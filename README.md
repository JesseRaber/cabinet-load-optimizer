# Cabinet Load Optimizer

A browser-based 3D load optimizer for custom cabinet jobs. Load a job, pick a trailer, and it nests the cabinets to minimize wasted space — then prints a load plan showing where every cabinet goes, by room and cabinet number.

**Live app:** https://jesseraber.github.io/cabinet-load-optimizer/

## Using it

1. Open the app (link above).
2. Load your cabinets one of two ways:
   - **Drag & drop a Mozaik `JobData.db`** onto the Mozaik panel. The file is read entirely in your browser — nothing is uploaded anywhere — converted from millimeters to inches and rounded to the nearest 1/16".
   - **Paste cabinet rows** into the CSV import: `name, width, height, depth, qty`.
3. Set your trailer / container interior dimensions.
4. Hit Calculate for the 3D view, the top / side / back 2D views, and a printable load manifest listing each cabinet's room/cabinet number and exact X / Y / Z placement.

Everything runs client-side. The site is just static files on GitHub Pages — no server required.

## Notes

- Room/cabinet IDs come out as `R{room}C{cab}` (e.g. `R1C5`), matching Mozaik.
- Dimensions convert from Mozaik's internal millimeters to inches, rounded to the nearest 1/16".
- Stackable heuristic: height ≤ 50" and not named "Tall". Adjust per item in the app if needed.

## Files

- `index.html` — a tiny redirect so the Pages root URL opens the app.
- `cabinet-load-optimizer.html` — the app itself: self-contained, with drag-drop `.db` import, CSV import, 3D + 2D views, and the printable manifest.
- `watcher.py`, `Dockerfile`, `docker-compose.yml`, `requirements.txt` — an optional NAS auto-import service, **not used by the hosted site**. Preserved for later (see below).

## Optional: NAS auto-import (future)

`watcher.py` is a Flask + watchdog service intended to run in Docker / Container Manager on a Synology NAS. It watches a Mozaik Jobs share for `JobData.db` changes, extracts the cabinet list automatically, and serves the app with a built-in job picker — no drag-drop needed. It isn't required for the hosted version and isn't wired into it; it's kept here for when the app moves onto the NAS.
