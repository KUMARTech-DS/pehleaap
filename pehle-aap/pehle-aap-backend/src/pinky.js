const {pool}=require('./db');
async function contextFor(p){
 const wid=p.wedding_id, id=p.id; const ctx={role:p.role,person:p.full_name,language:p.preferred_lang,tasks:[]};
 const tasks=await pool.query(`SELECT t.title,t.status,t.due_at,f.name function_name FROM task t LEFT JOIN wedding_function f ON f.id=t.function_id WHERE t.wedding_id=$1 AND ($2='couple' OR t.owner_id=$3 OR t.backup_id=$3 OR ($2='vendor' AND t.vendor_id=$4) OR EXISTS(SELECT 1 FROM assignment a WHERE a.member_id=$3 AND ((a.scope='event' AND a.scope_id=t.function_id) OR (a.scope='vendor' AND a.scope_id=t.vendor_id)))) ORDER BY t.due_at NULLS LAST LIMIT 30`,[wid,p.role,id,p.vendor_id]); ctx.tasks=tasks.rows;
 if(p.role==='couple'){
  const [v,g,e]=await Promise.all([
   pool.query(`SELECT v.name,v.category,b.agreed_amount,COALESCE(sum(pm.paid_amount),0) paid,b.agreed_amount-COALESCE(sum(pm.paid_amount),0) balance FROM vendor v LEFT JOIN booking b ON b.vendor_id=v.id LEFT JOIN payment_milestone pm ON pm.booking_id=b.id WHERE v.wedding_id=$1 GROUP BY v.id,b.id`,[wid]),
   pool.query(`SELECT count(*)::int entries,COALESCE(sum(amount),0) total FROM gift_entry WHERE wedding_id=$1`,[wid]),
   pool.query(`SELECT f.name,count(t.id)::int total,count(t.id) FILTER(WHERE t.status IN ('confirmed','set_up','done'))::int ready FROM wedding_function f LEFT JOIN task t ON t.function_id=f.id WHERE f.wedding_id=$1 GROUP BY f.id ORDER BY f.sort_order`,[wid])
  ]); ctx.vendors=v.rows;ctx.gifts=g.rows[0];ctx.functions=e.rows;
 } else if(p.role==='team'){
  const a=await pool.query(`SELECT f.name,count(t.id)::int total FROM assignment x JOIN wedding_function f ON x.scope='event' AND x.scope_id=f.id LEFT JOIN task t ON t.function_id=f.id WHERE x.member_id=$1 GROUP BY f.id`,[id]);ctx.assigned_functions=a.rows;
 } else if(p.role==='vendor'){
  const v=await pool.query(`SELECT name,category FROM vendor WHERE id=$1 AND wedding_id=$2`,[p.vendor_id,wid]);ctx.vendor=v.rows[0]||null;
 } else if(p.role==='guest'){
  const f=await pool.query(`SELECT family_name,side,headcount,rsvp_status FROM family WHERE id=$1 AND wedding_id=$2`,[p.family_id,wid]);ctx.family=f.rows[0]||null;
  const q=await pool.query(`SELECT token_no,headcount,due_at,status FROM guest_checkin WHERE family_id=$1`,[p.family_id]);ctx.queue=q.rows[0]||null;
 }
 return ctx;
}
module.exports={contextFor};
