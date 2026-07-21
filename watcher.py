"""
Mozaik JobData.db watcher + REST API for the Cabinet Load Optimizer.

- Watches JOBS_DIR recursively for JobData.db create/modify events
- Extracts CabinetTable/RoomTable/JobTable into an in-memory + on-disk cache
- Serves:
    GET    /api/jobs                   -> list of jobs (name, customer, updated, cabinet count)
    GET    /api/jobs/{job}/cabinets    -> extracted cabinet list (inches)
    POST   /api/upload                 -> manually upload a JobData.db (multipart field "file")
    DELETE /api/jobs/{job}             -> remove a manually uploaded job from the picker
    GET    /                           -> the load optimizer web app (static)
"""
import os, re, json, time, sqlite3, shutil, tempfile, threading
from pathlib import Path
from datetime import datetime

from flask import Flask, jsonify, send_from_directory, abort, request
from watchdog.observers.polling import PollingObserver
from watchdog.events import FileSystemEventHandler

JOBS_DIR = Path(os.environ.get("JOBS_DIR", "/data/Jobs"))
CACHE_FILE = Path(os.environ.get("CACHE_FILE", "/cache/jobs_cache.json"))
DEBOUNCE_SECONDS = 3
MM_TO_IN = 1 / 25.4
MAX_UPLOAD_MB = int(os.environ.get("MAX_UPLOAD_MB", "64"))

app = Flask(__name__, static_folder=".", static_url_path="")
app.config["MAX_CONTENT_LENGTH"] = MAX_UPLOAD_MB * 1024 * 1024
cache = {}          # job_name -> {meta..., cabinets: [...]}
cache_lock = threading.Lock()
pending = {}        # path -> timer

def frac(v):
    """Round to nearest 1/16 inch."""
    return round(v * 16) / 16

def slug(name: str) -> str:
    """Filesystem/URL-safe key for a job."""
    return re.sub(r"[^A-Za-z0-9._-]+", "-", (name or "").strip()).strip("-") or "job"


def extract_job(db_path: Path, job_key: str = None, job_label: str = None,
                updated: str = None, source: str = "watched"):
    """Read a Mozaik JobData.db and return job dict, or None on failure.

    job_key / job_label / updated override the values normally derived from the
    file's folder + mtime (used by the manual-upload endpoint, where the file
    lives in a temp dir and has no meaningful folder name).
    """
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
        fallback = job_label or folder.name
        return {
            "job": job_key or folder.name,
            "jobName": (job_row["JobName"] if job_row else fallback) or fallback,
            "customer": (job_row["Customer"] if job_row else "") or "",
            "path": str(db_path),
            "updated": updated or datetime.fromtimestamp(
                db_path.stat().st_mtime).isoformat(timespec="seconds"),
            "cabinetCount": len(cabinets),
            "cabinets": cabinets,
            "source": source,
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
            [{**{k: v[k] for k in ("job", "jobName", "customer", "updated", "cabinetCount")},
              "source": v.get("source", "watched")}
             for v in cache.values()],
            key=lambda j: j["updated"], reverse=True))

@app.get("/api/jobs/<job>/cabinets")
def job_cabinets(job):
    with cache_lock:
        j = cache.get(job)
    if not j:
        abort(404)
    return jsonify(j)

@app.post("/api/upload")
def upload_job():
    """Manually upload a Mozaik JobData.db and import its cabinets.

    multipart/form-data, field "file". Returns the same shape as
    /api/jobs/<job>/cabinets so the client can load it immediately.
    """
    f = request.files.get("file")
    if f is None or not f.filename:
        return jsonify(error='No file received. Use multipart field "file".'), 400

    tmp_dir = Path(tempfile.mkdtemp(prefix="upload-"))
    tmp = tmp_dir / "JobData.db"
    try:
        f.save(tmp)

        # Reject anything that isn't actually a SQLite database up front,
        # so the user gets a clear message instead of a parse error.
        with open(tmp, "rb") as fh:
            if fh.read(16) != b"SQLite format 3\x00":
                return jsonify(
                    error="That file is not a SQLite database. Pick the "
                          "JobData.db from the Mozaik job folder."), 400

        label = Path(f.filename).stem
        if label.lower() in ("jobdata", "job data"):
            label = "Uploaded job"

        job = extract_job(
            tmp,
            job_key=None,          # filled in below, once we know the job name
            job_label=label,
            updated=datetime.now().isoformat(timespec="seconds"),
            source="upload",
        )
        if job is None:
            return jsonify(
                error="Could not read that database. It may be corrupt or not "
                      "a Mozaik JobData.db."), 400
        if not job["cabinets"]:
            return jsonify(
                error="No cabinets found in that database. Make sure the job "
                      "was saved in Mozaik before exporting."), 400

        # Key it by job name so re-uploading the same job replaces it rather
        # than piling up duplicates in the picker.
        job["job"] = "upload-" + slug(job["jobName"])
        job["path"] = f"(uploaded: {f.filename})"

        with cache_lock:
            cache[job["job"]] = job
        save_cache()
        print(f"[upload] {job['jobName']} ({job['cabinetCount']} cabinets)", flush=True)
        return jsonify(job)
    finally:
        shutil.rmtree(tmp_dir, ignore_errors=True)


@app.errorhandler(413)
def too_large(_e):
    return jsonify(error=f"File too large (limit {MAX_UPLOAD_MB} MB)."), 413


@app.delete("/api/jobs/<job>")
def delete_job(job):
    """Remove a manually uploaded job. Watched jobs cannot be deleted here."""
    with cache_lock:
        j = cache.get(job)
        if not j:
            abort(404)
        if j.get("source") != "upload":
            return jsonify(error="Only uploaded jobs can be removed."), 400
        cache.pop(job, None)
    save_cache()
    return jsonify(ok=True)


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
