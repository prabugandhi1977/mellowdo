# MellowDo

> Personality development app: build gentle habits, starting with beating procrastination.

A gentle, guilt-free app for beating procrastination, for yourself and your community.
Installable web app (PWA). Node 22 only: no npm dependencies, built-in SQLite.

## Run

```bash
npm start      # http://localhost:3300   (PORT, DB_FILE env vars optional)
npm test       # API tests
```

## Features

- **Tiny-step breakdown:** enter a task you're avoiding (and optionally why) and get a 2-minute first step plus a few gentle follow-ups. Rule-based today (`server/breakdown.js`); a good place to plug in an LLM later.
- **Focus timer:** 5/10/15/25 minute sessions with soft check-ins at one-third and two-thirds. Stopping early still keeps your streak.
- **Daily check-in:** mood plus what made starting hard, with a 30-day pattern summary.
- **Community:** create or join a group with a code, share one small commitment a day, cheer others on. The group streak counts days anyone showed up, so there is no individual shaming.

## Layout

```
server/   db.js (schema), app.js (API routes), breakdown.js, server.js (HTTP + static)
web/      index.html, app.js (UI), style.css, sw.js (offline), manifest
tests/    api.test.js
```

## Next steps

Push-notification reminders, LLM-powered breakdowns, sharing a group invite link, data export, hosted deploy (the repo root has a Dockerfile/render.yaml pattern you can copy).

Note: auth is a name plus a short PIN, which suits a trusted community. Add email or OAuth sign-in before opening it to the public.

## Deploy (Render)

1. In Render choose **New → Blueprint**, connect this repo and select the branch with `render.yaml`.
2. Approve the `starter` web service with a 1 GB disk (needed so accounts and groups survive restarts).
3. When it is live, open the `onrender.com` URL on a phone and use "Add to Home Screen" to install the app.

Back up the database by copying `/data/mellowdo.db` (for example with Render's shell). The Dockerfile also works on Fly.io, Railway or any VPS: mount a volume at `/data`.
