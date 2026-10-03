# JERZEE Node.js + SQLite Demo

## Requirements
- Node.js 18+

## Run
```bash
npm install
npm start
```

Open:
- Store: http://localhost:3000
- Admin: http://localhost:3000/admin.html

## How it works
Customer submits the order form -> Express API `/api/orders` -> SQLite database `data/jerzee.db` -> admin dashboard reads `/api/orders`.

This is a local demo. For production, add authentication, validation, payment gateway, HTTPS, deployment, backups, and a production database such as PostgreSQL/Supabase.
