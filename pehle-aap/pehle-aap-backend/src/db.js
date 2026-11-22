const { Pool } = require('pg');
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSL === 'true' ? { rejectUnauthorized: false } : undefined,
  max: Number(process.env.DB_POOL_SIZE || 10)
});
pool.on('error', (err) => console.error(JSON.stringify({ level:'error', event:'db_pool_error', message:err.message })));
module.exports = { pool };
