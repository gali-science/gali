<div align="center">

[![Gali. Learn it. Review it. Out loud.](gali/ui/public/about/assets/img/og.jpg)](https://www.higali.ai)

### A voice assistant for papers, slides, and other PDFs

On [higali.ai](https://www.higali.ai), reviews run on open models through [Together Link](https://www.together.ai/link).

[![Try it free](.github/readme/try.svg)](https://www.higali.ai)&nbsp;&nbsp;[![Watch the video](.github/readme/video.svg)](https://www.higali.ai/about/assets/media/demo-1080.mp4)&nbsp;&nbsp;[![Website](.github/readme/website.svg)](https://www.higali.ai/about/)

</div>

<br>

## Features

- Explain: ask about any page. Get worked examples and practice problems.
- Review: Gali checks the math and can run the code. Findings link to the pages and lines of code they cite.
- Annotate: highlight and take notes. Export the notes as Markdown and the highlighted PDF.

## Codebase

| Folder | What it holds |
| --- | --- |
| `gali/ui/src` | Browser app |
| `gali/ui/api` | Control plane: sign-in, demo, sandbox proxy, model gateway to Together Link |
| `gali/src` | Server in the sandbox of each user |
| `gali/shared` | Shared code |
| `gali/test`, `gali/ui/e2e` | Tests |
| `sandboxes` | Sandbox image |

## Quick start

> [!WARNING]
> Locally, the agent can read every file that your user can read, it has network access, and it runs commands without asking you first. Hidden text in a PDF or a repo could tell it to send your files out. Use only papers and repos that you trust, or run Gali in a container or VM.

You need Node 22, pnpm 9, Docker, and an OpenAI API key. Locally, you sign in as a test user, and all models run on OpenAI.

1. Install the dependencies:

   ```sh
   cd gali
   pnpm install
   pnpm --dir ui install
   ```

2. Unset any `DATABASE_URL` in your terminal. Then start Postgres and create the tables:

   ```sh
   docker compose -f ui/docker-compose.yml up -d
   pnpm --dir ui db:migrate
   ```

3. Make a secret with `openssl rand -hex 32`. Put it in `gali/.env`:

   ```sh
   OPENAI_API_KEY=sk-...
   GALI_HTTP_SECRET=<your secret>
   ```

4. Put the same key and secret in `gali/ui/.env.local`:

   ```sh
   OPENAI_API_KEY=sk-...
   VITE_GALI_DEV_AUTH_BYPASS=1
   VITE_GALI_HTTP_URL=http://127.0.0.1:8787
   VITE_GALI_HTTP_TOKEN=<your secret>
   DATABASE_URL=postgresql://gali:gali@localhost:5432/gali_control
   ```

5. Start the server:

   ```sh
   mkdir -p .gali-data
   pnpm exec tsx scripts/serve.ts
   ```

6. In a second terminal in `gali`, run `pnpm --dir ui dev`. Then open the address it prints, usually http://localhost:5178.

## Tests

Stop the dev server first. Then run in `gali`:

```sh
pnpm --dir ui exec playwright install chromium
pnpm verify
```

## License

[MIT](LICENSE). Copyright 2026 Together AI.
