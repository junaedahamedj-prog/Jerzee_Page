# JERZEE Node.js + Supabase Demo

## Requirements
- Node.js 18+
- A Supabase project

## Configure Supabase
1. In the Supabase dashboard, open **SQL Editor** and run [`supabase/schema.sql`](./supabase/schema.sql).
2. Copy `.env.example` to `.env` and set `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` from your Supabase project settings.
3. Keep the service-role key private. It is used only by the Node.js server and must never be added to browser code or committed.

## Migrate existing SQLite orders
The original `data/jerzee.db` file is retained as the source for this one-time import. After configuring Supabase and applying the schema, run:

```bash
npm run migrate:sqlite
```

The importer preserves existing order IDs and fields, including email when present. It is safe to rerun: existing Supabase order IDs are not overwritten. The local SQLite file is not modified or deleted.

## Run
```bash
npm install
npm start
```

Open:
- Store: http://localhost:3000
- Admin: http://localhost:3000/admin.html

## How it works
The existing storefront and admin dashboard use the same Express API and request/response formats. Product data remains in `data/products.json`; customer orders are stored in the Supabase `public.orders` table.

Run the automated API tests with:

```bash
npm test
```

The tests use an isolated in-memory order store and do not write to the configured Supabase project.
