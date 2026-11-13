import {createRouter,screenUrl} from './router.js';
import {CRITERIA,fmt,ceda,projected,weighted,aggregate} from './core.js';
import {downloadWorkbook} from './xlsx.js';
import {evaluationSheets} from './export-model.js';
import {createAlarm} from './alarm.js';

const $=id=>document.getElementById(id),root=$('app');
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const uuid=()=>crypto.randomUUID();
const demo=new URLSearchParams(location.search).get('demo')==='1';

let api,online=false,busy=false,route={name:'cover'},pageUnsubs=[],draft,room=null,roomCode='',isHost=false,ballot,manage,detailId='',countdownTimer=null,sound=true,lastAlarm='',displaySeen=false,wakeLock;
const managerCache=new Map();
let adminAuthorized=false;
let routing;
const alarm=createAlarm(new URL('./assets/time-up.mp3',import.meta.url));
let endedConfig,leavingRoom=false,draftEpoch=0;

const icons={
  back:'<path d="m14 5-7 7 7 7"/>',
  trash:'<path d="M3 6h18M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7M14 10v7"/>',
  bell:'<path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4"/>',
  mute:'<path d="m3 3 18 18M18 13V8a6 6 0 0 0-9-5M6 6c-1 1-1 2-1 4 0 5-2 5-2 7h14M10 21h4"/>',
  full:'<path d="M8 3H3v5M16 3h5v5M3 16v5h5M21 16v5h-5"/>',
  copy:'<rect x="8" y="8" width="12" height="13" rx="2"/><path d="M16 8V3H3v13h5"/>'
};

const svg=name=>'<svg viewBox="0 0 24 24" aria-hidden="true">'+icons[name]+'</svg>';
const btn=(text,action,cls='',extra='')=>`<button type="button" data-action="${action}" class="${cls}" ${extra}>${text}</button>`;
const iconBtn=(name,action,label,extra='')=>btn(svg(name),action,'icon',`aria-label="${label}" title="${label}" ${extra}`);
const back=()=>btn(svg('back')+'<span>돌아가기</span>','back','row secondary');
const logo=()=>'<div class="logo-window" role="img" aria-label="Since 1986 HUMANISM"><img src="./assets/logo-source.png" alt=""></div>';
const names=(p,side)=>p.map((x,i)=>`<span class="${side==='A'?'pro':'con'}">${esc(x.name||((side==='A'?'찬성':'반대')+(i+1)))}</span>`).join(' · ');
const sideInfo=p=>`<div class="team-info"><div class="pro">찬성 — ${names(p.A,'A')}</div><div class="con">반대 — ${names(p.B,'B')}</div></div>`;
const top=(title,buttons='')=>`<div class="page-top"><h1>${title}</h1><div class="row">${buttons}${back()}</div></div>`;
const empty=t=>`<div class="empty">${t}</div>`;

function toast(t){
  $('toast').textContent=t;
  $('toast').style.display='block';
  clearTimeout(toast.timer);
  toast.timer=setTimeout(()=>$('toast').style.display='none',4000);
}

function fail(e){
  console.error(e);
  let t=e.message||String(e);
  if(/permission|PERMISSION/.test(e.code||t)){
    t='권한을 확인할 수 없습니다. Firebase 관리자 설정과 데이터베이스 규칙을 확인해주세요.';
  }
  if(/auth\/invalid|auth\/wrong-password/.test(e.code||'')){
    t='비밀번호가 올바르지 않습니다.';
  }
  if(/operation-not-allowed/.test(e.code||'')){
    t='Firebase에서 이메일/비밀번호 인증을 켜주세요.';
  }
  toast(t);
}

function cleanup(){
  pageUnsubs.forEach(fn=>fn());
  pageUnsubs=[];

  if(countdownTimer){
    clearInterval(countdownTimer);
    countdownTimer=null;
  }
}

function normalizeScreen(name,data={}){
  const next={name,...data};

  if(name==='timer'){
    next.code=data.code||roomCode;
    next.host=data.host??isHost;
  }

  if(['ballot','submitted'].includes(name)){
    next.id=data.id||ballot?.id;
  }

  if(['manage','detail','countdown','result'].includes(name)){
    next.id=data.id||manage?.id;
  }

  if(name==='detail'){
    next.responseId=data.responseId||detailId;
  }

  return next;
}

function navigate(name,data={},replace=false){
  const next=normalizeScreen(name,data);

  routing.go(next,replace);
  cleanup();
  route=next;

  document.body.classList.toggle('timer-view',name==='timer');

  render();
  window.scrollTo(0,0);
}

async function goBack(){
  if(routing.back())return;

  const fallback={
    cover:'cover',
    'timer-menu':'cover',
    setup:'timer-menu',
    join:'timer-menu',
    timer:isHost?'setup':'join',
    'timer-ended':'timer-menu',
    board:'cover',
    create:'board',
    ballot:'board',
    submitted:'board',
    manage:'board',
    detail:'manage',
    countdown:'manage',
    result:'manage'
  }[route.name]||'cover';

  await departScreen();
  navigate(fallback,{},true);
}

function captureScreen(){
  return structuredClone({
    route,
    scroll:window.scrollY,
    draft,
    creationDraft,
    ballot,
    detailId,
    roomCode,
    isHost,
    endedConfig,
    draftEpoch
  });
}

async function closeHostedRoom(){
  const code=roomCode,host=isHost;

  leavingRoom=true;
  cleanup();

  try{
    if(host&&code){
      await api.closeRoom(code);
    }

    room=null;
    roomCode='';
    isHost=false;

    if(host){
      draft=newDraft();
      draftEpoch++;
    }
  }finally{
    leavingRoom=false;
  }
}

async function departScreen(){
  if($('dialog').open){
    $('dialogCancel').click();
  }

  if(route.name==='timer'&&isHost&&room){
    await closeHostedRoom();
  }
}

async function waitForApi(){
  for(let i=0;i<150;i++){
    if(api&&online)return;
    await new Promise(resolve=>setTimeout(resolve,100));
  }

  throw Error('서버 연결을 확인하고 다시 시도해주세요.');
}

function onceResponses(id){
  let stop=()=>{};

  return new Promise((resolve,reject)=>{
    stop=api.watchResponses(id,rows=>{
      queueMicrotask(()=>stop());
      resolve(rows||{});
    },error=>{
      stop();
      reject(error);
    });
  });
}

async function loadManage(id){
  const meta=await api.management(id);

  if(!meta){
    throw Error('삭제된 평가입니다.');
  }

  manage=managerCache.get(id)||{
    id,
    meta,
    responses:{},
    settings:{
      mode:meta.mode||'audience',
      judgeWeight:meta.judgeWeight??50,
      judgeIds:{...(meta.judgeIds||{})}
    }
  };

  manage.meta=meta;
  manage.responses=await onceResponses(id);

  for(const key of Object.keys(manage.settings.judgeIds)){
    if(!manage.responses[key]){
      delete manage.settings.judgeIds[key];
    }
  }

  managerCache.set(id,manage);
  return manage;
}

