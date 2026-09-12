# SIGMA Life RPG

A full-stack productivity RPG that turns real-world tasks into quests, XP, levels, streaks, attributes, gold, and unlockable rewards.

The project intentionally avoids a generic dashboard aesthetic. The public page is designed as a high-polish game launch page, while the authenticated command center stays fast and task-focused.

## What is implemented

- Secure signup, login, logout, server-side sessions, CSRF protection, password hashing with `scrypt`, and per-user data isolation.
- SQLite persistence for users, quests, attributes, inventory, activity history, and sessions. Primary data does **not** use `localStorage`.
- Full quest CRUD with validation and user ownership checks.
- Server-authoritative rewards. The browser never decides how much XP/gold a quest pays.
- Non-linear XP thresholds, level-up events, attribute gains, timezone-aware daily streaks, gold economy, shop, inventory, themes, and badges.
- Optimistic quest completion with rollback on API failure.
- Offline indicator, validation messages, duplicate-completion protection, transaction boundaries, and race-condition checks.
- Responsive layouts, semantic controls, keyboard navigation, focus states, reduced-motion support, and screen-reader status regions.
- SEO metadata, canonical URL, Open Graph/Twitter metadata, JSON-LD, robots.txt, sitemap.xml, semantic page structure, and lightweight local assets.
- Automated unit and end-to-end smoke tests, including a database restart persistence check.

## Stack

This submission deliberately uses a small dependency surface:

- **Frontend:** semantic HTML + CSS + vanilla JavaScript
- **Backend:** Node.js HTTP server
- **Database:** SQLite via Node.js `node:sqlite`
- **Authentication:** custom server-side sessions with secure cookies

Requires **Node.js 22.13+**.

## Run locally

```bash
cp .env.example .env
npm start
```

The app opens at `http://localhost:3000`.

No package installation is required because this project uses Node built-ins only.

### Environment variables

| Variable | Example | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | Server port |
| `NODE_ENV` | `development` | Use `production` on deployment |
| `DB_PATH` | `./data/liferpg.db` | SQLite database file |
| `PUBLIC_URL` | `http://localhost:3000` | Canonical URL used by SEO metadata and sitemap |
| `TRUST_PROXY` | `0` | Set to `1` behind a trusted HTTPS reverse proxy |

## Test before submission

```bash
npm test
npm run smoke
```

`npm run smoke` checks the real HTTP app end to end: landing page, signup/session creation, invalid quest handling, quest creation, server-owned rewards, completion, XP/gold/attribute/streak updates, server restart, login, and persisted data.

## Deployment

### Recommended: Railway or Render with a persistent disk

SQLite needs a persistent filesystem. Do **not** deploy this exact database setup to a serverless platform whose filesystem is ephemeral.

Set these production variables:

```env
NODE_ENV=production
PUBLIC_URL=https://your-domain.example
TRUST_PROXY=1
DB_PATH=/data/liferpg.db
```

Mount a persistent volume at `/data`, then run:

```bash
npm start
```

A Dockerfile is included. The health endpoint is:

```text
GET /api/health
```

### Production checklist

1. Set `PUBLIC_URL` to the final HTTPS URL.
2. Confirm the persistent volume survives a redeploy.
3. Open the live URL in a private browser window and create a fresh account.
4. Create and complete a quest, refresh the page, then sign out/in again.
5. Check the browser console for runtime errors.
6. Test at 360px mobile width and desktop width.
7. Confirm `/robots.txt`, `/sitemap.xml`, and `/api/health` return successfully.

## Project structure

```text
life-rpg/
├── public/
│   ├── index.html       # SEO-focused public landing page
│   ├── landing.js       # auth dialog + reveal interactions
│   ├── app.html         # authenticated game UI
│   ├── app.js           # quest/shop/inventory client logic
│   ├── styles.css       # responsive visual system
│   ├── favicon.svg
│   └── og-card.svg
├── src/
│   ├── db.js            # schema, persistence, shop seed
│   ├── game.js          # pure XP/reward/streak rules
│   └── game.test.js     # unit tests
├── scripts/
│   └── smoke-test.mjs   # end-to-end persistence test
├── data/                # runtime SQLite database (gitignored)
├── server.js            # HTTP, auth, API, static serving, SEO endpoints
├── .env.example
├── Dockerfile
└── package.json
```

## Core API

- `POST /api/auth/register`
- `POST /api/auth/login`
- `POST /api/auth/logout`
- `GET /api/dashboard`
- `POST /api/tasks`
- `PATCH /api/tasks/:id`
- `DELETE /api/tasks/:id`
- `POST /api/tasks/:id/complete`
- `GET /api/shop`
- `POST /api/shop/:id/buy`
- `POST /api/inventory/:id/equip`
- `GET /api/health`

## Security decisions

Rewards are calculated and written by the backend. Quest ownership is checked on every user-specific route. Passwords are salted and hashed. Sessions are stored in the database and sent through `HttpOnly`, `SameSite=Strict` cookies. State-changing authenticated requests require the per-session CSRF token. Important multi-write actions use SQLite transactions.

For a larger production product, the next step would be moving persistence to PostgreSQL, adding email verification/password reset, distributed rate limiting, and automated browser accessibility tests.

## Accessibility

The app uses native buttons/forms/dialogs, skip links, visible keyboard focus, ARIA live regions for async feedback, labels on inputs, semantic headings, responsive layouts, and `prefers-reduced-motion`. Core actions work with Tab + Enter/Space because they use native interactive elements rather than clickable `<div>` elements.

## SEO

The public page includes title/description metadata, canonical URL, Open Graph/Twitter metadata, SoftwareApplication JSON-LD, semantic headings, crawl rules, a generated sitemap, and fast local assets with no third-party font/script request.

## Demo video plan

Use `VIDEO_SCRIPT.md` to record a 90–180 second walkthrough that proves signup/login, task creation, quest completion, level progression, and database persistence after refresh.

## License

MIT. See `LICENSE`.
# SIGMA_RPG
