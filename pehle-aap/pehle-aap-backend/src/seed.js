const fs=require('fs'),path=require('path');
const {pool}=require('./db');
const {hash}=require('./auth');
const data=JSON.parse(fs.readFileSync(path.join(__dirname,'../db/seed.json'),'utf8'));
(async()=>{
 const c=await pool.connect();
 try {
  const existing=await c.query('SELECT id FROM wedding WHERE name=$1 LIMIT 1',[data.wedding.name]);
  if(existing.rowCount){console.log(JSON.stringify({seeded:false,reason:'demo wedding already exists'}));return;}
  await c.query('BEGIN');
  const w=await c.query(`INSERT INTO wedding(name,event_start,event_end,venue_name,city,timezone)
   VALUES($1,$2,$3,$4,$5,$6) RETURNING id`,
   [data.wedding.name,data.wedding.event_start,data.wedding.event_end,data.wedding.venue_name,data.wedding.city,data.wedding.timezone]);
  const wid=w.rows[0].id, funcs={}, people={}, vendors={}, families={};
  for(const f of data.functions){
   const r=await c.query(`INSERT INTO wedding_function(wedding_id,name,starts_at,sort_order)
    VALUES($1,$2,$3,$4) RETURNING id`,[wid,f.name,f.starts_at,f.sort_order]); funcs[f.name]=r.rows[0].id;
  }
  for(const v of data.vendors){
   const r=await c.query(`INSERT INTO vendor(wedding_id,name,category,contact_name,source)
    VALUES($1,$2,$3,$4,$5) RETURNING id`,[wid,v.name,v.category,v.contact_name,v.source]);
   vendors[v.name]=r.rows[0].id;
   const b=await c.query(`INSERT INTO booking(wedding_id,vendor_id,agreed_amount,status)
    VALUES($1,$2,$3,'booked') RETURNING id`,[wid,r.rows[0].id,v.agreed_amount]);
   if(v.paid>0) await c.query(`INSERT INTO payment_milestone(booking_id,title,amount,due_at,paid_amount,status)
    VALUES($1,'Advance / paid to date',$2,$3,$2,'paid')`,[b.rows[0].id,v.paid,v.next_due||null]);
   if(v.agreed_amount-v.paid>0) await c.query(`INSERT INTO payment_milestone(booking_id,title,amount,due_at,paid_amount,status)
    VALUES($1,'Remaining balance',$2,$3,0,'pending')`,[b.rows[0].id,v.agreed_amount-v.paid,v.next_due||null]);
  }
  for(const p of data.people){
   const vendorId=p.vendor_name?vendors[p.vendor_name]:null;
   const r=await c.query(`INSERT INTO person(wedding_id,full_name,role,preferred_lang,access_key_hash,vendor_id)
    VALUES($1,$2,$3,$4,$5,$6) RETURNING id`,
    [wid,p.full_name,p.role,p.preferred_lang,hash(p.access_key),vendorId]);
   people[p.full_name]=r.rows[0].id;
  }
  for(const f of data.families){
   const r=await c.query(`INSERT INTO family(wedding_id,family_name,side,relation,headcount,preferred_lang,invite_key_hash)
    VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [wid,f.family_name,f.side,f.relation,f.headcount,f.preferred_lang,hash(f.invite_key)]);
   families[f.family_name]=r.rows[0].id;
  }
  for(const p of data.people){ if(p.family_name) await c.query('UPDATE person SET family_id=$1 WHERE full_name=$2 AND wedding_id=$3',[families[p.family_name],p.full_name,wid]); }
  for(const t of data.tasks){
   await c.query(`INSERT INTO task(wedding_id,type,title,function_id,owner_id,vendor_id,due_at,status)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
    [wid,t.type,t.title,funcs[t.function],people[t.owner],vendors[t.vendor_name]||null,t.due_at,t.status]);
  }
  for(const g of data.gifts){
   await c.query(`INSERT INTO gift_entry(wedding_id,family_id,token_no,gift_type,description,amount)
    VALUES($1,$2,$3,$4,$5,$6)`,
    [wid,families[g.family_name],g.token_no,g.gift_type,g.description,g.amount||null]);
  }
  await c.query('COMMIT');
  console.log(JSON.stringify({seeded:true,wedding_id:wid,people:Object.keys(people),demo_access_keys:data.people.map(p=>p.access_key)}));
 } catch(e) { await c.query('ROLLBACK'); console.error(e); process.exitCode=1; }
 finally { c.release(); await pool.end(); }
})();