async function restoreScreen(next,saved,alive){
  cleanup();
  route={name:'loading'};

  document.body.classList.remove('timer-view');

  root.innerHTML=`<section class="page">${top('화면을 불러오고 있습니다.')}<p class="muted">잠시만 기다려주세요.</p></section>`;

  let actual={...next};

  try{
    if(saved){
      draft=saved.draftEpoch===draftEpoch
        ?saved.draft
        :newDraft();

      creationDraft=saved.creationDraft;
      ballot=saved.ballot;
      detailId=saved.detailId||'';
      endedConfig=saved.endedConfig;
    }

    if([
      'board',
      'create',
      'timer',
      'ballot',
      'submitted',
      'manage',
      'detail',
      'countdown',
      'result'
    ].includes(next.name)){
      await waitForApi();
    }

    if(!alive())return;

    if([
      'create',
      'manage',
      'detail',
      'countdown',
      'result'
    ].includes(next.name)&&!adminAuthorized){
      if(!await authorize()){
        actual={name:'board'};
      }
    }

    if(!alive())return;

    if(actual.name==='timer-ended'&&!endedConfig){
      actual={name:'timer-menu'};
    }

    if(actual.name==='setup'){
      draft??=newDraft();
      delete draft.editingRoom;
    }

    if(actual.name==='timer'){
      const existing=await api.getRoom(actual.code);

      if(!existing){
        throw Error('해당 방이 없습니다. 사회자가 먼저 방을 만들어주세요.');
      }

      if(actual.host&&!api.ownsRoom(actual.code,existing)){
        throw Error('이 브라우저는 해당 방의 사회자가 아닙니다.');
      }

      room=existing;
      roomCode=actual.code;
      isHost=!!actual.host;
      displaySeen=false;
      lastAlarm='';
    }

    if(actual.name==='ballot'||actual.name==='submitted'){
      const meta=await api.evaluation(actual.id);

      if(!meta){
        throw Error('삭제된 평가입니다.');
      }

      const own=await api.ownResponse(actual.id);

      if(own){
        ballot={
          id:actual.id,
          meta,
          name:own.name,
          scores:[...own.scores],
          rated:Array(6).fill(true),
          isEditing:!!actual.edit&&meta.open
        };

        actual=actual.edit&&meta.open
          ?{name:'ballot',id:actual.id,edit:true}
          :{name:'submitted',id:actual.id};
      }else{
        if(!meta.open){
          throw Error('평가가 마감되어 제출할 수 없습니다.');
        }

        if(ballot?.id!==actual.id){
          ballot={
            id:actual.id,
            meta,
            name:'',
            scores:Array(6).fill(50),
            rated:Array(6).fill(false)
          };
        }

        ballot.meta=meta;
        actual={name:'ballot',id:actual.id};
      }
    }

    if([
      'manage',
      'detail',
      'countdown',
      'result'
    ].includes(actual.name)){
      await loadManage(actual.id);

      if(actual.name==='detail'){
        detailId=actual.responseId;

        if(!manage.responses[detailId]){
          toast('삭제된 응답입니다.');
          actual={name:'manage',id:actual.id};
        }
      }

      if(actual.name==='countdown'||actual.name==='result'){
        if(manage.meta.result){
          finalData={
            meta:manage.meta,
            result:manage.meta.result,
            responses:manage.responses
          };
        }else{
          toast('관리 화면에서 먼저 결과보기를 눌러주세요.');
          actual={name:'manage',id:actual.id};
        }
      }
    }
  }catch(error){
    if(!alive())return;

    fail(error);

    actual={
      name:next.name==='timer'
        ?'timer-menu'
        :next.name==='setup'
          ?'timer-menu'
          :next.name==='cover'
            ?'cover'
            :'board'
    };

    if(actual.name==='board'&&!api){
      actual={name:'cover'};
    }
  }

  if(!alive())return;

  route=actual;

  document.body.classList.toggle(
    'timer-view',
    actual.name==='timer'
  );

  render();

  requestAnimationFrame(()=>{
    window.scrollTo(0,saved?.scroll||0);
  });

  if(actual.name==='timer'){
    requestWake();
  }

  return actual;
}

function ask({
  title,
  text='',
  label='',
  type='text',
  value='',
  validate=null,
  confirmText='확인',
  input=true
}){
  return new Promise(resolve=>{
    const d=$('dialog');
    const field=$('dialogInput');

    $('dialogTitle').textContent=title;
    $('dialogText').textContent=text;
    $('dialogLabel').textContent=label;

    field.type=type;
    field.value=value;
    field.hidden=!input;

    $('dialogLabel').hidden=!input;
    $('dialogError').textContent='';
    $('dialogConfirm').textContent=confirmText;
    $('dialogConfirm').disabled=false;

    const finish=v=>{
      d.close();

      $('dialogForm').onsubmit=null;
      d.oncancel=null;
      $('dialogCancel').onclick=null;

      field.value='';
      resolve(v);
    };

    $('dialogCancel').onclick=()=>finish(null);

    d.oncancel=e=>{
      e.preventDefault();
      finish(null);
    };

    $('dialogForm').onsubmit=async e=>{
      e.preventDefault();
      $('dialogConfirm').disabled=true;

      try{
        const v=field.value;

        if(validate){
          await validate(v);
        }

        finish(input?v:true);
      }catch(err){
        $('dialogError').textContent=
          /auth\/invalid|auth\/wrong-password/.test(err.code||'')
            ?'비밀번호가 올바르지 않습니다.'
            :err.message||String(err);

        $('dialogConfirm').disabled=false;
        field.focus();
      }
    };

    d.showModal();

    setTimeout(()=>{
      input?field.focus():$('dialogCancel').focus();
    },0);
  });
}

const confirmIt=(title,text='')=>ask({
  title,
  text,
  input:false,
  confirmText:'확인'
});

async function authorize(){
  const accepted=(await ask({
    title:'관리자 비밀번호',
    text:demo
      ?'체험 모드의 비밀번호는 demo입니다.'
      :'비밀번호를 입력하면 관리 화면으로 이동합니다.',
    label:'비밀번호',
    type:'password',
    validate:p=>api.login(p)
  }))!==null;

  if(accepted){
    adminAuthorized=true;
  }

  return accepted;
}

function blankPeople(){
  return {
    A:[
      {id:uuid(),name:''},
      {id:uuid(),name:''}
    ],
    B:[
      {id:uuid(),name:''},
      {id:uuid(),name:''}
    ]
  };
}

function blankStage(){
  return {
    id:uuid(),
    type:'normal',
    name:'',
    seconds:90,
    burst:120,
    color:'A',
    speaker:'',
    target:''
  };
}

function newDraft(){
  return {
    mode:'CEDA',
    topic:'',
    people:blankPeople(),
    steps:[],
    roomCode:'',
    newStage:blankStage(),
    editStage:''
  };
}

function readPeople(p){
  return {
    A:p.A.map((x,i)=>({
      ...x,
      name:x.name.trim()||'찬성'+(i+1)
    })),
    B:p.B.map((x,i)=>({
      ...x,
      name:x.name.trim()||'반대'+(i+1)
    }))
  };
}

function render(){
  if(route.name==='cover'){
    root.innerHTML=`<section class="home"><div class="logo-area">${logo()}</div><div class="choices">${btn('<strong>토론 타이머</strong><small>같은 방에서 함께 보는 시간</small>','timer-menu','choice')}${btn('<strong>토론 평가</strong><small>평가 참여와 결과 기록</small>','board','choice')}</div><footer>휴머니즘 타이머 3.0 · Created by Sumin</footer></section>`;
    return;
  }

  if(route.name==='timer-menu'){
    root.innerHTML=`<section class="selection">${top('토론 타이머')}<div class="choices">${btn('<strong>사회자로 시작하기</strong><small>방을 만들고 타이머를 조작합니다</small>','host','choice')}${btn('<strong>표시 화면으로 입장</strong><small>방 코드로 시간만 확인합니다</small>','join','choice')}</div></section>`;
    return;
  }

  if(route.name==='join'){
    root.innerHTML=`<section class="page join"><div class="panel">${top('표시 화면 입장')}<form id="joinForm"><label for="roomInput">방 코드 · 영문·숫자 4~6자리</label><input id="roomInput" class="code" maxlength="6" autocapitalize="characters" autocomplete="off" required><div class="row end" style="margin-top:20px"><button type="submit" class="primary">입장</button></div></form></div></section>`;
    return;
  }

  if(route.name==='setup'){
    renderSetup();
    return;
  }

  if(route.name==='timer'){
    renderTimer();
    return;
  }

  if(route.name==='board'){
    renderBoard();
    return;
  }

  if(route.name==='create'){
    renderCreate();
    return;
  }

  if(route.name==='ballot'){
    renderBallot();
    return;
  }

  if(route.name==='submitted'){
    renderSubmitted();
    return;
  }

  if(route.name==='timer-ended'){
    root.innerHTML=`<section class="page done-screen">${top('토론 종료')}<h1>토론이 종료되었습니다.</h1><div class="row">${btn('평가 생성','ended-to-eval','primary')}${btn('처음으로','timer-home','secondary')}</div></section>`;
    return;
  }

  if(route.name==='manage'){
    renderManage();
    return;
  }

  if(route.name==='detail'){
    renderDetail();
    return;
  }

  if(route.name==='countdown'){
    renderCountdown();
    return;
  }

  if(route.name==='result'){
    renderResult();
    return;
  }
}

