# Cabinet Load Optimizer

A browser-based 3D load optimizer for custom cabinet jobs. Load a job, pick a trailer, and it nests the cabinets to minimize wasted space — then prints a load plan showing where every cabinet goes, by room and cabinet number.

**Live app:** https://jesseraber.github.io/cabinet-load-optimizer/

## Using it

1. Open the app (link above).
2. On the **Cabinets** tab, load your cabinets one of three ways:
   - **Drag & drop a Mozaik `JobData.db`** onto the Mozaik panel. The file is read entirely in your browser — nothing is uploaded anywhere — converted from millimeters to inches and rounded to the nearest 1/16".
   - **Paste the cabinet table straight out of Mozaik.** Tab-separated, columns in this order: Qty, Name, W, H, D, Description, Finished Ends, Room/Cab #. Fractions like `34 1/2` are handled.
   - **Add an item by hand.** Leave Room/Cab # blank and it's treated as a package — a trim bundle, loose doors, or anything else with no cabinet number.
3. On the **Trailers** tab, set the interior dimensions. Gooseneck decks, V-noses, wheel wells and the rear door frame lip are all modelled.
4. Press **⚙ Optimize Load** in the header. You get the 3D view, the floorplan and both side elevations, the loading order for the crew, and a printable manifest listing each cabinet's room/cabinet number and exact placement.

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

These rules live in exactly one place: `POSE_ORDER` and `packLoad()` in `cabinet-load-optimizer.html`. Nothing else in the app — including the two add-ons below — changes how a load is packed.

## Placing cabinets by hand — the Manual Layout tab

Sometimes you know where a piece has to go. The **Manual Layout** tab lets you put it there and keeps it there.

- **Two views, side by side.** A live 3D view of the trailer and a top-view plan. Use the **Views** selector to show both, or just one.
- **Drag a cabinet out of the list** into the plan, or drag something already loaded to a new spot. Boxes snap to your chosen increment and pull flush against walls and neighbours.
- **Click a cabinet in the 3D view** to select it, then reorient it with the buttons: turn 90°, change how it lies, move it up or down a layer, or nudge it fore/aft and side to side.
- **Anything you place by hand is pinned** (📌). Press **Optimize Load** and the packer fills the trailer around the pinned pieces without moving them.
- **Undo and redo** cover every hand placement in the session — buttons, or Ctrl+Z / Ctrl+Shift+Z.
- Placements are checked as you make them. A box that won't fit, overlaps something, or would end up resting on another cabinet's doors is outlined in red and the reason is spelled out.

Keys, while the tab is open: **R** turn 90° · **P** change how it lies · **[** / **]** down / up a layer · arrow keys nudge · **Backspace** take it back out · **Esc** deselect.

Pinned pieces are marked **SET SPOT** on the crew sheet and get their own table in the printout, so the loader knows the position was chosen deliberately.

## Reviewing what you changed — the Tuning tab

Every time you press Optimize Load, the app records the answer the packer gave. Every time you move something by hand, it records the change against that original answer. The **Tuning** tab reads the history back and writes out candidate changes to the loading rules.

**Nothing on that tab is ever applied automatically, and it is not machine learning.** There is no model and no training. It counts the times you disagreed with the packer and looks for a consistent pattern in those counts — arithmetic on your edits, nothing more. Each suggestion names the exact constant or function that would have to change, shows the sample count and how consistent the pattern is, and waits for you to decide.

What it looks for:

- A kind of cabinet whose **pose** you keep changing (→ `POSE_ORDER`)
- A kind you keep **turning 90°** (→ the variant order in `makePoses()`)
- A kind you keep moving **between the floor and the stacked layer** (→ the phase order in `packLoad()`)
- A consistent **shove fore/aft or side to side** for one kind (→ the sort comparators)
- Pieces the packer **said would not fit and you fitted by hand** (→ the candidate-position search)
- Real cabinets placed **face up** that you turned off their doors — flagged as a shop-rule breach and sorted above everything else

It also shows the share of the packer's placements you left alone, by kind, which is the honest counterweight: a high number there means those rules are already doing their job.

A pattern needs roughly 4 edits of the same kind, pointing the same way 60% of the time, before anything is suggested. **Copy suggestions** puts the whole list on the clipboard as text; **Download log (JSON)** exports the full history plus the suggestions, which is the file to hand to whoever is going to make the code change.

The log lives in `localStorage` on that one device — the last 25 optimize runs. Nothing is uploaded. **Clear log** wipes it.

## Notes

- Room/cabinet IDs come out as `R{room}C{cab}` (e.g. `R1C5`), matching Mozaik.
- Dimensions convert from Mozaik's internal millimeters to inches, rounded to the nearest 1/16".
- **Stack On** in the cabinet list controls whether a piece can carry a layer when it's loaded *upright*. Pieces on their side always can; pieces face up never can.
- Trailer profiles and header settings persist in `localStorage`, and also to `api/settings` if the copy you're running is served by something that provides it. Neither is required.

## Files

- `index.html` — a tiny redirect so the Pages root URL opens the app.
- `cabinet-load-optimizer.html` — the app itself: self-contained, with drag-drop `.db` import, paste and manual import, 3D + 2D views, the packing engine, and the printable manifest.
- `manual-layout.js` — the Manual Layout tab: hand placement, pinning, the shared 3D view with click-to-select, and undo/redo. Replaces `optimize()`, `showTab()`, `resize3D()` and `loadingOrderHTML()` at run time and decorates `draw3D()`, `renderCabs()` and `plansHTML()`. Deletes nothing.
- `load-learning.js` — the Tuning tab. Listens for the `clo:optimize` and `clo:edit` events that `manual-layout.js` announces on the document, and turns them into reviewable suggestions.

Both add-ons are optional. Remove a `<script>` tag and that feature is gone; the app underneath is untouched.

### Script order

The two add-ons load at the end of `<body>`, in this order — `load-learning.js` wraps `showTab()`, which `manual-layout.js` has already replaced, so it has to come second:

```html
<script src="manual-layout.js"></script>
<script src="load-learning.js"></script>
```

If you're serving a copy from somewhere that caches aggressively (a NAS, for instance), add a version query string when you update a file so browsers pick up the new one:

```html
<script src="manual-layout.js?v=2"></script>
<script src="load-learning.js?v=1"></script>
```
