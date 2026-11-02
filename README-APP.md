# Jacob's Ladder Racing — PWA

An installable phone app: your daily in-form trainer selections + Jacob's Ladder
staking + next-race alerts. Single folder, no build tools, hosted free on GitHub Pages.

## What's in here

| File            | What it is |
|-----------------|------------|
| `index.html`    | The whole app (offline-capable, all logic local to the phone) |
| `sw.js`         | Service worker — app shell cache, always-fresh selections data |
| `manifest.webmanifest` | Install metadata (name, icons, colours) |
| `icons/`        | 192 + 512 px app icons |
| `data/latest.json` | Today's selections (written by `inform_daily.py`) |

## One-time deploy (GitHub Pages)

1. Copy these files into your repo `jobsaboba/jacobs-ladder` (overwrite the old single-page tracker):
   `index.html`, `sw.js`, `manifest.webmanifest`, `icons/`, `data/`
2. Commit & push.
3. On your phone, open `https://jobsaboba.github.io/jacobs-ladder/` in Chrome (Android) or Safari (iPhone).
4. **Install**: Chrome → menu → "Add to Home screen"; Safari → Share → "Add to Home Screen".
   It then runs full-screen like a native app, works offline (last loaded day included).

## Daily flow (automated)

1. `bash ~/racing-scripts/push_selections.sh`
   — runs the pipeline (which mirrors `~/jacobs-ladder-app/data/latest.json`),
   then commits that file to the repo via the GitHub API.
2. In the app tap **⟳ Fetch day's selections** — it pulls `data/latest.json`, shows a stale-file
   warning if the JSON isn't for today, and can also **⬆ Import** the JSON file manually as a fallback.

## How the app works

- **Hero card**: next race by time, countdown to the off, the current stake
  (first + last of ladder × unit), and buttons **WON (enter return)** / **LOST** / **Skip**.
- **Ladder engine** — identical rules to the old tracker:
  - stakes follow `1-2-2` (next stake = first + last units; single element = that number),
  - a **loss** appends the stake to the ladder,
  - a **win** scratches off first and last (or resets if only ≤2 remain),
  - any **new bank peak resets straight back to 1-2-2**.
- **Race alerts** 🔔 — grant the notification prompt once; you get an alert ~10 min before
  each remaining race, with meeting, time, horse, stake and price. Alerts fire while the app
  is open in the background (switch apps freely; only fully closing the browser stops them).
- **Undo** reverses any processed race (or bank edit), **Reset day** clears results but keeps the bank.
- **Day ledger + Copy summary** exports the whole day's stakes/returns to the clipboard.
- Each phone keeps its **own private bank** — friends install the same link but their
  staking state never mixes.

## Background alerts (fully-closed phones) — the push worker

`worker/` holds a tiny Cloudflare Worker (free plan) that wakes every installed
phone 5–10 min before each race from ~10 minutes before each race:

1. Create a free Cloudflare account, then in a terminal:
   ```bash
   cd ~/jacobs-ladder-app/worker
   npx wrangler login                    # opens a browser to authorise
   npx wrangler kv namespace create DB   # copy the printed id into wrangler.toml
   npx wrangler secret put VAPID_SUBJECT  # e.g. mailto:you@example.com
   npx wrangler secret put PUSH_PRIVATE_JWK
   # when prompted, paste the full "private_jwk" JSON object from
   # ~/racing-scripts/secrets/vapid.json (single line)
   npx wrangler deploy
   npx wrangler crons sync              # (older wrangler: cron is in wrangler.toml)
   ```
2. Edit `index.html`: set `WORKER_URL` to your worker's URL (e.g.
   `https://jacobs-ladder-push.yourname.workers.dev`), then re-run `upload_app.sh`.
3. Architecture (why this stays free & simple):
   - worker cron (*/5 min) fetches `data/latest.json` from the Pages site,
   - races starting ≤ 11 min out trigger a **wake push** (no payload — no encryption needed),
   - each phone's service worker wakes, fetches the day's selections itself and
     builds the notification from **its own ladder mirror (IndexedDB)** — so every
     friend sees their own next stake.
   - `VAPID` keys: public key already embedded in `index.html`; the private JWK
     lives in `~/racing-scripts/secrets/vapid.json` (never commit it).
4. Trust me, order matters: a phone's 🔔 grants permission and subscribes to the
   worker; if the worker isn't deployed yet the app keeps its local (app-open)
   alerts and shows a hint.

## Automated publishing scripts (~/racing-scripts/)

No `git` needed — both scripts commit through the GitHub API with a PAT:
- `push_selections.sh` — the daily one-command flow: runs the pipeline,
  then commits `data/latest.json` to the repo. Phones fetch/alert from there.
- `upload_app.sh` — one-time (and after app updates): uploads index.html,
  sw.js, manifest, icons, worker files and the day's JSON.

Setup once:
```bash
mkdir -p ~/racing-scripts/secrets && chmod 700 ~/racing-scripts/secrets
# GitHub web: Settings -> Developer settings -> PAT (fine-grained)
#   repo: jobsaboba/jacobs-ladder · Contents: Read and write
echo 'ghp_yourtoken' > ~/racing-scripts/secrets/github_token
chmod 600 ~/racing-scripts/secrets/github_token
```
Then each morning is just:  `bash ~/racing-scripts/push_selections.sh`

## Known limits / next steps

- Local (in-app-open) alerts fire while the app is running in the background; the
  **push worker** above covers fully-closed phones. Race times are UK local.
- The fetch button can't scrape the live sites from the phone (CORS blocks browsers),
  which is why the daily JSON rides on the repo — this matches the current pipeline exactly.
- Race-day alert dedupe: each race announces once per day per phone (cron + NN tag).
