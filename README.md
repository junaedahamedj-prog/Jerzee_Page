# JERZEE Node.js + Supabase Demo

## Requirements
- Node.js 18+
- A Supabase project

## Configure Supabase
1. In the Supabase dashboard, open **SQL Editor** and run [`supabase/schema.sql`](./supabase/schema.sql).
2. Copy `.env.example` to `.env` and set `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` from your Supabase project settings.
3. Keep the service-role key private. It is used only by the Node.js server and must never be added to browser code or committed.

## Deploy to Vercel
Import the repository into Vercel and add `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `ADMIN_USERNAME`, and `ADMIN_PASSWORD` under **Project Settings → Environment Variables** for the Production environment (and Preview if needed), then redeploy. Choose a private username and a long, unique password. Vercel does not read the local `.env` file. Run the schema in Supabase before using order endpoints. The admin page and order-management API fail closed until both admin credentials are configured.

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
- Private admin portal: http://localhost:3000/staff

## How it works
The `/staff` portal is not linked from the storefront and uses browser basic authentication with the `ADMIN_USERNAME` and `ADMIN_PASSWORD` environment variables. The old `/admin.html` URL is protected by the same authentication. Order listing and management endpoints also require authentication; customer order submission remains public. Cart checkout submits all items together and records each product/size as its own order row with the same customer details. Product data remains in `data/products.json`; customer orders are stored in the Supabase `public.orders` table.

Run the automated API tests with:

```bash
npm test
```

The tests use an isolated in-memory order store and do not write to the configured Supabase project.
