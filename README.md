# PicklyOne Image App

A Tencent Cloud deployable image generation app backed by PicklyOne.

## Features

- Static web UI for prompt-driven image generation
- Same-origin `/api/images/generations` backend proxy
- API key kept on the server via environment variables
- PM2 and Nginx deployment files for Tencent Cloud

## Local run

1. Copy `.env.example` to `.env`
2. Set `PICKLYONE_API_KEY`
3. Start the server:

```bash
set -a
source .env
set +a
npm start
```

4. Open `http://127.0.0.1:3000`

## Tencent Cloud deployment

See [DEPLOY_TENCENT.md](./DEPLOY_TENCENT.md).
