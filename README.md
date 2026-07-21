# Cabinet Load Optimizer — Mozaik Auto-Import (Synology RS3621xs+)

Watches `/volume1/Mozaik-UW/Jobs` for new/updated `JobData.db` files, extracts the
cabinet list automatically (mm → inches), and serves the load optimizer web app
with a job picker. Open the app, pick the job, pick a trailer, hit Calculate.

## Deploy (Container Manager on DSM)

1. Copy this whole folder to the NAS, e.g. `/volume1/docker/load-optimizer/`
2. In DSM: **Container Manager → Project → Create**
   - Project name: `load-optimizer`
   - Path: `/volume1/docker/load-optimizer`
   - Source: use the included `docker-compose.yml`
3. Build & start. The app is then available at `http://<NAS-IP>:8085`

Or via SSH:
```bash
cd /volume1/docker/load-optimizer
sudo docker compose up -d --build
```

## How it works
- On startup it scans every job folder and indexes all `JobData.db` files.
- A polling watcher (reliable on Synology/SMB shares) detects new saves within
  ~10 seconds; a 3-second debounce ensures Mozaik has finished writing.
- Each db is copied to a temp file before reading, so a Mozaik export in
  progress can never corrupt a read.
- The Jobs share is mounted **read-only** — the container can never touch your
  Mozaik data.
- Extracted job lists are cached in `./cache/` so restarts are instant.

## API
- `GET /api/jobs` — all jobs, newest first
- `GET /api/jobs/<folder-name>/cabinets` — full cabinet list in inches

## Notes
- Dimensions are converted from Mozaik's internal millimeters to inches,
  rounded to the nearest 1/16".
- Room/cabinet IDs come out as `R{room}C{cab}` (e.g. R1C5) matching Mozaik.
- Stackable heuristic: height ≤ 50" and not named "Tall". Adjust per-item in
  the app if needed.
- Verified against your Mandabach (David) job: 9 cabinets extracted correctly
  (34.5" bases, 94.25" tall unit, 36×36 susan).
