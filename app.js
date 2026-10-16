'use strict';
const $=s=>document.querySelector(s);
const DEF_MODEL='gemini-3.8-flash';
const PLANG={English:'en-US',Spanish:'es-US',Portuguese:'pt-BR',French:'fr-FR',Chinese:'zh-CN',Vietnamese:'vi-VN',Tagalog:'fil-PH',Korean:'ko-KR',Arabic:'ar-SA',Hindi:'hi-IN'};
function prof(){try{return JSON.parse(localStorage.getItem('otocue_profile')||'null')}catch(_){return null}}
function saveProf(p){localStorage.setItem('otocue_profile',JSON.stringify(p))}
// existing users (key or contacts already saved) get a profile automatically and skip setup
(function(){if(prof())return;if(localStorage.getItem('otocue_key')||localStorage.getItem('otocue_contacts')||localStorage.getItem('otocue_contacts_bak'))saveProf({first:'J',nick:'',lang:'English',city:'',migrated:true})})();
const uname=()=>{const p=prof();return p?(p.nick||p.first||''):''};
const ulang=()=>{const p=prof();return p&&p.lang&&p.lang!=='English'?PLANG[p.lang]:''};
function profileCtx(){const p=prof();if(!p)return'';return ` The user's name is ${p.first}${p.nick?` (call them ${p.nick})`:''}.`+(p.city?` Their home city is ${p.city}; use it for weather, directions and "near me" questions when no place is given.`:'')+(p.lang&&p.lang!=='English'?` Reply in ${p.lang} unless asked otherwise.`:'')}
const S={get key(){return localStorage.getItem('otocue_key')||''},get model(){return localStorage.getItem('otocue_model')||DEF_MODEL},
 get voice(){return localStorage.getItem('otocue_voice')||''},get rate(){return parseFloat(localStorage.getItem('otocue_rate')||'1')}};
const SR=window.SpeechRecognition||window.webkitSpeechRecognition;
const LANGS=['Spanish','French','German','Italian','Portuguese','Japanese','Korean','Chinese (Mandarin)','Hindi','Arabic','Russian','Vietnamese','Tagalog','English'];
const LCODE={Spanish:'es-ES',French:'fr-FR',German:'de-DE',Italian:'it-IT',Portuguese:'pt-BR',Japanese:'ja-JP',Korean:'ko-KR','Chinese (Mandarin)':'zh-CN',Hindi:'hi-IN',Arabic:'ar-SA',Russian:'ru-RU',Vietnamese:'vi-VN',Tagalog:'fil-PH',English:'en-US'};
let wakeFails=0,lastAnswer='',busy=false,curRec=null,wakeRec=null,wakeOn=false,stopFn=null;
const status=t=>$('#status').textContent=t||'';

const FALLBACKS=['gemini-flash-latest','gemini-3.6-flash','gemini-2.5-flash'];
try{navigator.storage&&navigator.storage.persist&&navigator.storage.persist()}catch(_){}
let noSearch=sessionStorage.getItem('otocue_nosearch')==='1';const HIST=[];
function contactsCtx(){try{const c=JSON.parse(localStorage.getItem('otocue_contacts')||'[]');if(!c.length)return '';return ' The user shared these contacts: '+c.map(x=>`${x.name}: ${x.tel||''} ${x.email||''}`).join('; ')+'. If the user asks to call or text one of them, include exactly [CALL:number] or [TEXT:number] in your reply.'}catch(_){return ''}}
function timeCtx(s){const d=new Date(),tz=Intl.DateTimeFormat().resolvedOptions().timeZone;return ` The current date and time for the user is ${d.toLocaleString('en-US',{timeZone:tz,dateStyle:'full',timeStyle:'long'})} (time zone ${tz}); exact UTC time ${d.toISOString()}. Use this for any question about the current time or date anywhere, converting time zones yourself.`+(s?' Use Google Search for anything current (weather, news, scores, prices, hours).':'')}
const LIVE_RE=/\b(weather|forecast|temperature|rain|snow|news|headlines?|scores?|game|match|today|tonight|tomorrow|yesterday|latest|recent|currently|current|now|price|prices|cost|stocks?|market|crypto|bitcoin|open now|hours|near me|nearby|who won|winner|results?|election|this week|this weekend|next week|traffic|flights?|release date|update|live)\b/i;
function needsSearch(parts){const t=(parts||[]).map(p=>p.text||'').join(' ');return LIVE_RE.test(t)}
// Thinking control per model (Gemini docs, Oct 2026): 3.8-flash supports low|medium|high; 3.6/3/lite support minimal; 2.5-flash uses thinkingBudget 0.
function thinkCfg(m){m=m||'';if(/2\.5-flash/.test(m))return{thinkingBudget:0};if(/(3\.6-flash|3-flash|flash-lite)/.test(m))return{thinkingLevel:'minimal'};if(/gemini-[34]/.test(m)||/latest/.test(m))return{thinkingLevel:'low'};return null}
let noThink=false;
function buildRequest(parts,system,model,hist,search){
 const key=S.key; if(!key) throw new Error('Add your free Gemini API key in Settings first.');
 const m=model||S.model,tc=noThink?null:thinkCfg(m),gc={maxOutputTokens:tc&&tc.thinkingLevel==='low'?700:300};if(tc)gc.thinkingConfig=tc;
 if(search===undefined)search=!noSearch&&needsSearch(parts);
 const body={systemInstruction:{parts:[{text:system+profileCtx()+timeCtx(search)+contactsCtx()}]},contents:(hist||[]).concat([{role:'user',parts}]),generationConfig:gc};
 if(search)body.tools=[{google_search:{}}];
 return {search,url:`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(m)}:generateContent`,
  init:{method:'POST',headers:{'Content-Type':'application/json','x-goog-api-key':key},body:JSON.stringify(body)}};
}
async function geminiRaw(parts,system=SYS,model,hist){
 const {url,init,search}=buildRequest(parts,system,model,hist);
 const r=await fetch(url,init);
 if(search&&(r.status===429||r.status===400||r.status===403)){noSearch=true;sessionStorage.setItem('otocue_nosearch','1');return await geminiRaw(parts,system,model,hist)}
 if(r.status===400&&!noThink){noThink=true;return await geminiRaw(parts,system,model,hist)}
 if((r.status===503||r.status===429||r.status===404)&&!model){ for(const m of FALLBACKS) if(m!==S.model){ try{return await geminiRaw(parts,system,m,hist)}catch(_){} } } const j=await r.json().catch(()=>({}));
 if(r.status===429){const d=(j.error?.details||[]).find(x=>x.retryDelay),sec=Math.ceil(parseFloat(d?d.retryDelay:((j.error?.message||'').match(/retry in ([\d.]+)s/i)||[])[1])||0);const e=new Error('Free Gemini quota reached for now'+(sec?` — try again in about ${sec}s.`:'. Try again in a minute.')+' Local commands still work.');e.quota=true;e.retry=sec;throw e}
 if(!r.ok) throw new Error(j.error?.message||('Gemini error '+r.status));
 const t=(j.candidates?.[0]?.content?.parts||[]).filter(p=>!p.thought).map(p=>p.text||'').join('').trim();
 if(!t) throw new Error('No answer returned.'); return t;
}
const ACACHE=new Map();function ctxHist(h,parts){h=h||[];const q=JSON.stringify(parts);let i=h.length;while(i>=2&&JSON.stringify(h[i-2].parts)===q)i-=2;return h.slice(Math.max(0,i-2),i)}
let qT=null;
async function gemini(parts,system=SYS,model,hist){
 if(navigator.onLine===false) throw new Error("You're offline. Timers, alarms, reminders and the time still work offline.");
 const k=parts.every(p=>p.text!=null)&&!needsSearch(parts)?JSON.stringify([system,parts,ctxHist(hist,parts)]):null;
 if(k){const c=ACACHE.get(k);if(c&&Date.now()-c.t<600e3)return c.a}
 try{const a=await geminiRaw(parts,system,model,hist);if(k){ACACHE.set(k,{a,t:Date.now()});if(ACACHE.size>30)ACACHE.delete(ACACHE.keys().next().value)}return a}
 catch(e){if(e instanceof TypeError)throw new Error("You're offline or the network failed. Try again.");
  if(e.quota&&e.retry){clearInterval(qT);let n=e.retry;qT=setInterval(()=>{n--;if(n<=0){clearInterval(qT);status('Quota should be back — try again.')}else if(!busy)status(`Gemini quota: try again in ${n}s`)},1000)}throw e}}
const SYS='You are OtoCue, a concise AI assistant heard through an earpiece. Answer in 1-4 short spoken sentences, plain text, no markdown or lists. You cannot set alarms, timers, reminders, make calls, send texts or emails, or take any action on the device yourself; the app handles those only when the user uses command phrasing. Never claim you have done or set anything. If asked, say to use a command like "wake me up at 7 AM to <song>", "set an alarm for 6:30", "timer 5 minutes", "call Mom", "text Mom that I am on my way", "email Mom subject Dinner I will be late", "post to X <text>" or "share this".';

