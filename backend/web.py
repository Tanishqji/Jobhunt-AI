"""FastAPI Web Server for JobHunt Dashboard."""
from __future__ import annotations

import asyncio
import json
import os
import subprocess
import sys
from pathlib import Path
from typing import Any, Optional

import yaml
from fastapi import FastAPI, HTTPException, BackgroundTasks, Form, File, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from .fetch import fetch_board
from .store import Store

ROOT = Path(__file__).resolve().parent.parent
BACKEND_DIR = ROOT / "backend"
AI_DIR = ROOT / "ai"
FRONTEND_DIR = ROOT / "frontend"
WEB_DIR = FRONTEND_DIR


def _find_file(filename: str, candidates: list[Path]) -> Path:
    for c in candidates:
        if c.exists():
            return c
    return candidates[0]


app = FastAPI(title="JobHunt Agent Dashboard", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Global execution state for running crawler jobs
run_state = {
    "is_running": False,
    "last_run": None,
    "logs": "",
    "exit_code": None,
}


def _cfg(path: str = "config.yaml") -> dict:
    p = _find_file(str(path), [BACKEND_DIR / path, ROOT / path])
    if not p.exists():
        return {}
    return yaml.safe_load(p.read_text(encoding="utf-8")) or {}


def _save_cfg(data: dict, path: str = "config.yaml") -> None:
    p = _find_file(str(path), [BACKEND_DIR / path, ROOT / path])
    p.write_text(yaml.safe_dump(data, sort_keys=False, allow_unicode=True), encoding="utf-8")


def _update_env(key: str, value: str) -> None:
    env_path = _find_file(".env", [BACKEND_DIR / ".env", ROOT / ".env"])
    if not env_path.exists():
        env_path.write_text(f"{key}={value}\n", encoding="utf-8")
        os.environ[key] = value
        return
    lines = env_path.read_text(encoding="utf-8").splitlines()
    found = False
    new_lines = []
    for line in lines:
        if line.strip().startswith(f"{key}="):
            new_lines.append(f"{key}={value}")
            found = True
        else:
            new_lines.append(line)
    if not found:
        new_lines.append(f"{key}={value}")
    env_path.write_text("\n".join(new_lines) + "\n", encoding="utf-8")
    os.environ[key] = value


@app.get("/api/stats")
def get_stats():
    cfg = _cfg()
    seen_path = _find_file(cfg.get("seen_file", "seen.json"), [BACKEND_DIR / "seen.json", ROOT / "seen.json"])
    store = Store(seen_path)
    stats = store.stats()

    companies_path = _find_file(cfg.get("companies_file", "companies.yaml"), [BACKEND_DIR / "companies.yaml", ROOT / "companies.yaml"])
    companies_count = 0
    if companies_path.exists():
        comp_data = yaml.safe_load(companies_path.read_text(encoding="utf-8")) or {}
        companies_count = len(comp_data.get("companies", []))

    # Calculate average score of tracked jobs
    scores = [v.get("score") for v in store.data.values() if v.get("score") is not None]
    avg_score = round(sum(scores) / len(scores), 1) if scores else 0.0

    return {
        "tracked": stats["tracked"],
        "emailed": stats["emailed"],
        "applied": stats["applied"],
        "companies_monitored": companies_count,
        "avg_score": avg_score,
        "is_running": run_state["is_running"],
        "last_run": run_state["last_run"],
    }


@app.get("/api/jobs")
def get_jobs(search: Optional[str] = None, filter_applied: Optional[str] = "all", min_score: Optional[float] = 0.0):
    cfg = _cfg()
    seen_path = _find_file(cfg.get("seen_file", "seen.json"), [BACKEND_DIR / "seen.json", ROOT / "seen.json"])
    store = Store(seen_path)

    items = []
    for jid, d in store.data.items():
        score = d.get("score") or 0.0
        if score < min_score:
            continue
        applied = bool(d.get("applied", False))
        if filter_applied == "applied" and not applied:
            continue
        if filter_applied == "unapplied" and applied:
            continue

        title = d.get("title", "")
        company = d.get("company", "")
        location = d.get("location", "")
        reason = d.get("reason", "")

        if search:
            q = search.lower()
            text = f"{title} {company} {location} {reason}".lower()
            if q not in text:
                continue

        items.append({
            "job_id": jid,
            "company": company,
            "title": title,
            "location": location,
            "url": d.get("url", ""),
            "score": score,
            "reason": reason,
            "emailed": bool(d.get("emailed", False)),
            "applied": applied,
            "applied_on": d.get("applied_on"),
            "first_seen": d.get("first_seen"),
        })

    # Sort primarily by score descending, then by first_seen descending
    items.sort(key=lambda x: (x["score"], x.get("first_seen") or ""), reverse=True)
    return {"jobs": items, "total": len(items)}


@app.post("/api/jobs/{job_id:path}/apply")
def toggle_applied(job_id: str):
    cfg = _cfg()
    seen_path = _find_file(cfg.get("seen_file", "seen.json"), [BACKEND_DIR / "seen.json", ROOT / "seen.json"])
    store = Store(seen_path)

    if job_id not in store.data:
        raise HTTPException(status_code=404, detail="Job not found")

    cur = store.data[job_id].get("applied", False)
    new_state = not cur
    store.data[job_id]["applied"] = new_state
    if new_state:
        from datetime import datetime, timezone
        store.data[job_id]["applied_on"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
    else:
        store.data[job_id]["applied_on"] = None

    store.save()
    store.export_csv(ROOT / cfg.get("tracker_csv", "out/tracker.csv"))
    return {"job_id": job_id, "applied": new_state}


@app.get("/api/companies")
def get_companies():
    cfg = _cfg()
    p = _find_file(cfg.get("companies_file", "companies.yaml"), [BACKEND_DIR / "companies.yaml", ROOT / "companies.yaml"])
    if not p.exists():
        return {"companies": []}
    data = yaml.safe_load(p.read_text(encoding="utf-8")) or {}
    return {"companies": data.get("companies", [])}


class CompanyAddRequest(BaseModel):
    ats: str
    slug: str
    name: str


@app.post("/api/companies")
def add_company(req: CompanyAddRequest):
    ats = req.ats.lower().strip()
    slug = req.slug.strip()
    name = req.name.strip()

    if ats not in ("greenhouse", "lever", "ashby"):
        raise HTTPException(status_code=400, detail="Invalid ATS. Must be greenhouse, lever, or ashby")

    # Validate live board
    try:
        jobs = fetch_board(ats, slug, name)
        job_count = len(jobs)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Failed to fetch career board: {e}")

    cfg = _cfg()
    p = _find_file(cfg.get("companies_file", "companies.yaml"), [BACKEND_DIR / "companies.yaml", ROOT / "companies.yaml"])
    data = yaml.safe_load(p.read_text(encoding="utf-8")) if p.exists() else {"companies": []}
    comps = data.get("companies", [])

    # Check for duplicates
    for c in comps:
        if c.get("ats") == ats and c.get("slug") == slug:
            return {"message": "Company already exists", "companies": comps, "active_jobs": job_count}

    comps.append({"ats": ats, "slug": slug, "name": name})
    data["companies"] = comps
    p.write_text(yaml.safe_dump(data, sort_keys=False, allow_unicode=True), encoding="utf-8")

    return {"message": "Company added", "companies": comps, "active_jobs": job_count}


@app.delete("/api/companies/{ats}/{slug}")
def delete_company(ats: str, slug: str):
    cfg = _cfg()
    p = _find_file(cfg.get("companies_file", "companies.yaml"), [BACKEND_DIR / "companies.yaml", ROOT / "companies.yaml"])
    if not p.exists():
        raise HTTPException(status_code=404, detail="companies.yaml not found")
    data = yaml.safe_load(p.read_text(encoding="utf-8")) or {}
    comps = data.get("companies", [])
    new_comps = [c for c in comps if not (c.get("ats") == ats and c.get("slug") == slug)]
    data["companies"] = new_comps
    p.write_text(yaml.safe_dump(data, sort_keys=False, allow_unicode=True), encoding="utf-8")
    return {"message": "Company removed", "companies": new_comps}


@app.get("/api/profile")
def get_profile():
    cfg = _cfg()
    p = _find_file(cfg.get("profile_file", "profile.json"), [AI_DIR / "profile.json", ROOT / "profile.json"])
    if not p.exists():
        return {}
    return json.loads(p.read_text(encoding="utf-8"))


@app.post("/api/profile")
def update_profile(data: dict):
    cfg = _cfg()
    p = _find_file(cfg.get("profile_file", "profile.json"), [AI_DIR / "profile.json", ROOT / "profile.json"])
    p.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")
    return {"message": "Profile updated successfully"}


@app.get("/api/config")
def get_config():
    return _cfg()


@app.post("/api/config")
def update_config(data: dict):
    _save_cfg(data)
    return {"message": "Config updated successfully"}


@app.get("/api/digest")
def get_digest():
    p = ROOT / "out" / "digest.html"
    if not p.exists():
        return HTMLResponse("<p style='color:#fff;font-family:sans-serif;'>No digest generated yet.</p>")
    return HTMLResponse(p.read_text(encoding="utf-8"))


class RunRequest(BaseModel):
    send: bool = False
    no_draft: bool = False
    mock: bool = False
    limit: Optional[int] = None
    scorer: Optional[str] = "llm"


def _execute_run_worker(cmd: list[str]):
    global run_state
    from datetime import datetime, timezone
    run_state["is_running"] = True
    run_state["logs"] = f"Started pipeline run: {' '.join(cmd)}\n\n"
    run_state["exit_code"] = None

    try:
        proc = subprocess.Popen(
            cmd,
            cwd=str(ROOT),
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            bufsize=1,
            universal_newlines=True,
        )
        for line in iter(proc.stdout.readline, ""):
            run_state["logs"] += line
        proc.stdout.close()
        proc.wait()
        run_state["exit_code"] = proc.returncode
    except Exception as e:
        run_state["logs"] += f"\nError executing process: {e}\n"
        run_state["exit_code"] = 1
    finally:
        run_state["is_running"] = False
        run_state["last_run"] = datetime.now(timezone.utc).isoformat(timespec="seconds")


@app.post("/api/run")
def trigger_run(req: RunRequest, background_tasks: BackgroundTasks):
    global run_state
    if run_state["is_running"]:
        raise HTTPException(status_code=409, detail="A job scan is already running")

    # Path to Python executable in virtual environment if available
    py_exe = sys.executable
    cmd = [py_exe, "-m", "backend", "run"]
    if req.mock:
        cmd.append("--mock")
    if req.scorer and req.scorer != "llm":
        cmd.extend(["--scorer", req.scorer])
    if req.no_draft:
        cmd.append("--no-draft")
    if req.send:
        cmd.append("--send")
    if req.limit:
        cmd.extend(["--limit", str(req.limit)])

    background_tasks.add_task(_execute_run_worker, cmd)
    return {"message": "Pipeline scan launched", "command": " ".join(cmd)}


@app.get("/api/run/status")
def get_run_status():
    return run_state


@app.post("/api/onboard")
async def onboard_user(
    background_tasks: BackgroundTasks,
    full_name: str = Form(...),
    email: str = Form(...),
    positions: str = Form(...),
    locations: str = Form(...),
    resume_file: Optional[UploadFile] = File(None),
    resume_text: Optional[str] = Form(None),
    auto_scan: bool = Form(True),
):
    full_name = full_name.strip()
    email = email.strip()
    pos_list = [p.strip() for p in positions.split(",") if p.strip()]
    loc_list = [l.strip().lower() for l in locations.split(",") if l.strip()]

    # 1. Update Profile
    prof_path = _find_file("profile.json", [AI_DIR / "profile.json", ROOT / "profile.json"])
    profile = {}
    if prof_path.exists():
        try:
            profile = json.loads(prof_path.read_text(encoding="utf-8"))
        except Exception:
            profile = {}
    profile["name"] = full_name
    profile["target_titles"] = pos_list if pos_list else profile.get("target_titles", ["Software Engineer"])
    
    # Save uploaded resume if provided
    if resume_file and resume_file.filename:
        save_path = ROOT / "resume.pdf"
        contents = await resume_file.read()
        save_path.write_bytes(contents)

    prof_path.write_text(json.dumps(profile, indent=2, ensure_ascii=False), encoding="utf-8")

    # 2. Update Config Filters
    cfg = _cfg()
    filters = cfg.get("filters", {}) or {}
    
    has_remote = "remote" in loc_list or any("remote" in l for l in loc_list)
    clean_locs = [l for l in loc_list if "remote" not in l]
    if clean_locs:
        filters["locations"] = clean_locs
    if has_remote or bool(filters.get("allow_remote", True)):
        filters["allow_remote"] = True

    # Add positions into include_titles
    inc = filters.get("include_titles", [])
    for pos in pos_list:
        clean_pos = pos.lower()
        if clean_pos not in inc:
            inc.insert(0, clean_pos)
    filters["include_titles"] = inc
    cfg["filters"] = filters
    _save_cfg(cfg)

    # 3. Update Email Target
    _update_env("MAIL_TO", email)

    # 4. Reset seen.json if requested to allow immediate fresh screening
    seen_path = _find_file(cfg.get("seen_file", "seen.json"), [BACKEND_DIR / "seen.json", ROOT / "seen.json"])
    seen_path.write_text("{}", encoding="utf-8")

    # 5. Launch scan in background if requested
    if auto_scan:
        py_exe = sys.executable
        cmd = [py_exe, "-m", "backend", "run", "--send"]
        background_tasks.add_task(_execute_run_worker, cmd)

    return {
        "status": "success",
        "message": f"Welcome {full_name}! Preferences saved and scanning initiated.",
        "name": full_name,
        "email": email,
        "positions": pos_list,
        "locations": loc_list,
        "auto_scan": auto_scan,
    }


# Serve static web files from ROOT / "web"
if WEB_DIR.exists():
    app.mount("/", StaticFiles(directory=str(WEB_DIR), html=True), name="static")
