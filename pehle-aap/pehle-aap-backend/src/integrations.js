const { Storage } = require('@google-cloud/storage');
const crypto = require('crypto');
const { pool } = require('./db');
const { flagsFor } = require('./flags');
const storage = new Storage();
const LANG_BY_STATE = {
  Karnataka:'kn-IN','Tamil Nadu':'ta-IN','West Bengal':'bn-IN',Maharashtra:'mr-IN',
  Gujarat:'gu-IN',Punjab:'pa-IN',Kerala:'ml-IN',Odisha:'od-IN',
  Telangana:'te-IN','Andhra Pradesh':'te-IN'
};
function sarvamHeaders(){
  if(!process.env.SARVAM_API_KEY) throw new Error('SARVAM_API_KEY is not configured');
  return {'api-subscription-key':process.env.SARVAM_API_KEY};
}
async function sarvamJson(path, body){
  const r=await fetch(`https://api.sarvam.ai${path}`,{method:'POST',headers:{...sarvamHeaders(),'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(30000)});
  const data=await r.json().catch(()=>({})); if(!r.ok) throw new Error(`Sarvam ${r.status}: ${data.message||data.error||'request failed'}`); return data;
}
async function translate(text,to){
  const d=await sarvamJson('/translate',{input:text,source_language_code:'auto',target_language_code:to,model:'mayura:v1'});
  return d.translated_text||d.translatedText||text;
}
async function speak(text,lang){
  const d=await sarvamJson('/text-to-speech',{text:String(text).slice(0,2500),language_code:lang,model:process.env.SARVAM_TTS_MODEL||'bulbul:v3',speaker:process.env.SARVAM_TTS_SPEAKER||'shubh'});
  return d.audios?.[0]||null;
}
async function transcribe(buffer,mimetype='audio/webm'){
  const form=new FormData();
  const ext=mimetype.includes('wav')?'wav':mimetype.includes('mp4')?'mp4':'webm';
  form.append('file',new Blob([buffer],{type:mimetype}),`voice.${ext}`);
  form.append('model',process.env.SARVAM_STT_MODEL||'saaras:v4'); form.append('mode','transcribe');
  const r=await fetch('https://api.sarvam.ai/speech-to-text',{method:'POST',headers:sarvamHeaders(),body:form,signal:AbortSignal.timeout(45000)});
  const d=await r.json().catch(()=>({})); if(!r.ok) throw new Error(`Sarvam STT ${r.status}: ${d.message||d.error||'request failed'}`);
  return {text:d.transcript||d.text||'',language:d.language_code||d.language||null};
}
async function chat(messages){
  return sarvamJson('/v1/chat/completions',{model:process.env.SARVAM_CHAT_MODEL||'sarvam-105b-conversations',messages,temperature:0.2,max_tokens:700});
}
async function suggestLanguage(lat,lng){
  if(!process.env.GEOCODING_API_KEY) return {suggested_lang:null,reason:'geocoding_not_configured'};
  const u=new URL('https://maps.googleapis.com/maps/api/geocode/json'); u.searchParams.set('latlng',`${lat},${lng}`); u.searchParams.set('result_type','administrative_area_level_1'); u.searchParams.set('key',process.env.GEOCODING_API_KEY);
  const r=await fetch(u,{signal:AbortSignal.timeout(12000)}); const d=await r.json();
  const state=d.results?.[0]?.address_components?.find(x=>x.types.includes('administrative_area_level_1'))?.long_name;
  return {state:state||null,suggested_lang:LANG_BY_STATE[state]||null,reason:state?'state_lookup':'state_not_found'};
}
async function saveAudio(buffer,mimetype,weddingId){
  if(!process.env.GCS_BUCKET) throw new Error('GCS_BUCKET is not configured');
  const ext=mimetype&&mimetype.includes('wav')?'wav':mimetype&&mimetype.includes('mp4')?'mp4':'webm';
  const path=`weddings/${weddingId}/voice/${crypto.randomUUID()}.${ext}`;
  await storage.bucket(process.env.GCS_BUCKET).file(path).save(buffer,{resumable:false,metadata:{contentType:mimetype||'audio/webm',cacheControl:'private, max-age=0'}});
  return path;
}
async function signedUpload(name,type){
  if(!process.env.GCS_BUCKET) throw new Error('GCS_BUCKET is not configured');
  const safe=String(name).replace(/[^a-zA-Z0-9._-]/g,'_').slice(0,100);
  const file=storage.bucket(process.env.GCS_BUCKET).file(`weddings/${Date.now()}-${safe}`);
  const [url]=await file.getSignedUrl({version:'v4',action:'write',expires:Date.now()+10*60*1000,contentType:type});
  return {url,path:file.name};
}
module.exports={translate,speak,transcribe,chat,suggestLanguage,signedUpload,saveAudio};