function peopleFields(p,editable=true){
  return `<div class="grid">${['A','B'].map(side=>`<section><h3 class="${side==='A'?'pro':'con'}">${side==='A'?'찬성':'반대'}측 토론자</h3>${p[side].map((x,i)=>`<div class="people-row"><label class="${side==='A'?'pro':'con'}" for="person-${x.id}">${side==='A'?'찬성':'반대'}${i+1}</label><input id="person-${x.id}" data-person="${x.id}" data-side="${side}" aria-label="${side==='A'?'찬성':'반대'}${i+1} 이름" class="${side==='A'?'pro':'con'}" value="${esc(x.name)}" maxlength="60" placeholder="이름">${editable?iconBtn('trash','remove-person','토론자 삭제',`data-side="${side}" data-id="${x.id}" ${p[side].length<=1?'disabled':''}`):''}</div>`).join('')}${editable?btn('+ 토론자 추가','add-person','small',`data-side="${side}"`):''}</section>`).join('')}</div>`;
}

function options(selected){
  return Object.entries({
    normal:'일반',
    cross:'교차조사',
    free:'자유토론',
    deliberation:'숙의'
  }).map(([v,t])=>`<option value="${v}" ${selected===v?'selected':''}>${t}</option>`).join('');
}

function personOptions(selected){
  return '<option value="">선택해주세요</option>'+
    ['A','B'].map(side=>
      draft.people[side].map((p,i)=>
        `<option value="${p.id}" ${selected===p.id?'selected':''}>${side==='A'?'찬성':'반대'}${i+1} · ${esc(p.name||'이름 미입력')}</option>`
      ).join('')
    ).join('');
}

function stageForm(s,scope){
  return `<div class="stage-form" data-scope="${scope}"><div class="grid"><div class="field"><label>단계 이름<input data-step-field="name" maxlength="80" value="${esc(s.name)}" placeholder="예: 찬성 입론"></label></div><div class="field"><label>종류<select data-step-field="type">${options(s.type)}</select></label></div>${['normal','cross'].includes(s.type)?`<div class="field"><label>${s.type==='cross'?'질문자':'발언자'}<select data-step-field="speaker">${personOptions(s.speaker)}</select></label></div>`:''}${s.type==='cross'?`<div class="field"><label>답변자<select data-step-field="target">${personOptions(s.target)}</select></label></div>`:''}<div class="field"><label>${s.type==='free'?'각 팀 총 시간':'시간'} · 초<input type="number" min="1" max="59999" step="1" data-step-field="seconds" value="${s.seconds}"></label></div>${s.type!=='free'&&s.type!=='deliberation'?`<div class="field"><label>표시색<select data-step-field="color"><option value="A" ${s.color==='A'?'selected':''}>찬성 · 파랑</option><option value="B" ${s.color==='B'?'selected':''}>반대 · 빨강</option><option value="N" ${s.color==='N'?'selected':''}>중립 · 흰색</option></select></label></div>`:''}${s.type==='free'?`<div class="field"><label>연속발언 제한 · 초<input type="number" min="1" max="59999" step="1" data-step-field="burst" value="${s.burst||120}"></label></div>`:''}</div><div class="row end">${scope==='new'?btn('입력칸 비우기','clear-new','secondary')+btn('새 단계 추가','add-stage','primary'):btn('취소','cancel-stage','secondary')+btn('저장','save-stage','primary',`data-id="${scope}"`)}</div></div>`;
}

function personName(id){
  for(const side of ['A','B']){
    const i=draft.people[side].findIndex(x=>x.id===id);

    if(i>=0){
      const p=draft.people[side][i];

      return `<span class="${side==='A'?'pro':'con'}">${esc(p.name||(side==='A'?'찬성':'반대')+(i+1))}</span>`;
    }
  }

  return '<span class="muted">선택 필요</span>';
}

function stageCards(){
  return draft.steps.map((s,i)=>`<div class="stage" data-stage-id="${s.id}"><div class="stage-head"><div><div class="stage-title ${s.color==='A'?'pro':s.color==='B'?'con':''}">${i+1}. ${esc(s.name)}</div><p class="muted small">${fmt(s.seconds*1000)}${s.type==='free'?' · 각 팀 / 연속 '+fmt(s.burst*1000):s.type==='cross'?' · 질문자 '+personName(s.speaker)+' → 답변자 '+personName(s.target):s.type==='normal'?' · '+personName(s.speaker):''}</p></div><div class="row stage-actions">${btn('편집','edit-stage','',`data-id="${s.id}"`)}${btn('↑','move-stage','',`data-id="${s.id}" data-dir="-1" aria-label="위로" ${i===0?'disabled':''}`)}${btn('↓','move-stage','',`data-id="${s.id}" data-dir="1" aria-label="아래로" ${i===draft.steps.length-1?'disabled':''}`)}${iconBtn('trash','delete-stage','단계 삭제',`data-id="${s.id}"`)}</div></div>${draft.editStage===s.id?stageForm(draft.editBuffer,s.id):''}</div>`).join('')||empty('단계를 추가하거나 CEDA 구성을 불러오세요.');
}

function renderSetup(){
  root.innerHTML=`<section class="page">${top('토론 설정',btn('초기화','reset-setup','secondary'))}<div class="panel"><div class="field"><label for="mode">토론 방식</label><select id="mode"><option value="CEDA" ${draft.mode==='CEDA'?'selected':''}>CEDA 토론</option><option value="CUSTOM" ${draft.mode==='CUSTOM'?'selected':''}>사용자 설정 토론</option></select></div><div class="field"><label for="topicInput">논제</label><input id="topicInput" maxlength="300" value="${esc(draft.topic)}" placeholder="논제를 입력해주세요"></div>${peopleFields(draft.people,draft.mode==='CUSTOM')}</div><div style="height:18px"></div>${draft.mode==='CUSTOM'?`<div class="panel"><div class="page-top"><h2>진행 순서</h2><div class="row">${btn('초기화','reset-stages','secondary')}${btn('CEDA 구성 불러오기','load-ceda')}</div></div><div id="stageCards">${stageCards()}</div></div><div style="height:18px"></div><div class="panel"><h2>새 단계 추가</h2>${stageForm(draft.newStage,'new')}</div>`:`<div class="panel"><h2>CEDA 기본 진행</h2><p class="muted small">입론·교차조사 각 1분 30초 → 자유토론 각 팀 10분(연속 2분) → 숙의 1분 → 반대·찬성 최종발언 각 2분</p></div>`}<div class="panel" style="margin-top:18px"><div class="field"><label for="createCode">방 코드 · 영문·숫자 4~6자리</label><input id="createCode" maxlength="6" value="${esc(draft.roomCode)}" style="text-transform:uppercase" placeholder="예: HM1986"></div><div class="row end">${btn('토론 방 생성','create-room','primary')}</div></div></section>`;
}

function validStage(s){
  if(!s.name.trim()){
    throw Error('단계 이름을 입력해주세요.');
  }

  if(
    !Number.isInteger(s.seconds)||
    s.seconds<1||
    s.seconds>59999
  ){
    throw Error('시간은 1~59999초로 입력해주세요.');
  }

  if(
    s.type==='free'&&(
      !Number.isInteger(s.burst)||
      s.burst<1||
      s.burst>s.seconds
    )
  ){
    throw Error('연속발언 제한은 1초 이상, 총 시간 이하로 입력해주세요.');
  }

  const ids=[
    ...draft.people.A,
    ...draft.people.B
  ].map(p=>p.id);

  if(
    ['normal','cross'].includes(s.type)&&
    !ids.includes(s.speaker)
  ){
    throw Error('발언자 또는 질문자를 선택해주세요.');
  }

  if(
    s.type==='cross'&&(
      !ids.includes(s.target)||
      s.target===s.speaker
    )
  ){
    throw Error('질문자와 다른 답변자를 선택해주세요.');
  }

  return {
    ...s,
    name:s.name.trim(),
    speaker:['normal','cross'].includes(s.type)
      ?s.speaker
      :'',
    target:s.type==='cross'?s.target:'',
    burst:s.type==='free'?s.burst:0,
    color:['free','deliberation'].includes(s.type)
      ?'N'
      :s.color
  };
}

