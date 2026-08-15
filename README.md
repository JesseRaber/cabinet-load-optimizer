# Cabinet Load Optimizer

A browser-based 3D load optimizer for custom cabinet jobs. Load a job, pick a trailer, and it nests the cabinets to minimize wasted space — then prints a load plan showing where every cabinet goes, by room and cabinet number.

**Live app:** https://jesseraber.github.io/cabinet-load-optimizer/

## Using it

1. Open the app (link above).
2. On the **Cabinets** tab, load your cabinets one of three ways:
   - **Drag & drop a Mozaik `JobData.db`** onto the Mozaik panel. The file is read entirely in your browser — nothing is uploaded anywhere — converted from millimeters to inches and rounded to the nearest 1/16".
   - **Add an item by hand.** Leave Room/Cab # blank and it's treated as a package — a trim bundle, loose doors, or anything else with no cabinet number.
   - **Import a spreadsheet or CSV**, or paste a table copied off the screen — including a cabinet table copied straight out of Mozaik, which is just the tab-separated case. Reads `.csv`, `.tsv` and `.txt`; comma, semicolon, pipe or tab separated, with quoted fields handled. It works out whether the first row is a header, guesses which column is which, and then *shows you that guess* as a row of dropdowns with a three-row preview, so you can correct anything it got wrong before importing. Separate `Room` and `Cab` columns are combined into `R{room}C{cab}`, and a metric source converts via the **Units** selector (in / mm / cm). Fractions like `34 1/2` are handled everywhere.
3. On the **Trailers** tab, set the interior dimensions. Gooseneck decks, V-noses, wheel wells and the rear door frame lip are all modelled.
4. Press **⚙ Optimize Load** in the header. You get the 3D view, the floorplan, both side elevations, the front and back end views, the loading order for the crew, and a printable manifest listing each cabinet's room/cabinet number and exact placement.

Everything runs client-side. The site is just static files on GitHub Pages — no server required.

## How the load is built

A short version of this lives in the app itself, under the collapsible **How the Load Gets Built** panel at the bottom of the Cabinets tab.

Every item is sorted into a kind, and the kind decides how it rides:

| Kind | What it is | How it's loaded |
|---|---|---|
| **Base** | short and deep (bases, vanities, sink/drawer bases) | **standing upright on the trailer floor** — the bottom deck is built out of these because they're the only pieces strong enough to carry several layers |
| **Tall** | 55" or taller (pantries, oven cabinets) | **on its side, end panel down** — the upward face is a solid gable, so the next layer can ride on it |
| **Wall** | short and shallow (uppers) | **on its side, end panel down** |
| **Panel / trim** | anything under 3" in one direction — skins, fillers, valances, floating shelves | lies flat, filling the gaps between layers |
| **Package** | trim bundles / loose doors added with no Room-Cab # | lies flat |

The passes, in order:

1. **A bay for the long talls.** A tall cabinet wider than the trailer has to lie lengthwise, so it needs a clear run of eight or nine feet. If the bases take the floor first that run never exists again, so these get nested side by side before anything else. Nested talls also give the layer above a solid end-panel-up deck.
2. **Fill the floor with base cabinets standing upright**, widest first, so the heavy pieces land at the front while the trailer is still empty.
3. **Whatever floor is left over** (usually toward the rear) gets tall and wall cabinets **on their side**.
4. **Plywood over the deck**, then the upper layers.
5. **Face up is the last resort.** A cabinet is only laid doors-toward-the-ceiling when it won't go on its side or upright, and then it is *never* put on the floor. Uncheck **Allow face-up** in the header to refuse it outright.
6. **Last call on the doors.** Anything still without a home gets one more try, allowed to ride on a face-up cabinet — one piece per door bank, nothing above it, nothing heavy. See below.

A cabinet is only stood upright if the diagonal of its height × depth face, plus the stand-up margin, fits under the ceiling — that's the room the far corner needs to sweep as you tip it up.

Two more rules apply to every piece:

- **The snuggest spot wins.** Rather than taking the first position that fits, the packer looks at everything within a short window of the frontmost one and keeps whichever has the most contact with its neighbours, the walls and the deck under it. A piece that still ends up with air on *both* sides is marked **block it** on the manifest — the packer is telling you it could not wedge that one in, and the crew needs to shim or strap it.
- **Nothing can slide forward and drop.** A load shifts toward the nose under braking, so a piece off the floor has to either butt something ahead of it or sit on a deck that keeps running forward far enough to catch it if it moves.

The rules live in two places: `POSE_ORDER` and `packLoad()` in `cabinet-load-optimizer.html`, and `load-rules-v2.js`, which replaces the packing engine at run time. **`load-rules-v2.js` is the only add-on that changes how a load is packed** — the other three draw, arrange or report. Remove its `<script>` tag and the app falls straight back to the engine in the HTML.

## Checking the cross-section — the end views

The floorplan gives you length and width. The side elevations give you length and height. Neither one shows the cross-section, which is where a load actually runs out of room — so the plans include two more drawings, side by side, above the loading order:

- **Front view** — standing at the nose, looking back down the trailer. Draws the raised gooseneck deck where there is one.
- **Back view** — standing at the rear doors, looking forward. This is what you see the moment the doors open, so it's the one to check the finished load against.

Every piece in the trailer is drawn, in depth order: pieces nearest the end you're looking at are solid, pieces deeper into the load fade back. A cabinet number is printed **only where that cabinet still shows a face** — each box is sampled on a grid and samples covered by a nearer box are thrown out, so a number never floats over the box that's hiding it. Anything unnumbered is buried behind something in front of it, and each view reports how many of the pieces show a face from that end.

