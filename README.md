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
The `/staff` portal is not linked from the storefront. The legacy `/admin.html` route and every order-listing or order-management endpoint require a session created by `/admin/login`; customers can still submit orders publicly. Logout invalidates the server-side session. The active admin dashboard section refreshes automatically every 60 seconds while its browser tab is visible; manual refresh remains available. Stock inputs are not refreshed while being edited. Order actions look up only the requested order. Cart checkout submits all items together and records each product/size as its own order row with the same customer details. Products are stored in Supabase `public.products`; customer orders are stored in `public.orders`. `data/products.json` is the idempotent initial catalog seed retained for reference and local fallback.

## Inventory management
Running [`supabase/schema.sql`](./supabase/schema.sql) adds the `public.inventory_stock` size-level table and transactional stock/order functions. It preserves existing order history and seeds each current catalog product/size with zero available units. The seed uses `ON CONFLICT DO NOTHING`, so rerunning the migration does not reset stock that has already been entered. Existing orders are not marked as reserved and do not change stock retroactively.

After applying the schema, sign in at `/admin/login` and open `/staff`. The **Stock by Size** table shows available-to-sell units after pending-order reservations; enter the verified available quantity and select **Save stock**. Sizes at or below the default low-stock threshold of five are flagged; zero-stock sizes are identified separately. The storefront refreshes product availability when a customer returns to its browser tab and selects an in-stock size automatically if their previous selection has sold out. Customers see only whether a size is available, not exact inventory counts.

Checkout atomically reserves all requested product/size quantities while creating pending orders. Insufficient stock rejects the entire cart. Confirmation does not deduct stock a second time. Editing a pending order adjusts its reservation by the quantity difference, while cancelling a pending reserved order releases its units once and preserves the order record. Historical pending orders created before this migration have no reservation; their cancellation does not add stock.

## Product management
Run the updated [`supabase/schema.sql`](./supabase/schema.sql) in the Supabase SQL Editor before deploying the product-management application. It creates the RLS-protected `public.products` catalog, inserts the six existing JSON catalog entries only when their IDs are absent, and seeds any missing inventory rows at zero. `ON CONFLICT DO NOTHING` preserves existing product edits and stock; it does not reset production data. The `create_product_with_inventory` database function creates a product and its initial per-size stock in one transaction. Existing product edits never change size inventory; quantity edits remain in the Stock tab.

The schema also creates a public-read `product-images` Storage bucket if it does not already exist. Product image uploads are limited to PNG, JPEG, or WebP files up to 650 KB and use the server-side service-role key; no new environment variables are required. If a bucket named `product-images` already exists, review its Supabase Storage settings and set it to public with those MIME types and a 650 KB upload limit. The admin also accepts secure HTTPS image URLs and existing `/images/...` paths. No image or product delete endpoint is exposed, so existing order records and their product snapshots remain intact.

After applying the schema, deploy the application and sign in at `/admin/login`. Open **Products** to search/filter, create, edit, or deactivate products. Use the optional **Product message** field to show a short badge such as “National Pride” on a jersey card; it is limited to 40 characters. Creating a product requires one or more sizes and a starting quantity for each; later quantity changes must be made in **Stock**. Deactivated products are hidden from the storefront and rejected by the transactional checkout function, while historical and pending order workflows remain available.

Run the automated API tests with:

```bash
npm test
```

The tests use an isolated in-memory order store and do not write to the configured Supabase project.
