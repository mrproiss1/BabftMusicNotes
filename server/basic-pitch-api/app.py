import os
import pathlib
import json
import tempfile
import time
import threading
from datetime import datetime, timezone
from collections import defaultdict, deque
from typing import Any

from fastapi import FastAPI, File, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from starlette.concurrency import run_in_threadpool

from basic_pitch import ICASSP_2022_MODEL_PATH
from basic_pitch.inference import Model, predict


MAX_UPLOAD_MB = int(os.getenv("MAX_UPLOAD_MB", "5"))
RATE_LIMIT_PER_MINUTE = int(os.getenv("RATE_LIMIT_PER_MINUTE", "4"))
MAX_RETURNED_NOTES = int(os.getenv("MAX_RETURNED_NOTES", "20000"))
WEEKLY_UPLOAD_GB = float(os.getenv("WEEKLY_UPLOAD_GB", "7.5"))
WEEKLY_UPLOAD_BYTES = int(WEEKLY_UPLOAD_GB * 1024 * 1024 * 1024)
USAGE_LEDGER_PATH = pathlib.Path(os.getenv("USAGE_LEDGER_PATH", "/tmp/babft-mp3-api-usage.json"))
ALLOWED_EXTENSIONS = {".mp3", ".wav", ".flac", ".ogg", ".m4a"}
DEFAULT_CORS_ORIGINS = "http://localhost:5173,https://babft-music-note.vercel.app"

app = FastAPI(title="BABFT Basic Pitch API")
request_log: dict[str, deque[float]] = defaultdict(deque)
basic_pitch_model: Model | None = None
usage_lock = threading.Lock()


def cors_origins() -> list[str]:
  raw = os.getenv("CORS_ORIGINS", DEFAULT_CORS_ORIGINS).strip()
  if raw == "*":
    return ["*"]
  return [origin.strip() for origin in raw.split(",") if origin.strip()]


app.add_middleware(
  CORSMiddleware,
  allow_origins=cors_origins(),
  allow_credentials=False,
  allow_methods=["GET", "POST", "OPTIONS"],
  allow_headers=["*"],
)


def client_ip(request: Request) -> str:
  forwarded_for = request.headers.get("x-forwarded-for", "")
  if forwarded_for:
    return forwarded_for.split(",")[0].strip()
  return request.client.host if request.client else "unknown"


def check_rate_limit(ip_address: str) -> None:
  now = time.monotonic()
  window_start = now - 60
  log = request_log[ip_address]

  while log and log[0] < window_start:
    log.popleft()

  if len(log) >= RATE_LIMIT_PER_MINUTE:
    raise HTTPException(
      status_code=429,
      detail=f"Rate limit hit. Try again later. Limit: {RATE_LIMIT_PER_MINUTE} MP3 conversions per minute.",
    )

  log.append(now)


def current_week_key() -> str:
  year, week, _weekday = datetime.now(timezone.utc).isocalendar()
  return f"{year}-W{week:02d}"


def load_usage_ledger() -> dict[str, Any]:
  try:
    return json.loads(USAGE_LEDGER_PATH.read_text(encoding="utf-8"))
  except (FileNotFoundError, json.JSONDecodeError):
    return {}


def save_usage_ledger(ledger: dict[str, Any]) -> None:
  USAGE_LEDGER_PATH.parent.mkdir(parents=True, exist_ok=True)
  USAGE_LEDGER_PATH.write_text(json.dumps(ledger), encoding="utf-8")


def reserve_weekly_upload_budget(byte_count: int) -> None:
  if WEEKLY_UPLOAD_BYTES <= 0:
    return

  week_key = current_week_key()
  with usage_lock:
    ledger = load_usage_ledger()
    if ledger.get("week") != week_key:
      ledger = {"week": week_key, "usedBytes": 0}

    used_bytes = int(ledger.get("usedBytes", 0))
    if used_bytes + byte_count > WEEKLY_UPLOAD_BYTES:
      raise HTTPException(
        status_code=429,
        detail=f"Weekly MP3 budget reached ({WEEKLY_UPLOAD_GB:g} GB). Wait until next week for it to reset.",
      )

    ledger["usedBytes"] = used_bytes + byte_count
    save_usage_ledger(ledger)


def get_model() -> Model:
  global basic_pitch_model
  if basic_pitch_model is None:
    basic_pitch_model = Model(ICASSP_2022_MODEL_PATH)
  return basic_pitch_model


def note_event_to_json(event: Any) -> dict[str, float | int]:
  start, end, midi, amplitude, *_ = event
  duration = max(0.05, float(end) - float(start))
  return {
    "start": round(float(start), 4),
    "end": round(float(end), 4),
    "duration": round(duration, 4),
    "midi": int(midi),
    "velocity": max(0.05, min(1.0, float(amplitude))),
  }


def transcribe_file(path: pathlib.Path) -> list[dict[str, float | int]]:
  _model_output, _midi_data, note_events = predict(str(path), get_model())
  return [note_event_to_json(event) for event in note_events[:MAX_RETURNED_NOTES]]


@app.get("/health")
def health() -> dict[str, str | int]:
  return {
    "status": "ok",
    "model": "spotify/basic-pitch",
    "rateLimitPerMinute": RATE_LIMIT_PER_MINUTE,
    "maxUploadMb": MAX_UPLOAD_MB,
    "maxReturnedNotes": MAX_RETURNED_NOTES,
    "weeklyUploadGb": WEEKLY_UPLOAD_GB,
  }


@app.post("/transcribe")
async def transcribe(request: Request, file: UploadFile = File(...)) -> dict[str, Any]:
  check_rate_limit(client_ip(request))

  filename = file.filename or "song.mp3"
  extension = pathlib.Path(filename).suffix.lower()
  if extension not in ALLOWED_EXTENSIONS:
    raise HTTPException(
      status_code=400,
      detail="Upload an MP3, WAV, FLAC, OGG, or M4A file.",
    )

  max_bytes = MAX_UPLOAD_MB * 1024 * 1024
  total_bytes = 0

  with tempfile.TemporaryDirectory(prefix="babft-basic-pitch-") as temp_dir:
    input_path = pathlib.Path(temp_dir) / f"input{extension}"
    with input_path.open("wb") as output:
      while True:
        chunk = await file.read(1024 * 1024)
        if not chunk:
          break
        total_bytes += len(chunk)
        if total_bytes > max_bytes:
          raise HTTPException(
            status_code=413,
            detail=f"File is too large. Max upload is {MAX_UPLOAD_MB} MB.",
          )
        reserve_weekly_upload_budget(len(chunk))
        output.write(chunk)

    notes = await run_in_threadpool(transcribe_file, input_path)

  return {
    "notes": notes,
    "meta": {
      "model": "spotify/basic-pitch",
      "bytes": total_bytes,
      "notesReturned": len(notes),
      "notesCapped": len(notes) >= MAX_RETURNED_NOTES,
      "rateLimitPerMinute": RATE_LIMIT_PER_MINUTE,
      "maxUploadMb": MAX_UPLOAD_MB,
      "weeklyUploadGb": WEEKLY_UPLOAD_GB,
    },
  }
