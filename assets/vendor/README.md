# Vendored browser dependencies

These files are committed so the static app remains deterministic and usable on
an offline/NAS deployment. Update them deliberately and review the resulting
diff/hash rather than loading mutable production assets from a CDN.

| File | Upstream | Version/snapshot | License |
|---|---|---|---|
| `tailwindcss-play-2026-08-14.js` | https://cdn.tailwindcss.com | Snapshot downloaded 2026-08-14 | MIT |
| `three-r128.min.js` | https://github.com/mrdoob/three.js | r128 | MIT |
| `OrbitControls-r128.js` | https://github.com/mrdoob/three.js | r128 | MIT |
| `sql-wasm-1.10.3.js` / `.wasm` | https://github.com/sql-js/sql.js | 1.10.3 | MIT |

