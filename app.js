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
function buildRequest(parts,system,model){
 const key=S.key; if(!key) throw new Error('Add your free Gemini API key in Settings first.');
 return {url:`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model||S.model)}:generateContent`,
  init:{method:'POST',headers:{'Content-Type':'application/json','x-goog-api-key':key},
  body:JSON.stringify({systemInstruction:{parts:[{text:system}]},contents:[{role:'user',parts}]})}};
}
async function gemini(parts,system=SYS,model){
 const {url,init}=buildRequest(parts,system,model);
 const r=await fetch(url,init);
 if((r.status===503||r.status===429)&&!model){ for(const m of FALLBACKS) if(m!==S.model){ try{return await gemini(parts,system,m)}catch(_){} } } const j=await r.json().catch(()=>({}));
 if(!r.ok) throw new Error(j.error?.message||('Gemini error '+r.status));
 const t=(j.candidates?.[0]?.content?.parts||[]).map(p=>p.text||'').join('').trim();
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
   const r=new SR(); curRec=r; r.lang=lang||navigator.language||'en-US'; r.interimResults=true; r.continuous=continuous; let fin='',timer;
   r.onresult=e=>{let it='';for(let i=e.resultIndex;i<e.results.length;i++){const t=e.results[i][0].transcript;if(e.results[i].isFinal)fin+=t+' ';else it+=t}$('#you').textContent=(fin+it).trim()||'…'};
   r.onerror=e=>{if(e.error!=='no-speech'&&e.error!=='aborted'){clearTimeout(timer);curRec=null;rej(new Error('Mic: '+e.error))}};
   r.onend=()=>{ if(continuous&&curRec===r&&Date.now()<end){try{r.start()}catch(_){};return} clearTimeout(timer);curRec=null;res({text:fin.trim()})};
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
 status('Thinking…'); const a=await gemini(heard.audio?partsFrom(heard,'Answer the question asked in this audio.'):[{text:heard.text}]);
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