function makeConfig(){
  const config={
    mode:draft.mode,
    topic:draft.topic.trim(),
    people:readPeople(draft.people)
  };

  if(!config.topic){
    throw Error('논제를 입력해주세요.');
  }

  if(draft.mode==='CEDA'){
    config.steps=ceda(config.people);
  }else{
    if(!draft.steps.length){
      throw Error('진행 단계를 추가해주세요.');
    }

    config.steps=draft.steps.map(validStage);
  }

  return config;
}

async function enterRoom(code,asHost){
  code=code.trim().toUpperCase();

  if(!/^[A-Z0-9]{4,6}$/.test(code)){
    throw Error('방 코드를 영문·숫자 4~6자리로 입력해주세요.');
  }

  const existing=await api.getRoom(code);

  if(!existing){
    throw Error('해당 방이 없습니다. 사회자가 먼저 방을 만들어주세요.');
  }

  if(asHost&&!api.ownsRoom(code,existing)){
    throw Error('이 브라우저는 해당 방의 사회자가 아닙니다.');
  }

  room=existing;
  roomCode=code;
  isHost=asHost;
  displaySeen=false;
  lastAlarm='';

  navigate('timer');
  requestWake();
}

function roomPerson(id){
  for(const side of ['A','B']){
    const person=room.config.people[side].find(
      person=>person.id===id
    );

    if(person){
      return `<span class="${side==='A'?'pro':'con'}">${esc(person.name)}</span>`;
    }
  }

  return '';
}

function timerTools(){
  return `<div class="timer-tools"><div class="row">${iconBtn('back','timer-back','돌아가기')}${isHost?iconBtn('copy','copy-room','표시 화면 링크 복사')+btn('토론 종료','close-room','small secondary'):''}<span id="connectionDot" class="connection-dot ${online?'':'off'}" title="${online?'연결됨':'연결 끊김'}"></span></div><div class="row">${iconBtn(sound?'bell':'mute','sound',sound?'알림음 끄기':'알림음 켜기')}${iconBtn('full','fullscreen','전체화면')}</div></div>`;
}

function renderTimer(){
  if(!room){
    navigate('timer-menu',{},true);
    return;
  }

  const free=room.config.steps[room.state.index].type==='free';

  root.innerHTML=`<section class="timer">${timerTools()}<div class="timer-heading"><h1 id="stageTitle"></h1><p id="timerTopic" class="timer-topic"></p><div id="speaker" class="speaker"></div></div><div id="fixedArea" class="fixed-area ${free?'hidden':''}"><div id="fixedClock" class="clock fixed-clock"></div></div><div id="freeArea" class="free-area ${free?'':'hidden'}">${['A','B'].map(side=>`<div id="team${side}" class="team ${side==='A'?'pro':'con'}"><div class="team-label">${side==='A'?'찬성':'반대'}</div><div id="clock${side}" class="clock team-clock"></div><div id="burst${side}" class="clock burst"></div><div class="team-names">${names(room.config.people[side],side)}</div>${isHost?`<div class="row adjust">${btn('+10초','adjust','',`data-side="${side}" data-delta="10"`)}${btn('−10초','adjust','',`data-side="${side}" data-delta="-10"`)}</div>`:''}</div>`).join('')}</div><p id="timerStatus" class="timer-status"></p>${isHost?`<div class="timer-controls"><div id="freeControls" class="row ${free?'':'hidden'}">${btn('찬성 시작','side','primary',`data-side="A"`)}${btn('일시정지·재개','toggle','')}${btn('반대 시작','side','danger',`data-side="B"`)}</div><div class="row">${btn('이전 단계','prev')}${btn('시작','toggle','primary','id="toggleFixed"'+(free?' style="display:none"':''))}${btn('초기화','reset-timer')}${btn('다음 단계','next','success','id="nextStage"')}${btn('토론 설정','timer-setup')}${btn('처음으로','timer-home','secondary','id="timerHome" style="display:none"')}</div><div id="goEvaluate" class="row hidden">${btn('평가 생성','timer-to-eval','primary')}</div><p class="shortcuts">Space 시작·정지 / 일반 단계 ← → 이전·다음 / 자유토론 ← → 찬성·반대 전환</p></div>`:''}</section>`;

  tickTimer();

  pageUnsubs.push(api.watchRoom(roomCode,current=>{
    if(!current){
      if(leavingRoom)return;

      if(isHost){
        draft=newDraft();
        draftEpoch++;
      }

      room=null;
      roomCode='';
      isHost=false;

      toast('방이 종료되었습니다.');
      navigate('timer-menu',{},true);
      return;
    }

    const oldType=room?.config.steps[room.state.index]?.type;
    const oldConfig=JSON.stringify(room?.config);

    room=current;

    if(
      oldType!==current.config.steps[current.state.index].type||
      oldConfig!==JSON.stringify(current.config)
    ){
      cleanup();
      renderTimer();
      return;
    }

    tickTimer();
  },fail,isHost));
}

function tickTimer(){
  if(route.name!=='timer'||!room)return;

  const config=room.config;
  const state=projected(room.state,config,api.now());
  const step=config.steps[state.index];
  const free=step.type==='free';

  $('stageTitle').textContent=step.name;
  $('stageTitle').className=
    step.color==='A'
      ?'pro'
      :step.color==='B'
        ?'con'
        :'';

  $('timerTopic').textContent=config.topic;

  $('speaker').innerHTML=
    step.type==='cross'
      ?`질문자 ${roomPerson(step.speaker)} <span class="muted">→</span> 답변자 ${roomPerson(step.target)}`
      :step.type==='normal'
        ?roomPerson(step.speaker)
        :'';

  $('fixedClock').textContent=fmt(state.remaining);

  $('fixedClock').className=
    'clock fixed-clock '+
    (step.color==='A'?'pro':step.color==='B'?'con':'');

  for(const side of ['A','B']){
    const key=side==='A'?'a':'b';

    $('clock'+side).textContent=fmt(state[key]);
    $('burst'+side).textContent=fmt(
      state[key==='a'?'ba':'bb']
    );

    $('team'+side).classList.toggle(
      'active',
      state.active===side
    );
  }

  const ended=free
    ?!!state.active&&(
      state.active==='A'
        ?state.a<=0||state.ba<=0
        :state.b<=0||state.bb<=0
    )
    :state.remaining<=0;

  $('timerStatus').textContent=
    (
      ended
        ?'시간 종료'
        :state.running
          ?free
            ?(state.active==='A'?'찬성':'반대')+' 발언 중'
            :'진행 중'
          :'시작 대기 · 일시정지'
    )+
    (online?'':' · 연결 끊김: 마지막 수신 상태 기준');

  if(isHost){
    $('toggleFixed').textContent=state.running
      ?'일시정지'
      :state.remaining<step.seconds*1000&&state.remaining>0
        ?'재개'
        :'시작';

    const lastStep=state.index===config.steps.length-1;

    $('nextStage').disabled=lastStep;
    $('timerHome').style.display=lastStep?'':'none';

    root.querySelector('[data-action=prev]').disabled=
      state.index===0;

    const finished=free
      ?state.a<=0&&state.b<=0
      :ended;

    $('goEvaluate').classList.toggle(
      'hidden',
      !(finished&&lastStep)
    );
  }

  if(ended&&room.state.running&&displaySeen){
    const key=
      roomCode+':'+
      room.state.index+':'+
      room.state.revision;

    if(key!==lastAlarm){
      lastAlarm=key;
      beep();
    }
  }

  displaySeen=true;
  fitClocks();
}

