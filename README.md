# RouteFusion

RouteFusion is an OpenAI-compatible LLM gateway with a React operations dashboard. The hosted setup uses Vercel for the API and dashboard, and Supabase Postgres for provider/model configuration, hashed client API keys, rate limits, health state, and request history.

## Local development

Requirements: Node.js 20+ and npm.

```powershell
Copy-Item .env.example .env
npm ci
npm run dev
```

The dashboard runs at `http://localhost:5173` and API at `http://localhost:3000`. Without Supabase credentials, local development uses ignored JSON files in `data/` and the local admin secret. Set a stable `ENCRYPTION_KEY` before saving provider credentials.

## Prepare Supabase

1. Create a Supabase project.
2. In **SQL Editor**, run [`supabase/migrations/202610060001_routefusion.sql`](supabase/migrations/202610060001_routefusion.sql). It creates owner-scoped tables, disables direct `anon`/`authenticated` table access, and installs restricted server-only RPCs for atomic config writes, usage retention, and shared rate limits.
3. In **Authentication → Users**, create and confirm the owner account. Copy its user UUID.
4. In **Authentication → URL Configuration**, add the dashboard's production URL and Vercel preview URL to the allowed redirect URLs.
5. In the Supabase API settings, copy the project URL and publishable key. Create a server secret key; it must stay in the API's environment and never be exposed as a `VITE_` variable.

The API only accepts dashboard admin requests from the Supabase Auth user whose UUID matches `ROUTEFUSION_OWNER_ID`. Client gateway keys are independent credentials; their SHA-256 hashes are stored in Postgres and the raw key is shown only once.

## Deploy to Vercel

Create two Vercel projects from the same repository:

### API project

- Root Directory: `apps/api`
- Framework: Fastify (auto-detected)
- Add the `api.net2coder.in` domain to this project.
- Configure these Production environment variables:
  - `NODE_ENV=production`
  - `PORT=3000`
  - `SUPABASE_URL`
  - `SUPABASE_SECRET_KEY`
  - `ROUTEFUSION_OWNER_ID` (the Auth user UUID from above)
  - `ENCRYPTION_KEY` (generate once with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`; keep it backed up and stable)
  - `CORS_ORIGIN` (the exact dashboard origin, for example `https://console.net2coder.in`)
  - `REQUESTS_PER_MINUTE` (optional, defaults to `120` per client API key)
  - `LOG_LEVEL=info`

`apps/api/vercel.json` sets a 300-second function duration for upstream calls and streams. Vercel plan limits still apply. The API's Fastify routes are served as a Vercel Function; there is no persistent Node process or writable local data store in production.

### Dashboard project

- Root Directory: `apps/dashboard`
- Framework: Vite
- Add your dashboard domain (for example `console.net2coder.in`).
- Configure Production build variables:
  - `VITE_API_URL=https://api.net2coder.in`
  - `VITE_SUPABASE_URL` (same value as `SUPABASE_URL`)
  - `VITE_SUPABASE_PUBLISHABLE_KEY` (the Supabase publishable key; safe for browser use)

Redeploy both projects after setting environment variables. Sign into the dashboard using the owner account created in Supabase Auth, then add providers and model mappings. Generate a client API key in the API Keys page. Do not set `SUPABASE_SECRET_KEY`, `ENCRYPTION_KEY`, or provider credentials on the dashboard project.

## Gateway request

```bash
curl https://api.net2coder.in/v1/chat/completions \
  -H 'Authorization: Bearer rf_live_your-generated-key' \
  -H 'Content-Type: application/json' \
  -d '{"model":"rf-auto","messages":[{"role":"user","content":"Hello"}]}'
```

## Data and security

- Providers and models are stored in Supabase. Provider credentials are encrypted with AES-256-GCM before storage; the encryption key is only in Vercel's API environment.
- Client key hashes, last-use timestamps, and request metadata are stored in Supabase. Prompts and completions are not stored. Request metadata is retained to the latest 10,000 records per owner.
- The Requests page fetches up to 5,000 recent records at a time and can filter by date, key, provider, model, or request ID and export the filtered rows to CSV.
- Rate limits use a Supabase RPC so they are shared across Vercel instances (`REQUESTS_PER_MINUTE`, default 120 per bearer credential).
- Provider destinations are checked against DNS results and private/local IP ranges before connection attempts. Private provider endpoints are blocked in production.
- For local development only, set `ALLOW_PRIVATE_PROVIDER_URLS=true` in the API environment when you intentionally connect to a local provider. Production rejects this override.
- All data tables have RLS enabled and direct browser roles have no table grants. The API uses Supabase's server secret, which bypasses RLS, and independently verifies the owner JWT and fixed owner UUID before admin operations. Never put that secret in the dashboard build.
- Table rows include `owner_id` to support a future multi-user model. The current API intentionally permits one owner configured by `ROUTEFUSION_OWNER_ID`; multi-user support will require deriving tenant scope from authenticated users/client keys and adding tenant-aware policies.
- Set Vercel function regions close to the Supabase project region to reduce database latency. Supabase's serverless pooler guidance applies if adding direct Postgres connections; the current implementation uses the Supabase HTTPS API.

To copy existing local JSON data, put the Supabase URL, server secret, and owner UUID in local `.env`, apply the migration first, and run `npm run migrate:local --workspace @routefusion/api`. Keep the same `ENCRYPTION_KEY` value that encrypted the local provider credentials. The import copies provider/model config, key hashes, and request metadata; it never needs the raw client API key values.