The back view overlays the **rear door opening in red dashes**, with the frame insets in grey. A cabinet can clear the interior and still foul the opening, and this is where that shows up. Wheel wells are drawn as dashed ghosts — they sit mid-trailer, not at either end.

**The two views are mirrored.** In the back view the left wall is on your left; in the front view you've turned around, so the same wall is on your right. Both drawings label the walls at the top corners. "Left wall" everywhere else in the app — including every measurement on the manifest — means your left standing at the rear doors looking forward.

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

## Tighter loads and restraint — load-rules-v2.js

This add-on replaces the packing engine. It deletes nothing: pull the `<script>` tag and you are back on the rules built into the HTML.

- **Tight packing.** The engine in the HTML takes the first spot that works, which is usually a grid position with air on both sides. This one scores every spot within a short window and keeps the snuggest.
- **Forward restraint.** Every piece off the floor has to be held against a shift toward the nose, as described above.
- **Wall cabinets ride upside down.** A wall cabinet's bottom is finished and its top is not, so one standing upright goes on its head, unfinished top to the deck. Same box, same space — it only changes what the printout tells the crew, which now reads *standing upright, upside down*.
- **One cabinet may ride on doors.** A face-up cabinet can carry exactly one piece; that piece carries nothing itself and has to cover at least 85% of the door bank, so the load spreads instead of point-loading a stile. Bases standing upright, and anything over roughly 16,000 cubic inches, stay off doors entirely. Once a bank has its one piece the airspace above it closes, so nothing can even overhang onto it. This is a deliberate loosening of the old nothing-on-doors rule, which was written to stop *several* layers landing on a door bank, not one.
- **A bay for the long talls,** as described above.

Measured on a real 83-piece job in a 28' gooseneck: 71 cabinets loaded became 79, the share of faces butted against something went from 55% to 64%, volume used went from 44% to 61%, and the number of pieces that could have slid forward off their deck went from 13 to zero.

Every constant is a dial in the `V2` block at the top of the file, reachable as `window.LOAD_RULES_V2` in the browser console, so you can re-run a real job and compare without editing anything. Two of them are judgement calls rather than measurements: `doorBulk` (16,000 cubic inches, roughly a wall cabinet) and `foreRun` (10 inches of deck ahead of a stacked piece).

## Notes

- Room/cabinet IDs come out as `R{room}C{cab}` (e.g. `R1C5`), matching Mozaik.
- Dimensions convert from Mozaik's internal millimeters to inches, rounded to the nearest 1/16".
- **Stack On** in the cabinet list controls whether a piece can carry a layer when it's loaded *upright*. Pieces on their side always can. A piece lying face up can carry one light piece and no more, and only as a last resort — see `load-rules-v2.js` below.
- Trailer profiles and header settings persist in `localStorage`, and also to `api/settings` if the copy you're running is served by something that provides it. Neither is required.

## Files

- `index.html` — a tiny redirect so the Pages root URL opens the app.
- `cabinet-load-optimizer.html` — the app itself: self-contained, with drag-drop `.db` import, spreadsheet/CSV import, manual entry, 3D + 2D views, the packing engine, and the printable manifest.
- `clo-utils.js` — context-safe text and attribute escaping shared by the browser UI and security tests.
- `manual-layout.js` — the Manual Layout tab: hand placement, pinning, 2D and 3D cabinet dragging, and undo/redo. Replaces `optimize()`, `showTab()`, `resize3D()` and `loadingOrderHTML()` at run time and decorates `draw3D()`, `renderCabs()` and `plansHTML()`. Deletes nothing.
- `drag-3d.js` — pointer hit-testing, OrbitControls handoff, world-plane projection, and the reusable 3D drag ghost.
- `load-learning.js` — the Tuning tab. Listens for the `clo:optimize` and `clo:edit` events that `manual-layout.js` announces on the document, and turns them into reviewable suggestions.
- `end-views.js` — the front and back end views described above. Decorates `plansHTML()` to splice the two cross-sections in above the loading order. Reads the finished load and draws it; touches nothing else.
- `load-rules-v2.js` — the packing engine itself: tighter placement, forward restraint, wall cabinets upside down, and one cabinet allowed on a door bank. Replaces `packLoad()`, `tryPlace()`, `canPlace()`, `makePoses()` and `isSupport()` at run time, and decorates `poseText()`. Deletes nothing. This is the only add-on that changes where cabinets end up.

The add-ons are all optional. Remove a `<script>` tag and that feature is gone; the app underneath is untouched.

### Script order

The add-ons load at the end of `<body>`, in this order — `load-learning.js` wraps `showTab()`, which `manual-layout.js` has already replaced, so it has to come second, and `load-rules-v2.js` goes last so its engine is the one left standing:

```html
<script src="manual-layout.js"></script>
<script src="load-learning.js"></script>
<script src="end-views.js"></script>
<script src="drag-3d.js"></script>
<script src="load-rules-v2.js"></script>
```

If you're serving a copy from somewhere that caches aggressively (a NAS, for instance), add a version query string when you update a file so browsers pick up the new one:

```html
<script src="manual-layout.js?v=3"></script>
<script src="load-learning.js?v=2"></script>
<script src="end-views.js?v=2"></script>
<script src="drag-3d.js?v=2"></script>
<script src="load-rules-v2.js?v=2"></script>
```