function fitClocks(){
  root.querySelectorAll('.clock').forEach(element=>{
    if(
      !element.offsetWidth||
      !element.parentElement.clientWidth
    )return;

    element.style.fontSize='';

    const max=element.parentElement.clientWidth-10;
    const base=parseFloat(
      getComputedStyle(element).fontSize
    );

    if(element.scrollWidth>max){
      element.style.fontSize=
        Math.floor(base*max/element.scrollWidth)+'px';
    }
  });

  const fixed=$('fixedClock');
  const area=$('fixedArea');

  if(fixed&&area&&!area.classList.contains('hidden')){
    const height=area.clientHeight-8;

    if(fixed.getBoundingClientRect().height>height){
      fixed.style.fontSize=Math.max(20,height)+'px';
    }
  }

  root.querySelectorAll('.team').forEach(team=>{
    if(!team.offsetHeight)return;

    const children=Array.from(team.children).filter(
      element=>element.offsetHeight
    );

    const gap=parseFloat(
      getComputedStyle(team).rowGap
    )||0;

    const needed=children.reduce(
      (sum,element)=>
        sum+element.getBoundingClientRect().height,
      0
    )+gap*Math.max(0,children.length-1);

    const style=getComputedStyle(team);

    const available=
      team.clientHeight-
      parseFloat(style.paddingTop)-
      parseFloat(style.paddingBottom);

    const clocks=children.filter(
      element=>element.classList.contains('clock')
    );

    const clockHeight=clocks.reduce(
      (sum,element)=>
        sum+element.getBoundingClientRect().height,
      0
    );

    if(needed>available&&clockHeight){
      const factor=Math.max(
        .15,
        (clockHeight-needed+available)/clockHeight
      );

      clocks.forEach(element=>{
        element.style.fontSize=Math.floor(
          parseFloat(getComputedStyle(element).fontSize)*
          factor
        )+'px';
      });
    }
  });
}

async function requestWake(){
  if(
    'wakeLock'in navigator&&
    document.visibilityState==='visible'
  ){
    try{
      if(!wakeLock||wakeLock.released){
        wakeLock=await navigator.wakeLock.request('screen');
      }
    }catch(_){}
  }
}

function beep(){
  if(sound){
    alarm.play();
  }
}

function unlockSound(){
  if(sound){
    alarm.unlock().catch(error=>{
      console.warn(error.message);
    });
  }
}

window.addEventListener(
  'click',
  unlockSound,
  {capture:true}
);

window.addEventListener(
  'keydown',
  unlockSound,
  {capture:true}
);

function renderBoard(){
  root.innerHTML=`<section class="page">${top('토론 평가')}<div class="board-top"><div class="board-logo">${logo()}</div>${btn('평가 생성하기','create-eval','primary')}</div><div id="boardList">${empty('평가 목록을 불러오고 있습니다.')}</div></section>`;

  pageUnsubs.push(api.watchBoard(rows=>{
    if(route.name!=='board')return;

    const list=Object.entries(rows||{}).sort(
      (a,b)=>
        b[1].createdAt-a[1].createdAt||
        b[0].localeCompare(a[0])
    );

    $('boardList').innerHTML=list.map(([id,meta])=>`<article class="board-item" role="link" tabindex="0" data-board-id="${id}" aria-label="${esc(meta.topic)} 평가하기"><div><h2>${esc(meta.topic)}</h2><p class="pro">찬성 — ${names(meta.people.A,'A')}</p><p class="con">반대 — ${names(meta.people.B,'B')}</p></div><div class="board-right"><span class="receipt-status ${meta.open?'receiving':'closed'}">${meta.open?'평가 중':'마감'}</span><div class="board-date">${new Date(meta.createdAt).toLocaleDateString('ko-KR')}</div><div class="row">${btn('결과보기','manage','',`data-id="${id}"`)}${iconBtn('trash','delete-eval','평가 삭제',`data-id="${id}"`)}</div></div></article>`).join('')||empty('아직 생성된 평가가 없습니다.');
  },fail));
}

let creationDraft;

function renderCreate(){
  creationDraft??={
    topic:'',
    people:blankPeople()
  };

  root.innerHTML=`<section class="page">${top('평가 생성')}<form id="createEvaluationForm"><div class="panel"><div class="field"><label for="evalTopic">논제</label><input id="evalTopic" required maxlength="300" value="${esc(creationDraft.topic)}"></div>${peopleFields(creationDraft.people,true)}</div><div class="row end" style="margin-top:20px"><button type="submit" class="primary">생성하기</button></div></form></section>`;
}

async function startBallot(id,edit=false){
  const meta=await api.evaluation(id);

  if(!meta){
    throw Error('삭제된 평가입니다.');
  }

  const own=await api.ownResponse(id);

  ballot={
    id,
    meta,
    name:own?.name||'',
    scores:own?[...own.scores]:Array(6).fill(50),
    rated:Array(6).fill(!!own),
    isEditing:!!own&&edit
  };

  if(own&&!edit){
    navigate('submitted',{id});
    return;
  }

  if(!meta.open){
    throw Error('평가가 마감되어 수정하거나 제출할 수 없습니다.');
  }

  navigate('ballot',{
    id,
    edit:!!own&&edit
  });
}

function renderSubmitted(){
  root.innerHTML=`<section class="page done-screen"><div><div class="checkmark" aria-hidden="true">✓</div><h1>제출이 완료되었습니다.</h1><p class="muted">평가에 참여해주셔서 감사합니다.</p><p id="editNotice" class="small muted"></p><div class="row">${btn('응답 수정','edit-response','primary','id="editResponse"')}${btn('돌아가기','submitted-back','secondary')}</div></div></section>`;

  pageUnsubs.push(api.watchEvaluation(route.id,meta=>{
    if(!$('editResponse'))return;

    $('editResponse').disabled=!meta?.open;

    $('editNotice').textContent=meta?.open
      ?'마감 전까지 제출한 응답을 수정하실 수 있습니다.'
      :'평가가 마감되어 수정할 수 없습니다.';
  },fail));
}

function renderBallot(){
  const meta=ballot.meta;

  root.innerHTML=`<section class="page ballot">${top('토론 평가')}<div class="eval-heading"><h1>${esc(meta.topic)}</h1>${sideInfo(meta.people)}</div><form id="ballotForm"><div class="panel field"><label for="voterName">이름</label><input id="voterName" required maxlength="60" autocomplete="name" value="${esc(ballot.name)}" placeholder="본인의 이름을 입력해주세요"></div><p class="small muted">양 팀에 총 100점을 배분해주세요. 대등하면 ‘50 : 50 대등’을 눌러주세요.</p>${CRITERIA.map((criterion,i)=>`<section class="criterion"><div class="criterion-title"><span>${i+1}. ${criterion.title}</span><span class="muted small">${criterion.weight}%</span></div><p>${criterion.text}</p><div class="score-line"><span class="pro">찬성 <strong id="proScore${i}">${ballot.scores[i]}</strong></span><span class="con">반대 <strong id="conScore${i}">${100-ballot.scores[i]}</strong></span></div><input class="slider" type="range" min="0" max="100" step="1" value="${100-ballot.scores[i]}" data-score="${i}" aria-label="${criterion.title}: 왼쪽 찬성, 오른쪽 반대" aria-valuetext="찬성 ${ballot.scores[i]}, 반대 ${100-ballot.scores[i]}"><div class="row between">${btn('50 : 50 대등','equal','small secondary',`data-index="${i}"`)}<span id="rated${i}" class="${ballot.rated[i]?'done':'pending'}">${ballot.rated[i]?'평가 완료':'평가 전'}</span></div></section>`).join('')}<p id="ballotError" class="error" role="alert"></p><button data-action="submit" class="submit primary" type="submit">${ballot.isEditing?'수정 내용 저장':'제출하기'}</button></form></section>`;

  pageUnsubs.push(api.watchEvaluation(ballot.id,meta=>{
    ballot.meta.open=!!meta?.open;

    const button=root.querySelector('button[type=submit]');

    if(button){
      button.disabled=!meta?.open;
    }

    if($('ballotError')){
      $('ballotError').textContent=meta?.open
        ?''
        :'평가가 마감되었습니다. 접수가 재개되면 제출하거나 수정할 수 있습니다.';
    }
  },fail));
}

function setScore(i,value){
  ballot.scores[i]=value;
  ballot.rated[i]=true;

  $('proScore'+i).textContent=value;
  $('conScore'+i).textContent=100-value;

  const range=root.querySelector(
    `[data-score="${i}"]`
  );

  range.value=100-value;

  range.setAttribute(
    'aria-valuetext',
    `찬성 ${value}, 반대 ${100-value}`
  );

  $('rated'+i).className='done';
  $('rated'+i).textContent='평가 완료';
}

