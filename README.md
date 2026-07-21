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

## Manual upload
If a job isn't on the watched share — a `JobData.db` emailed to you, one from a
USB stick, or a folder outside `/volume1/Mozaik-UW/Jobs` — use the
**Upload JobData.db** box in the Mozaik Job panel. Click it or drag the file on,
and the cabinets import immediately using the exact same extraction as the
watcher.

Uploaded jobs are marked with `⬆` in the job picker, persist in the cache across
restarts, and can be removed with the **Remove** link. Re-uploading the same job
replaces it instead of creating a duplicate. Max upload size is 64 MB
(override with the `MAX_UPLOAD_MB` env var).

## API
- `GET /api/jobs` — all jobs, newest first
- `GET /api/jobs/<folder-name>/cabinets` — full cabinet list in inches
- `POST /api/upload` — manually upload a `JobData.db` (multipart field `file`);
  returns the extracted job, same shape as the endpoint above
- `DELETE /api/jobs/<job>` — remove a manually uploaded job (watched jobs are
  read-only and cannot be deleted)

## Notes
- Dimensions are converted from Mozaik's internal millimeters to inches,
  rounded to the nearest 1/16".
- Room/cabinet IDs come out as `R{room}C{cab}` (e.g. R1C5) matching Mozaik.
- Stackable heuristic: height ≤ 50" and not named "Tall". Adjust per-item in
  the app if needed.
- Verified against your Mandabach (David) job: 9 cabinets extracted correctly
  (34.5" bases, 94.25" tall unit, 36×36 susan).
