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

## How the load is built

Every item is sorted into a kind, and the kind decides how it rides:

| Kind | What it is | How it's loaded |
|---|---|---|
| **Base** | short and deep (bases, vanities, sink/drawer bases) | **standing upright on the trailer floor** — the bottom deck is built out of these because they're the only pieces strong enough to carry several layers |
| **Tall** | 55" or taller (pantries, oven cabinets) | **on its side, end panel down** — the upward face is a solid gable, so the next layer can ride on it |
| **Wall** | short and shallow (uppers) | **on its side, end panel down** |
| **Panel / trim** | anything under 3" in one direction — skins, fillers, valances, floating shelves | lies flat, filling the gaps between layers |
| **Package** | trim bundles / loose doors added with no Room-Cab # | lies flat |

The passes, in order:

1. **Fill the floor with base cabinets standing upright**, widest first, so the heavy pieces land at the front while the trailer is still empty.
2. **Whatever floor is left over** (usually toward the rear) gets tall and wall cabinets **on their side**.
3. **Plywood over the deck**, then the upper layers.
4. **Face up is the last resort.** A cabinet is only laid doors-toward-the-ceiling when it won't go on its side or upright — and then it is *never* put on the floor and *never* has anything stacked on it, because the load would land on its doors. Uncheck **Allow face-up** in the header to refuse it outright.

A cabinet is only stood upright if the diagonal of its height × depth face, plus the stand-up margin, fits under the ceiling — that's the room the far corner needs to sweep as you tip it up.

## Notes

- Room/cabinet IDs come out as `R{room}C{cab}` (e.g. `R1C5`), matching Mozaik.
- Dimensions convert from Mozaik's internal millimeters to inches, rounded to the nearest 1/16".
- **Stack On** in the cabinet list controls whether a piece can carry a layer when it's loaded *upright*. Pieces on their side always can; pieces face up never can.

## Files

- `index.html` — a tiny redirect so the Pages root URL opens the app.
- `cabinet-load-optimizer.html` — the app itself: self-contained, with drag-drop `.db` import, CSV import, 3D + 2D views, and the printable manifest.