async function openManage(id){
  await loadManage(id);
  navigate('manage',{id});
}

function renderManage(){
  root.innerHTML=`<section class="page"><div class="page-top"><span class="small muted">평가 관리</span>${back()}</div><div class="eval-heading"><h1>${esc(manage.meta.topic)}</h1>${sideInfo(manage.meta.people)}</div><div class="modes">${[['judges','심사위원 평가'],['mixed','심사위원+청중 평가'],['audience','청중 평가']].map(([value,text])=>btn(text,'mode',manage.settings.mode===value?'selected':'',`data-mode="${value}" aria-pressed="${manage.settings.mode===value}"`)).join('')}${btn('결과보기','publish-result','primary')}${btn(manage.meta.open?'평가 마감':'접수 재개','toggle-receipt','secondary','id="receiptToggle"')}</div><p id="receiptStatus" class="small muted" aria-live="polite"></p>${manage.settings.mode==='mixed'?`<div class="mix"><div class="row between"><strong id="judgePercent">심사위원 ${manage.settings.judgeWeight}%</strong><strong id="audiencePercent">청중 ${100-manage.settings.judgeWeight}%</strong></div><input class="slider" id="mixSlider" type="range" min="0" max="100" step="1" value="${100-manage.settings.judgeWeight}" aria-label="심사위원과 청중 반영 비중"></div>`:''}<div class="row between" style="margin-bottom:14px"><span class="muted small">${manage.settings.mode==='audience'?'응답자':'심사위원 체크 · 최대 3명'}</span><span id="responseCount">응답자 수: ${Object.keys(manage.responses).length}명</span></div><div id="responseList"></div></section>`;

  fillResponses();
  fillReceiptStatus();

  pageUnsubs.push(api.watchEvaluation(manage.id,meta=>{
    if(!meta){
      toast('삭제된 평가입니다.');
      navigate('board',{},true);
      return;
    }

    manage.meta={
      ...manage.meta,
      ...meta
    };

    if(route.name==='manage'){
      fillReceiptStatus();
    }
  },fail));

  pageUnsubs.push(api.watchResponses(manage.id,rows=>{
    manage.responses=rows||{};

    for(const id of Object.keys(manage.settings.judgeIds)){
      if(!manage.responses[id]){
        delete manage.settings.judgeIds[id];
      }
    }

    if(route.name==='manage'){
      fillResponses();
    }
  },fail));
}

function fillReceiptStatus(){
  if(!$('receiptToggle'))return;

  $('receiptToggle').textContent=manage.meta.open
    ?'평가 마감'
    :'접수 재개';

  $('receiptStatus').textContent=manage.meta.open
    ?'평가 중 · 응답 제출과 수정이 가능합니다. 결과보기는 접수를 마감하지 않습니다.'
    :'마감 · 새 응답과 수정이 중단되었습니다. 접수 재개를 누르면 다시 받습니다.';
}

function fillResponses(){
  if(!$('responseList'))return;

  $('responseCount').textContent=
    '응답자 수: '+
    Object.keys(manage.responses).length+
    '명';

  $('responseList').innerHTML=Object.entries(
    manage.responses
  )
    .sort((a,b)=>a[1].submittedAt-b[1].submittedAt)
    .map(([id,response])=>`<div class="respondent">${manage.settings.mode!=='audience'?`<label><input type="checkbox" data-judge="${id}" ${manage.settings.judgeIds[id]?'checked':''} aria-label="${esc(response.name)} 심사위원 지정"><span class="small">심사위원</span></label>`:''}${btn(esc(response.name),'response-detail','name-button',`data-id="${id}"`)}${iconBtn('trash','delete-response','응답 삭제',`data-id="${id}"`)}</div>`)
    .join('')||empty('아직 제출된 응답이 없습니다.');
}

function renderDetail(){
  const response=manage.responses[detailId];

  if(!response){
    goBack();
    return;
  }

  root.innerHTML=`<section class="page ballot">${top('개별 평가 응답')}<h2>${esc(response.name)}</h2><p class="muted small">${esc(manage.meta.topic)}</p><div class="panel"><table class="detail-table"><thead><tr><th>평가 항목</th><th class="pro">찬성</th><th class="con">반대</th></tr></thead><tbody>${CRITERIA.map((criterion,i)=>`<tr><td>${criterion.title} <span class="small muted">${criterion.weight}%</span></td><td class="pro">${response.scores[i]}</td><td class="con">${100-response.scores[i]}</td></tr>`).join('')}<tr><td><strong>가중평균</strong></td><td class="pro">${weighted(response.scores).toFixed(2)}</td><td class="con">${(100-weighted(response.scores)).toFixed(2)}</td></tr></tbody></table></div></section>`;
}

let finalData;

function renderCountdown(){
  const deadline=performance.now()+5000;

  root.innerHTML=`<section class="result"><div class="result-top">${back()}</div><div class="winner"><div id="countdown" class="countdown" aria-live="polite">5</div></div></section>`;

  countdownTimer=setInterval(()=>{
    const left=Math.max(
      0,
      Math.ceil((deadline-performance.now())/1000)
    );

    if(left>0){
      $('countdown').textContent=left;
    }else{
      clearInterval(countdownTimer);
      countdownTimer=null;
      navigate('result',{},true);
    }
  },70);
}

function renderResult(){
  const result=finalData.result;

  root.innerHTML=`<section class="result"><div class="result-top">${back()}</div><div class="winner"><p class="small muted">${esc(finalData.meta.topic)}</p><h1 class="${result.winner==='A'?'pro':result.winner==='B'?'con':''}">${result.winner==='A'?'찬성 승리':result.winner==='B'?'반대 승리':'무승부'}</h1><div class="result-score"><span class="pro">${result.pro.toFixed(1)}%</span> <span class="muted">:</span> <span class="con">${result.con.toFixed(1)}%</span></div></div><div class="result-bottom"><div class="row between"><strong class="pro">찬성</strong><strong class="con">반대</strong></div><div class="result-track" role="img" aria-label="찬성 ${result.pro.toFixed(1)}퍼센트, 반대 ${result.con.toFixed(1)}퍼센트"><div class="a" style="width:${result.pro}%"></div><div class="b" style="width:${result.con}%"></div></div><p class="small muted">${result.mode==='judges'?'심사위원 100%':result.mode==='audience'?'청중 100%':'심사위원 '+result.judgeWeight+'% · 청중 '+(100-result.judgeWeight)+'%'}</p><p class="small muted">${new Date(result.finalizedAt).toLocaleString('ko-KR')} 집계 기준${finalData.meta.open?' · 접수 중이므로 새 응답은 다시 집계해주세요.':''}</p><div class="row">${btn('엑셀 다운로드','download','primary')}</div></div></section>`;
}

function exportResult(){
  const {meta,responses}=finalData;

  downloadWorkbook(
    evaluationSheets(meta,responses,meta),
    '휴머니즘_평가_'+
    new Date(meta.createdAt).toISOString().slice(0,10)+
    '.xlsx'
  );
}

function refreshStages(){
  if($('stageCards')){
    $('stageCards').innerHTML=stageCards();
  }
}

function editingPeople(){
  return route.name==='create'
    ?creationDraft.people
    :draft.people;
}

