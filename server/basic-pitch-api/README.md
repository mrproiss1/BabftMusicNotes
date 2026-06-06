# BABFT MP3 API

This optional backend lets the website use Spotify Basic Pitch for stronger MP3-to-MIDI transcription.

You do **not** need to run it on your PC. Deploy this folder to a cloud host, then paste the HTTPS API URL into the website's **MP3 API** field.

The Vercel website stays static. MP3 files go only to the API URL you choose when **Use MP3 API** is enabled.

## Best Setup

Use one of these:

- Render web service with Docker
- Fly.io app with Docker
- Hugging Face Docker Space
- Any VPS that can run Docker

Vercel is not a great fit for this backend because audio ML can be slow/heavy and needs Python model dependencies.

## Docker Deploy

This folder includes a `Dockerfile`.

Important environment variables:

```text
CORS_ORIGINS=https://babft-music-note.vercel.app,http://localhost:5173
RATE_LIMIT_PER_MINUTE=4
MAX_UPLOAD_MB=5
MAX_RETURNED_NOTES=20000
WEEKLY_UPLOAD_GB=7.5
PORT=8787
```

After deployment, test:

```text
https://YOUR-BACKEND-URL/health
```

Then put this in the website's API URL box:

```text
https://YOUR-BACKEND-URL
```

Use HTTPS for the cloud backend. Browsers can block a Vercel HTTPS website from calling a plain HTTP API.

## Render Notes

Create a new Web Service from this repo, use Docker, and set the root directory to:

```text
server/basic-pitch-api
```

Render supports deploying web services from repos or Docker images, and can build from a Dockerfile.

## Fly.io Notes

From this folder:

```powershell
fly launch --no-deploy
fly deploy
```

Fly can detect and deploy a Dockerfile.

## Hugging Face Notes

Create a Docker Space and upload/copy this folder's files. Hugging Face Docker Spaces are made for containerized AI apps, but free hardware can sleep or be slow.

## Local Test Only

You can still test locally if needed:

```powershell
cd server/basic-pitch-api
py -3.11 -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
uvicorn app:app --host 0.0.0.0 --port 8787
```

## Rate Limits

Defaults:

- `RATE_LIMIT_PER_MINUTE=4`
- `MAX_UPLOAD_MB=5`
- `MAX_RETURNED_NOTES=20000`
- `WEEKLY_UPLOAD_GB=7.5`

Lower those if too many people are using it. The weekly budget is stored server-side in `USAGE_LEDGER_PATH` and shows users: "Wait until next week" when it is reached.

## Privacy / Storage

The server writes each upload to a temporary folder, runs Basic Pitch, returns notes, then deletes the temporary folder. It does not keep MP3 files or MIDI output.

Sources:

- Spotify Basic Pitch: https://github.com/spotify/basic-pitch
- Render Docker docs: https://render.com/docs/docker
- Fly Dockerfile docs: https://fly.io/docs/languages-and-frameworks/dockerfile/
- Hugging Face Docker Spaces docs: https://huggingface.co/docs/hub/main/en/spaces-sdks-docker
