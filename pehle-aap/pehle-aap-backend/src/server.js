const express = require('express');
const helmet = require('helmet');
const morgan = require('morgan');
const { pool } = require('./db');
const { auth, allow } = require('./auth');
const { flagsFor } = require('./flags');
const { prom, middleware, queueLength } = require('./metrics');
const multer = require('multer');
const {translate,speak,transcribe,chat,suggestLanguage,signedUpload,saveAudio}=require('./integrations');
const {contextFor}=require('./pinky');
const upload=multer({storage:multer.memoryStorage(),limits:{fileSize:12*1024*1024}});

const app = express();
app.use(helmet({contentSecurityPolicy:false})); // The supplied HTML uses inline event handlers; replace them with delegated listeners before enabling a strict CSP.
app.use(express.json({ limit: '2mb' }));
app.use(express.static(require('path').join(__dirname,'../public')));
app.use((req,res,next) => {
  const origin = process.env.CORS_ORIGIN || '*';
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
app.use(middleware);
app.use(morgan((tokens,req,res) => JSON.stringify({
  level:'info', event:'http_request', method:tokens.method(req,res),
  path:tokens.url(req,res), status:Number(tokens.status(req,res)),
  response_ms:Number(tokens['response-time'](req,res))
})));

app.get('/api/health', async (req,res) => {
  await pool.query('SELECT 1');
  res.json({ ok:true, service:process.env.APP_NAME || 'pehle-aap-api' });
});
app.get('/api/metrics', async (req,res) => {
  try {
    const q = await pool.query(`SELECT count(*)::int AS n FROM guest_checkin WHERE status='waiting'`);
    queueLength.set(q.rows[0].n);
  } catch {}
  res.set('Content-Type', prom.register.contentType);
  res.end(await prom.register.metrics());
});

app.use('/api', auth);
app.get('/api/status/me',(req,res)=>res.json({person:req.person}));
app.get('/api/flags',async(req,res)=>res.json(await flagsFor(req.person)));
app.post('/api/vendors/:id/booking',allow('couple'),async(req,res)=>{const amount=Number(req.body.agreed_amount);if(!Number.isFinite(amount)||amount<0)return res.status(400).json({error:'Valid agreed_amount required'});const v=await pool.query('SELECT id FROM vendor WHERE id=$1 AND wedding_id=$2',[req.params.id,req.person.wedding_id]);if(!v.rowCount)return res.status(404).json({error:'Vendor not found'});const b=await pool.query(`INSERT INTO booking(wedding_id,vendor_id,agreed_amount,status) VALUES($1,$2,$3,'booked') RETURNING *`,[req.person.wedding_id,req.params.id,amount]);res.status(201).json(b.rows[0]);});

app.get('/api/status/:key', async (req,res) => {
  const flags = await flagsFor(req.person);
  const queue = await pool.query(
    `SELECT count(*)::int AS waiting FROM guest_checkin
     WHERE status='waiting' AND wedding_id=$1`, [req.person.wedding_id]);
  res.json({ person:req.person, flags, queue:queue.rows[0] });
});

app.get('/api/dashboard', allow('couple','team'), async (req,res) => {
  const wid = req.person.wedding_id;
  const [vendors,tasks,functions,gifts] = await Promise.all([
    pool.query(`SELECT v.id,v.name,v.category,b.agreed_amount,
      COALESCE(sum(pm.paid_amount),0) AS paid,
      b.agreed_amount-COALESCE(sum(pm.paid_amount),0) AS balance
      FROM vendor v LEFT JOIN booking b ON b.vendor_id=v.id
      LEFT JOIN payment_milestone pm ON pm.booking_id=b.id
      WHERE v.wedding_id=$1 GROUP BY v.id,b.id ORDER BY v.name`,[wid]),
    pool.query(`SELECT t.*,f.name AS function_name FROM task t
      LEFT JOIN wedding_function f ON f.id=t.function_id
      WHERE t.wedding_id=$1 ORDER BY t.due_at NULLS LAST`,[wid]),
    pool.query(`SELECT f.*, count(t.id)::int AS total,
      count(t.id) FILTER (WHERE t.status IN ('confirmed','set_up','done'))::int AS ready
      FROM wedding_function f LEFT JOIN task t ON t.function_id=f.id
      WHERE f.wedding_id=$1 GROUP BY f.id ORDER BY f.sort_order`,[wid]),
    req.person.role === 'couple'
      ? pool.query(`SELECT count(*)::int AS entries,COALESCE(sum(amount),0) AS total
        FROM gift_entry WHERE wedding_id=$1`,[wid])
      : Promise.resolve({rows:[{entries:null,total:null}]})
  ]);
  res.json({ vendors:vendors.rows, tasks:tasks.rows, functions:functions.rows, gifts:gifts.rows[0] });
});

app.get('/api/vendors', allow('couple','team','vendor'), async (req,res) => {
  const p=req.person;
  const params=[p.wedding_id];
  let scope='';
  if (p.role==='vendor') { scope=' AND v.id=$2'; params.push(p.vendor_id); }
  const r=await pool.query(`SELECT v.*,b.id AS booking_id,b.agreed_amount,
    COALESCE(sum(pm.paid_amount),0) AS paid,
    b.agreed_amount-COALESCE(sum(pm.paid_amount),0) AS balance,
    min(pm.due_at) FILTER (WHERE pm.status<>'paid') AS next_due,
    string_agg(DISTINCT wf.name, ', ' ORDER BY wf.name) AS functions,
    COALESCE(b.status,'vendor_added') AS status
    FROM vendor v LEFT JOIN booking b ON b.vendor_id=v.id
    LEFT JOIN payment_milestone pm ON pm.booking_id=b.id
    LEFT JOIN booking_function bf ON bf.booking_id=b.id
    LEFT JOIN wedding_function wf ON wf.id=bf.function_id
    WHERE v.wedding_id=$1 ${scope}
    GROUP BY v.id,b.id ORDER BY v.name`,params);
  // Non-couple users never receive payment amounts unless an explicit assignment allows it.
  if (p.role!=='couple') r.rows.forEach(x=>{delete x.agreed_amount;delete x.paid;delete x.balance;});
  res.json(r.rows);
});

app.post('/api/vendors', allow('couple'), async (req,res) => {
  const {name,category,contact_name,phone,source}=req.body;
  if (!name || !category) return res.status(400).json({error:'name and category are required'});
  const r=await pool.query(`INSERT INTO vendor(wedding_id,name,category,contact_name,phone,source)
    VALUES($1,$2,$3,$4,$5,$6) RETURNING *`,
    [req.person.wedding_id,name,category,contact_name,phone,source || 'own_vendor']);
  res.status(201).json(r.rows[0]);
});


app.get('/api/members',allow('couple','team'),async(req,res)=>{const r=await pool.query(`SELECT id,full_name,role FROM person WHERE wedding_id=$1 AND active=true ORDER BY full_name`,[req.person.wedding_id]);res.json(r.rows)});
app.get('/api/payments',allow('couple'),async(req,res)=>{const r=await pool.query(`SELECT v.name vendor_name,pm.id,pm.title,pm.amount,pm.paid_amount,pm.due_at,pm.status FROM payment_milestone pm JOIN booking b ON b.id=pm.booking_id JOIN vendor v ON v.id=b.vendor_id WHERE b.wedding_id=$1 ORDER BY pm.due_at`,[req.person.wedding_id]);res.json(r.rows)});
app.post('/api/payments/:id/record',allow('couple'),async(req,res)=>{const amount=Number(req.body.amount);if(!Number.isFinite(amount)||amount<=0)return res.status(400).json({error:'Valid amount required'});const r=await pool.query(`UPDATE payment_milestone pm SET paid_amount=LEAST(pm.amount,pm.paid_amount+$1),paid_at=now(),status=CASE WHEN pm.paid_amount+$1>=pm.amount THEN 'paid' ELSE 'partial' END FROM booking b WHERE pm.booking_id=b.id AND b.wedding_id=$2 AND pm.id=$3 RETURNING pm.*`,[amount,req.person.wedding_id,req.params.id]);if(!r.rowCount)return res.status(404).json({error:'Payment milestone not found'});res.json(r.rows[0])});

app.get('/api/functions', allow('couple','team','vendor','guest'), async (req,res) => {
  const r=await pool.query(`SELECT f.*,count(t.id)::int AS total,
    count(t.id) FILTER (WHERE t.status IN ('confirmed','set_up','done'))::int AS ready
    FROM wedding_function f LEFT JOIN task t ON t.function_id=f.id
    WHERE f.wedding_id=$1 GROUP BY f.id ORDER BY f.sort_order`,[req.person.wedding_id]);
  res.json(r.rows);
});

app.get('/api/tasks', async (req,res) => {
  const p=req.person;
  const r=await pool.query(`SELECT t.*,f.name AS function_name,v.name AS vendor_name
    FROM task t LEFT JOIN wedding_function f ON f.id=t.function_id
    LEFT JOIN vendor v ON v.id=t.vendor_id
    WHERE t.wedding_id=$1 AND (
      $2='couple' OR t.owner_id=$3 OR t.backup_id=$3 OR
      EXISTS (SELECT 1 FROM assignment a WHERE a.member_id=$3 AND
        ((a.scope='event' AND a.scope_id=t.function_id) OR
         (a.scope='vendor' AND a.scope_id=t.vendor_id))) OR
      ($2='vendor' AND t.vendor_id=$4))
    ORDER BY t.due_at NULLS LAST`,[p.wedding_id,p.role,p.id,p.vendor_id]);
  res.json(r.rows);
});
app.post('/api/tasks', allow('couple','team'), async (req,res) => {
  const b=req.body;
  if (!b.title || !b.type) return res.status(400).json({error:'title and type are required'});
  const r=await pool.query(`INSERT INTO task
    (wedding_id,type,title,qty,function_id,vendor_id,owner_id,backup_id,due_at,window_start,window_end,repeat_rule)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
    [req.person.wedding_id,b.type,b.title,b.qty,b.function_id,b.vendor_id,b.owner_id,b.backup_id,
     b.due_at,b.window_start,b.window_end,b.repeat_rule]);
  res.status(201).json(r.rows[0]);
});
app.patch('/api/tasks/:id', async (req,res) => {
  const b=req.body,p=req.person;
  const allowed=['arranged','confirmed','set_up','done','at_risk','to_do'];
  if (!allowed.includes(b.status)) return res.status(400).json({error:'Invalid task status'});
  const r=await pool.query(`UPDATE task SET status=$1,progress_note=COALESCE($2,progress_note),
    updated_by=$3,updated_via=$4,updated_at=now()
    WHERE id=$5 AND wedding_id=$6 AND (
      $7='couple' OR owner_id=$3 OR backup_id=$3 OR
      EXISTS(SELECT 1 FROM assignment a WHERE a.member_id=$3 AND
      ((a.scope='event' AND a.scope_id=task.function_id) OR (a.scope='vendor' AND a.scope_id=task.vendor_id))) OR
      ($7='vendor' AND vendor_id=$8))
    RETURNING *`,[b.status,b.progress_note,p.id,b.updated_via || 'tap',req.params.id,p.wedding_id,p.role,p.vendor_id]);
  if (!r.rowCount) return res.status(404).json({error:'Task not found or not in your scope'});
  res.json(r.rows[0]);
});

app.get('/api/gifts', allow('couple','team'), async (req,res) => {
  const r=await pool.query(`SELECT g.id,g.token_no,g.gift_type,g.description,g.amount,g.estimated_value,
    g.thanked_at,f.family_name,f.side FROM gift_entry g LEFT JOIN family f ON f.id=g.family_id
    WHERE g.wedding_id=$1 ORDER BY g.created_at DESC`,[req.person.wedding_id]);
  if(req.person.role!=='couple') r.rows.forEach(x=>{delete x.amount;delete x.estimated_value;});
  res.json(r.rows);
});
app.post('/api/gifts', allow('couple','team'), async (req,res) => {
  const b=req.body;
  if(!b.gift_type) return res.status(400).json({error:'gift_type is required'});
  const r=await pool.query(`INSERT INTO gift_entry(wedding_id,family_id,token_no,gift_type,description,amount,estimated_value,recorded_by)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [req.person.wedding_id,b.family_id,b.token_no,b.gift_type,b.description,
     req.person.role==='couple'?b.amount:null,b.estimated_value,req.person.id]);
  res.status(201).json(r.rows[0]);
});

app.get('/api/queue', async (req,res) => {
  const r=await pool.query(`SELECT c.token_no,c.headcount,c.arrived_at,c.due_at,c.status
    FROM guest_checkin c JOIN family f ON f.id=c.family_id
    WHERE f.wedding_id=$1 AND c.status='waiting' ORDER BY c.due_at,c.token_no`,[req.person.wedding_id]);
  res.json(r.rows);
});
app.post('/api/checkin/me', async (req,res) => {
  if(req.person.role!=='guest' || !req.person.family_id) return res.status(403).json({error:'Guest family profile is not linked'});
  const f=await pool.query('SELECT id,headcount,elders,leave_by FROM family WHERE id=$1 AND wedding_id=$2',[req.person.family_id,req.person.wedding_id]);
  if(!f.rowCount) return res.status(404).json({error:'Family not found'});
  const family=f.rows[0], count=Number(req.body.headcount||family.headcount), flags=await flagsFor(req.person);
  const cfg=flags.flags.queue_due_minutes||{regular:45,elder:15,leave_buffer:10}; const now=new Date();
  let due=new Date(now.getTime()+(family.elders?cfg.elder:cfg.regular)*60000);
  if(family.leave_by) due=new Date(Math.max(now.getTime(),new Date(family.leave_by).getTime()-cfg.leave_buffer*60000));
  const r=await pool.query(`INSERT INTO guest_checkin(family_id,token_no,headcount,due_at) VALUES($1,nextval('guest_token_seq'),$2,$3) ON CONFLICT(family_id) DO UPDATE SET headcount=EXCLUDED.headcount RETURNING *`,[family.id,count,due]);
  res.status(201).json(r.rows[0]);
});
app.post('/api/checkin/:inviteKey', async (req,res) => {
  const f=await pool.query(`SELECT id,wedding_id,headcount,elders,leave_by FROM family
    WHERE invite_key_hash=encode(digest($1,'sha256'),'hex')`,[req.params.inviteKey]);
  if(!f.rowCount || f.rows[0].wedding_id!==req.person.wedding_id) return res.status(404).json({error:'Invite not found'});
  const family=f.rows[0], count=Number(req.body.headcount || family.headcount);
  const flags=await flagsFor(req.person);
  const due= new Date();
  const q=flags.flags.queue_due_minutes || {regular:45,elder:15,leave_buffer:10};
  let dueAt=new Date(due.getTime()+(family.elders?q.elder:q.regular)*60000);
  if(family.leave_by) dueAt=new Date(Math.max(due.getTime(),new Date(family.leave_by).getTime()-q.leave_buffer*60000));
  const r=await pool.query(`INSERT INTO guest_checkin(family_id,token_no,headcount,due_at)
    VALUES($1,nextval('guest_token_seq'),$2,$3)
    ON CONFLICT(family_id) DO UPDATE SET headcount=EXCLUDED.headcount
    RETURNING *`,[family.id,count,dueAt]);
  res.status(201).json(r.rows[0]);
});
app.post('/api/stage/next', allow('couple','team'), async (req,res) => {
  const next=await pool.query(`SELECT c.* FROM guest_checkin c JOIN family f ON f.id=c.family_id
    WHERE f.wedding_id=$1 AND c.status='waiting' ORDER BY c.due_at,c.token_no LIMIT 1`,[req.person.wedding_id]);
  if(!next.rowCount) return res.json({message:'Queue is empty'});
  const c=next.rows[0];
  await pool.query('BEGIN');
  try {
    await pool.query(`UPDATE guest_checkin SET status='called' WHERE id=$1`,[c.id]);
    await pool.query(`INSERT INTO stage_log(wedding_id,family_id,token_no,action,actor_id)
      VALUES($1,$2,$3,'called',$4)`,[req.person.wedding_id,c.family_id,c.token_no,req.person.id]);
    await pool.query('COMMIT');
  } catch(e) { await pool.query('ROLLBACK'); throw e; }
  res.json({token_no:c.token_no,headcount:c.headcount,status:'called'});
});

app.get('/api/pinky/context', async (req,res) => {
  // Return only role-scoped context; never give the model unrestricted database access.
  const p=req.person, wid=p.wedding_id;
  const tasks=await pool.query(`SELECT title,status,due_at FROM task WHERE wedding_id=$1 AND
    ($2='couple' OR owner_id=$3 OR backup_id=$3) ORDER BY due_at LIMIT 20`,[wid,p.role,p.id]);
  const context={tasks:tasks.rows};
  if(p.role==='couple') {
    const v=await pool.query(`SELECT v.name,b.agreed_amount,
      COALESCE(sum(pm.paid_amount),0) paid FROM vendor v JOIN booking b ON b.vendor_id=v.id
      LEFT JOIN payment_milestone pm ON pm.booking_id=b.id
      WHERE v.wedding_id=$1 GROUP BY v.id,b.id`,[wid]);
    const g=await pool.query(`SELECT count(*)::int entries,coalesce(sum(amount),0) total
      FROM gift_entry WHERE wedding_id=$1`,[wid]);
    context.vendors=v.rows; context.gifts=g.rows[0];
  }
  if(p.role==='team') {
    const f=await pool.query(`SELECT f.name,count(t.id)::int tasks FROM assignment a
      JOIN wedding_function f ON a.scope='event' AND a.scope_id=f.id
      LEFT JOIN task t ON t.function_id=f.id WHERE a.member_id=$1 GROUP BY f.id`,[p.id]);
    context.assigned_functions=f.rows;
  }
  res.json(context);
});


// Read/write endpoints used by the HTML UI.
app.get('/api/wedding', async (req,res)=>{
 const r=await pool.query('SELECT id,name,event_start,event_end,venue_name,city,timezone FROM wedding WHERE id=$1',[req.person.wedding_id]);res.json(r.rows[0]||{});
});
app.put('/api/preferences/language', async(req,res)=>{
 const lang=String(req.body.language||'').slice(0,12);if(!/^[a-z]{2}(-[A-Z]{2})?$/.test(lang))return res.status(400).json({error:'Invalid language code'});
 await pool.query('UPDATE person SET preferred_lang=$1 WHERE id=$2',[lang,req.person.id]);
 if(req.person.family_id) await pool.query('UPDATE family SET preferred_lang=$1 WHERE id=$2',[lang,req.person.family_id]);
 if(req.person.vendor_id) await pool.query('UPDATE vendor SET preferred_lang=$1 WHERE id=$2',[lang,req.person.vendor_id]);res.json({ok:true,preferred_lang:lang});
});
app.post('/api/lang/suggest',async(req,res)=>{
 const lat=Number(req.body.latitude),lng=Number(req.body.longitude);if(!Number.isFinite(lat)||!Number.isFinite(lng)||Math.abs(lat)>90||Math.abs(lng)>180)return res.status(400).json({error:'Valid coordinates required'});
 const result=await suggestLanguage(lat,lng);res.json(result);
});
app.post('/api/uploads/sign',async(req,res)=>{const f=await flagsFor(req.person);if(f.flags.photo_upload_enabled===false)return res.status(403).json({error:'Photo uploads are disabled for this wedding'});const {name,type}=req.body||{};if(!name||!type)return res.status(400).json({error:'name and type required'});res.json(await signedUpload(name,type));});
app.post('/api/pinky/chat',async(req,res)=>{
 const message=String(req.body.message||'').trim();if(!message)return res.status(400).json({error:'message required'});
 const f=await flagsFor(req.person);if(f.flags.pinky_bua===false)return res.status(403).json({error:'Pinky Bua is disabled for this wedding'});
 const ctx=await contextFor(req.person);const lang=req.person.preferred_lang||'en-IN';
 const system=`You are Pinky Bua, a warm, concise wedding assistant. Answer in English; the server will translate your answer into ${lang}. Use ONLY the JSON context supplied below. Never invent data. Never disclose data outside the user's role. Role permissions: couple sees all; team sees only assigned tasks/functions and no money; vendor sees own booking/tasks only and no other vendor prices or guest contacts; guest sees own RSVP/token/schedule only. Do not make database changes. If a user asks to record/update anything, explain that they must use the relevant confirmation control. Context JSON: ${JSON.stringify(ctx)}`;
 const history=Array.isArray(req.body.history)?req.body.history.slice(-8).filter(x=>['user','assistant'].includes(x.role)).map(x=>({role:x.role,content:String(x.content).slice(0,1500)})):[];
 const result=await chat([{role:'system',content:system},...history,{role:'user',content:message}]);
 let answer=result.choices?.[0]?.message?.content||result.choices?.[0]?.message?.reasoning_content||'Sorry, I could not prepare an answer. Please try again.';
 if(lang!=='en-IN') { try{answer=await translate(answer,lang)}catch(e){console.error('translation_failed',e.message)} }
 res.json({answer,language:lang,role:req.person.role});
});
app.post('/api/voice/transcribe',upload.single('audio'),async(req,res)=>{
 if(!req.file)return res.status(400).json({error:'audio file required'});const result=await transcribe(req.file.buffer,req.file.mimetype);const path=await saveAudio(req.file.buffer,req.file.mimetype,req.person.wedding_id);await pool.query(`INSERT INTO voice_update(wedding_id,speaker_id,speaker_type,audio_path,original_text,original_lang) VALUES($1,$2,$3,$4,$5,$6)`,[req.person.wedding_id,req.person.id,req.person.role,path,result.text,result.language]);res.json({...result,audio_path:path});
});
app.post('/api/voice/speak',async(req,res)=>{
 const f=await flagsFor(req.person);if(f.flags.voice_announcements===false)return res.status(403).json({error:'Voice output is disabled for this wedding'});const text=String(req.body.text||'').trim(),lang=String(req.body.language||req.person.preferred_lang||'en-IN');if(!text)return res.status(400).json({error:'text required'});
 const audio=await speak(text,lang);res.json({audio_base64:audio,mime_type:'audio/wav'});
});
app.post('/api/voice/ask',upload.single('audio'),async(req,res)=>{
 if(!req.file)return res.status(400).json({error:'audio file required'});const transcript=await transcribe(req.file.buffer,req.file.mimetype);const audioPath=await saveAudio(req.file.buffer,req.file.mimetype,req.person.wedding_id);
 const f=await flagsFor(req.person);if(f.flags.pinky_bua===false)return res.status(403).json({error:'Pinky Bua is disabled'});
 const ctx=await contextFor(req.person);const lang=req.person.preferred_lang||transcript.language||'en-IN';
 const system=`You are Pinky Bua. Answer briefly and warmly in English; the server will translate into ${lang}. Use only this role-filtered wedding context: ${JSON.stringify(ctx)}. Never infer or reveal unavailable records. Never mutate data; ask for explicit confirmation through the UI for any change.`;
 const result=await chat([{role:'system',content:system},{role:'user',content:transcript.text}]);let answer=result.choices?.[0]?.message?.content||'I could not answer that yet.';
 if(lang!=='en-IN'){try{answer=await translate(answer,lang)}catch{}}
 let audio=null;try{audio=await speak(answer,lang)}catch(e){console.error('tts_failed',e.message)}
 await pool.query(`INSERT INTO voice_update(wedding_id,speaker_id,speaker_type,audio_path,original_text,original_lang,translations) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)`,[req.person.wedding_id,req.person.id,req.person.role,audioPath,transcript.text,transcript.language,JSON.stringify({[lang]:answer})]);
 res.json({transcript:transcript.text,detected_language:transcript.language,answer,audio_base64:audio,mime_type:'audio/wav'});
});
app.get('/api/metrics/health',async(req,res)=>res.json({sarvam_configured:Boolean(process.env.SARVAM_API_KEY),flagsmith_configured:Boolean(process.env.FLAGSMITH_SERVER_KEY),geocoding_configured:Boolean(process.env.GEOCODING_API_KEY),storage_configured:Boolean(process.env.GCS_BUCKET)}));

app.use((err,req,res,next) => {
  console.error(JSON.stringify({level:'error',event:'request_failed',path:req.path,message:err.message}));
  res.status(500).json({error:'Internal server error'});
});
const port=Number(process.env.PORT || 3000);
app.listen(port,()=>console.log(JSON.stringify({level:'info',event:'server_started',port})));
