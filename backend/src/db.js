const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

// Set Node.js process timezone to IST
process.env.TZ = 'Asia/Kolkata';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: false
});

// Set IST timezone on every new DB connection
pool.on('connect', (client) => {
  client.query("SET timezone='Asia/Kolkata'");
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
