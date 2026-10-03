require('dotenv').config();

const fs = require('fs');
const path = require('path');
const initSqlJs = require('sql.js');
const { SupabaseRestClient } = require('../supabase-rest-client');

const sqlitePath = path.join(__dirname, '..', 'data', 'jerzee.db');
const supabaseUrl = process.env.SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

async function migrate() {
  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error('Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY before migrating.');
  }
  if (!fs.existsSync(sqlitePath)) {
    throw new Error(`SQLite database was not found at ${sqlitePath}`);
  }

  const SQL = await initSqlJs();
  const sqlite = new SQL.Database(fs.readFileSync(sqlitePath));
  const table = sqlite.exec('SELECT * FROM orders ORDER BY id ASC')[0];

  if (!table) {
    console.log('SQLite orders table is empty; there are no orders to migrate.');
    sqlite.close();
    return;
  }

  const emailIndex = table.columns.indexOf('email');
  const orders = table.values.map((values) => {
    const order = {};
    table.columns.forEach((column, index) => {
      order[column] = values[index];
    });
    if (emailIndex === -1) {
      order.email = null;
    }
    return order;
  });
  sqlite.close();

  const supabase = new SupabaseRestClient(supabaseUrl, serviceRoleKey);

  for (let offset = 0; offset < orders.length; offset += 500) {
    const batch = orders.slice(offset, offset + 500);
    await supabase.request('orders', {
      method: 'POST',
      query: { on_conflict: 'id' },
      prefer: 'resolution=ignore-duplicates,return=minimal',
      body: batch,
    });
  }

  await supabase.request('rpc/sync_orders_id_sequence', { method: 'POST', body: {} });

  console.log(`Migrated ${orders.length} orders from SQLite to Supabase.`);
}

migrate().catch((error) => {
  console.error('SQLite to Supabase migration failed:', error.message);
  process.exitCode = 1;
});
