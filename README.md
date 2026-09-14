# Keep

A multiplayer dragon card game for 2–6 players. Hoard three visible treasures to win. Send ordered face-down piles, risk a reveal, and protect your lair with goblins.

- Play: https://keep2-65fe1099bb65.herokuapp.com/
- Source: https://github.com/FelipeBudinich/keep-prototype
- Rules and acceptance criteria: [keep-specification.md](keep-specification.md)

## Architecture

Node.js 24.18.0 is the single authoritative process; `ws` carries authenticated, individually projected snapshots. All gameplay is drawn in one Theseus canvas: the table, private hand, outgoing pile, decisions, timer, and public log. Theseus is pinned to `a6c5535cd99eaf2ebabdf09d26d286ca5de85287`. Transparent native buttons match the canvas controls for keyboard and screen-reader access, with visible focus drawn on the canvas and a semantic text summary of the game. The home and lobby screens use native HTML forms.

Supabase Postgres replaces the specification's original SQLite default at the user's request. The private `keep_private` schema holds a transactional JSON snapshot of rooms, guest-session verifiers, private card handles, and idempotency receipts. `room_codes` enforces unique six-digit codes. A compare-and-swap revision and a session-level PostgreSQL advisory lock fence the single authority. The serialized executor includes lobby allocations, commands, bot decisions, presence, and deadlines. All automatic game effects commit together before acknowledgment or publication.

The application database role has access only to this schema. The browser has no Supabase credential, database endpoint, authoritative state, or opponent card IDs. The schema is not exposed through the Supabase Data API and its tables have RLS enabled. The CA certificate in `server/certs` was downloaded from Supabase's database settings; hostname and certificate verification remain enabled.

## Develop

```sh
npm ci
npm run build
cp .env.example .env
# Configure SUPABASE_DB_URL with your restricted server role, then:
npm run dev
```

Open http://localhost:3000/. A private room with zero additional humans and one or more bots is a quick way to play solo. To test multiplayer locally, use separate browser profiles or private windows: tabs sharing a guest cookie share one seat, and the newest tab takes control.

For disposable local development without a database:

```sh
npm run build
KEEP_MEMORY=1 npm run dev
```

This mode loses its state on restart and is rejected when `NODE_ENV=production`. No test randomness or shortened timing controls are exposed through browser requests or production environment variables.

## Build and test

```sh
npm test
npm run build
npm audit --omit=dev
```

The build stages authored `public/games/keep` alongside unmodified vendored Theseus engine and bake tools. Only the baked `/dist/keep/` client is served. The upstream editor, tools, server source, environment files, and database snapshots are outside the HTTP surface. The upstream license and revision notice remain under `vendor/theseus`.

Domain tests cover all seat counts, exact card conservation, pile ordering and return, all adventurer effects, immediate wins, private-handle rotation, projected-state invariance, bot policy, and complete simulated matches. Integration tests use real HTTP and WebSocket clients for session ownership, strict schemas, joining and starting races, three-client privacy, duplicate receipts, random taking, reconnect/reclaim, deadlines, rate and payload limits, and failures on both sides of the persistence acknowledgment boundary.

## Database setup

The deployed Supabase project is `xfisnoeavonaaphrdjjy`. Schema migrations are under `supabase/migrations`. For another project, apply those migrations as its administrator, set a strong unique password on `keep_app`, and store only the resulting server URI in `SUPABASE_DB_URL`. The credential migration in the deployed database contains a SCRAM verifier; that deployment-specific verifier is deliberately excluded from Git.

Use the session-pooler URI from the Supabase **Connect → Direct → Session pooler** panel on port 5432. Transaction pooling is unsuitable for the persistent advisory lock. Do not use the administrator, anonymous, or service-role API key for game access.

## Heroku deployment

The app has Git remotes `origin` (GitHub) and `heroku` (keep2). `Procfile` starts one web process; Heroku runs `npm run build` during its Node build and removes development dependencies from the runtime.

```sh
heroku login
heroku git:remote -a keep2
node --env-file=.env scripts/configure-heroku.mjs
npm test
npm run build
git push origin main
git push heroku main
heroku ps:scale web=1 -a keep2
```

`configure-heroku.mjs` sets `SUPABASE_DB_URL`, `NODE_ENV=production`, and the exact HTTPS `APP_ORIGIN` without printing credentials. Keep one web dyno and leave Heroku preboot disabled: overlapping authorities are intentionally refused by the database lock. `/healthz` returns a safe health response; no debug-state endpoint exists.

## Recovery and backups

On restart, the server loads the latest committed snapshot and receipt set, marks human connections disconnected, and resolves an elapsed decision once. It does not redeal, replay acknowledged moves, or simulate turns for the length of the outage. Clients reconnect with their 30-day HttpOnly guest cookie, replace their personal view, and retry an uncertain command with its original ID. Temporary bot seats require explicit reclaim.

A database failure never acknowledges a speculative action. An uncertain database transaction fences that process; restart the authority to recover the actual committed snapshot before retrying. A healthy second authority cannot start while the first owns its database lock. Graceful SIGTERM closes sockets and releases the database connection.

Use Supabase's project backups or point-in-time recovery under **Database → Backups** for full recovery, and keep any exported dumps in restricted storage outside the web root and Git. Backups contain private hands, session verifiers, and command receipts. Stop the authority before restoring; restore the private schema and both tables together, then start exactly one dyno. Do not manually edit card zones or replay old client commands as new IDs.

Timers: human active decisions 60 seconds, recipient decisions 30 seconds; bot decisions five seconds with 750–1,500 ms thinking; lobby seats and live host transfer 60 seconds; no connected humans abandons a match after ten continuous minutes; inactive terminal rooms expire after 30 minutes. Lobbies with connected humans do not expire. Outcomes retain hidden-card privacy.
