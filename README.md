# ASTA MINI

WhatsApp multi-device bot with a web pairing page and MongoDB-backed authentication.

## Requirements
- Node.js 20 or 22
- MongoDB database
- API credentials for any optional external commands you want to use

## Setup
1. Copy `.env.example` to `.env`.
2. Set `MONGODB_URI` and any API keys you need. Never commit `.env`.
3. Install dependencies: `npm install`
4. Start: `npm start`
5. Open the app's base URL for the pairing page.

## Environment variables
- `PORT`, `PREFIX`, `BOT_NAME`, `BOT_LOGO`, `BOT_FOOTER`
- `MONGODB_URI`, optional `MONGODB_DB`
- `LAKVISION_API_KEY`, `MOVIEMANIA_API_KEY`, `TIKTOK_API_KEY`, `WPREACT_API_KEY`

## Security notes
- The repository archive previously included `.env` and hard-coded API keys. Rotate/revoke those credentials before deploying this version. Removing a secret from the latest source does not remove it from old Git history.
- Use a least-privilege MongoDB user and restrict network access in Atlas.
- The built-in pairing limiter is per-process; use a shared store/proxy limiter if deploying multiple instances.
- Do not run multiple bot instances with the same WhatsApp session at once.

## Checks
Run `npm run check` to perform Node.js syntax checks on the core files. External APIs, pairing, and WhatsApp connection still require live integration tests with valid credentials.
