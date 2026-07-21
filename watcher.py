"""
Mozaik JobData.db watcher + REST API for the Cabinet Load Optimizer.

- Watches JOBS_DIR recursively for JobData.db create/modify events
- Extracts CabinetTable/RoomTable/JobTable into an in-memory + on-disk cache
- Serves:
    GET /api/jobs                      -> list of jobs (name, customer, updated, cabinet count)
    GET /api/jobs/{job}/cabinets       -> extracted cabinet list (inches)
    GET /                              -> the load optimizer web app (static)
"""
import os, json, time, sqlite3, shutil, tempfile, threading
from pathlib import Path
from datetime import datetime

from flask import Flask, jsonify, send_from_directory, abort
from watchdog.observers.polling import PollingObserver
from watchdog.events import FileSystemEventHandler

JOBS_DIR = Path(os.environ.get("JOBS_DIR", "/data/Jobs"))
CACHE_FILE = Path(os.environ.get("CACHE_FILE", "/cache/jobs_cache.json"))
DEBOUNCE_SECONDS = 3
MM_TO_IN = 1 / 25.4

app = Flask(__name__, static_folder=".", static_url_path="")
cache = {}          # job_name -> {meta..., cabinets: [...]}
cache_lock = threading.Lock()
pending = {}        # path -> timer

def frac(v):
    """Round to nearest 1/16 inch."""
    return round(v * 16) / 16

def extract_job(db_path: Path):
    """Read a Mozaik JobData.db and return job dict, or None on failure."""
    # copy to temp first: Mozaik may hold the file open / mid-write
    tmp = Path(tempfile.mkstemp(suffix=".db")[1])
    try:
        shutil.copy2(db_path, tmp)
        con = sqlite3.connect(f"file:{tmp}?mode=ro", uri=True)
        con.row_factory = sqlite3.Row
        try:
            job_row = con.execute("SELECT * FROM JobTable LIMIT 1").fetchone()
        except sqlite3.Error:
            job_row = None
        rooms = {}
        try:
            for r in con.execute("SELECT * FROM RoomTable"):
                rooms[r["ID"]] = {"name": r["roomName"], "num": r["Room."]}
        except sqlite3.Error:
            pass
        cabinets = []
        for r in con.execute(
            'SELECT Room, [Cab.] AS cab, cabName, Type, W, H, D, quan, finEnds '
            'FROM CabinetTable'
        ):
            room = rooms.get(r["Room"], {"name": f"Room {r['Room']}", "num": r["Room"]})
            w = frac((r["W"] or 0) * MM_TO_IN)
            h = frac((r["H"] or 0) * MM_TO_IN)
            d = frac((r["D"] or 0) * MM_TO_IN)
            if w <= 0 or h <= 0 or d <= 0:
                continue
            cabinets.append({
                "rc": f"R{room['num']}C{r['cab']}",
                "room": room["name"],
                "roomNum": room["num"],
                "cabNum": str(r["cab"]),
                "name": r["cabName"] or "Cabinet",
                "type": r["Type"] or "Cabinet",
                "w": w, "h": h, "d": d,
                "quan": int(r["quan"] or 1),
                "finEnds": r["finEnds"],
                # heuristic: base/short cabinets are stackable, tall units are not
                "stackable": h <= 50 and "tall" not in (r["cabName"] or "").lower(),
            })
        con.close()
        folder = db_path.parent
        return {
            "job": folder.name,
            "jobName": (job_row["JobName"] if job_row else folder.name) or folder.name,
            "customer": (job_row["Customer"] if job_row else "") or "",
            "path": str(db_path),
            "updated": datetime.fromtimestamp(db_path.stat().st_mtime).isoformat(timespec="seconds"),
            "cabinetCount": len(cabinets),
            "cabinets": cabinets,
        }
    except Exception as e:
        print(f"[extract] FAILED {db_path}: {e}", flush=True)
        return None
    finally:
        tmp.unlink(missing_ok=True)

def save_cache():
    CACHE_FILE.parent.mkdir(parents=True, exist_ok=True)
    with cache_lock:
        CACHE_FILE.write_text(json.dumps(cache))

def process_db(path: Path):
    job = extract_job(path)
    if job:
        with cache_lock:
            cache[job["job"]] = job
        save_cache()
        print(f"[watch] updated: {job['job']} ({job['cabinetCount']} cabinets)", flush=True)

def schedule(path: Path):
    """Debounce: wait for Mozaik to finish writing."""
    key = str(path)
    if key in pending:
        pending[key].cancel()
    t = threading.Timer(DEBOUNCE_SECONDS, lambda: (pending.pop(key, None), process_db(path)))
    pending[key] = t
    t.start()

class Handler(FileSystemEventHandler):
    def _maybe(self, p):
        if p and Path(p).name.lower() == "jobdata.db":
            schedule(Path(p))
    def on_created(self, e):  self._maybe(e.src_path)
    def on_modified(self, e): self._maybe(e.src_path)
    def on_moved(self, e):    self._maybe(e.dest_path)

def initial_scan():
    print(f"[scan] scanning {JOBS_DIR} ...", flush=True)
    for db in JOBS_DIR.rglob("JobData.db"):
        process_db(db)
    print(f"[scan] done, {len(cache)} jobs indexed", flush=True)

# ---------- API ----------
@app.get("/api/jobs")
def list_jobs():
    with cache_lock:
        return jsonify(sorted(
            [{k: v[k] for k in ("job", "jobName", "customer", "updated", "cabinetCount")}
             for v in cache.values()],
            key=lambda j: j["updated"], reverse=True))

@app.get("/api/jobs/<job>/cabinets")
def job_cabinets(job):
    with cache_lock:
        j = cache.get(job)
    if not j:
        abort(404)
    return jsonify(j)

@app.get("/")
def index():
    return send_from_directory(".", "index.html")

if __name__ == "__main__":
    if CACHE_FILE.exists():
        try:
            cache.update(json.loads(CACHE_FILE.read_text()))
            print(f"[cache] loaded {len(cache)} jobs", flush=True)
        except Exception:
            pass
    threading.Thread(target=initial_scan, daemon=True).start()
    # PollingObserver: reliable on SMB/btrfs shares where inotify can miss events
    obs = PollingObserver(timeout=10)
    obs.schedule(Handler(), str(JOBS_DIR), recursive=True)
    obs.start()
    app.run(host="0.0.0.0", port=8085)
