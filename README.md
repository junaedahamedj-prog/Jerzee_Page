# JERZEE Node.js + Supabase Demo

## Requirements
- Node.js 18+
- A Supabase project

## Configure Supabase
1. In the Supabase dashboard, open **SQL Editor** and run [`supabase/schema.sql`](./supabase/schema.sql). Run it again on an existing project to create the private admin session and login-rate-limit tables and function.
2. If `.env` does not already exist, copy `.env.example` to `.env` (PowerShell: `if (-not (Test-Path .env)) { Copy-Item .env.example .env }`). If it already exists, edit it in place; do not overwrite it. Fill in the values locally. Required variables are:
   - `SUPABASE_URL`: your Supabase project URL.
   - `SUPABASE_SERVICE_ROLE_KEY`: the private service-role key from Supabase project API settings.
   - `ADMIN_USERNAME` and `ADMIN_PASSWORD`: private admin login credentials. Use a unique username and a long, unique password.
   - `PORT`: optional local server port (defaults to `3000`).
3. Keep `.env` and the service-role key private. `.env` and `.env.*` are ignored by Git except for the placeholder-only `.env.example`. The service-role key is only used by server-side code.

## Deploy to Vercel
1. In Supabase, run [`supabase/schema.sql`](./supabase/schema.sql).
2. In Vercel, open **Project → Settings → Environment Variables** and add `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `ADMIN_USERNAME`, and `ADMIN_PASSWORD` for each environment you will use (Production, Preview, or Development). Use private, unique admin credentials. Vercel does not read the local `.env` file.
3. Save the variables and redeploy from **Deployments → Redeploy** (or push a new commit). Vercel applies changed environment variables to new deployments.
4. Open `https://<your-deployment>/admin/login` to sign in. Production admin cookies require HTTPS.

Admin sessions are opaque, random, server-side records stored in Supabase and expire after eight hours. Login attempts are rate-limited across Vercel instances using a keyed hash of the client address. The session and rate-limit tables can only be accessed using the server-side service-role key. A missing or invalid required environment variable produces a clear configuration error without returning its value.

## Migrate existing SQLite orders
The original `data/jerzee.db` file is retained as the source for this one-time import. After configuring Supabase and applying the schema, run:

```bash
npm run migrate:sqlite
```

The importer preserves existing order IDs and fields, including email when present. It is safe to rerun: existing Supabase order IDs are not overwritten. The local SQLite file is not modified or deleted.

## Run locally
```bash
npm install
npm start
```

Open:
- Store: http://localhost:3000
- Admin login: http://localhost:3000/admin/login
- Private admin portal: http://localhost:3000/staff

## How it works
The `/staff` portal is not linked from the storefront. The legacy `/admin.html` route and every order-listing or order-management endpoint require a session created by `/admin/login`; customers can still submit orders publicly. Logout invalidates the server-side session. The admin order list refreshes automatically every 15 seconds while its browser tab is visible; manual refresh remains available. Order actions look up only the requested order, and product pricing is loaded once per admin page visit. Cart checkout submits all items together and records each product/size as its own order row with the same customer details. Product data remains in `data/products.json`; customer orders are stored in the Supabase `public.orders` table.

Run the automated API tests with:

```bash
npm test
```

The tests use an isolated in-memory order store and do not write to the configured Supabase project.
