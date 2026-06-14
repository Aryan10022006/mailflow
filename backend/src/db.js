const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

// Set Node.js process timezone to IST
process.env.TZ = 'Asia/Kolkata';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // NOTE: ssl:false is correct for local Postgres. Most managed providers
  // (RDS, Supabase, Neon, Heroku, etc.) require TLS — set the env var
  // PGSSL=require in those environments to flip this on without code changes.
  ssl: process.env.PGSSL === 'require' ? { rejectUnauthorized: false } : false,
});

// Set IST timezone on every new DB connection.
// FIX: This hook cannot be awaited, and an unhandled rejection here would
// surface as a process-level warning. Attach a catch so a transient failure
// to set the timezone is logged rather than thrown into the void.
pool.on('connect', (client) => {
  client.query("SET timezone='Asia/Kolkata'").catch((err) => {
    console.error('Failed to set session timezone:', err.message);
  });
});

async function initDB() {
  const client = await pool.connect();
  try {
    const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
    await client.query(schema);
    console.log('✅ Database initialized');
  } catch (err) {
    console.error('❌ DB init error:', err.message);
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { pool, initDB };