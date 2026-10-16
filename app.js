'use strict';
const $=s=>document.querySelector(s);
const DEF_MODEL='gemini-3.8-flash';
const S={get key(){return localStorage.getItem('otocue_key')||''},get model(){return localStorage.getItem('otocue_model')||DEF_MODEL},
 get voice(){return localStorage.getItem('otocue_voice')||''},get rate(){return parseFloat(localStorage.getItem('otocue_rate')||'1')}};
const SR=window.SpeechRecognition||window.webkitSpeechRecognition;
const LANGS=['Spanish','French','German','Italian','Portuguese','Japanese','Korean','Chinese (Mandarin)','Hindi','Arabic','Russian','Vietnamese','Tagalog','English'];
const LCODE={Spanish:'es-ES',French:'fr-FR',German:'de-DE',Italian:'it-IT',Portuguese:'pt-BR',Japanese:'ja-JP',Korean:'ko-KR','Chinese (Mandarin)':'zh-CN',Hindi:'hi-IN',Arabic:'ar-SA',Russian:'ru-RU',Vietnamese:'vi-VN',Tagalog:'fil-PH',English:'en-US'};
let lastAnswer='',busy=false,curRec=null,wakeRec=null,wakeOn=false,stopFn=null;
const status=t=>$('#status').textContent=t||'';

const FALLBACKS=['gemini-flash-latest','gemini-3.6-flash','gemini-2.5-flash'];
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
 const body={systemInstruction:{parts:[{text:system+timeCtx(search)+contactsCtx()}]},contents:(hist||[]).concat([{role:'user',parts}]),generationConfig:gc};
 if(search)body.tools=[{google_search:{}}];
 return {search,url:`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(m)}:generateContent`,
  init:{method:'POST',headers:{'Content-Type':'application/json','x-goog-api-key':key},body:JSON.stringify(body)}};
}
async function gemini(parts,system=SYS,model,hist){
 const {url,init,search}=buildRequest(parts,system,model,hist);
 const r=await fetch(url,init);
 if(search&&(r.status===429||r.status===400||r.status===403)){noSearch=true;sessionStorage.setItem('otocue_nosearch','1');return await gemini(parts,system,model,hist)}
 if(r.status===400&&!noThink){noThink=true;return await gemini(parts,system,model,hist)}
 if((r.status===503||r.status===429)&&!model){ for(const m of FALLBACKS) if(m!==S.model){ try{return await gemini(parts,system,m,hist)}catch(_){} } } const j=await r.json().catch(()=>({}));
 if(!r.ok) throw new Error(j.error?.message||('Gemini error '+r.status));
 const t=(j.candidates?.[0]?.content?.parts||[]).filter(p=>!p.thought).map(p=>p.text||'').join('').trim();
 if(!t) throw new Error('No answer returned.'); return t;
}
const SYS='You are OtoCue, a concise AI assistant heard through an earpiece. Answer in 1-4 short spoken sentences, plain text, no markdown or lists.';