function speak(text,lang){
 if(!('speechSynthesis' in window)) return; speechSynthesis.cancel();
 const u=new SpeechSynthesisUtterance(text.replace(/[*#_`]/g,'')); u.rate=S.rate;
 const vs=speechSynthesis.getVoices();
 lang=lang||ulang();let v=lang?vs.find(x=>x.lang.replace('_','-').startsWith(lang.slice(0,2))):vs.find(x=>x.name===S.voice);
 if(v){u.voice=v;u.lang=v.lang} else if(lang) u.lang=lang;
 u.onend=()=>{if(wakeOn) startWake()}; pauseWake(); speechSynthesis.speak(u);
}
function show(you,ans,lang){ if(you!=null)$('#you').textContent=you; $('#out').textContent=ans; lastAnswer=ans; window._lastLang=lang; speak(ans,lang); }

// ---- listening: SpeechRecognition, fallback MediaRecorder -> Gemini audio
function pickMime(){if(!window.MediaRecorder)return '';for(const t of ['audio/webm;codecs=opus','audio/webm','audio/mp4','audio/aac','audio/ogg'])try{if(MediaRecorder.isTypeSupported(t))return t}catch(_){}return ''}
function micHelp(){const ios=/iPhone|iPad|iPod/.test(navigator.userAgent);status('Microphone blocked.');$('#out').textContent='🎙 Microphone access is blocked. '+(ios?'On iPhone: tap “aA” in the address bar › Website Settings › Microphone › Allow (or Settings › Safari › Microphone › Allow), then reload.':'Tap the icon left of the address › Permissions › Microphone › Allow, then reload.')+' You can also type below.'}
function record(ms){return new Promise(async(res,rej)=>{if(!(navigator.mediaDevices&&window.MediaRecorder))return rej(new Error('No microphone support in this browser. Type your question below.'));
 try{const st=await navigator.mediaDevices.getUserMedia({audio:true});const mt=pickMime(),mr=mt?new MediaRecorder(st,{mimeType:mt}):new MediaRecorder(st),ch=[];
  mr.ondataavailable=e=>{if(e.data&&e.data.size)ch.push(e.data)};
  mr.onstop=async()=>{st.getTracks().forEach(t=>t.stop());const b=new Blob(ch,{type:mr.mimeType||mt||'audio/webm'});if(!b.size)return res({text:''});res({audio:{mimeType:(b.type||'audio/webm').split(';')[0],data:await b64(b)}})};
  mr.start(1000);const stop=()=>{clearTimeout(t);if(mr.state!=='inactive')mr.stop()},t=setTimeout(stop,ms||8000);stopFn=stop;
 }catch(e){if(e&&e.name==='NotAllowedError'){micHelp();e=new Error('Microphone permission denied.');e.code='not-allowed'}rej(e)}})}
function listenSR({ms=0,continuous=false,lang}={}){return new Promise((res,rej)=>{
 const r=new SR();curRec=r;r.lang=lang||ulang()||navigator.language||'en-US';r.interimResults=true;r.continuous=continuous;let fin='',timer,lastInt='',stopped=false,done=false;const end=Date.now()+(ms||60000);
 const finish=()=>{if(done)return;done=true;clearTimeout(timer);if(curRec===r)curRec=null;res({text:(fin.trim()||lastInt.trim()),stopped})};
 r.onresult=e=>{let it='';for(let i=e.resultIndex;i<e.results.length;i++){const t=e.results[i][0].transcript;if(e.results[i].isFinal)fin+=t+' ';else it+=t}lastInt=it;$('#you').textContent=(fin+it).trim()||'…'};
 r.onerror=e=>{if(e.error==='not-allowed'||e.error==='service-not-allowed'){done=true;clearTimeout(timer);curRec=null;micHelp();const x=new Error('Microphone permission denied.');x.code='not-allowed';return rej(x)}
  if(continuous||e.error==='no-speech'||e.error==='aborted')return;done=true;clearTimeout(timer);curRec=null;rej(new Error('Mic: '+e.error))};
 // continuous (Soft Listen): keep restarting on pauses until time is up, accumulating text
 r.onend=()=>{if(done)return;if(continuous&&curRec===r&&Date.now()<end){if(lastInt){fin+=lastInt+' ';lastInt=''}setTimeout(()=>{if(curRec!==r||done)return finish();try{r.start()}catch(_){finish()}},120);return}finish()};
 if(ms)timer=setTimeout(()=>{curRec=null;try{r.stop()}catch(_){}setTimeout(finish,800)},ms);
 stopFn=()=>{stopped=true;const c=curRec;curRec=null;try{c&&c.stop()}catch(_){}setTimeout(finish,800)};try{r.start()}catch(e){rej(e)}});}
async function listen(o={}){
 if(SR){try{const h=await listenSR(o);if(h.text||h.stopped||!o.fallback||!window.MediaRecorder)return h;status('Didn’t catch that — recording instead, speak again…')}
  catch(e){if(e.code==='not-allowed'||!o.fallback||!window.MediaRecorder)throw e;status('Recording… speak now')}
  return record(o.ms||8000)}
 return record(o.ms||7000)}
const b64=b=>new Promise(r=>{const f=new FileReader();f.onload=()=>r(f.result.split(',')[1]);f.readAsDataURL(b)});
const partsFrom=(heard,prompt)=>heard.audio?[{inline_data:{mime_type:heard.audio.mimeType,data:heard.audio.data}},{text:prompt}]:[{text:prompt+'\n\n"'+heard.text+'"'}];

async function run(label,fn){ if(busy) return; busy=true; $('#ask').classList.add('rec'); pauseWake();
 try{await fn()}catch(e){status('');if(e.code!=='not-allowed')$('#out').textContent='⚠ '+e.message}finally{busy=false;$('#ask').classList.remove('rec');stopFn=null; if(wakeOn&&!speechSynthesis.speaking) startWake()} }

async function doAsk(pre){ await run('ask',async()=>{
 let heard; if(pre) heard={text:pre}; else {status('Listening… ask your question');speechSynthesis.cancel();heard=await listen({ms:SR?0:7000,fallback:true});}
 if(!heard.audio&&!heard.text){status('Didn\'t catch that.');return}
 {const bm=document.getElementById('buyMaps');if(bm)bm.remove()}
 if(heard.text&&await localCmd(heard.text)) return;
 if(heard.text)lastQ=heard.text; status('Thinking…'); const q=heard.audio?partsFrom(heard,'Answer the question asked in this audio.'):[{text:heard.text}]; const a=await gemini(q,SYS,undefined,HIST.slice(-12));
 HIST.push({role:'user',parts:[{text:heard.text||'(voice question)'}]},{role:'model',parts:[{text:a}]}); while(HIST.length>12) HIST.shift();
 status(''); show(heard.text??'(voice)',a); });}
async function doSoft(){ await run('soft',async()=>{ status('Soft Listen: listening for 30s…'); speechSynthesis.cancel();
 const heard=await listen({ms:30000,continuous:true,fallback:true});
 if(!heard.audio&&!heard.text){status('Heard nothing.');return}
 status('Summarizing…'); const a=await gemini(partsFrom(heard,'This is ~30 seconds of overheard speech/conversation. Briefly summarize it and, if there is a question or task in it, answer it.'));
 status(''); show(heard.text??'(30s audio)',a); });}
async function doTranslate(){ await run('tr',async()=>{ const L=$('#lang').value; localStorage.setItem('otocue_lang',L);
 status('Listening… speak now'); speechSynthesis.cancel(); const heard=await listen({ms:SR?0:8000,fallback:true});
 if(!heard.audio&&!heard.text){status('Didn\'t catch that.');return}
 status('Translating…'); const a=await gemini(partsFrom(heard,`Translate the following speech into ${L}. Output only the translation.`),'You are a precise translator. Output only the translated text.');
 status(''); show(heard.text??'(voice)',a,LCODE[L]); });}
async function doPhoto(){ const f=$('#pfile').files[0]; if(!f){status('Pick or take a photo first.');return}
 await run('photo',async()=>{ status('Looking…'); const img=await shrink(f); const q=$('#pq').value.trim()||'What is in this photo? Describe what matters.';
 const a=await gemini([{inline_data:{mime_type:'image/jpeg',data:img}},{text:q}]); status(''); show(q,a); });}
function shrink(file){return new Promise((res,rej)=>{const i=new Image();i.onload=()=>{const m=1280,s=Math.min(1,m/Math.max(i.width,i.height)),c=document.createElement('canvas');c.width=i.width*s;c.height=i.height*s;c.getContext('2d').drawImage(i,0,0,c.width,c.height);URL.revokeObjectURL(i.src);res(c.toDataURL('image/jpeg',.85).split(',')[1])};i.onerror=()=>rej(new Error('Could not read image'));i.src=URL.createObjectURL(file)})}

// ---- wake word
function startWake(){ if(!wakeOn||busy||!SR||wakeRec) return; const r=new SR(); wakeRec=r; r.continuous=true; r.interimResults=true; r.lang=ulang()||navigator.language||'en-US';
 r.onresult=e=>{wakeFails=0;for(let i=e.resultIndex;i<e.results.length;i++){const t=e.results[i][0].transcript.toLowerCase();
  const m=t.match(/\b(hey|hi|ok|okay)[ ,]*(cue|queue|q|kyu|cute|cu)\b(.*)/);
  if(m&&e.results[i].isFinal){pauseWake();const rest=m[3].trim();rest.split(' ').length>2?doAsk(rest):doAsk();return}}};
 r.onend=()=>{if(wakeRec===r){wakeRec=null;setTimeout(startWake,Math.min(30000,300*2**wakeFails))}}; r.onerror=e=>{if(e.error==='not-allowed'||e.error==='service-not-allowed'){wakeOn=false;$('#wake').checked=false;micHelp();wakeUI();return}if(e.error!=='no-speech'&&e.error!=='aborted')wakeFails=Math.min(wakeFails+1,7)};
 try{r.start();status('Listening for “Hey Cue”…')}catch(_){wakeRec=null;wakeFails=Math.min(wakeFails+1,7);setTimeout(startWake,Math.min(30000,300*2**wakeFails))}}
function wakeUI(){document.body.classList.toggle('wakeon',wakeOn);window.OtoCue&&window.OtoCue.lock&&window.OtoCue.lock()}
function pauseWake(){const r=wakeRec;wakeRec=null;if(r)try{r.abort()}catch(_){}}

// ---- UI wiring
let tapT=null;
$('#ask').addEventListener('click',()=>{ if(busy){stopFn&&stopFn();return} if(tapT){clearTimeout(tapT);tapT=null;doSoft();return} tapT=setTimeout(()=>{tapT=null;doAsk()},280)});
$('#softBtn').onclick=doSoft; $('#stopBtn').onclick=()=>{stopFn&&stopFn();speechSynthesis.cancel();status('')};
$('#trBtn').onclick=doTranslate; $('#pgo').onclick=doPhoto; $('#replay').onclick=()=>lastAnswer&&speak(lastAnswer,window._lastLang);
$('#pmic').onclick=async()=>{ if(!SR){status('Type your question (voice needs SpeechRecognition).');return} try{status('Listening…');const h=await listen();$('#pq').value=h.text;status('')}catch(e){status(e.message)}};
$('#pfile').onchange=()=>{const f=$('#pfile').files[0];if(f){$('#prev').src=URL.createObjectURL(f);$('#prev').style.display='block'}};
$('#wake').onchange=e=>{wakeOn=e.target.checked;localStorage.setItem('otocue_wake',wakeOn?'1':'');if(!SR&&wakeOn){status('Wake word needs Chrome/Edge/Safari speech recognition.');}wakeOn?startWake():(pauseWake(),status(''));wakeUI()};
document.querySelectorAll('.tabs button').forEach(b=>b.onclick=()=>{document.querySelectorAll('.tabs button,.panel').forEach(x=>x.classList.remove('on'));b.classList.add('on');$('#'+b.dataset.t).classList.add('on')});
$('#lang').innerHTML=LANGS.map(l=>`<option>${l}</option>`).join(''); $('#lang').value=localStorage.getItem('otocue_lang')||'Spanish';
function fillVoices(){const vs=speechSynthesis.getVoices();$('#voice').innerHTML='<option value="">Default</option>'+vs.map(v=>`<option value="${v.name.replace(/"/g,'&quot;')}">${v.name} (${v.lang})</option>`).join('');$('#voice').value=S.voice}
if('speechSynthesis' in window){fillVoices();speechSynthesis.onvoiceschanged=fillVoices}
$('#setBtn').onclick=()=>{$('#cfmSet').checked=confirmOn();$('#key').value=S.key;$('#model').value=S.model;$('#rate').value=S.rate;$('#voice').value=S.voice;$('#dlg').showModal()};
$('#close').onclick=()=>$('#dlg').close();
$('#save').onclick=()=>{localStorage.setItem('otocue_key',$('#key').value.trim());localStorage.setItem('otocue_model',$('#model').value.trim()||DEF_MODEL);localStorage.setItem('otocue_voice',$('#voice').value);localStorage.setItem('otocue_rate',$('#rate').value);localStorage.setItem('otocue_confirm',$('#cfmSet').checked?'1':'0');$('#dlg').close();status('Settings saved ✓');if(S.key)$('#out').textContent='Ready. Tap Ask.'};

if(localStorage.getItem('otocue_wake')){$('#wake').checked=true;wakeOn=true;}
document.addEventListener('visibilitychange',()=>{document.hidden?pauseWake():startWake()});
function showUpdate(){if($('#updToast'))return;const b=document.createElement('button');b.id='updToast';b.textContent='✨ New version — tap to update';b.onclick=()=>location.reload();document.body.appendChild(b)}
if('serviceWorker' in navigator){let had=!!navigator.serviceWorker.controller;navigator.serviceWorker.register('sw.js').then(r=>{r.update().catch(()=>{});r.addEventListener('updatefound',()=>{const w=r.installing;w&&w.addEventListener('statechange',()=>{if(w.state==='installed'&&navigator.serviceWorker.controller)showUpdate()})})}).catch(()=>{});
 navigator.serviceWorker.addEventListener('controllerchange',()=>{if(had)showUpdate();had=true})}
window.OtoCue={buildRequest,gemini,doAsk,listen,showUpdate,ACACHE};

$('#contactsBtn').onclick=async()=>{
 if(!('contacts' in navigator&&'select' in navigator.contacts)){status('Contacts sharing works in Chrome on Android. iPhone web apps can\'t access contacts.');return}
 status('Tap Select all (or pick everyone you text/call), then Done. You only do this once.');try{const r=await navigator.contacts.select(['name','tel'],{multiple:true});
  const c=r.map(x=>({name:(x.name||[])[0]||'',tel:(x.tel||[])[0]||'',email:(x.email||[])[0]||''}));
  const n=mergeContacts(c);status(`Shared ${c.length} contact(s) with OtoCue (${n} saved).`)}catch(e){status('Contacts: '+e.message)}};
(function(){const o=$('#out');if(!o)return;new MutationObserver(()=>{const t=o.textContent,m=t.match(/\[(CALL|TEXT):([^\]]+)\]/);if(m){o.textContent=t.replace(m[0],'');location.href=(m[1]==='CALL'?'tel:':'sms:')+m[2].replace(/[^+\d]/g,'')}}).observe(o,{childList:true,characterData:true,subtree:true})})();

// ---- v2 UI layer (visuals, chat, haptics, message)
(function(){
const buzz=(p=12)=>{try{if(navigator.userActivation&&!navigator.userActivation.hasBeenActive)return;navigator.vibrate&&navigator.vibrate(p)}catch(_){}};
document.addEventListener('pointerdown',e=>{if(e.target.closest('button'))buzz()},{passive:true});
window.greetUser=function(){const h=new Date().getHours();$('#greet').textContent=(h<5?'Up late':h<12?'Good morning':h<18?'Good afternoon':'Good evening')+(uname()?', '+uname():'')};greetUser();
const stage=$('#stage');let mic=null;
function setState(s){if(stage.dataset.state===s)return;stage.dataset.state=s;if(s==='listening')startMeter();else stopMeter()}
async function startMeter(){return;try{if(!navigator.permissions||!navigator.mediaDevices||!(window.AudioContext||window.webkitAudioContext))return;
 const p=await navigator.permissions.query({name:'microphone'}).catch(()=>null);if(!p||p.state!=='granted')return;
 const st=await navigator.mediaDevices.getUserMedia({audio:true});if(stage.dataset.state!=='listening'){st.getTracks().forEach(t=>t.stop());return}
 const ac=new(window.AudioContext||window.webkitAudioContext)(),an=ac.createAnalyser();an.fftSize=256;ac.createMediaStreamSource(st).connect(an);
 const d=new Uint8Array(an.frequencyBinCount),ask=$('#ask'),core=ask.querySelector('.core');mic={st,ac};stage.classList.add('live-audio');
 (function f(){if(!mic)return;an.getByteFrequencyData(d);let s=0;for(const v of d)s+=v;const w=Math.min(1,s/d.length/90);ask.style.setProperty('--w',w.toFixed(3));
  core.style.transform=`scale(${1-w*.08},${1+w*.06}) rotate(${(Math.random()-.5)*w*8}deg)`;requestAnimationFrame(f)})();
}catch(_){}}
function stopMeter(){stage.classList.remove('live-audio');$('#ask').style.setProperty('--w',0);const c=$('#ask .core');if(c)c.style.transform='';
 if(mic){mic.st.getTracks().forEach(t=>t.stop());mic.ac.close().catch(()=>{});mic=null}}
function sync(){const t=$('#status').textContent;
 if(/^(Thinking|Summariz|Translating|Looking)/.test(t))setState('thinking');
 else if(/^(Listening|Soft Listen)/.test(t)&&$('#ask').classList.contains('rec'))setState('listening');
 else if('speechSynthesis' in window&&speechSynthesis.speaking)setState('speaking');
 else setState('idle')}
new MutationObserver(sync).observe($('#status'),{childList:true,characterData:true,subtree:true});
new MutationObserver(sync).observe($('#ask'),{attributes:true,attributeFilter:['class']});setInterval(()=>{if(!document.hidden&&(stage.dataset.state!=='idle'||('speechSynthesis' in window&&speechSynthesis.speaking)))sync()},400);
document.addEventListener('visibilitychange',()=>document.body.classList.toggle('paused',document.hidden));
// chat history mirrors #out
const chat=$('#chat');let typer=null;
function bubble(cls,text,type){const b=document.createElement('div');b.className='bub '+cls;chat.appendChild(b);
 b.textContent=text;if(type)b.scrollIntoView({block:'nearest'});return b}
const out=$('#out');let last='';
function mirror(){const t=out.textContent;if(!t||t===last||/\[(CALL|TEXT):/.test(t))return;last=t;
 const you=$('#you').textContent;if(you&&you!=='—'&&you!=='…'&&!t.startsWith('⚠'))bubble('me',you);bubble('ai',t,true);buzz([8,40,8])}
new MutationObserver(()=>setTimeout(mirror,0)).observe(out,{childList:true,characterData:true,subtree:true});mirror();
// Message flow (no Gemini)
let to=null;const D=$('#msgDlg');
function sel(n,label){to=n;$('#mTo').textContent=n?'To: '+(label||n):'';document.querySelectorAll('#mList button').forEach(b=>b.classList.toggle('on',b.dataset.n===n))}
function list(){let c=[];try{c=JSON.parse(localStorage.getItem('otocue_contacts')||'[]')}catch(_){}c=c.filter(x=>x.tel);
 $('#mList').innerHTML=c.length?'':'<p class="hint">No shared contacts yet.</p>';
 c.forEach(x=>{const b=document.createElement('button');b.dataset.n=x.tel;b.innerHTML='<b></b><span></span>';b.querySelector('b').textContent=x.name||x.tel;b.querySelector('span').textContent=x.tel;b.onclick=()=>{$('#mNum').value='';sel(x.tel,x.name)};$('#mList').appendChild(b)})}
$('#msgBtn').onclick=()=>{list();sel(null);$('#mNum').value='';$('#mText').value='';D.showModal()};
window.OtoCue.openMessage=(p,t)=>{list();sel(p.tel,p.name);$('#mNum').value='';$('#mText').value=t||'';D.showModal()};
$('#mClose').onclick=()=>D.close();
$('#mLang').value=msgLang();$('#mLang').onchange=e=>localStorage.setItem('otocue_msglang',e.target.value);
function runMsgCommand(t){t=(t||'').trim().replace(/[.!?]+$/,'');const r=t.replace(/^(?:please\s+)?(?:send\s+(?:a\s+)?(?:text|message|sms)\s+(?:to\s+)?|text\s+|message\s+|tell\s+)/i,'').replace(/^([^,]{1,30}),\s*/,'$1 ');
 const isCall=/^(?:call|phone|dial|ring)\s/i.test(r)&&!/,/.test(t);D.close();return localCmd(isCall?r:'text '+r)}
// Ask in the modal: same start path as the main Ask (listen → listenSR → recognition.start), called synchronously inside the tap
$('#mAsk').onclick=()=>{const b=$('#mAsk');if(b.classList.contains('rec')){stopFn&&stopFn();return}
 pauseWake();try{curRec&&curRec.abort()}catch(_){}speechSynthesis.cancel();const lbl='🎙 Ask — say “text Pops I’m on my way”';b.classList.add('rec');b.textContent='🎙 Listening… speak now (tap to stop)';$('#mTo').textContent='Listening…';busy=true;
 listen({ms:SR?0:7000}).then(async h=>{busy=false;b.classList.remove('rec');b.textContent=lbl;const t=((h&&h.text)||'').trim();if(!t){$('#mTo').textContent='Didn\'t catch that. Tap Ask and try again.';return}$('#mTo').textContent='Heard: '+t;await runMsgCommand(t)})
  .catch(e=>{busy=false;b.classList.remove('rec');b.textContent=lbl;$('#mTo').textContent=e.message||'Mic error'}).finally(()=>{if(wakeOn)setTimeout(startWake,500)})};
$('#mNum').oninput=e=>sel(e.target.value.trim()||null);
$('#mPick').onclick=async()=>{if(!('contacts' in navigator&&'select' in navigator.contacts)){$('#mTo').textContent='Phone picker needs Chrome on Android — type the number instead.';$('#mNum').focus();return}
 try{const r=await navigator.contacts.select(['name','tel'],{multiple:false});const x=r[0];if(x&&x.tel&&x.tel[0])sel(x.tel[0],(x.name||[])[0])}catch(e){$('#mTo').textContent='Contacts: '+e.message}};
$('#mMic').onclick=async()=>{if(busy)return;const b=$('#mMic');b.textContent='🎙 Listening…';
 try{const h=await listen({ms:SR?0:8000});if(h.text)$('#mText').value=(($('#mText').value+' ')+h.text).trim();else if(h.audio)$('#mTo').textContent='Voice typing needs speech recognition — please type the message.'}catch(e){$('#mTo').textContent=e.message}finally{b.textContent='🎙 Speak'}};
$('#mSend').onclick=async()=>{const n=(to||'').replace(/[^+\d]/g,'');let t=$('#mText').value.trim();
 if(/^(?:text|message|tell|send\s+(?:a\s+)?(?:text|message))\s+\S/i.test(t)&&(!n||parseCmd(t)&&parseCmd(t).p)){await runMsgCommand(t);return}
 if(!n){$('#mTo').textContent='Choose a contact or enter a number.';return}if(!t){$('#mTo').textContent='Say or type a message.';return}
 const lg=msgLang();if(lg&&$('#mText').dataset.tr!==t){$('#mTo').textContent=`Translating to ${lg}…`;const r=await translateMsg(t,lg);if(r.ok){t=r.t;$('#mText').value=t;$('#mText').dataset.tr=t;$('#mTo').textContent=`Translated to ${lg}. Sending…`}else $('#mTo').textContent=`Couldn't translate, sending the original.`;await new Promise(r=>setTimeout(r,900))}
 buzz([10,30,10]);D.close();window.OtoCue.lastUrl=smsUrl(n,t);location.href=smsUrl(n,t)};
})();

// ---- local voice commands (no Gemini)
const CITY={'new york':'America/New_York','nyc':'America/New_York','los angeles':'America/Los_Angeles','la':'America/Los_Angeles','san francisco':'America/Los_Angeles','seattle':'America/Los_Angeles','las vegas':'America/Los_Angeles','chicago':'America/Chicago','houston':'America/Chicago','dallas':'America/Chicago','denver':'America/Denver','phoenix':'America/Phoenix','miami':'America/New_York','boston':'America/New_York','atlanta':'America/New_York','washington':'America/New_York','toronto':'America/Toronto','vancouver':'America/Vancouver','mexico city':'America/Mexico_City','honolulu':'Pacific/Honolulu','hawaii':'Pacific/Honolulu','anchorage':'America/Anchorage','sao paulo':'America/Sao_Paulo','rio':'America/Sao_Paulo','buenos aires':'America/Argentina/Buenos_Aires','bogota':'America/Bogota','lima':'America/Lima','santiago':'America/Santiago','london':'Europe/London','dublin':'Europe/Dublin','lisbon':'Europe/Lisbon','paris':'Europe/Paris','berlin':'Europe/Berlin','madrid':'Europe/Madrid','barcelona':'Europe/Madrid','rome':'Europe/Rome','milan':'Europe/Rome','amsterdam':'Europe/Amsterdam','brussels':'Europe/Brussels','zurich':'Europe/Zurich','vienna':'Europe/Vienna','stockholm':'Europe/Stockholm','oslo':'Europe/Oslo','copenhagen':'Europe/Copenhagen','helsinki':'Europe/Helsinki','warsaw':'Europe/Warsaw','prague':'Europe/Prague','athens':'Europe/Athens','istanbul':'Europe/Istanbul','moscow':'Europe/Moscow','kyiv':'Europe/Kyiv','cairo':'Africa/Cairo','lagos':'Africa/Lagos','nairobi':'Africa/Nairobi','johannesburg':'Africa/Johannesburg','dubai':'Asia/Dubai','tel aviv':'Asia/Jerusalem','jerusalem':'Asia/Jerusalem','riyadh':'Asia/Riyadh','tehran':'Asia/Tehran','karachi':'Asia/Karachi','mumbai':'Asia/Kolkata','delhi':'Asia/Kolkata','new delhi':'Asia/Kolkata','bangalore':'Asia/Kolkata','dhaka':'Asia/Dhaka','bangkok':'Asia/Bangkok','hanoi':'Asia/Ho_Chi_Minh','ho chi minh city':'Asia/Ho_Chi_Minh','jakarta':'Asia/Jakarta','singapore':'Asia/Singapore','kuala lumpur':'Asia/Kuala_Lumpur','manila':'Asia/Manila','hong kong':'Asia/Hong_Kong','beijing':'Asia/Shanghai','shanghai':'Asia/Shanghai','taipei':'Asia/Taipei','seoul':'Asia/Seoul','tokyo':'Asia/Tokyo','osaka':'Asia/Tokyo','sydney':'Australia/Sydney','melbourne':'Australia/Melbourne','brisbane':'Australia/Brisbane','perth':'Australia/Perth','auckland':'Pacific/Auckland'};
const NICK={mom:['mom','mommy','mama','mum','mother','ma','madre','mami','momma','mommie','mamma'],dad:['dad','daddy','papa','father','pa','pop','pops','padre','papi','dada'],grandma:['grandma','granny','nana','grandmother'],grandpa:['grandpa','grandfather','gramps'],wife:['wife','honey','babe'],husband:['husband','hubby']};
const APPS={youtube:['https://www.youtube.com','vnd.youtube://'],maps:['https://www.google.com/maps','geo:0,0'],'google maps':['https://www.google.com/maps'],spotify:['https://open.spotify.com','spotify:'],instagram:['https://www.instagram.com','instagram://app'],whatsapp:['https://web.whatsapp.com','whatsapp://'],gmail:['https://mail.google.com'],netflix:['https://www.netflix.com'],tiktok:['https://www.tiktok.com']};
function contacts(){let c=[];try{c=JSON.parse(localStorage.getItem('otocue_contacts')||'[]')}catch(_){}if(!c.length){try{c=JSON.parse(localStorage.getItem('otocue_contacts_bak')||'[]');if(c.length)localStorage.setItem('otocue_contacts',JSON.stringify(c))}catch(_){}}return c}
function saveContacts(c){const j=JSON.stringify(c);localStorage.setItem('otocue_contacts',j);localStorage.setItem('otocue_contacts_bak',j);window.OtoCue&&window.OtoCue.cl&&window.OtoCue.cl()}
const digits=t=>(t||'').replace(/[^+\d]/g,'');
function mergeContacts(add){const c=contacts();for(const x of add){if(!x.name&&!x.tel)continue;const i=c.findIndex(y=>(x.tel&&digits(y.tel)===digits(x.tel))||(y.name&&y.name===x.name));if(i>=0)c[i]={...c[i],...Object.fromEntries(Object.entries(x).filter(([,v])=>v))};else c.push(x)}saveContacts(c);return c.length}
function aliases(){try{return JSON.parse(localStorage.getItem('otocue_alias')||'{}')}catch(_){return{}}}
const normN=t=>(t||'').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g,'').replace(/['’`]/g,'').replace(/[^\p{L}\p{N}\s]/gu,' ').replace(/\s+/g,' ').trim();
const nickKey=q=>Object.keys(NICK).find(k=>NICK[k].includes(q))||'';
function smsUrl(n,t){return 'sms:'+digits(n)+(t?(/iPhone|iPad|iPod/.test(navigator.userAgent)?'&':'?')+'body='+encodeURIComponent(t):'')}
function lev(a,b){const d=[...Array(b.length+1).keys()];for(let i=1;i<=a.length;i++){let p=d[0];d[0]=i;for(let j=1;j<=b.length;j++){const t=d[j];d[j]=Math.min(d[j]+1,d[j-1]+1,p+(a[i-1]===b[j-1]?0:1));p=t}}return d[b.length]}
function findContact(q){q=normN(q).replace(/^(my|the|our)\s+/,'').trim();if(!q)return null;const cs=contacts(),key=nickKey(q)||q,al=aliases()[key];
 if(al&&al.tel){const hit=cs.find(c=>digits(c.tel)===digits(al.tel));return hit||al}
 const grp=NICK[key];if(!cs.length)return null;let best=null,bs=1e9;
 for(const c of cs){const n=normN(c.name);if(!n&&!c.rel)continue;const words=n.split(' '),rel=normN(c.rel||c.relationship||'');let s;
  if(n===q||rel===q||(grp&&grp.includes(rel)))s=0;else if(grp&&words.some(w=>grp.includes(w)))s=0.5;else if(words.includes(q)||n.startsWith(q+' '))s=1;else if(grp)s=99;else s=2+Math.min(...words.map(w=>lev(w,q)),lev(n,q));
  if(s<bs){bs=s;best=c}}
 return bs<=2+Math.max(1,Math.floor(q.length/4))?best:null}
// split "mom running late" into contact + message: longest matching name prefix wins
function splitWho(t){const w=t.trim().split(/\s+/);for(let n=Math.min(4,w.length);n>=1;n--){const who=w.slice(0,n).join(' '),p=findContact(who);if(p&&p.tel)return{p,who,msg:w.slice(n).join(' ').replace(/^(?:that|saying|says|and say|to say)\s+/i,'')}}
 const n=/^(my|the)$/i.test(w[0])&&w.length>1?2:1;return{p:null,who:w.slice(0,n).join(' '),msg:w.slice(n).join(' ').replace(/^(?:that|saying|says|and say|to say)\s+/i,'')}}
const canPick=()=>'contacts' in navigator&&'select' in navigator.contacts;
async function pickFor(who){const r=await navigator.contacts.select(['name','tel'],{multiple:false});const x=r&&r[0];if(!x||!x.tel||!x.tel[0])return null;
 const p={name:(x.name||[])[0]||who,tel:x.tel[0]};mergeContacts([p]);const k=nickKey(normN(who).replace(/^(my|the|our)\s+/,''))||normN(who).replace(/^(my|the|our)\s+/,'');const a=aliases();a[k]={name:p.name,tel:p.tel};localStorage.setItem('otocue_alias',JSON.stringify(a));return p}
// resolve a contact; if unknown, open the picker (now, or via a tap button if Chrome needs a fresh gesture)
async function resolveOrPick(you,who,kind,then){const p=findContact(who);if(p&&p.tel)return then(p);
 if(!canPick()){say(you,`I don't have “${who}” saved yet. Add them in Settings → Contacts and I'll remember.`);return}
 try{const q=await pickFor(who);if(q){status('');return then(q)}say(you,'No contact picked.');return}catch(_){}
 say(you,`Pick ${who} once and I'll remember.`);let b=$('#tapOpen');if(!b){b=document.createElement('a');b.id='tapOpen';b.className='btn';$('#timers').before(b)}b.removeAttribute('href');b.hidden=false;b.textContent=`👤 Pick ${who} to ${kind}`;
 b.onclick=async e=>{e.preventDefault();b.remove();try{const q=await pickFor(who);if(q)then(q)}catch(err){status('Contacts: '+err.message)}}}
function speakWait(t){show(null,t);return new Promise(r=>{let n=0;const w=setInterval(()=>{if(!('speechSynthesis' in window)||(!speechSynthesis.speaking&&n>2)||n>40){clearInterval(w);r()}n++},250)})}
var TLANG={spanish:['es'],portuguese:['pt'],french:['fr'],chinese:['zh-CN'],mandarin:['zh-CN'],vietnamese:['vi'],tagalog:['tl','fil-PH'],filipino:['tl','fil-PH'],korean:['ko'],arabic:['ar'],hindi:['hi']};
function msgLang(){return localStorage.getItem('otocue_msglang')||''}
async function translateMsg(t,lang){const L=TLANG[(lang||'').toLowerCase()];if(!L||!t)return{t,ok:true};
 try{const r=(await geminiRaw([{text:t}],`Translate the user's text message into ${lang}. Keep the tone casual. Output only the translation.`,undefined,[],false)).trim();if(r)return{t:r,ok:true,via:'gemini'}}catch(_){}
 for(const code of L){try{const j=await (await fetch('https://api.mymemory.translated.net/get?q='+encodeURIComponent(t)+'&langpair=en|'+code)).json();if(!j||j.responseStatus!=200)continue;const src=new Set(t.toLowerCase().match(/[a-z']+/g)||[]),eng=r=>{const w=r.toLowerCase().match(/[a-z']+/g)||[];return w.length&&w.filter(x=>src.has(x)).length/w.length>=.5};
  const ms=j.matches||[],cands=[...ms.filter(m=>m['created-by']==='MT!').map(m=>m.translation),(j.responseData||{}).translatedText];
  for(let r of cands){r=(r||'').trim();if(r&&!/MYMEMORY WARNING|INVALID/i.test(r)&&!eng(r)){const x=document.createElement('textarea');x.innerHTML=r;return{t:x.value,ok:true,via:'mymemory'}}}}catch(_){}}
 return{t,ok:false}}
async function textTo(you,p,msg,lang){if(!msg){await speakWait('What should I say?');try{status('Listening… say your message');msg=((await listen({ms:SR?0:7000})).text||'').trim()}catch(_){}status('');
  if(!msg){const t=prompt(`What should I text ${p.name}?`);msg=(t||'').trim()}if(!msg){say(you,'No message, so I didn\'t text.');return}}
 lang=lang||msgLang();let note='';if(lang){status(`Translating to ${lang}…`);const r=await translateMsg(msg,lang);status('');if(r.ok)msg=r.t;else note=` (Couldn't translate to ${lang}, sending the original.)`;const mt=document.getElementById('mText');if(mt)mt.value=msg}
 await confirmRun(you,`Texting ${p.name}${lang&&!note?' in '+lang:''}: “${msg}”.${note}`,smsUrl(p.tel,msg))}
function tzTime(tz){return new Date().toLocaleTimeString('en-US',{timeZone:tz,hour:'numeric',minute:'2-digit'})}
function say(you,t){status('');show(you,t)}
function sayNoContact(you,name){say(you,`I couldn't find “${name}” in your contacts. Add them in Settings → Contacts.`)}
const confirmOn=()=>localStorage.getItem('otocue_confirm')!=='0';
// open a URL right away: new tab with a fresh user gesture, same tab otherwise; big tap fallback if blocked
let lastQ='';function lastTopic(){return lastQ?lastQ.toLowerCase().replace(/[?.!]/g,'').split(/\s+/).filter(w=>!/^(what|which|where|how|who|does|do|did|is|are|should|can|could|would|my|i|me|a|an|the|need|needs|best|kind|of|type|for|to|eat|use|good|recommend|you)$/.test(w)).join(' '):''}
async function buyCmd(you,q){let prod=q,store='',tips='',cat='';status('Finding where to buy…');
 try{const ctx=HIST.slice(-4).map(h=>(h.role==='user'?'User: ':'Assistant: ')+h.parts[0].text).join('\n');
  const r=await geminiRaw([{text:(ctx?'Conversation:\n'+ctx+'\n\n':'')+'User now asks: "'+you+'"\n'+(q?'The product is: '+q+'.\n':'Work out which specific product the user wants to buy from the conversation.\n')+'Reply on ONE line exactly as: product name | store type for a maps search (plural, e.g. pet stores) | two well-known US retailers | category (one of: pet, home, electronics, pharmacy, auto, other). No other text.'}],'You extract shopping intent. Output only the requested single line.',undefined,[],false);
  const f=r.split('\n')[0].split('|').map(x=>x.trim().replace(/^["*]+|["*.]+$/g,''));if(!q&&f[0])prod=f[0];store=f[1]||'';tips=f[2]||'';cat=(f[3]||'').toLowerCase()}catch(_){}
 if(!prod)prod=lastTopic();status('');if(!prod){say(you,'What would you like to buy? Say "where can I buy" and the product.');return}
 prod=prod.toLowerCase();store=(store||'stores').toLowerCase();
 openNow(you,`Here's where to buy ${prod}.`+(tips?` You can also try ${tips.replace(/\s*,\s*/,' or ')} nearby.`:''),'https://www.google.com/search?tbm=shop&q='+encodeURIComponent(prod));
 if(!CATS[cat])cat=catOf(prod+' '+store);if(store==='stores'&&cat)store={pet:'pet stores',home:'hardware stores',electronics:'electronics stores',pharmacy:'pharmacies',auto:'auto parts stores'}[cat];
 const box=document.createElement('div');box.id='buyMaps';box.className='row buyrow';const mk=(t,u)=>{const a=document.createElement('a');a.className='btn2';a.target='_blank';a.rel='noopener';a.href=u;a.textContent=t;box.appendChild(a)};
 mk('📍 '+store[0].toUpperCase()+store.slice(1)+' near me','https://www.google.com/maps/search/'+encodeURIComponent(store).replace(/%20/g,'+')+'+near+me');
 for(const k of ['amazon','walmart','target',...(CATS[cat]||[])])mk(STORES[k][0],STORES[k][1]+encodeURIComponent(prod));$('#timers').before(box)}
const STORES={amazon:['Amazon','https://www.amazon.com/s?k='],walmart:['Walmart','https://www.walmart.com/search?q='],target:['Target','https://www.target.com/s?searchTerm='],petco:['Petco','https://www.petco.com/shop/en/petcostore/search?query='],petsmart:['PetSmart','https://www.petsmart.com/search/?q='],chewy:['Chewy','https://www.chewy.com/s?query='],homedepot:['Home Depot','https://www.homedepot.com/s/'],lowes:["Lowe's",'https://www.lowes.com/search?searchTerm='],bestbuy:['Best Buy','https://www.bestbuy.com/site/searchpage.jsp?st='],cvs:['CVS','https://www.cvs.com/search?searchTerm='],walgreens:['Walgreens','https://www.walgreens.com/search/results.jsp?Ntt='],autozone:['AutoZone','https://www.autozone.com/searchresult?searchText=']};
const CATS={pet:['petco','petsmart','chewy'],home:['homedepot','lowes'],electronics:['bestbuy'],pharmacy:['cvs','walgreens'],auto:['autozone']};
function catOf(t){t=t.toLowerCase();return /\b(pet|dog|cat|puppy|kitten|parrot|bird|fish|aquarium|hamster|rabbit|reptile|litter|kibble|leash|pellets?)\b/.test(t)?'pet':/\b(drill|tools?|paint|lumber|hardware|faucet|plumbing|garden|mulch|screws?|hammer|ladder|home improvement)\b/.test(t)?'home':/\b(tv|laptop|phone|iphone|headphones?|earbuds|airpods|camera|charger|monitor|tablet|ipad|console|electronics?)\b/.test(t)?'electronics':/\b(medicine|vitamins?|tylenol|advil|ibuprofen|allergy|pharmac\w*|bandages?|cough|cold|prescription|health)\b/.test(t)?'pharmacy':/\b(car|motor oil|oil filter|brake|tires?|wiper|battery|spark plugs?|auto\w*)\b/.test(t)?'auto':''}
function openNow(you,msg,url){if(you!==null)say(you,msg);window.OtoCue.lastUrl=url;const web=/^https?:/.test(url),act=!navigator.userActivation||navigator.userActivation.isActive;
 const fb=()=>{let b=$('#tapOpen');if(!b){b=document.createElement('a');b.id='tapOpen';b.className='btn';b.target='_blank';b.rel='noopener';$('#timers').before(b)}b.href=url;b.textContent='▶ Tap to '+(/^tel:/.test(url)?'call':/^(sms|mailto):/.test(url)?'send':/Playing/.test(msg)?'play':'open');b.onclick=()=>setTimeout(()=>b.remove(),300);b.hidden=false;window.OtoCue.fallback=true};
 if(web&&act){const w=window.open(url,'_blank');if(!w)fb();return}
 fb();setTimeout(()=>{location.href=url},web?700:0)}
async function confirmRun(you,msg,url){if(!confirmOn()){openNow(you,msg,url);return}show(you,msg+' Say yes or tap Confirm.');const box=$('#cfm');box.hidden=false;$('#cfmTxt').textContent=msg;
 const r=await new Promise(res=>{let done=false;const fin=v=>{if(done)return;done=true;box.hidden=true;stopFn&&stopFn();res(v)};window._cfm=fin;
  $('#cfmYes').onclick=()=>fin(true);$('#cfmNo').onclick=()=>fin(false);
  const go=()=>{if(done)return;status('Listening for yes / no…');listen({ms:5000}).then(h=>{if(done)return;const t=(h.text||'').toLowerCase();
   if(/\b(yes|yeah|yep|sure|ok|okay|confirm|do it|go)\b/.test(t))fin(true);else if(/\b(no|nope|cancel|stop|don'?t)\b/.test(t))fin(false);else status('Tap Confirm or Cancel.')}).catch(()=>status('Tap Confirm or Cancel.'))};
  if('speechSynthesis' in window&&SR){const w=setInterval(()=>{if(!speechSynthesis.speaking){clearInterval(w);go()}},250);setTimeout(()=>{clearInterval(w);go()},6000)}else status('Tap Confirm or Cancel.');
 });
 status('');if(r){$('#out').textContent='✓ '+msg.replace(/\.$/,'')+'…';window.OtoCue.lastUrl=url;if(/^https?:/.test(url)){if(!window.open(url,'_blank'))location.href=url}else location.href=url}else{$('#out').textContent='Cancelled.';speak('Cancelled.')}}
let timers=0;function startTimer(you,n,unit){const ms=n*(/^h/.test(unit)?3600e3:/^s/.test(unit)?1e3:60e3),lbl=`${n} ${n==1?unit.replace(/s$/,''):unit.replace(/s?$/,'s')}`;timers++;
 const el=document.createElement('div');el.className='timer glass';$('#timers').appendChild(el);const end=Date.now()+ms;
 const tick=()=>{const s=Math.max(0,Math.round((end-Date.now())/1000));el.textContent=`⏱ ${lbl}: ${Math.floor(s/60)}:${String(s%60).padStart(2,'0')}`;
  if(s<=0){clearInterval(iv);window._tmr=(window._tmr||[]).filter(x=>x.iv!==iv);el.textContent=`⏰ ${lbl} timer done!`;el.classList.add('done');try{navigator.vibrate&&navigator.vibrate([400,200,400,200,400])}catch(_){}speak(`Your ${lbl} timer is done.`);setTimeout(()=>el.remove(),15000)}};
 const iv=setInterval(tick,1000);(window._tmr=window._tmr||[]).push({el,iv,end,lbl});tick();say(you,`Timer set for ${lbl}.`)}
const NUMW={a:1,an:1,one:1,two:2,three:3,four:4,five:5,six:6,seven:7,eight:8,nine:9,ten:10,fifteen:15,twenty:20,thirty:30,forty:40,'forty five':45,sixty:60};
function parseCmd(raw){const t=raw.trim().replace(/[.?!]+$/,''),l=t.toLowerCase();let m;
 if(m=l.match(/^(?:please\s+)?(?:buy|order|find|get|search|shop for|look for|look up)\s+(?:me\s+)?(.+?)\s+(?:on|at|from)\s+(amazon|walmart|target|petco|petsmart|chewy|home depot|lowe'?s|best buy|cvs|walgreens|autozone)(?:\.com)?$/))return{k:'store',q:m[1].replace(/^(?:some|a|an|the)\s+/,''),st:m[2].replace(/'/g,'').replace(' ','')};
 if(m=l.match(/^(?:so\s+|ok\s+|okay\s+|and\s+)?(?:where|how)\s+(?:can|could|do|should|would)\s+(?:i|we)\s+(?:buy|purchase|get|order)\s*(.*?)(?:\s+(?:from|online|near me|nearby))?$/))if(!/^(?:to|there|home|back|in|out|on|rid)\b/.test(m[1])){const x=m[1].replace(/^(?:some|a|an|the)\s+/,'').trim();return{k:'buy',q:/^(?:it|that|this|them|those|these|one|some|any|stuff|)$/.test(x)?'':x}}
 if(m=l.match(/^(?:please\s+)?(?:call|phone|dial|ring)\s+(.+)$/))return{k:'call',who:t.slice(t.length-m[1].length)};
 if(m=t.match(/^(?:please\s+)?(?:send\s+(?:a\s+)?(?:text|message|sms)\s+to|text|message|sms|send\s+(?:a\s+)?(?:text|message)\s+(?=\S))\s*(.+)$/i)){let r=m[1].replace(/^to\s+/i,''),lg='';const lm=r.match(/\s+in\s+(spanish|portuguese|french|chinese|mandarin|vietnamese|tagalog|filipino|korean|arabic|hindi)\b[:,]?/i);if(lm){lg=lm[1][0].toUpperCase()+lm[1].slice(1).toLowerCase();r=(r.slice(0,lm.index)+' '+r.slice(lm.index+lm[0].length)).replace(/\s+/g,' ').trim()}const k=r.match(/^(.+?)(?:\s*,?\s+(?:that|saying|says|and say|to say)\s+|\s*:\s*)(.+)$/i);if(k&&findContact(k[1]))return{k:'text',who:k[1],msg:k[2],lg};const x=splitWho(r);return{k:'text',who:x.who,msg:x.msg,p:x.p,lg}}
 if(m=t.match(/^(?:send\s+(?:an\s+)?)?e-?mail(?:\s+to)?\s+(\S+(?:\s\S+)?)(?:\s*,?\s+(?:that|saying|about)?\s*(.*))?$/i)){
  const ws=(m[1]+' '+(m[2]||'')).trim().split(/\s+/);for(const n of [2,1]){const c=findContact(ws.slice(0,n).join(' '));if(c)return{k:'email',who:ws.slice(0,n).join(' '),c,msg:ws.slice(n).join(' ').replace(/^(that|saying|about)\s+/i,'')}}return{k:'email',who:ws[0],msg:ws.slice(1).join(' ')}}
 {const M=l.match(/^(?:please\s+)?(?:(?:can you\s+|could you\s+)?(?:get|buy|book|find|grab|order)\s+(?:me\s+|us\s+)?(?:some\s+|a\s+couple\s+|two\s+|2\s+)?(?:movie\s+)?tickets?\s+(?:to\s+see|to|for|to watch)\s+|(?:movie\s+)?tickets?\s+(?:to\s+see\s+|for\s+|to\s+)|(?:movie\s+)?showtimes?\s+(?:for\s+)?|when\s+is\s+(.+?)\s+playing|i\s+(?:want|wanna|would like)\s+to\s+(?:see|watch)\s+(?=.+\s+(?:in|at)\s+(?:the\s+)?(?:theaters?|theatres?|cinemas?|the movies)$))(.*)$/);
  if(M){let q=(M[1]||M[2]||'').replace(/\s+(?:in|at)\s+(?:the\s+)?(?:theaters?|theatres?|cinemas?|movies)$/,'').replace(/\s+(?:near me|nearby|tonight|today|tomorrow|this weekend|please|on fandango)$/g,'').replace(/^(?:the\s+(?:new\s+)?movie\s+|the\s+film\s+|movie\s+|film\s+|see\s+|watch\s+)/,'').replace(/\s+(?:movie|film)$/,'').trim();
   if(q)return{k:'movie',q:q.replace(/\b\w/g,c=>c.toUpperCase())}}}
 if(/^(?:what(?:'s| is)\s+playing|what movies are (?:playing|showing|out)|movies?\s+(?:near me|nearby|playing)|(?:movie\s+)?showtimes?(?:\s+near me)?)(?:\s+(?:near me|nearby|tonight|today|in theaters))?$/.test(l))return{k:'url',msg:'Opening movie showtimes on Fandango.',u:'https://www.fandango.com/movietimes'};
 if(/^(?:find\s+(?:me\s+)?(?:a\s+)?(?:gas|gas station)|(?:nearest\s+|closest\s+)?gas stations?\s+(?:near me|nearby)|cheapest gas|where can i get gas)(?:\s+near me|\s+nearby)?$/.test(l))return{k:'url',msg:'Finding gas stations near you.',u:'https://www.google.com/maps/search/gas+station+near+me'};
 if(m=l.match(/^(?:(?:get|call|order|book)\s+(?:me\s+)?(?:a\s+|an\s+)?(?:ride|uber|lyft|car)|uber|ride)\s+to\s+(.+)$/))return{k:'url',msg:`Getting a ride to ${m[1]}.`,u:'https://m.uber.com/ul/?action=setPickup&pickup=my_location&dropoff[formatted_address]='+encodeURIComponent(m[1])};
 if(m=l.match(/^(?:(?:book|find|get|search)\s+(?:me\s+)?(?:a\s+)?)?(?:flights?|plane tickets?)\s+to\s+(.+)$/))return{k:'url',msg:`Searching flights to ${m[1]}.`,u:'https://www.google.com/travel/flights?q='+encodeURIComponent('Flights to '+m[1])};
 if(m=l.match(/^(?:(?:book|find|get|search)\s+(?:me\s+)?(?:a\s+)?)?hotels?\s+(?:in|near|at)\s+(.+)$/))return{k:'url',msg:`Searching hotels in ${m[1]}.`,u:'https://www.google.com/travel/hotels/'+encodeURIComponent(m[1])};
 if(m=l.match(/^(?:(?:find\s+)?(?:food|restaurants?|places to eat)|(?:find\s+)?(.+?)\s+(?:restaurants?|places?))\s+(?:near me|nearby)$/))return{k:'url',msg:`Finding ${m[1]||'restaurants'} near you.`,u:'https://www.google.com/maps/search/'+encodeURIComponent(m[1]||'restaurants').replace(/%20/g,'+')+'+near+me'};
 if(/^(?:i'?m|i am)\s+(?:so\s+|really\s+)?(?:hungry|starving)$|^order\s+(?:some\s+)?food$|^(?:get|order)\s+(?:me\s+)?(?:some\s+)?(?:food|delivery|takeout)$/.test(l))return{k:'url',msg:'Opening DoorDash.',u:'https://www.doordash.com/'};
 if(m=l.match(/^(?:order|get me|i want|deliver)\s+(?:me\s+)?(?:some\s+|a\s+)?(.+?)(?:\s+(?:delivered|for delivery|from doordash|on doordash))?$/))if(!/\b(?:ride|uber|lyft|ticket|flight|hotel|directions|text|call|email|message|timer|alarm|reminder|to)\b/.test(m[1])&&m[1].split(' ').length<=4)return{k:'url',msg:`Ordering ${m[1]} on DoorDash.`,u:'https://www.doordash.com/search/store/'+encodeURIComponent(m[1])+'/'};
 if(m=l.match(/^(?:find\s+(?:me\s+)?(?:a\s+|an\s+)?|nearest\s+|closest\s+)?(?:([a-z-]+(?:\s[a-z-]+)?)\s+)?(?:car\s+)?(?:dealerships?|dealers?)(?:\s+(?:near me|nearby))?$/)){const b=(m[1]||'').replace(/^(?:car|auto|a|an|the)$/,'');return{k:'url',msg:`Finding ${b?b.replace(/\b\w/g,c=>c.toUpperCase())+' ':''}car dealerships near you.`,u:'https://www.google.com/maps/search/'+(b?encodeURIComponent(b).replace(/%20/g,'+')+'+':'')+'car+dealership+near+me'}}
 if(m=l.match(/^(?:find\s+(?:me\s+)?(?:a\s+|an\s+)?|nearest\s+|closest\s+)?(?:([a-z-]+(?:\s[a-z-]+)?)\s+)?(schools?|colleges?|universit(?:y|ies))(?:\s+(?:near me|nearby))?$/)){const t=(m[1]||'').replace(/^(?:a|an|the)$/,''),col=/^c|^u/.test(m[2]);const q=col?(m[2].startsWith('u')?'universities':'colleges'):(t?t.replace(/\s+/g,'+')+'+':'')+'schools';return{k:'url',msg:`Finding ${q.replace(/\+/g,' ')} near you.`,u:'https://www.google.com/maps/search/'+q+'+near+me'}}
 if((m=l.match(/^(?:find\s+(?:me\s+)?|where(?:'s| is)\s+|show me\s+)?(?:a\s+|an\s+|the\s+)?(?:nearest\s+|closest\s+)?(.+?)\s+(?:near me|nearby|around here)$/))||(m=l.match(/^(?:find\s+(?:me\s+)?(?:a|an|the)\s+(?:nearest\s+|closest\s+)?|where(?:'s| is)\s+(?:the\s+)?(?:nearest|closest)\s+|(?:nearest|closest)\s+)(.+?)$/))){const q=m[1].replace(/^(?:a|an|the)\s+/,'');if(q&&q.split(' ').length<=4)return{k:'url',msg:`Finding ${q} near you.`,u:'https://www.google.com/maps/search/'+encodeURIComponent(q).replace(/%20/g,'+')+'+near+me'}}
 if(m=l.match(/^(?:navigate|directions|take me|drive|get directions|give me directions)\s+(?:to\s+)?(.+)$/))return{k:'nav',q:m[1]};
 if(m=l.match(/^(?:play)\s+(.+?)(?:\s+on\s+(spotify|youtube))?$/))return{k:'play',q:m[1],on:m[2]};
 if(m=l.match(/^open\s+(?:the\s+)?(.+?)(?:\s+app)?$/))if(APPS[m[1]])return{k:'open',app:m[1]};
 if(m=l.match(/^(?:set\s+(?:a\s+)?)?timer\s+(?:for\s+)?(\d+|[a-z]+(?:\s[a-z]+)?)\s+(minutes?|mins?|hours?|seconds?|secs?)/)||(m=l.match(/^set\s+(?:a\s+)?(\d+|[a-z]+)\s+(minutes?|hours?|seconds?)\s+timer/))){const n=+m[1]||NUMW[m[1]];if(n)return{k:'timer',n,unit:m[2].replace(/^min$|^mins$/,'minutes').replace(/^secs?$/,'seconds')}}
 if(m=l.match(/^(?:what(?:'s| is)?\s+(?:the\s+)?)?(?:current\s+)?time\s+(?:is\s+it\s+)?(?:right\s+now\s+|now\s+)?in\s+(.+?)[?.!]*$/))return{k:'tz',city:m[1].replace(/^the\s+/,'')};
 if(/^(?:what(?:'s| is)\s+(?:the\s+)?)?(?:current\s+)?time(?:\s+is\s+it)?(?:\s+now)?$|^what time is it/.test(l))return{k:'time'};
 if(/^(?:what(?:'s| is)\s+)?(?:today'?s?\s+)?(?:the\s+)?date(?:\s+today)?$|^what day is (?:it|today)/.test(l))return{k:'date'};
 if(m=l.match(/^(?:search(?:\s+for)?|google|look up)\s+(.+)$/))return{k:'search',q:m[1]};
 return null}
let localCmd=async function(text){const c=parseCmd(text);if(!c)return false;const you=text;
 switch(c.k){
  case 'store':openNow(you,`Searching ${STORES[c.st][0]} for ${c.q}.`,STORES[c.st][1]+encodeURIComponent(c.q));break;
  case 'buy':await buyCmd(you,c.q);break;
  case 'call':{const dig=digits(c.who);if(!findContact(c.who)&&dig.length>=3){await confirmRun(you,`Calling ${c.who}.`,'tel:'+dig);break}
   await resolveOrPick(you,c.who,'call',p=>confirmRun(you,`Calling ${p.name}.`,'tel:'+digits(p.tel)));break}
  case 'text':{const dig=digits(c.who);if(!c.p&&!findContact(c.who)&&dig.length>=3){await textTo(you,{name:c.who,tel:dig},c.msg,c.lg);break}
   if(c.p){await textTo(you,c.p,c.msg,c.lg);break}await resolveOrPick(you,c.who,'text',p=>textTo(you,p,c.msg,c.lg));break}
  case 'email':{const p=c.c||findContact(c.who);if(!p||!p.email){p?say(you,`${p.name} has no email in your shared contacts.`):sayNoContact(you,c.who);break}
   await confirmRun(you,`Emailing ${p.name}${c.msg?': “'+c.msg+'”':''}.`,'mailto:'+p.email+'?body='+encodeURIComponent(c.msg||''));break}
  case 'url':openNow(you,c.msg,c.u);break;
  case 'movie':openNow(you,`Opening tickets for ${c.q} on Fandango.`,'https://www.fandango.com/search?q='+encodeURIComponent(c.q)+'&mode=all');break;
  case 'nav':openNow(you,`Getting directions to ${c.q}.`,'https://www.google.com/maps/dir/?api=1&destination='+encodeURIComponent(c.q));break;
  case 'search':openNow(you,`Searching Google for ${c.q}.`,'https://www.google.com/search?q='+encodeURIComponent(c.q));break;
  case 'play':openNow(you,`Playing ${c.q} on ${c.on==='spotify'?'Spotify':'YouTube'}.`,c.on==='spotify'?'https://open.spotify.com/search/'+encodeURIComponent(c.q):'https://www.youtube.com/results?search_query='+encodeURIComponent(c.q));break;
  case 'open':{const u=APPS[c.app],android=/Android/i.test(navigator.userAgent);openNow(you,`Opening ${c.app[0].toUpperCase()+c.app.slice(1)}.`,u[0]);break}
  case 'timer':startTimer(you,c.n,c.unit);break;
  case 'time':say(you,`It's ${new Date().toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit'})}.`);break;
  case 'tz':{const z=CITY[c.city];if(!z)return false;const n=c.city.replace(/\b\w/g,x=>x.toUpperCase());say(you,`It's ${tzTime(z)} in ${n} (${new Date().toLocaleDateString('en-US',{timeZone:z,weekday:'long'})}).`);break}
  case 'date':say(you,`Today is ${new Date().toLocaleDateString('en-US',{weekday:'long',month:'long',day:'numeric',year:'numeric'})}.`);break}
 return true}
Object.assign(window.OtoCue,{parseCmd,findContact,localCmd});

$('#typeForm').onsubmit=async e=>{e.preventDefault();const v=$('#typeQ').value.trim();if(!v)return;if(busy){if(window.OtoCue.conv&&window.OtoCue.conv())$('#convBtn').click();stopFn&&stopFn();for(let i=0;i<30&&busy;i++)await new Promise(r=>setTimeout(r,100))}$('#typeQ').value='';$('#you').textContent=v;window._typed=true;doAsk(v).finally(()=>{window._typed=false})};

// ---- alarms (local, no Gemini)
(function(){
const KEY='otocue_alarms';let pend=null,ac=null,beepT=null,ringing=null,wl=null;
const load=()=>{try{return JSON.parse(localStorage.getItem(KEY)||'[]')}catch(_){return[]}},saveA=a=>{localStorage.setItem(KEY,JSON.stringify(a));render();lock()};
const fmt=t=>new Date(t).toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit',second:(t-Date.now()<120e3)?'2-digit':undefined});
const NW={a:1,an:1,one:1,two:2,three:3,four:4,five:5,six:6,seven:7,eight:8,nine:9,ten:10,fifteen:15,twenty:20,thirty:30,forty:40,'forty five':45,fifty:50,sixty:60};
function parseWhen(s){s=s.toLowerCase().trim().replace(/[.?!]+$/,'');let tm=false;if(/\btomorrow\b/.test(s)){tm=true;s=s.replace(/\b(tomorrow|at)\b/g,' ').replace(/\s+/g,' ').trim()}const v=pw(s);if(v&&tm&&v-Date.now()<86400e3&&/\d/.test(s)&&!/^in\b|from now/.test(s)){const d=new Date(v);if(d.getDate()===new Date().getDate())d.setDate(d.getDate()+1);return d.getTime()}return v}
function pw(s){let m;
 if(m=s.match(/^(?:in\s+)?(\d+|[a-z]+(?:\s[a-z]+)?)\s+(seconds?|secs?|minutes?|mins?|hours?|hrs?)(?:\s+from\s+now)?$/)){const n=+m[1]||NW[m[1]];if(!n)return null;return Date.now()+n*(/^h/.test(m[2])?3600e3:/^s/.test(m[2])?1e3:60e3)}
 if(m=s.match(/^(?:at\s+|for\s+)?(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)?(?:\s+(?:tomorrow|in the morning|tonight))?$/)){let h=+m[1],mi=+(m[2]||0);if(h>23||mi>59)return null;const ap=m[3]&&m[3][0];
  if(ap==='p'&&h<12)h+=12;if(ap==='a'&&h===12)h=0;const d=new Date();d.setSeconds(0,0);d.setHours(h,mi);
  if(!ap&&h<12){if(d<=Date.now())d.setHours(h+12)}if(d<=Date.now())d.setDate(d.getDate()+1);return d.getTime()}
 return null}
const cleanSong=s=>(s||'').trim().replace(/^(?:the song\s+)?/i,'').replace(/[.?!]+$/,'');
function parseAlarm(raw){const t=raw.trim().replace(/[.?!]+$/,'');let m;
 if(!(m=t.match(/^(?:please\s+)?(?:wake me(?:\s+up)?|set (?:an?\s+|my\s+)?alarm|alarm)\s*(.*)$/i)))return null;
 let rest=m[1].trim(),song='',when=null;
 const sm=rest.match(/\s*\b(?:to|with|playing)\s+(?!\d)(.+)$/i);if(sm){const before=rest.slice(0,sm.index).trim();const w=before?parseWhen(before.replace(/^(for|at|in)\s+/i,x=>/in/i.test(x)?'in ':'')):null;if(!before||w){song=cleanSong(sm[1]);rest=before}}
 if(rest)when=parseWhen(rest);
 if(rest&&!when)return{k:'alarm',bad:rest,song};
 return{k:'alarm',when,song}}
function add(you,when,song,text){const a=load();a.push({id:Date.now()+''+Math.random().toString(36).slice(2,6),t:when,song,text});saveA(a);
 if(text)return say(you,`Reminder set for ${fmt(when)}: ${text}. Keep OtoCue open with the screen on.`);say(you,`Alarm set for ${fmt(when)}${song?' with '+song:''}. Keep OtoCue open with the screen on.`)}
async function handle(text){
 if(pend){const w=parseWhen(text.replace(/^(?:at|for)\s+/i,''));if(w){const s=pend.song;pend=null;add(text,w,s);return true}
  if(/^(cancel|never ?mind|no)\b/i.test(text)){pend=null;say(text,'Okay, no alarm.');return true}pend=null}
 const c=parseAlarm(text);if(!c)return false;
 if(c.when){add(text,c.when,c.song);return true}
 pend={song:c.song};say(text,c.bad?`Sorry, I didn't understand the time “${c.bad}”. What time should I wake you?`:'What time? Say a time like “7 AM” or “in 30 minutes”.');
 if(!window._typed)setTimeout(()=>{if(pend&&SR&&!busy)doAsk()},2500);return true}
const orig=localCmd;localCmd=async t=>(await handle(t))||orig(t);
// UI
const box=document.createElement('div');box.id='alarms';$('#timers').before(box);
function render(){const a=load().sort((x,y)=>x.t-y.t);box.innerHTML='';a.forEach(x=>{const el=document.createElement('div');el.className='timer glass alarm';
 el.innerHTML='<span></span><button class="btn2 acx" aria-label="Cancel alarm">✕</button>';el.firstChild.textContent=x.text?`🔔 ${fmt(x.t)} · ${x.text}`:`⏰ ${fmt(x.t)}${x.song?' · '+x.song:''}`;
 el.querySelector('button').onclick=()=>{saveA(load().filter(y=>y.id!==x.id));status('Alarm cancelled.')};box.appendChild(el)})}
async function lock(){const has=load().length>0||ringing||wakeOn;try{if(has&&!wl&&'wakeLock' in navigator&&!document.hidden){wl=await navigator.wakeLock.request('screen');wl.addEventListener('release',()=>{wl=null})}else if(!has&&wl){wl.release();wl=null}}catch(_){}}
document.addEventListener('visibilitychange',()=>{if(!document.hidden)lock()});
const unlock=()=>{try{ac=ac||new(window.AudioContext||window.webkitAudioContext)();ac.resume()}catch(_){}};document.addEventListener('pointerdown',unlock,{passive:true});
function beep(){if(!ac)unlock();if(!ac)return;const t=ac.currentTime;for(let i=0;i<3;i++){const o=ac.createOscillator(),g=ac.createGain();o.type='square';o.frequency.value=880;g.gain.setValueAtTime(.0001,t+i*.25);g.gain.exponentialRampToValueAtTime(.6,t+i*.25+.02);g.gain.exponentialRampToValueAtTime(.0001,t+i*.25+.2);o.connect(g).connect(ac.destination);o.start(t+i*.25);o.stop(t+i*.25+.22)}}
function stopRing(){clearInterval(beepT);beepT=null;try{navigator.vibrate&&navigator.vibrate(0)}catch(_){}const c=$('#alarmCard');if(c)c.remove();ringing=null;lock()}
function fire(x){if(ringing)return;ringing=x;speechSynthesis&&speechSynthesis.cancel();
 const q=x.song?encodeURIComponent(x.song):'',yt='https://www.youtube.com/results?search_query='+q;
 const c=document.createElement('div');c.id='alarmCard';c.setAttribute('role','alertdialog');
 c.innerHTML=`<div class="wk">⏰</div><h2>${x.text?'Reminder':'Wake up'}</h2><p class="at"></p>${x.song?`<iframe id="alarmYT" allow="autoplay; encrypted-media" src="https://www.youtube-nocookie.com/embed?listType=search&list=${q}&autoplay=1&playsinline=1"></iframe><a class="btn" id="alarmPlay" href="${yt}" target="_blank" rel="noopener">▶ Play song</a>`:''}<div class="row"><button class="btn2" id="alarmSnooze">😴 Snooze 5 min</button><button class="btn" id="alarmStop">⏹ Stop</button></div>`;
 c.querySelector('.at').textContent=x.text?x.text:fmt(x.t)+(x.song?' · '+x.song:'');document.body.appendChild(c);
 let n=0;beep();if(x.text)setTimeout(()=>speak('Reminder: '+x.text),900);beepT=setInterval(()=>{n++;if(x.text?n%8===0:(!x.song||n<6))beep();try{navigator.vibrate&&navigator.vibrate([500,300,500])}catch(_){}},1200);
 $('#alarmStop').onclick=()=>{stopRing();status('Alarm stopped.')};
 $('#alarmSnooze').onclick=()=>{const t=Date.now()+300e3;stopRing();const a=load();a.push({id:'s'+t,t,song:x.song});saveA(a);status('Snoozed until '+fmt(t)+'.')}}
setInterval(()=>{const a=load(),now=Date.now(),due=a.filter(x=>x.t<=now);if(due.length){saveA(a.filter(x=>x.t>now));fire(due[0])}else if(a.some(x=>x.t-now<120e3))render()},1000);
render();lock();
Object.assign(window.OtoCue,{parseAlarm,parseWhen,stopAlarm:stopRing,addAlarm:add,lock,fireAlarm:fire,loadAlarms:load,saveAlarms:saveA,ringing:()=>ringing,fmtTime:fmt});
})();

// ---- v3: reminders, calendar, conversation, contacts, offline, earbud button
(function(){
const O=window.OtoCue,pw=O.parseWhen;
// reminders: "remind me to X at/in T" or "remind me at/in T to X"
function parseReminder(raw){const t=raw.trim().replace(/[.!]+$/,'');let m=t.match(/^(?:please\s+)?(?:remind me|set (?:a\s+)?reminder)\s+(?:to\s+|about\s+|that\s+)?(.+)$/i);if(!m)return null;const r=m[1];
 let a=r.match(/^((?:in|at|tomorrow|on)\b.+?)\s+(?:to|about|that)\s+(.+)$/i);if(a){const w=pw(a[1]);if(w)return{when:w,text:a[2]}}
 const ws=r.split(/\s+/);for(let i=1;i<ws.length;i++){const tail=ws.slice(i).join(' ');if(/^(in|at|tomorrow)\b/i.test(tail)||/from now$/i.test(tail)){const w=pw(tail);if(w)return{when:w,text:ws.slice(0,i).join(' ').replace(/^to\s+/i,'')}}}
 return{when:null,text:r}}
// calendar: "add <event> to my calendar <time>" / "add <event> <time> to my calendar"
function parseCal(raw){const t=raw.trim().replace(/[.!]+$/,'');let m=t.match(/^(?:please\s+)?(?:add|put|schedule)\s+(.+?)\s+(?:to|on|in)\s+(?:my\s+)?calendar\s*(.*)$/i);if(!m)return null;
 let ev=m[1],when=m[2].replace(/^(for|at|on)\s+/i,'');let w=when?pw(when):null;
 if(!w){const ws=ev.split(/\s+/);for(let i=1;i<ws.length;i++){const tail=ws.slice(i).join(' ').replace(/^(for|at|on)\s+/i,'');const x=pw(tail);if(x){w=x;ev=ws.slice(0,i).join(' ').replace(/\s+(at|on|for)$/i,'');break}}}
 return{ev,when:w}}
const z=d=>new Date(d).toISOString().replace(/[-:]/g,'').replace(/\.\d{3}/,'');
function calCard(you,ev,start){const end=start+3600e3,ics=['BEGIN:VCALENDAR','VERSION:2.0','PRODID:-//OtoCue//EN','BEGIN:VEVENT','UID:'+Date.now()+'@otocue','DTSTAMP:'+z(Date.now()),'DTSTART:'+z(start),'DTEND:'+z(end),'SUMMARY:'+ev.replace(/[,;\\]/g,m=>'\\'+m),'END:VEVENT','END:VCALENDAR'].join('\r\n');
 const url=URL.createObjectURL(new Blob([ics],{type:'text/calendar'})),g='https://calendar.google.com/calendar/render?action=TEMPLATE&text='+encodeURIComponent(ev)+'&dates='+z(start)+'/'+z(end);
 let c=$('#calCard');if(!c){c=document.createElement('div');c.id='calCard';c.className='card glass calcard';$('#timers').after(c)}
 c.innerHTML='<b></b><a class="btn" id="calIcs">📅 Add to calendar (.ics)</a><a class="btn2" id="calG" target="_blank" rel="noopener">Google Calendar</a><button class="btn2" id="calX" style="width:100%;margin-top:8px">✕ Close</button>';
 c.querySelector('b').textContent=`${ev} — ${new Date(start).toLocaleString('en-US',{weekday:'short',month:'short',day:'numeric',hour:'numeric',minute:'2-digit'})}`;
 const a=$('#calIcs');a.href=url;a.download=ev.replace(/[^\w ]+/g,'').slice(0,40)+'.ics';$('#calG').href=g;$('#calX').onclick=()=>c.remove();try{a.click()}catch(_){}
 say(you,`Event ready: ${ev}, ${new Date(start).toLocaleString('en-US',{weekday:'long',hour:'numeric',minute:'2-digit'})}. Tap Add to calendar to save it.`)}
let remPend=null;
const prev=localCmd;localCmd=async text=>{
 if(remPend){const w=pw(text.replace(/^(?:at|for)\s+/i,''));const p=remPend;remPend=null;if(w){O.addAlarm(text,w,'',p.text);return true}}
 const r=parseReminder(text);if(r){if(r.when)O.addAlarm(text,r.when,'',r.text);else{remPend=r;say(text,`When should I remind you to ${r.text}?`)}return true}
 const c=parseCal(text);if(c){if(c.when)calCard(text,c.ev,c.when);else say(text,`What time is “${c.ev}”? Say e.g. “add ${c.ev} to my calendar tomorrow at 3pm”.`);return true}
 return prev(text)};
Object.assign(O,{parseReminder,parseCal});
// contacts manager (manual add / edit / delete) in Settings
const getC=()=>{try{return JSON.parse(localStorage.getItem('otocue_contacts')||'[]')}catch(_){return[]}},setC=c=>{saveContacts(c);cl()};let edit=-1;
function cl(){const c=getC(),L=$('#cList');let h=$('#cCount');if(!h){h=document.createElement('p');h.id='cCount';h.className='hint';L.before(h)}h.textContent=`${c.length} contact${c.length===1?'':'s'} saved (${c.filter(x=>x.tel).length} with phone numbers).`;if(!$('#cImport')){const b=document.createElement('button');b.type='button';b.id='cImport';b.className='btn2';b.style.width='100%';b.textContent='📥 Add existing contacts';const n=document.createElement('p');n.id='cImpMsg';n.className='hint small';n.textContent='Tap Select all (or pick everyone you text/call), then Done. You only do this once.';h.after(b,n);
 b.onclick=async()=>{if(!('contacts' in navigator&&'select' in navigator.contacts)){n.textContent='Adding from your phone works in Chrome on Android. Add contacts below instead.';return}n.textContent='Tap Select all (or pick everyone you text/call), then Done. You only do this once.';
  try{const r=await navigator.contacts.select(['name','tel'],{multiple:true});const before=getC().length,t=mergeContacts(r.map(x=>({name:(x.name||[])[0]||'',tel:(x.tel||[])[0]||''})));n.textContent=`✅ Added ${t-before} new (${t} saved).`}catch(e){n.textContent='Not added: '+e.message}}}L.innerHTML=c.length?'':'<p class="hint">No contacts yet. Add one below (iPhone) or use Share Contacts (Android).</p>';
 c.forEach((x,i)=>{const b=document.createElement('button');b.type='button';b.innerHTML='<b></b><span></span><span class="cx" aria-label="Delete">✕</span>';b.querySelector('b').textContent=x.name;b.querySelector('span').textContent=x.tel||x.email||'';
  b.onclick=e=>{if(e.target.classList.contains('cx')){c.splice(i,1);setC(c);return}edit=i;$('#cName').value=x.name;$('#cTel').value=x.tel||'';$('#cEmail').value=x.email||'';$('#cAdd').textContent='💾 Save contact'};L.appendChild(b)})}
$('#cAdd').onclick=()=>{const n=$('#cName').value.trim(),t=$('#cTel').value.trim(),e=$('#cEmail').value.trim();if(!n||!(t||e)){status('Enter a name and a number.');return}
 const c=getC(),x={name:n,tel:t,email:e};if(edit>=0)c[edit]=x;else c.push(x);edit=-1;setC(c);['#cName','#cTel','#cEmail'].forEach(s=>$(s).value='');$('#cAdd').textContent='➕ Add contact';status('Contact saved ✓')};
$('#setBtn').addEventListener('click',cl);cl();window.OtoCue.cl=cl;
// conversation translation
const LN=['English','Spanish','French','German','Italian','Portuguese','Japanese','Korean','Chinese (Mandarin)','Hindi','Arabic','Russian','Vietnamese','Tagalog'];
const LC={English:'en-US',Spanish:'es-ES',French:'fr-FR',German:'de-DE',Italian:'it-IT',Portuguese:'pt-BR',Japanese:'ja-JP',Korean:'ko-KR','Chinese (Mandarin)':'zh-CN',Hindi:'hi-IN',Arabic:'ar-SA',Russian:'ru-RU',Vietnamese:'vi-VN',Tagalog:'fil-PH'};
$('#convA').innerHTML=$('#convB').innerHTML=LN.map(l=>`<option>${l}</option>`).join('');$('#convA').value=localStorage.getItem('otocue_convA')||'English';$('#convB').value=localStorage.getItem('otocue_convB')||'Spanish';
let conv=false;const log=t=>{const d=document.createElement('div');d.textContent=t;$('#convLog').prepend(d)};
const waitSpeak=()=>new Promise(r=>{const s=Date.now();const iv=setInterval(()=>{if(!('speechSynthesis' in window)||(!speechSynthesis.speaking&&Date.now()-s>300)||Date.now()-s>30000){clearInterval(iv);r()}},200)});
async function convTurn(A,B,turn){const lang=turn%2?B:A;status(`🔁 Listening (${A} or ${B})…`);const h=await listen({ms:SR?0:8000,lang:LC[lang],fallback:true});if(!conv)return;
 if(!h.text&&!h.audio)return;status('Translating…');
 const a=await gemini(h.audio?[{inline_data:{mime_type:h.audio.mimeType,data:h.audio.data}},{text:'Interpret this speech.'}]:[{text:h.text}],`You are a live interpreter between ${A} and ${B}. Detect which of the two languages the input is in and translate it into the other one. Reply exactly as: <target language name>|<translation>. No other text.`);
 const m=a.match(/^\s*([^|]+)\|([\s\S]+)$/),tl=m&&LN.find(l=>m[1].toLowerCase().includes(l.toLowerCase().split(' ')[0]))||(turn%2?A:B),tr=(m?m[2]:a).trim();
 log(`${h.text||'(voice)'} → [${tl}] ${tr}`);status('');show(h.text??'(voice)',tr,LC[tl]);await waitSpeak()}
$('#convBtn').onclick=async()=>{if(conv){conv=false;stopFn&&stopFn();$('#convBtn').textContent='🔁 Start conversation';status('');return}
 if(busy)return;const A=$('#convA').value,B=$('#convB').value;localStorage.setItem('otocue_convA',A);localStorage.setItem('otocue_convB',B);conv=true;$('#convBtn').textContent='⏹ Stop conversation';let turn=0,fails=0;
 while(conv){busy=true;try{await convTurn(A,B,turn++);fails=0}catch(e){$('#out').textContent='⚠ '+e.message;if(++fails>2||e.code==='not-allowed'||e.quota)conv=false}finally{busy=false}}
 $('#convBtn').textContent='🔁 Start conversation'};
O.conv=()=>conv;
// offline indicator
const net=()=>document.body.classList.toggle('offline',navigator.onLine===false);addEventListener('online',net);addEventListener('offline',net);net();
// wake indicator at startup
document.body.classList.toggle('wakeon',wakeOn);if(wakeOn)O.lock();
// earbud button = Ask (Media Session + silent looping audio)
let au=null;function silentWav(){const n=8000,b=new ArrayBuffer(44+n),v=new DataView(b),w=(o,s)=>[...s].forEach((c,i)=>v.setUint8(o+i,c.charCodeAt(0)));
 w(0,'RIFF');v.setUint32(4,36+n,true);w(8,'WAVEfmt ');v.setUint32(16,16,true);v.setUint16(20,1,true);v.setUint16(22,1,true);v.setUint32(24,8000,true);v.setUint32(28,8000,true);v.setUint16(32,1,true);v.setUint16(34,8,true);w(36,'data');v.setUint32(40,n,true);for(let i=0;i<n;i++)v.setUint8(44+i,128);return URL.createObjectURL(new Blob([b],{type:'audio/wav'}))}
function earTrigger(){if(au)au.play().catch(()=>{});if(busy){stopFn&&stopFn();return}doAsk()}
async function earOn(on){localStorage.setItem('otocue_earbud',on?'1':'');const ms=navigator.mediaSession;
 if(!on){if(au){au.pause();au=null}if(ms)['play','pause','nexttrack','previoustrack'].forEach(a=>{try{ms.setActionHandler(a,null)}catch(_){}});return}
 au=au||new Audio(silentWav());au.loop=true;try{await au.play()}catch(_){status('Tap the toggle again to enable earbud button.')}
 if(ms){try{ms.metadata=new MediaMetadata({title:'OtoCue — press play/pause to Ask',artist:'OtoCue'})}catch(_){}['play','pause','nexttrack','previoustrack'].forEach(a=>{try{ms.setActionHandler(a,earTrigger)}catch(_){}});ms.playbackState='playing'}
 else status('Media buttons are not supported in this browser.')}
$('#earbud').onchange=e=>earOn(e.target.checked);if(localStorage.getItem('otocue_earbud')){$('#earbud').checked=true;document.addEventListener('pointerdown',()=>earOn(true),{once:true})}
O.earTrigger=earTrigger;
})();

// ---- v3b: email + social sharing
(function(){
const O=window.OtoCue;
function toast(t){let e=$('#toast');if(!e){e=document.createElement('div');e.id='toast';document.body.appendChild(e)}e.textContent=t;e.hidden=false;clearTimeout(e._t);e._t=setTimeout(()=>e.hidden=true,4000)}
O.toast=toast;
function splitWho(rest){const ws=rest.split(/\s+/);for(const n of [2,1]){if(ws.length<n)continue;const c=O.findContact(ws.slice(0,n).join(' '));if(c)return{c,who:ws.slice(0,n).join(' '),rest:ws.slice(n).join(' ')}}return{c:null,who:ws[0],rest:ws.slice(1).join(' ')}}
function parseEmail(raw){const t=raw.trim().replace(/[.!]+$/,'');let m,polish=false;
 if(m=t.match(/^(?:please\s+)?write\s+(?:me\s+)?(?:a|an)\s+(?:nice|polite|friendly|short|professional|good)?\s*e-?mail\s+to\s+(.+)$/i))polish=true;
 else if(!(m=t.match(/^(?:please\s+)?(?:send\s+(?:an\s+)?)?e-?mail(?:\s+to)?\s+(.+)$/i)))return null;
 const w=splitWho(m[1]);let rest=w.rest.trim(),subject='',body=rest,s;
 if(s=rest.match(/^(?:with\s+)?(?:subject|re|about)\s*:?\s+(.+?)(?:\s*(?:,|:|\bsaying\b|\bthat says\b|\bmessage\b|\bbody\b)\s+(.+))?$/i)){subject=s[1];body=s[2]||''}
 body=body.replace(/^(?:that|saying|and say|to say)\s+/i,'');return{k:'email',polish,c:w.c,who:w.who,subject,body}}
async function doEmail(you,e){const p=e.c;if(!p){say(you,`I couldn't find “${e.who}” in your contacts. Add them in Settings › Contacts.`);return}
 if(!p.email){say(you,`${p.name} has no email saved. Add one in Settings › Contacts.`);return}
 let {subject,body}=e;
 if(e.polish){status('Writing…');const a=await gemini([{text:`Write a short, warm email to ${p.name}${subject?' about '+subject:''}. Content: ${body||subject||'a friendly hello'}. Sign it from ${uname()||'me'}. Reply exactly as:\nSubject: <subject>\n<body>`}],'You write short, natural emails. Plain text only.');
  const m=a.match(/^\s*Subject:\s*(.+)\n+([\s\S]+)$/i);if(m){subject=m[1].trim();body=m[2].trim()}else body=a}
 await confirmRun(you,`Emailing ${p.name}${subject?' — subject “'+subject+'”':''}${body?': “'+body+'”':''}.`,'mailto:'+encodeURIComponent(p.email).replace('%40','@')+'?subject='+encodeURIComponent(subject)+'&body='+encodeURIComponent(body))}
const NETS={instagram:'instagram',ig:'instagram',insta:'instagram',facebook:'facebook',fb:'facebook',x:'x',twitter:'x',tiktok:'tiktok','tik tok':'tiktok',whatsapp:'whatsapp',snapchat:'snapchat',snap:'snapchat',linkedin:'linkedin'};
const NRE='(instagram|insta|ig|facebook|fb|x|twitter|tik tok|tiktok|whatsapp|snapchat|snap|linkedin)';
function parseSocial(raw){const t=raw.trim().replace(/[.!]+$/,''),l=t.toLowerCase();let m;
 if(/^(?:please\s+)?share\s+(?:this|that|it|the (?:last )?answer)(?:\s+(?:to|on)\s+.+)?$/.test(l)){const n=l.match(new RegExp('(?:to|on)\\s+'+NRE+'$'));return{k:'social',last:true,net:n?NETS[n[1]]:null}}
 if(m=t.match(new RegExp('^(?:please\\s+)?write\\s+(?:me\\s+)?(?:a\\s+)?(?:caption|post|tweet)(?:\\s+(?:for|on)\\s+'+NRE+')?\\s*(?:about|for|on)?\\s*(.*)$','i')))return{k:'social',polish:true,net:m[1]?NETS[m[1].toLowerCase()]:(/tweet/i.test(t)?'x':null),text:m[2]};
 if(m=t.match(new RegExp('^(?:please\\s+)?(?:post|share|put|tweet)\\s+(?:this\\s+)?(?:to|on)\\s+'+NRE+'\\s*[:,]?\\s*(.*)$','i')))return{k:'social',net:NETS[m[1].toLowerCase()],text:m[2].replace(/^(?:that|saying|says)\s+/i,'')};
 if(m=t.match(/^tweet\s+(.+)$/i))return{k:'social',net:'x',text:m[1]};
 return null}
const NAME={instagram:'Instagram',facebook:'Facebook',x:'X',tiktok:'TikTok',whatsapp:'WhatsApp',snapchat:'Snapchat',linkedin:'LinkedIn'};
const APP={instagram:'https://www.instagram.com/',tiktok:'https://www.tiktok.com/upload',snapchat:'https://www.snapchat.com/'};
function intent(net,t){const e=encodeURIComponent(t);return{x:'https://x.com/intent/post?text='+e,facebook:'https://www.facebook.com/sharer/sharer.php?u='+encodeURIComponent('https://joeandai9511-art.github.io/otocue/')+'&quote='+e,whatsapp:'https://wa.me/?text='+e,linkedin:'https://www.linkedin.com/feed/?shareActive=true&text='+e}[net]}
const go=u=>{O.lastUrl=u;if(!window.open(u,'_blank'))location.href=u};
async function shareNow(net,text){
 if(APP[net]){try{await navigator.clipboard.writeText(text)}catch(_){}toast('Caption copied — paste it in '+NAME[net]);go(APP[net]);return 'copied'}
 if(navigator.share&&(!net||net==='whatsapp'||!intent(net,text))){try{await navigator.share({text});return 'shared'}catch(e){if(e.name==='AbortError')return 'cancelled'}}
 if(net){go(intent(net,text));return 'intent'}
 try{await navigator.clipboard.writeText(text)}catch(_){}toast('Copied — paste it anywhere');return 'copied'}
async function doSocial(you,s){let text=s.last?lastAnswer:s.text;
 if(s.last&&!text){say(you,'There is no answer to share yet.');return}
 if(s.polish){status('Writing…');text=(await gemini([{text:`Write one short, catchy social media caption${s.net?' for '+NAME[s.net]:''} about: ${text||'my day'}. Include 1-3 fitting hashtags. Output only the caption.`}],'You write short social captions. Plain text only.')).trim()}
 if(!text){say(you,`What should I post${s.net?' to '+NAME[s.net]:''}? Say e.g. “post to ${s.net?NAME[s.net]:'X'} just landed in Paris”.`);return}
 status('');if(!confirmOn()){const r=await shareNow(s.net,text);O.lastShare={net:s.net,text,r};say(you,`Sharing to ${s.net?NAME[s.net]:'…'}.`);return}const box=$('#cfm'),where=s.net?NAME[s.net]:'…';$('#cfmTxt').textContent=`Share to ${where}: “${text}”`;box.hidden=false;
 $('#out').textContent=`Ready to share to ${where}: “${text}”. Tap Confirm.`;
 await new Promise(res=>{const fin=async v=>{box.hidden=true;if(v){const r=await shareNow(s.net,text);O.lastShare={net:s.net,text,r}}else $('#out').textContent='Cancelled.';res()};$('#cfmYes').onclick=()=>fin(true);$('#cfmNo').onclick=()=>fin(false)})}
const prev=localCmd;localCmd=async text=>{const s=parseSocial(text);if(s){await doSocial(text,s);return true}const e=parseEmail(text);if(e){await doEmail(text,e);return true}return prev(text)};
Object.assign(O,{parseEmail,parseSocial,shareNow});
})();

// ---- v3c: manage alarms/reminders/timers by voice (local, instant, no confirm)
(function(){
const O=window.OtoCue;
const kindOf=w=>/remind/.test(w)?'reminder':/timer/.test(w)?'timer':'alarm';
const isK=(x,k)=>k==='reminder'?!!x.text:!x.text;
const desc=x=>x.text?`reminder at ${O.fmtTime(x.t)} to ${x.text}`:`alarm at ${O.fmtTime(x.t)}${x.song?' with '+x.song:''}`;
const sameHM=(a,b)=>{const x=new Date(a),y=new Date(b);return x.getHours()===y.getHours()&&x.getMinutes()===y.getMinutes()};
function manage(raw){const l=raw.toLowerCase().trim().replace(/[.?!]+$/,'').replace(/^(?:please|hey cue|okay|ok)[ ,]+/,'');let m;
 const list=()=>O.loadAlarms().sort((a,b)=>a.t-b.t);
 // snooze
 if(/^snooze(?: (?:it|the alarm|my alarm|alarm))?(?: for \d+ minutes?)?$/.test(l)){const b=$('#alarmSnooze');if(b){b.click();say(raw,'Snoozed for 5 minutes.')}else say(raw,'No alarm is ringing right now.');return true}
 // list
 if(/^(?:what|which|list|show|read)\b.*\b(alarms?|reminders?|timers?)\b|^(?:do i have|have i got|are there) any (alarms?|reminders?|timers?)/.test(l)){
  const k=/remind/.test(l)&&!/alarm/.test(l)?'reminder':/alarm/.test(l)&&!/remind/.test(l)?'alarm':null,a=list().filter(x=>!k||isK(x,k)),tm=(window._tmr||[]);
  const parts=a.map(desc);if(!k||/timer/.test(l))tm.forEach(t=>{const s=Math.max(0,Math.round((t.end-Date.now())/1000));parts.push(`${t.lbl} timer with ${Math.floor(s/60)}:${String(s%60).padStart(2,'0')} left`)});
  say(raw,parts.length?`You have ${parts.length}: ${parts.join('; ')}.`:`You have no ${k?k+'s':'alarms, reminders or timers'} set.`);return true}
 // change
 if(m=l.match(/^(?:change|move|reschedule|update|set|push)\s+(?:my\s+|the\s+)?(?:next\s+)?(alarm|reminder)\s+(?:to|for|until)\s+(.+)$/)){const k=kindOf(m[1]),w=O.parseWhen(m[2].replace(/^at\s+/,''));
  if(!w){say(raw,`Sorry, I didn't understand the time “${m[2]}”.`);return true}const a=list(),x=a.find(y=>isK(y,k));
  if(!x){if(k==='alarm'){O.addAlarm(raw,w,'');return true}say(raw,'You have no reminders to change.');return true}
  x.t=w;O.saveAlarms(a);say(raw,`Done. Your ${k} is now set for ${O.fmtTime(w)}.`);return true}
 // cancel / stop
 if(m=l.match(/^(?:cancel|delete|remove|turn off|switch off|stop|clear|disable|kill|get rid of)\s+(.*?)\b(alarms?|reminders?|timers?)\b\s*(.*)$/)){
  const k=kindOf(m[2]),mods=(m[1]+' '+m[3]).replace(/\b(my|the|of|for|at|set|that|this|one)\b/g,' ').replace(/\s+/g,' ').trim(),all=/\ball\b|\bevery\b/.test(mods)||/s$/.test(m[2]);
  if(k==='alarm'&&O.ringing()&&!all){O.stopAlarm();say(raw,'Alarm stopped.');return true}
  if(k==='timer'){const tm=window._tmr||[];if(!tm.length){say(raw,'You have no timers running.');return true}const kill=all?tm.slice():[tm.slice().sort((a,b)=>a.end-b.end)[0]];
   kill.forEach(t=>{clearInterval(t.iv);t.el.remove()});window._tmr=tm.filter(t=>!kill.includes(t));say(raw,all&&kill.length>1?`Cancelled all ${kill.length} timers.`:`Cancelled your ${kill[0].lbl} timer.`);return true}
  const a=list(),mine=a.filter(x=>isK(x,k));if(!mine.length){say(raw,`You have no ${k}s set.`);return true}
  let kill;const tq=mods.replace(/\b(all|every|next|first)\b/g,'').trim(),tw=tq?O.parseWhen(tq):null;
  if(all)kill=mine;else if(tw)kill=mine.filter(x=>sameHM(x.t,tw));else if(tq&&k==='reminder')kill=mine.filter(x=>x.text.toLowerCase().includes(tq.replace(/^(to|about)\s+/,'')));else kill=[mine[0]];
  if(!kill.length){say(raw,`I couldn't find a ${k} for “${tq}”. You have: ${mine.map(desc).join('; ')}.`);return true}
  O.saveAlarms(a.filter(x=>!kill.includes(x)));const left=mine.length-kill.length;
  say(raw,(kill.length>1?`Cancelled all ${kill.length} ${k}s.`:`Cancelled your ${desc(kill[0])}.`)+(left?` You still have ${left} ${k}${left>1?'s':''}.`:''));return true}
 if(/^(?:stop|turn off|dismiss)(?: it)?$/.test(l)&&O.ringing()){O.stopAlarm();say(raw,'Alarm stopped.');return true}
 return false}
const prev=localCmd;localCmd=async t=>manage(t)||prev(t);O.manage=manage;
})();

// ---- first-run setup / edit profile
(function(){const D=$('#setupDlg');if(!D)return;let step=0,mode='full';const secs=[...D.querySelectorAll('section')],dots=[...D.querySelectorAll('.sdots i')];
 const show=n=>{step=n;secs.forEach((x,i)=>x.classList.toggle('on',i===n));dots.forEach((d,i)=>d.classList.toggle('on',i<=n));const f=secs[n].querySelector('input');if(f&&n===1)setTimeout(()=>f.focus(),50)};
 const fill=()=>{const p=prof()||{};$('#suFirst').value=p.first||'';$('#suNick').value=p.nick||'';$('#suLang').value=p.lang||'English';$('#suCity').value=p.city||'';$('#suKey').value=localStorage.getItem('otocue_key')||'';$('#suErr').textContent='';$('#suKeyMsg').textContent=''};
 const open=(m,n)=>{mode=m;fill();$('#suInfoNext').textContent=m==='edit'?'💾 Save':'Next';if(!D.open)D.showModal();show(n)};
 const saveInfo=()=>{const first=$('#suFirst').value.trim();if(!first){$('#suErr').textContent='Please enter your first name.';$('#suFirst').focus();return false}
  const lang=$('#suLang').value,old=prof()||{};saveProf({...old,first,nick:$('#suNick').value.trim(),lang,city:$('#suCity').value.trim(),migrated:false});
  if(lang!=='English'&&!localStorage.getItem('otocue_lang'))localStorage.setItem('otocue_lang','English');greetUser();return true};
 D.querySelectorAll('.snext').forEach(b=>b.onclick=()=>{if(step===1){if(!saveInfo())return;if(mode==='edit'){D.close();status('Profile saved.');return}}
  if(step===2){const k=$('#suKey').value.trim();if(k)localStorage.setItem('otocue_key',k)}show(Math.min(step+1,4));if(step===4)$('#suDoneH').textContent=`Hi ${uname()}! Tap Ask to start.`});
 D.querySelectorAll('.sback').forEach(b=>b.onclick=()=>show(Math.max(0,step-1)));
 $('#suSkipKey').onclick=()=>{$('#suKeyMsg').textContent='No problem: commands like text, call, play and directions work without a key.';show(3)};
 $('#suPaste').onclick=async()=>{try{const t=(await navigator.clipboard.readText()).trim();if(t){$('#suKey').value=t;$('#suKeyMsg').textContent='Pasted. Tap Test key.'}}catch(_){$('#suKeyMsg').textContent='Long-press the box and choose Paste.'}};
 $('#suTest').onclick=async()=>{const k=$('#suKey').value.trim(),m=$('#suKeyMsg');if(!k){m.textContent='Paste your key first.';return}m.textContent='Testing…';
  try{const r=await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(S.model)}:generateContent`,{method:'POST',headers:{'Content-Type':'application/json','x-goog-api-key':k},body:JSON.stringify({contents:[{role:'user',parts:[{text:'Say OK'}]}],generationConfig:{maxOutputTokens:5}})});
   if(r.ok||r.status===429){localStorage.setItem('otocue_key',k);m.textContent=r.ok?'✅ Your key works! You\'re ready.':'✅ Key works, but today\'s free limit is used up. It resets daily.'}
   else if(r.status===400||r.status===401||r.status===403)m.textContent='❌ That key didn\'t work. Copy it again from AI Studio and paste the whole thing.';else m.textContent='⚠ Google returned an error ('+r.status+'). Try again in a minute.'}
  catch(_){m.textContent='⚠ Couldn\'t reach Google. Check your internet and try again.'}};
 $('#suContacts').onclick=async()=>{const m=$('#suCMsg');if(!('contacts' in navigator&&'select' in navigator.contacts)){m.textContent='Contact sharing works in Chrome on Android. You can add contacts in Settings anytime.';return}
  m.textContent='Tap Select all (or pick everyone you text/call), then Done. You only do this once.';try{const r=await navigator.contacts.select(['name','tel'],{multiple:true});const n=mergeContacts(r.map(x=>({name:(x.name||[])[0]||'',tel:(x.tel||[])[0]||'',email:(x.email||[])[0]||''})));m.textContent=`✅ ${n} contact${n===1?'':'s'} saved.`}catch(e){m.textContent='Skipped: '+e.message}};
 $('#suMic').onclick=()=>{const m=$('#suMMsg');if(!SR){m.textContent='Voice typing isn\'t supported in this browser; you can still type.';return}m.textContent='🎙 Listening… say “hello OtoCue”';
  listen({ms:5000}).then(h=>{m.textContent=h&&h.text?`✅ Heard: “${h.text}”`:'Didn\'t hear anything. Check mic permission, or skip.'}).catch(e=>{m.textContent='⚠ '+e.message})};
 $('#suDone').onclick=()=>{localStorage.setItem('otocue_setup_done','1');D.close();greetUser();speak(`Hi ${uname()}! Tap Ask to start.`)};
 D.addEventListener('cancel',e=>{if(!prof())e.preventDefault()});
 $('#profEdit').onclick=()=>{$('#dlg').close();open('edit',1)};$('#profRerun').onclick=()=>{$('#dlg').close();open('full',0)};
 window.OtoCue.setup=open;
 if(!prof()){document.querySelectorAll('dialog[open]').forEach(d=>d.close());open('full',0)}
})();
