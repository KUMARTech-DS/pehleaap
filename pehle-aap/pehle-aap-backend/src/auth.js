const crypto = require('crypto');
const { pool } = require('./db');
const hash = (v) => crypto.createHash('sha256').update(v).digest('hex');

async function auth(req, res, next) {
  try {
    const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (!token) return res.status(401).json({ error: 'Bearer link token required' });
    const result = await pool.query(
      `SELECT id, wedding_id, full_name, role, preferred_lang, elders, vendor_id, family_id
       FROM person WHERE access_key_hash=$1 AND active=true`, [hash(token)]
    );
    if (!result.rowCount) return res.status(401).json({ error: 'Invalid or expired link' });
    req.person = result.rows[0];
    next();
  } catch (e) { next(e); }
}
function allow(...roles) {
  return (req, res, next) => roles.includes(req.person.role)
    ? next() : res.status(403).json({ error: 'This role cannot access this resource' });
}
module.exports = { auth, allow, hash };