function speak(text,lang){
 if(!('speechSynthesis' in window)) return; speechSynthesis.cancel();
 const u=new SpeechSynthesisUtterance(text.replace(/[*#_`]/g,'')); u.rate=S.rate;
 const vs=speechSynthesis.getVoices();
 let v=lang?vs.find(x=>x.lang.replace('_','-').startsWith(lang.slice(0,2))):vs.find(x=>x.name===S.voice);
 if(v){u.voice=v;u.lang=v.lang} else if(lang) u.lang=lang;
 u.onend=()=>{if(wakeOn) startWake()}; pauseWake(); speechSynthesis.speak(u);
}
function show(you,ans,lang){ if(you!=null)$('#you').textContent=you; $('#out').textContent=ans; lastAnswer=ans; window._lastLang=lang; speak(ans,lang); }

// ---- listening: SpeechRecognition, fallback MediaRecorder -> Gemini audio
function listen({ms=0,continuous=false,lang}={}){
 return new Promise(async(res,rej)=>{
  if(SR){
   const r=new SR(); curRec=r; r.lang=lang||navigator.language||'en-US'; r.interimResults=true; r.continuous=continuous; let fin='',timer,lastInt='';
   r.onresult=e=>{let it='';for(let i=e.resultIndex;i<e.results.length;i++){const t=e.results[i][0].transcript;if(e.results[i].isFinal)fin+=t+' ';else it+=t}lastInt=it||lastInt;$('#you').textContent=(fin+it).trim()||'…'};
   r.onerror=e=>{if(e.error!=='no-speech'&&e.error!=='aborted'){clearTimeout(timer);curRec=null;rej(new Error('Mic: '+e.error))}};
   r.onend=()=>{ if(continuous&&curRec===r&&Date.now()<end){try{r.start()}catch(_){};return} clearTimeout(timer);curRec=null;res({text:(fin.trim()||lastInt.trim())})};
   const end=Date.now()+(ms||60000); if(ms) timer=setTimeout(()=>{curRec=null;r.stop()},ms);
   stopFn=()=>{const c=curRec;curRec=null;c&&c.stop()}; try{r.start()}catch(e){rej(e)}
  } else if(navigator.mediaDevices&&window.MediaRecorder){
   try{const st=await navigator.mediaDevices.getUserMedia({audio:true}); const mr=new MediaRecorder(st),ch=[];
    mr.ondataavailable=e=>ch.push(e.data);
    mr.onstop=async()=>{st.getTracks().forEach(t=>t.stop()); const b=new Blob(ch,{type:mr.mimeType||'audio/webm'});
     res({audio:{mimeType:(b.type||'audio/webm').split(';')[0],data:await b64(b)}})};
    mr.start(); stopFn=()=>mr.state!=='inactive'&&mr.stop(); setTimeout(stopFn,ms||7000);
   }catch(e){rej(e)}
  } else rej(new Error('No microphone support in this browser.'));
 });
}
const b64=b=>new Promise(r=>{const f=new FileReader();f.onload=()=>r(f.result.split(',')[1]);f.readAsDataURL(b)});
const partsFrom=(heard,prompt)=>heard.audio?[{inline_data:{mime_type:heard.audio.mimeType,data:heard.audio.data}},{text:prompt}]:[{text:prompt+'\n\n"'+heard.text+'"'}];

async function run(label,fn){ if(busy) return; busy=true; $('#ask').classList.add('rec'); pauseWake();
 try{await fn()}catch(e){status('');$('#out').textContent='⚠ '+e.message}finally{busy=false;$('#ask').classList.remove('rec');stopFn=null; if(wakeOn&&!speechSynthesis.speaking) startWake()} }

async function doAsk(pre){ await run('ask',async()=>{
 let heard; if(pre) heard={text:pre}; else {status('Listening… ask your question');speechSynthesis.cancel();heard=await listen({ms:SR?0:7000});}
 if(!heard.audio&&!heard.text){status('Didn\'t catch that.');return}
 if(heard.text&&await localCmd(heard.text)) return;
 status('Thinking…'); const q=heard.audio?partsFrom(heard,'Answer the question asked in this audio.'):[{text:heard.text}]; const a=await gemini(q,SYS,undefined,HIST.slice(-12));
 HIST.push({role:'user',parts:[{text:heard.text||'(voice question)'}]},{role:'model',parts:[{text:a}]}); while(HIST.length>12) HIST.shift();
 status(''); show(heard.text??'(voice)',a); });}
async function doSoft(){ await run('soft',async()=>{ status('Soft Listen: listening for 30s…'); speechSynthesis.cancel();
 const heard=await listen({ms:30000,continuous:true});
 if(!heard.audio&&!heard.text){status('Heard nothing.');return}
 status('Summarizing…'); const a=await gemini(partsFrom(heard,'This is ~30 seconds of overheard speech/conversation. Briefly summarize it and, if there is a question or task in it, answer it.'));
 status(''); show(heard.text??'(30s audio)',a); });}
async function doTranslate(){ await run('tr',async()=>{ const L=$('#lang').value; localStorage.setItem('otocue_lang',L);
 status('Listening… speak now'); speechSynthesis.cancel(); const heard=await listen({ms:SR?0:8000});
 if(!heard.audio&&!heard.text){status('Didn\'t catch that.');return}
 status('Translating…'); const a=await gemini(partsFrom(heard,`Translate the following speech into ${L}. Output only the translation.`),'You are a precise translator. Output only the translated text.');
 status(''); show(heard.text??'(voice)',a,LCODE[L]); });}
async function doPhoto(){ const f=$('#pfile').files[0]; if(!f){status('Pick or take a photo first.');return}
 await run('photo',async()=>{ status('Looking…'); const img=await shrink(f); const q=$('#pq').value.trim()||'What is in this photo? Describe what matters.';
 const a=await gemini([{inline_data:{mime_type:'image/jpeg',data:img}},{text:q}]); status(''); show(q,a); });}
function shrink(file){return new Promise((res,rej)=>{const i=new Image();i.onload=()=>{const m=1280,s=Math.min(1,m/Math.max(i.width,i.height)),c=document.createElement('canvas');c.width=i.width*s;c.height=i.height*s;c.getContext('2d').drawImage(i,0,0,c.width,c.height);URL.revokeObjectURL(i.src);res(c.toDataURL('image/jpeg',.85).split(',')[1])};i.onerror=()=>rej(new Error('Could not read image'));i.src=URL.createObjectURL(file)})}

// ---- wake word
function startWake(){ if(!wakeOn||busy||!SR||wakeRec) return; const r=new SR(); wakeRec=r; r.continuous=true; r.interimResults=true; r.lang=navigator.language||'en-US';
 r.onresult=e=>{for(let i=e.resultIndex;i<e.results.length;i++){const t=e.results[i][0].transcript.toLowerCase();
  const m=t.match(/\b(hey|hi|ok|okay)[ ,]*(cue|queue|q|kyu|cute|cu)\b(.*)/);
  if(m&&e.results[i].isFinal){pauseWake();const rest=m[3].trim();rest.split(' ').length>2?doAsk(rest):doAsk();return}}};
 r.onend=()=>{if(wakeRec===r){wakeRec=null;setTimeout(startWake,300)}}; r.onerror=e=>{if(e.error==='not-allowed'){wakeOn=false;$('#wake').checked=false;status('Mic permission denied.')}};
 try{r.start();status('Listening for “Hey Cue”…')}catch(_){wakeRec=null}}
function pauseWake(){const r=wakeRec;wakeRec=null;if(r)try{r.abort()}catch(_){}}

// ---- UI wiring
let tapT=null;
$('#ask').addEventListener('click',()=>{ if(busy){stopFn&&stopFn();return} if(tapT){clearTimeout(tapT);tapT=null;doSoft();return} tapT=setTimeout(()=>{tapT=null;doAsk()},280)});
$('#softBtn').onclick=doSoft; $('#stopBtn').onclick=()=>{stopFn&&stopFn();speechSynthesis.cancel();status('')};
$('#trBtn').onclick=doTranslate; $('#pgo').onclick=doPhoto; $('#replay').onclick=()=>lastAnswer&&speak(lastAnswer,window._lastLang);
$('#pmic').onclick=async()=>{ if(!SR){status('Type your question (voice needs SpeechRecognition).');return} try{status('Listening…');const h=await listen();$('#pq').value=h.text;status('')}catch(e){status(e.message)}};
$('#pfile').onchange=()=>{const f=$('#pfile').files[0];if(f){$('#prev').src=URL.createObjectURL(f);$('#prev').style.display='block'}};
$('#wake').onchange=e=>{wakeOn=e.target.checked;localStorage.setItem('otocue_wake',wakeOn?'1':'');if(!SR&&wakeOn){status('Wake word needs Chrome/Edge/Safari speech recognition.');}wakeOn?startWake():(pauseWake(),status(''))};
document.querySelectorAll('.tabs button').forEach(b=>b.onclick=()=>{document.querySelectorAll('.tabs button,.panel').forEach(x=>x.classList.remove('on'));b.classList.add('on');$('#'+b.dataset.t).classList.add('on')});
$('#lang').innerHTML=LANGS.map(l=>`<option>${l}</option>`).join(''); $('#lang').value=localStorage.getItem('otocue_lang')||'Spanish';
function fillVoices(){const vs=speechSynthesis.getVoices();$('#voice').innerHTML='<option value="">Default</option>'+vs.map(v=>`<option value="${v.name.replace(/"/g,'&quot;')}">${v.name} (${v.lang})</option>`).join('');$('#voice').value=S.voice}
if('speechSynthesis' in window){fillVoices();speechSynthesis.onvoiceschanged=fillVoices}
$('#setBtn').onclick=()=>{$('#key').value=S.key;$('#model').value=S.model;$('#rate').value=S.rate;$('#voice').value=S.voice;$('#dlg').showModal()};
$('#close').onclick=()=>$('#dlg').close();
$('#save').onclick=()=>{localStorage.setItem('otocue_key',$('#key').value.trim());localStorage.setItem('otocue_model',$('#model').value.trim()||DEF_MODEL);localStorage.setItem('otocue_voice',$('#voice').value);localStorage.setItem('otocue_rate',$('#rate').value);$('#dlg').close();status('Settings saved ✓');if(S.key)$('#out').textContent='Ready. Tap Ask.'};
if(!S.key) setTimeout(()=>$('#setBtn').click(),400);
if(localStorage.getItem('otocue_wake')){$('#wake').checked=true;wakeOn=true;}
document.addEventListener('visibilitychange',()=>{document.hidden?pauseWake():startWake()});
if('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js');
window.OtoCue={buildRequest,gemini,doAsk};

$('#contactsBtn').onclick=async()=>{
 if(!('contacts' in navigator&&'select' in navigator.contacts)){status('Contacts sharing works in Chrome on Android. iPhone web apps can\'t access contacts.');return}
 try{const r=await navigator.contacts.select(['name','tel','email'],{multiple:true});
  const c=r.map(x=>({name:(x.name||[])[0]||'',tel:(x.tel||[])[0]||'',email:(x.email||[])[0]||''}));
  localStorage.setItem('otocue_contacts',JSON.stringify(c));status(`Shared ${c.length} contact(s) with OtoCue.`)}catch(e){status('Contacts: '+e.message)}};
(function(){const o=$('#out');if(!o)return;new MutationObserver(()=>{const t=o.textContent,m=t.match(/\[(CALL|TEXT):([^\]]+)\]/);if(m){o.textContent=t.replace(m[0],'');location.href=(m[1]==='CALL'?'tel:':'sms:')+m[2].replace(/[^+\d]/g,'')}}).observe(o,{childList:true,characterData:true,subtree:true})})();

// ---- v2 UI layer (visuals, chat, haptics, message)
(function(){
const buzz=(p=12)=>{try{if(navigator.userActivation&&!navigator.userActivation.hasBeenActive)return;navigator.vibrate&&navigator.vibrate(p)}catch(_){}};
document.addEventListener('pointerdown',e=>{if(e.target.closest('button'))buzz()},{passive:true});
const h=new Date().getHours();$('#greet').textContent=(h<5?'Up late':h<12?'Good morning':h<18?'Good afternoon':'Good evening')+', J';
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
$('#mNum').oninput=e=>sel(e.target.value.trim()||null);
$('#mPick').onclick=async()=>{if(!('contacts' in navigator&&'select' in navigator.contacts)){$('#mTo').textContent='Phone picker needs Chrome on Android — type the number instead.';$('#mNum').focus();return}
 try{const r=await navigator.contacts.select(['name','tel'],{multiple:false});const x=r[0];if(x&&x.tel&&x.tel[0])sel(x.tel[0],(x.name||[])[0])}catch(e){$('#mTo').textContent='Contacts: '+e.message}};
$('#mMic').onclick=async()=>{if(busy)return;const b=$('#mMic');b.textContent='🎙 Listening…';
 try{const h=await listen({ms:SR?0:8000});if(h.text)$('#mText').value=(($('#mText').value+' ')+h.text).trim();else if(h.audio)$('#mTo').textContent='Voice typing needs speech recognition — please type the message.'}catch(e){$('#mTo').textContent=e.message}finally{b.textContent='🎙 Speak'}};
$('#mSend').onclick=()=>{const n=(to||'').replace(/[^+\d]/g,''),t=$('#mText').value.trim();
 if(!n){$('#mTo').textContent='Choose a contact or enter a number.';return}if(!t){$('#mTo').textContent='Say or type a message.';return}
 buzz([10,30,10]);D.close();location.href='sms:'+n+'?&body='+encodeURIComponent(t)};
})();

// ---- local voice commands (no Gemini)
const CITY={'new york':'America/New_York','nyc':'America/New_York','los angeles':'America/Los_Angeles','la':'America/Los_Angeles','san francisco':'America/Los_Angeles','seattle':'America/Los_Angeles','las vegas':'America/Los_Angeles','chicago':'America/Chicago','houston':'America/Chicago','dallas':'America/Chicago','denver':'America/Denver','phoenix':'America/Phoenix','miami':'America/New_York','boston':'America/New_York','atlanta':'America/New_York','washington':'America/New_York','toronto':'America/Toronto','vancouver':'America/Vancouver','mexico city':'America/Mexico_City','honolulu':'Pacific/Honolulu','hawaii':'Pacific/Honolulu','anchorage':'America/Anchorage','sao paulo':'America/Sao_Paulo','rio':'America/Sao_Paulo','buenos aires':'America/Argentina/Buenos_Aires','bogota':'America/Bogota','lima':'America/Lima','santiago':'America/Santiago','london':'Europe/London','dublin':'Europe/Dublin','lisbon':'Europe/Lisbon','paris':'Europe/Paris','berlin':'Europe/Berlin','madrid':'Europe/Madrid','barcelona':'Europe/Madrid','rome':'Europe/Rome','milan':'Europe/Rome','amsterdam':'Europe/Amsterdam','brussels':'Europe/Brussels','zurich':'Europe/Zurich','vienna':'Europe/Vienna','stockholm':'Europe/Stockholm','oslo':'Europe/Oslo','copenhagen':'Europe/Copenhagen','helsinki':'Europe/Helsinki','warsaw':'Europe/Warsaw','prague':'Europe/Prague','athens':'Europe/Athens','istanbul':'Europe/Istanbul','moscow':'Europe/Moscow','kyiv':'Europe/Kyiv','cairo':'Africa/Cairo','lagos':'Africa/Lagos','nairobi':'Africa/Nairobi','johannesburg':'Africa/Johannesburg','dubai':'Asia/Dubai','tel aviv':'Asia/Jerusalem','jerusalem':'Asia/Jerusalem','riyadh':'Asia/Riyadh','tehran':'Asia/Tehran','karachi':'Asia/Karachi','mumbai':'Asia/Kolkata','delhi':'Asia/Kolkata','new delhi':'Asia/Kolkata','bangalore':'Asia/Kolkata','dhaka':'Asia/Dhaka','bangkok':'Asia/Bangkok','hanoi':'Asia/Ho_Chi_Minh','ho chi minh city':'Asia/Ho_Chi_Minh','jakarta':'Asia/Jakarta','singapore':'Asia/Singapore','kuala lumpur':'Asia/Kuala_Lumpur','manila':'Asia/Manila','hong kong':'Asia/Hong_Kong','beijing':'Asia/Shanghai','shanghai':'Asia/Shanghai','taipei':'Asia/Taipei','seoul':'Asia/Seoul','tokyo':'Asia/Tokyo','osaka':'Asia/Tokyo','sydney':'Australia/Sydney','melbourne':'Australia/Melbourne','brisbane':'Australia/Brisbane','perth':'Australia/Perth','auckland':'Pacific/Auckland'};
const NICK={mom:['mom','mommy','mama','mum','mother','ma'],dad:['dad','daddy','papa','father','pa','pop'],grandma:['grandma','granny','nana','grandmother'],grandpa:['grandpa','grandfather','gramps'],wife:['wife','honey','babe'],husband:['husband','hubby']};
const APPS={youtube:['https://www.youtube.com','vnd.youtube://'],maps:['https://www.google.com/maps','geo:0,0'],'google maps':['https://www.google.com/maps'],spotify:['https://open.spotify.com','spotify:'],instagram:['https://www.instagram.com','instagram://app'],whatsapp:['https://web.whatsapp.com','whatsapp://'],gmail:['https://mail.google.com'],netflix:['https://www.netflix.com'],tiktok:['https://www.tiktok.com']};
function contacts(){try{return JSON.parse(localStorage.getItem('otocue_contacts')||'[]')}catch(_){return[]}}
function lev(a,b){const d=[...Array(b.length+1).keys()];for(let i=1;i<=a.length;i++){let p=d[0];d[0]=i;for(let j=1;j<=b.length;j++){const t=d[j];d[j]=Math.min(d[j]+1,d[j-1]+1,p+(a[i-1]===b[j-1]?0:1));p=t}}return d[b.length]}
function findContact(q){q=q.toLowerCase().replace(/^(my|the)\s+/,'').trim();const cs=contacts();if(!q||!cs.length)return null;
 const grp=Object.values(NICK).find(g=>g.includes(q));let best=null,bs=1e9;
 for(const c of cs){const n=(c.name||'').toLowerCase();if(!n)continue;const words=n.split(/\s+/);let s;
  if(n===q)s=0;else if(grp&&words.some(w=>grp.includes(w)))s=0.5;else if(words.includes(q)||n.startsWith(q))s=1;else s=2+Math.min(...words.map(w=>lev(w,q)),lev(n,q));
  if(s<bs){bs=s;best=c}}
 return bs<=2+Math.max(1,Math.floor(q.length/4))?best:null}
function tzTime(tz){return new Date().toLocaleTimeString('en-US',{timeZone:tz,hour:'numeric',minute:'2-digit'})}
function say(you,t){status('');show(you,t)}
function sayNoContact(you,name){say(you,`I couldn't find “${name}” in your shared contacts. Tap 💬 Message to pick one or enter a number.`)}
async function confirmRun(you,msg,url){show(you,msg+' Say yes or tap Confirm.');const box=$('#cfm');box.hidden=false;$('#cfmTxt').textContent=msg;
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
  if(s<=0){clearInterval(iv);el.textContent=`⏰ ${lbl} timer done!`;el.classList.add('done');try{navigator.vibrate&&navigator.vibrate([400,200,400,200,400])}catch(_){}speak(`Your ${lbl} timer is done.`);setTimeout(()=>el.remove(),15000)}};
 const iv=setInterval(tick,1000);tick();say(you,`Timer set for ${lbl}.`)}
const NUMW={a:1,an:1,one:1,two:2,three:3,four:4,five:5,six:6,seven:7,eight:8,nine:9,ten:10,fifteen:15,twenty:20,thirty:30,forty:40,'forty five':45,sixty:60};
function parseCmd(raw){const t=raw.trim().replace(/[.?!]+$/,''),l=t.toLowerCase();let m;
 if(m=l.match(/^(?:please\s+)?(?:call|phone|dial|ring)\s+(.+)$/))return{k:'call',who:t.slice(t.length-m[1].length)};
 if(m=t.match(/^(?:please\s+)?(?:send\s+(?:a\s+)?(?:text|message|sms)\s+to|text|message|send\s+(?:a\s+)?(?:text|message)\s+)\s*(.+?)(?:\s*,?\s+(?:that|saying|says|and say|to say)\s+|\s*:\s*)(.+)$/i))return{k:'text',who:m[1],msg:m[2]};
 if(m=t.match(/^(?:please\s+)?(?:send\s+(?:a\s+)?(?:text|message)\s+to|text|message)\s+(\S+(?:\s\S+)?)$/i))return{k:'text',who:m[1],msg:''};
 if(m=t.match(/^(?:send\s+(?:an\s+)?)?e-?mail(?:\s+to)?\s+(\S+(?:\s\S+)?)(?:\s*,?\s+(?:that|saying|about)?\s*(.*))?$/i)){
  const ws=(m[1]+' '+(m[2]||'')).trim().split(/\s+/);for(const n of [2,1]){const c=findContact(ws.slice(0,n).join(' '));if(c)return{k:'email',who:ws.slice(0,n).join(' '),c,msg:ws.slice(n).join(' ').replace(/^(that|saying|about)\s+/i,'')}}return{k:'email',who:ws[0],msg:ws.slice(1).join(' ')}}
 if(m=l.match(/^(?:navigate|directions|take me|drive|get directions|give me directions)\s+(?:to\s+)?(.+)$/))return{k:'nav',q:m[1]};
 if(m=l.match(/^(?:play)\s+(.+?)(?:\s+on\s+(spotify|youtube))?$/))return{k:'play',q:m[1],on:m[2]};
 if(m=l.match(/^open\s+(?:the\s+)?(.+?)(?:\s+app)?$/))if(APPS[m[1]])return{k:'open',app:m[1]};
 if(m=l.match(/^(?:set\s+(?:a\s+)?)?timer\s+(?:for\s+)?(\d+|[a-z]+(?:\s[a-z]+)?)\s+(minutes?|mins?|hours?|seconds?|secs?)/)||(m=l.match(/^set\s+(?:a\s+)?(\d+|[a-z]+)\s+(minutes?|hours?|seconds?)\s+timer/))){const n=+m[1]||NUMW[m[1]];if(n)return{k:'timer',n,unit:m[2].replace(/^min$|^mins$/,'minutes').replace(/^secs?$/,'seconds')}}
 if(m=l.match(/^(?:what(?:'s| is)?\s+(?:the\s+)?)?(?:current\s+)?time\s+(?:is\s+it\s+)?(?:right\s+now\s+|now\s+)?in\s+(.+?)[?.!]*$/))return{k:'tz',city:m[1].replace(/^the\s+/,'')};
 if(/^(?:what(?:'s| is)\s+(?:the\s+)?)?(?:current\s+)?time(?:\s+is\s+it)?(?:\s+now)?$|^what time is it/.test(l))return{k:'time'};
 if(/^(?:what(?:'s| is)\s+)?(?:today'?s?\s+)?(?:the\s+)?date(?:\s+today)?$|^what day is (?:it|today)/.test(l))return{k:'date'};
 if(m=l.match(/^(?:search(?:\s+for)?|google|look up)\s+(.+)$/))return{k:'search',q:m[1]};
 return null}
async function localCmd(text){const c=parseCmd(text);if(!c)return false;const you=text;
 switch(c.k){
  case 'call':{const p=findContact(c.who),dig=c.who.replace(/[^+\d]/g,'');if(!p&&dig.length>=3){await confirmRun(you,`Calling ${c.who}.`,'tel:'+dig);break}
   if(!p||!p.tel){sayNoContact(you,c.who);break}await confirmRun(you,`Calling ${p.name}.`,'tel:'+p.tel.replace(/[^+\d]/g,''));break}
  case 'text':{const p=findContact(c.who);if(!p||!p.tel){sayNoContact(you,c.who);break}
   if(!c.msg){window.OtoCue.openMessage(p,'');say(you,`What should I text ${p.name}? Speak or type it, then tap Send.`);break}
   await confirmRun(you,`Texting ${p.name}: “${c.msg}”.`,'sms:'+p.tel.replace(/[^+\d]/g,'')+'?&body='+encodeURIComponent(c.msg));break}
  case 'email':{const p=c.c||findContact(c.who);if(!p||!p.email){p?say(you,`${p.name} has no email in your shared contacts.`):sayNoContact(you,c.who);break}
   await confirmRun(you,`Emailing ${p.name}${c.msg?': “'+c.msg+'”':''}.`,'mailto:'+p.email+'?body='+encodeURIComponent(c.msg||''));break}
  case 'nav':await confirmRun(you,`Getting directions to ${c.q}.`,'https://www.google.com/maps/dir/?api=1&destination='+encodeURIComponent(c.q));break;
  case 'search':await confirmRun(you,`Searching Google for ${c.q}.`,'https://www.google.com/search?q='+encodeURIComponent(c.q));break;
  case 'play':await confirmRun(you,`Playing ${c.q} on ${c.on==='spotify'?'Spotify':'YouTube'}.`,c.on==='spotify'?'https://open.spotify.com/search/'+encodeURIComponent(c.q):'https://www.youtube.com/results?search_query='+encodeURIComponent(c.q));break;
  case 'open':{const u=APPS[c.app],android=/Android/i.test(navigator.userAgent);await confirmRun(you,`Opening ${c.app[0].toUpperCase()+c.app.slice(1)}.`,u[0]);break}
  case 'timer':startTimer(you,c.n,c.unit);break;
  case 'time':say(you,`It's ${new Date().toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit'})}.`);break;
  case 'tz':{const z=CITY[c.city];if(!z)return false;const n=c.city.replace(/\b\w/g,x=>x.toUpperCase());say(you,`It's ${tzTime(z)} in ${n} (${new Date().toLocaleDateString('en-US',{timeZone:z,weekday:'long'})}).`);break}
  case 'date':say(you,`Today is ${new Date().toLocaleDateString('en-US',{weekday:'long',month:'long',day:'numeric',year:'numeric'})}.`);break}
 return true}
Object.assign(window.OtoCue,{parseCmd,findContact,localCmd});

$('#typeForm').onsubmit=e=>{e.preventDefault();const v=$('#typeQ').value.trim();if(!v)return;$('#typeQ').value='';$('#you').textContent=v;doAsk(v)};