async function perform(action,button){
  const id=button?.dataset.id;
  const side=button?.dataset.side;

  if(action==='back'||action==='timer-back'){
    await goBack();
    return;
  }

  if(action==='timer-menu'){
    navigate('timer-menu');
    return;
  }

  if(action==='host'){
    draft=newDraft();
    navigate('setup');
    return;
  }

  if(action==='join'){
    navigate('join');
    return;
  }

  if(action==='board'){
    if(!api){
      throw Error('연결을 준비하고 있습니다. 잠시 후 다시 눌러주세요.');
    }

    navigate('board');
    return;
  }

  if(action==='add-person'){
    const people=editingPeople();

    if(people[side].length>=20){
      throw Error('한 팀에 최대 20명까지 입력할 수 있습니다.');
    }

    people[side].push({
      id:uuid(),
      name:''
    });

    render();
    return;
  }

  if(action==='remove-person'){
    const people=editingPeople();

    if(people[side].length<=1)return;

    people[side]=people[side].filter(
      person=>person.id!==id
    );

    render();
    return;
  }

  if(action==='reset-setup'){
    if(await confirmIt(
      '토론 설정을 초기화하시겠습니까?',
      '논제, 토론자와 사용자 구성을 비웁니다.'
    )){
      const code=draft.roomCode;

      draft=newDraft();
      draft.roomCode=code;
      render();
    }

    return;
  }

  if(action==='load-ceda'){
    if(
      draft.steps.length&&
      !await confirmIt(
        'CEDA 구성으로 바꾸시겠습니까?',
        '현재 진행 순서를 교체합니다.'
      )
    )return;

    draft.steps=ceda(readPeople(draft.people));
    draft.editStage='';
    refreshStages();
    return;
  }

  if(action==='reset-stages'){
    if(await confirmIt(
      '진행 순서를 초기화하시겠습니까?',
      '논제와 토론자 정보는 유지합니다.'
    )){
      draft.steps=[];
      draft.editStage='';
      refreshStages();
    }

    return;
  }

  if(action==='clear-new'){
    draft.newStage=blankStage();

    const y=window.scrollY;

    render();
    window.scrollTo(0,y);
    return;
  }

  if(action==='add-stage'){
    draft.steps.push(validStage(draft.newStage));
    draft.newStage=blankStage();

    const y=window.scrollY;

    render();
    window.scrollTo(0,y);
    toast('단계를 추가했습니다.');
    return;
  }

  if(action==='edit-stage'){
    draft.editStage=id;

    draft.editBuffer=structuredClone(
      draft.steps.find(step=>step.id===id)
    );

    refreshStages();
    return;
  }

  if(action==='cancel-stage'){
    draft.editStage='';
    refreshStages();
    return;
  }

  if(action==='save-stage'){
    const index=draft.steps.findIndex(
      step=>step.id===id
    );

    draft.steps[index]=validStage(draft.editBuffer);
    draft.editStage='';
    refreshStages();
    return;
  }

  if(action==='delete-stage'){
    draft.steps=draft.steps.filter(
      step=>step.id!==id
    );

    if(draft.editStage===id){
      draft.editStage='';
    }

    refreshStages();
    return;
  }

  if(action==='move-stage'){
    const index=draft.steps.findIndex(
      step=>step.id===id
    );

    const next=index+Number(button.dataset.dir);

    if(next>=0&&next<draft.steps.length){
      [draft.steps[index],draft.steps[next]]=[
        draft.steps[next],
        draft.steps[index]
      ];
    }

    refreshStages();
    return;
  }

  if(action==='create-room'){
    if(!api){
      throw Error('서버 연결을 준비하고 있습니다.');
    }

    const code=draft.roomCode.trim().toUpperCase();

    if(!/^[A-Z0-9]{4,6}$/.test(code)){
      throw Error('방 코드를 영문·숫자 4~6자리로 입력해주세요.');
    }

    const config=makeConfig();

    await api.createRoom(code,config);
    await enterRoom(code,true);
    return;
  }

  if([
    'toggle',
    'prev',
    'next',
    'side',
    'adjust'
  ].includes(action)){
    await api.roomAction(roomCode,{
      type:action,
      side,
      delta:Number(button?.dataset.delta)
    });

    return;
  }

  if(action==='reset-timer'){
    if(await confirmIt(
      '현재 단계를 초기화하시겠습니까?'
    )){
      await api.roomAction(roomCode,{
        type:'reset'
      });
    }

    return;
  }

  if(action==='timer-setup'){
    const config=structuredClone(room.config);
    const code=roomCode;

    await closeHostedRoom();

    draft={
      ...config,
      roomCode:code,
      newStage:blankStage(),
      editStage:''
    };

    navigate('setup');
    return;
  }

  if(action==='timer-home'){
    if(isHost&&room){
      await closeHostedRoom();
    }

    endedConfig=null;
    creationDraft=null;

    navigate('cover',{},true);
    return;
  }

  if(action==='close-room'){
    if(await confirmIt(
      '토론을 종료하시겠습니까?',
      '표시 화면의 연결도 종료됩니다.'
    )){
      endedConfig=structuredClone(room.config);

      await closeHostedRoom();
      navigate('timer-ended',{},true);
    }

    return;
  }

  if(action==='copy-room'){
    const url=new URL(screenUrl({
      name:'timer',
      code:roomCode,
      host:false
    }));

    try{
      await navigator.clipboard.writeText(url.href);
      toast('표시 화면 링크를 복사했습니다.');
    }catch(_){
      await ask({
        title:'표시 화면 링크',
        text:'아래 주소를 복사해 전달해주세요.',
        value:url.href,
        label:'링크'
      });
    }

    return;
  }

  if(action==='sound'){
    sound=!sound;

    if(sound){
      await alarm.unlock();
    }else{
      alarm.stop();
    }

    const element=root.querySelector(
      '[data-action="sound"]'
    );

    element.innerHTML=svg(sound?'bell':'mute');

    element.setAttribute(
      'aria-label',
      sound?'알림음 끄기':'알림음 켜기'
    );

    element.title=element.getAttribute('aria-label');
    return;
  }

  if(action==='fullscreen'){
    if(document.fullscreenElement){
      await document.exitFullscreen();
    }else if(document.documentElement.requestFullscreen){
      await document.documentElement.requestFullscreen();
    }else{
      toast('이 브라우저는 전체화면을 지원하지 않습니다.');
    }

    return;
  }

  if([
    'create-eval',
    'timer-to-eval',
    'ended-to-eval'
  ].includes(action)){
    if(!api){
      throw Error('서버 연결을 준비하고 있습니다.');
    }

    if(!await authorize())return;

    const config=action==='timer-to-eval'
      ?room.config
      :action==='ended-to-eval'
        ?endedConfig
        :null;

    creationDraft=config
      ?{
        topic:config.topic,
        people:structuredClone(config.people)
      }
      :{
        topic:'',
        people:blankPeople()
      };

    if(action==='timer-to-eval'){
      await closeHostedRoom();
    }

    navigate('create');
    return;
  }

  if(action==='edit-response'){
    await startBallot(route.id,true);
    return;
  }

  if(action==='manage'){
    if(await authorize()){
      await openManage(id);
    }

    return;
  }

  if(action==='delete-eval'){
    if(!await authorize())return;

    if(await confirmIt(
      '이 평가를 삭제하시겠습니까?',
      '논제와 모든 응답이 영구 삭제됩니다.'
    )){
      await api.deleteEvaluation(id);
      managerCache.delete(id);
      toast('평가를 삭제했습니다.');
    }

    return;
  }

  if(action==='equal'){
    setScore(
      Number(button.dataset.index),
      50
    );
    return;
  }

  if(action==='submitted-back'){
    navigate('board',{},true);
    return;
  }

  if(action==='mode'){
    manage.settings.mode=button.dataset.mode;
    cleanup();
    renderManage();
    return;
  }

  if(action==='response-detail'){
    detailId=id;
    navigate('detail');
    return;
  }

  if(action==='delete-response'){
    const response=manage.responses[id];

    if(await confirmIt(
      '응답을 삭제하시겠습니까?',
      response.name+
      '님의 응답을 삭제합니다. 기존 집계 결과도 지워집니다.'
    )){
      await api.deleteResponse(manage.id,id);
    }

    return;
  }

  if(action==='toggle-receipt'){
    const open=!manage.meta.open;

    const meta=await api.setEvaluationOpen(
      manage.id,
      open
    );

    manage.meta={
      ...manage.meta,
      ...meta
    };

    delete manage.meta.result;

    fillReceiptStatus();

    toast(
      open
        ?'평가 접수를 다시 시작했습니다.'
        :'평가를 마감했습니다.'
    );

    return;
  }

  if(action==='publish-result'){
    const settings={
      ...manage.settings,
      judgeIds:manage.settings.mode==='audience'
        ?{}
        :{...manage.settings.judgeIds}
    };

    aggregate(manage.responses,settings);

    finalData=await api.finalize(
      manage.id,
      settings
    );

    manage.meta=finalData.meta;
    navigate('countdown');
    return;
  }

  if(action==='download'){
    exportResult();
    return;
  }
}

