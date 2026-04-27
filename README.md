# GPT Image Canvas

Local professional AI canvas built with tldraw, Hono, SQLite, and GPT Image 2.

## Quick Start

```powershell
pnpm install
Copy-Item .env.example .env
pnpm dev
```

Set `OPENAI_API_KEY` and, when using an OpenAI-compatible service, `OPENAI_BASE_URL` in `.env`.

Open the web app at `http://localhost:5173`.

## Scripts

- `pnpm dev` starts both workspace development workflows.
- `pnpm api:dev` starts the API development workflow.
- `pnpm web:dev` starts the web development workflow.
- `pnpm typecheck` checks shared, web, and API TypeScript.
- `pnpm build` builds shared, web, and API packages.
- `pnpm start` starts the built API package.

## Docker

Docker Compose builds the shared contracts, web app, and API into one image. The Hono API serves both `/api` and the built web bundle from a single localhost port, while SQLite data and generated assets persist in host `./data`.

```powershell
Copy-Item .env.example .env
docker compose up --build
```

Open the app at `http://localhost:8787` by default. Set `PORT` in `.env` before starting Docker Compose to use a different localhost port.

`OPENAI_API_KEY` may be left empty for local boot checks. The app still starts, and generation endpoints return a missing-key JSON error until credentials are configured.

## Ralph

Ralph templates live in `.agents/ralph`, and the executable PRD is `.agents/tasks/prd-gpt-image-canvas.json`.