async function safely(fn){
  if(busy)return;

  busy=true;

  try{
    await fn();
  }catch(error){
    fail(error);
  }finally{
    busy=false;
  }
}

root.addEventListener('click',event=>{
  const button=event.target.closest('[data-action]');

  if(button){
    const action=button.dataset.action;

    if(action==='submit'||button.disabled)return;

    event.preventDefault();
    safely(()=>perform(action,button));
    return;
  }

  const row=event.target.closest('[data-board-id]');

  if(row){
    safely(()=>startBallot(row.dataset.boardId));
  }
});

root.addEventListener('input',event=>{
  const element=event.target;

  if(element.dataset.person){
    const people=editingPeople();

    const person=people[element.dataset.side].find(
      person=>person.id===element.dataset.person
    );

    if(person){
      person.name=element.value;
    }

    if(route.name==='setup'){
      root.querySelectorAll(
        'select[data-step-field="speaker"],select[data-step-field="target"]'
      ).forEach(select=>{
        const selected=select.value;
        select.innerHTML=personOptions(selected);
      });

      refreshStages();
    }

    return;
  }

  if(element.id==='topicInput'){
    draft.topic=element.value;
  }

  if(element.id==='createCode'){
    draft.roomCode=element.value;
  }

  if(element.id==='evalTopic'){
    creationDraft.topic=element.value;
  }

  if(element.id==='voterName'){
    ballot.name=element.value;
  }

  if(element.dataset.score!==undefined){
    setScore(
      Number(element.dataset.score),
      100-Number(element.value)
    );
  }

  if(element.id==='mixSlider'){
    manage.settings.judgeWeight=
      100-Number(element.value);

    $('judgePercent').textContent=
      '심사위원 '+manage.settings.judgeWeight+'%';

    $('audiencePercent').textContent=
      '청중 '+(100-manage.settings.judgeWeight)+'%';
  }

  if(element.dataset.stepField){
    const scope=element.closest(
      '[data-scope]'
    ).dataset.scope;

    const step=scope==='new'
      ?draft.newStage
      :draft.editBuffer;

    const field=element.dataset.stepField;

    step[field]=['seconds','burst'].includes(field)
      ?Number(element.value)
      :element.value;

    if(field==='speaker'){
      step.color=draft.people.A.some(
        person=>person.id===step.speaker
      )?'A':'B';
    }
  }
});

root.addEventListener('change',event=>{
  const element=event.target;

  if(element.id==='mode'){
    draft.mode=element.value;

    if(draft.mode==='CEDA'){
      for(const side of ['A','B']){
        while(draft.people[side].length<2){
          draft.people[side].push({
            id:uuid(),
            name:''
          });
        }

        draft.people[side]=draft.people[side].slice(0,2);
      }
    }

    render();
  }

  if(element.dataset.stepField==='type'){
    const y=window.scrollY;

    const scope=element.closest(
      '[data-scope]'
    ).dataset.scope;

    const step=scope==='new'
      ?draft.newStage
      :draft.editBuffer;

    step.type=element.value;

    if(
      step.type==='free'||
      step.type==='deliberation'
    ){
      step.color='N';
    }

    render();
    window.scrollTo(0,y);
  }

  if(element.dataset.judge){
    const id=element.dataset.judge;

    if(
      element.checked&&
      Object.keys(manage.settings.judgeIds).length>=3
    ){
      element.checked=false;
      toast('심사위원은 최대 3명입니다.');
      return;
    }

    if(element.checked){
      manage.settings.judgeIds[id]=true;
    }else{
      delete manage.settings.judgeIds[id];
    }
  }
});

root.addEventListener('submit',event=>{
  event.preventDefault();

  safely(async()=>{
    if(!api){
      throw Error('연결을 준비하고 있습니다.');
    }

    if(event.target.id==='joinForm'){
      await enterRoom(
        $('roomInput').value,
        false
      );
      return;
    }

    if(event.target.id==='createEvaluationForm'){
      const topic=creationDraft.topic.trim();

      if(!topic){
        throw Error('논제를 입력해주세요.');
      }

      await api.createEvaluation({
        topic,
        people:readPeople(creationDraft.people)
      });

      creationDraft=null;

      navigate('board',{},true);
      toast('평가를 생성했습니다.');
      return;
    }

    if(event.target.id==='ballotForm'){
      const name=ballot.name.trim();

      if(!name){
        $('voterName').focus();
        throw Error('이름을 입력해주세요.');
      }

      if(ballot.rated.some(value=>!value)){
        const index=ballot.rated.findIndex(
          value=>!value
        );

        root.querySelector(
          `[data-score="${index}"]`
        ).focus();

        throw Error(
          '모든 항목을 평가해주세요. 대등하면 50 : 50 버튼을 눌러주세요.'
        );
      }

      await api.submit(
        ballot.id,
        name,
        ballot.scores
      );

      navigate(
        'submitted',
        {id:ballot.id},
        true
      );
    }
  });
});

document.addEventListener('keydown',event=>{
  if(
    event.target.closest('[data-board-id]')&&
    (event.key==='Enter'||event.key===' ')
  ){
    if(event.target.closest('button,input,select,textarea')){
      return;
    }

    event.preventDefault();

    safely(()=>startBallot(
      event.target.closest('[data-board-id]').dataset.boardId
    ));

    return;
  }

  if(
    route.name!=='timer'||
    !isHost||
    $('dialog').open||
    event.target.closest('input,select,textarea,button')||
    event.ctrlKey||
    event.metaKey||
    event.altKey||
    event.repeat
  )return;

  let action;

  if(event.code==='Space'){
    action={type:'toggle'};
  }

  if(event.code==='ArrowLeft'){
    action=room.config.steps[room.state.index].type==='free'
      ?{type:'side',side:'A'}
      :{type:'prev'};
  }

  if(event.code==='ArrowRight'){
    action=room.config.steps[room.state.index].type==='free'
      ?{type:'side',side:'B'}
      :{type:'next'};
  }

  if(action){
    event.preventDefault();
    safely(()=>api.roomAction(roomCode,action));
  }
});

window.addEventListener('resize',fitClocks);

document.addEventListener('visibilitychange',()=>{
  if(route.name==='timer'){
    requestWake();
    tickTimer();
  }
});

if('scrollRestoration'in history){
  history.scrollRestoration='manual';
}

routing=createRouter({
  capture:captureScreen,
  restore:restoreScreen,
  depart:departScreen,
  onError:fail
});

render();

if(demo){
  $('notice').textContent=
    '체험 모드 · 비밀번호 demo · 이 브라우저에만 저장됩니다.';

  $('notice').hidden=false;
}

setInterval(tickTimer,100);

(async()=>{
  try{
    const backend=await import(
      demo
        ?'./backend-demo.js'
        :'./backend-firebase.js'
    );

    api=await backend.createBackend();

    api.onConnection(value=>{
      online=value;

      const dot=$('connectionDot');

      if(dot){
        dot.classList.toggle('off',!value);
        dot.title=value?'연결됨':'연결 끊김';
      }
    });

    const legacy=new URLSearchParams(
      location.search
    ).get('room');

    if(legacy&&!location.hash){
      await waitForApi();

      const code=legacy.trim().toUpperCase();

      if(!/^[A-Z0-9]{4,6}$/.test(code)){
        throw Error('방 코드를 확인해주세요.');
      }

      const url=screenUrl({
        name:'timer',
        code,
        host:false
      });

      history.replaceState(
        history.state,
        '',
        url
      );
    }

    await routing.start();
  }catch(error){
    fail(error);
  }
})();

window.addEventListener('pagehide',()=>{
  if(isHost&&room){
    api?.disconnect();
  }
});

window.addEventListener('pageshow',event=>{
  if(!event.persisted)return;

  api?.reconnect();

  if(route.name==='timer'&&isHost){
    cleanup();

    room=null;
    roomCode='';
    isHost=false;
    draft=newDraft();
    draftEpoch++;

    navigate('timer-menu',{},true);
  }
});
