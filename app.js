import {
  initializeApp
} from 'https://www.gstatic.com/firebasejs/13.3.0/firebase-app.js';

import {
  getAuth,
  signInAnonymously
} from 'https://www.gstatic.com/firebasejs/13.3.0/firebase-auth.js';

import {
  getDatabase,
  ref,
  get,
  onValue,
  runTransaction,
  serverTimestamp
} from 'https://www.gstatic.com/firebasejs/13.3.0/firebase-database.js';

const firebaseConfig = {
  apiKey: 'AIzaSyDE3Am6ucUj1o0XxhGvlk8Ak7K3AWPZRLU',
  authDomain: 'humanism-timer-6ec7d.firebaseapp.com',
  databaseURL:
    'https://humanism-timer-6ec7d-default-rtdb.asia-southeast1.firebasedatabase.app',
  projectId: 'humanism-timer-6ec7d',
  storageBucket: 'humanism-timer-6ec7d.firebasestorage.app',
  messagingSenderId: '479626948957',
  appId: '1:479626948957:web:c9599dd6315a8ccd58f8b4'
};

/* ---------- 시간 계산 ---------- */

function fresh(config, index, now) {
  const step = config.steps[index];

  return {
    index,
    remaining: step.seconds * 1000,
    a: step.seconds * 1000,
    b: step.seconds * 1000,
    ba: Math.min(step.burst_limit, step.seconds) * 1000,
    bb: Math.min(step.burst_limit, step.seconds) * 1000,
    active: '',
    running: false,
    at: now,
    revision: 0
  };
}

function projected(source, config, now) {
  const s = { ...source };
  const step = config.steps[s.index];

  if (s.running) {
    const elapsed = Math.max(0, now - s.at);

    if (step.type === 'fixed') {
      s.remaining = Math.max(0, s.remaining - elapsed);

      if (!s.remaining) {
        s.running = false;
      }
    } else if (s.active) {
      const total = s.active === 'A' ? 'a' : 'b';
      const burst = s.active === 'A' ? 'ba' : 'bb';

      const used = Math.min(
        elapsed,
        s[total],
        s[burst]
      );

      s[total] = Math.max(0, s[total] - used);
      s[burst] = Math.max(0, s[burst] - used);

      if (!s[total] || !s[burst]) {
        s.running = false;
      }
    } else {
      s.running = false;
    }
  }

  s.at = now;
  return s;
}

function changed(source, config, action, now) {
  let s = projected(source, config, now);
  const step = config.steps[s.index];

  if (action.type === 'next' || action.type === 'prev') {
    const index = s.index +
      (action.type === 'next' ? 1 : -1);

    if (index < 0 || index >= config.steps.length) {
      return null;
    }

    s = fresh(config, index, now);

  } else if (action.type === 'reset') {
    s = fresh(config, s.index, now);

  } else if (action.type === 'pause') {
    s.running = false;

  } else if (action.type === 'toggle') {
    if (s.running) {
      s.running = false;

    } else if (step.type === 'fixed') {
      if (s.remaining <= 0) {
        s.remaining = step.seconds * 1000;
      }

      s.running = true;

    } else if (s.active) {
      const total = s.active === 'A' ? 'a' : 'b';
      const burst = s.active === 'A' ? 'ba' : 'bb';

      s.running = s[total] > 0 && s[burst] > 0;
    }

  } else if (
    action.type === 'start' &&
    step.type === 'fixed'
  ) {
    if (!s.running) {
      if (s.remaining <= 0) {
        s.remaining = step.seconds * 1000;
      }

      s.running = true;
    }

  } else if (
    action.type === 'side' &&
    step.type === 'free'
  ) {
    const total = action.side === 'A' ? 'a' : 'b';
    const burst = action.side === 'A' ? 'ba' : 'bb';

    if (s[total] <= 0) {
      return null;
    }

    if (s.active !== action.side) {
      s[burst] = Math.min(
        step.burst_limit * 1000,
        s[total]
      );
    }

    s.active = action.side;
    s.running = s[burst] > 0;

  } else if (
    action.type === 'adjust' &&
    step.type === 'free'
  ) {
    const total = action.side === 'A' ? 'a' : 'b';
    const burst = action.side === 'A' ? 'ba' : 'bb';

    s[total] = Math.max(
      0,
      Math.min(
        step.seconds * 1000,
        s[total] + action.delta * 1000
      )
    );

    s[burst] = Math.min(s[burst], s[total]);

    if (
      s.active === action.side &&
      (!s[total] || !s[burst])
    ) {
      s.running = false;
    }
  }

  s.revision = source.revision + 1;
  return s;
}

function ceda(config) {
  const a = config.sideALabel;
  const b = config.sideBLabel;

  const a1 = config.sideANames[0] || a + '1';
  const a2 = config.sideANames[1] || a + '2';
  const b1 = config.sideBNames[0] || b + '1';
  const b2 = config.sideBNames[1] || b + '2';

  return [
    ['fixed', a + ' 입론', 90, 'A', a1, ''],
    ['fixed', b + ' 교차조사', 90, 'B', b2, a1],
    ['fixed', b + ' 입론', 90, 'B', b1, ''],
    ['fixed', a + ' 교차조사', 90, 'A', a2, b1],
    ['free', '자유토론', 600, 'N', '', ''],
    ['fixed', '숙의시간', 60, 'N', '', ''],
    ['fixed', b + ' 최종발언', 120, 'B', b2, ''],
    ['fixed', a + ' 최종발언', 120, 'A', a2, '']
  ].map(row => ({
    type: row[0],
    name: row[1],
    seconds: row[2],
    color_role: row[3],
    speaker: row[4],
    target: row[5],
    burst_limit: row[0] === 'free' ? 120 : 0
  }));
}

function clock(ms) {
  const seconds = Math.max(0, Math.ceil(ms / 1000));

  return String(Math.floor(seconds / 60)).padStart(2, '0') +
    ':' +
    String(seconds % 60).padStart(2, '0');
}

/* ---------- 기본 상태 ---------- */

const $ = id => document.getElementById(id);

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getDatabase(app);

let user;
let online = false;
let offset = 0;
let timeReady = false;

let room = null;
let roomCode = '';
let host = false;
let unsubscribe = null;
let busy = false;

let editing = false;
let stages = [];
let selected = -1;

let audio = null;
let sound = false;
let lastAlarm = '';
let seenState = false;
let wakeLock = null;

const now = () => Date.now() + offset;

const hide = (id, value) => {
  $(id).classList.toggle('hidden', value);
};

function show(id) {
  [
    'homeScreen',
    'joinScreen',
    'setupScreen',
    'timerScreen'
  ].forEach(screen => hide(screen, screen !== id));

  $('error').textContent = '';
}

function error(e) {
  console.error(e);

  const code = e.code || '';

  $('error').textContent =
    code.includes('permission') ||
    code.includes('PERMISSION')
      ? '접근할 수 없습니다. Firebase 규칙과 익명 인증 설정을 확인해주세요.'
      : (e.message || String(e));
}

function remember(value) {
  try {
    if (value) {
      sessionStorage.setItem(
        'humanism-timer-room',
        JSON.stringify(value)
      );

      if (value.host) {
        localStorage.setItem(
          'humanism-timer-host',
          JSON.stringify(value)
        );
      }
    } else {
      sessionStorage.removeItem('humanism-timer-room');
    }
  } catch (_) {}
}

function remembered() {
  try {
    return JSON.parse(
      sessionStorage.getItem('humanism-timer-room') ||
      localStorage.getItem('humanism-timer-host') ||
      'null'
    );
  } catch (_) {
    return null;
  }
}

function validCode(value) {
  const code = value.trim().toUpperCase();

  if (!/^[A-Z0-9]{4,6}$/.test(code)) {
    throw new Error(
      '방 코드는 영문·숫자 4~6자리로 입력해주세요.'
    );
  }

  return code;
}

/* 방 코드 입력란 추가 */

const codeBox = document.createElement('div');
codeBox.className = 'field';

codeBox.innerHTML = `
  <label for="createRoomCode">
    방 코드 · 영문·숫자 4~6자리
  </label>

  <input
    id="createRoomCode"
    maxlength="6"
    autocomplete="off"
    placeholder="예: HM1986"
    style="text-transform: uppercase"
  >
`;

$('createRoomButton').parentElement.before(codeBox);

function connectedLabel() {
  const ready = online && user && timeReady;

  $('connection').textContent =
    ready ? '실시간 연결됨' : '연결 준비·재연결 중';

  $('connection').style.color =
    ready ? '#43cf9b' : '#ffb45c';
}

function requireConnection() {
  if (!user || !online || !timeReady) {
    throw new Error(
      '서버에 연결될 때까지 기다려주세요.'
    );
  }
}

/* ---------- 토론 설정 ---------- */

function configFromForm() {
  const names = (id, label) => {
    const list = $(id).value
      .split('\n')
      .map(value => value.trim())
      .filter(Boolean);

    if (
      list.length > 20 ||
      list.some(value => value.length > 60)
    ) {
      throw new Error(
        '팀별 인원은 최대 20명, 이름은 60자 이내입니다.'
      );
    }

    return list.length
      ? list
      : [label + '1', label + '2'];
  };

  const config = {
    mode: $('debateMode').value,
    topic: $('topic').value.trim(),
    sideALabel: $('sideALabel').value.trim() || '찬성',
    sideBLabel: $('sideBLabel').value.trim() || '반대'
  };

  config.sideANames = names(
    'sideANames',
    config.sideALabel
  );

  config.sideBNames = names(
    'sideBNames',
    config.sideBLabel
  );

  config.steps = config.mode === 'CEDA'
    ? ceda(config)
    : stages.map(stage => ({ ...stage }));

  if (
    !config.steps.length ||
    config.steps.length > 60
  ) {
    throw new Error(
      '진행 단계는 1~60개로 설정해주세요.'
    );
  }

  return config;
}

function fillForm(config) {
  $('debateMode').value = config.mode;
  $('topic').value = config.topic;
  $('sideALabel').value = config.sideALabel;
  $('sideBLabel').value = config.sideBLabel;

  $('sideANames').value = config.sideANames.join('\n');
  $('sideBNames').value = config.sideBNames.join('\n');

  stages = config.steps.map(stage => ({ ...stage }));
  selected = -1;

  modeChanged();
  renderStages();
}

function modeChanged() {
  const custom = $('debateMode').value === 'CUSTOM';

  hide('customEditor', !custom);
  hide('cedaInfo', custom);

  $('sideALabel').disabled = !custom;
  $('sideBLabel').disabled = !custom;

  if (!custom) {
    $('sideALabel').value = '찬성';
    $('sideBLabel').value = '반대';
  }
}

function stageTypeChanged() {
  const free = $('stageType').value === 'free';

  [
    'stageSpeaker',
    'stageTarget',
    'stageColor'
  ].forEach(id => {
    $(id).disabled = free;
  });

  $('stageBurst').disabled = !free;
}

function stageInput() {
  const type = $('stageType').value;
  const seconds = Number($('stageSeconds').value);
  const burst = Number($('stageBurst').value);
  const name = $('stageName').value.trim();

  if (!name) {
    throw new Error('단계 이름을 입력해주세요.');
  }

  if (
    !Number.isInteger(seconds) ||
    seconds < 1 ||
    seconds > 59999
  ) {
    throw new Error(
      '시간은 1~59999초의 정수로 입력해주세요.'
    );
  }

  if (
    type === 'free' &&
    (
      !Number.isInteger(burst) ||
      burst < 1 ||
      burst > 59999
    )
  ) {
    throw new Error(
      '연속발언 제한을 1~59999초로 입력해주세요.'
    );
  }

  return {
    type,
    name,
    seconds,
    burst_limit: type === 'free'
      ? Math.min(burst, seconds)
      : 0,
    speaker: type === 'free'
      ? ''
      : $('stageSpeaker').value.trim(),
    target: type === 'free'
      ? ''
      : $('stageTarget').value.trim(),
    color_role: type === 'free'
      ? 'N'
      : $('stageColor').value
  };
}

function clearEditor() {
  selected = -1;

  $('stageName').value = '';
  $('stageSpeaker').value = '';
  $('stageTarget').value = '';
  $('stageType').value = 'fixed';
  $('stageSeconds').value = 90;
  $('stageBurst').value = 120;
  $('stageColor').value = 'A';

  stageTypeChanged();
  renderStages();
}

function selectStage(index) {
  selected = index;

  const stage = stages[index];

  $('stageName').value = stage.name;
  $('stageType').value = stage.type;
  $('stageSeconds').value = stage.seconds;
  $('stageSpeaker').value = stage.speaker;
  $('stageTarget').value = stage.target;
  $('stageColor').value = stage.color_role;
  $('stageBurst').value = stage.burst_limit || 120;

  stageTypeChanged();
  renderStages();
}

function renderStages() {
  $('stageList').replaceChildren();

  if (!stages.length) {
    $('stageList').textContent =
      '단계를 추가하거나 CEDA 구성을 불러오세요.';
  }

  stages.forEach((stage, index) => {
    const item = document.createElement('div');
    item.className = 'stage-item';

    if (index === selected) {
      item.style.borderColor = '#4295ff';
    }

    const title = document.createElement('strong');
    title.textContent =
      (index + 1) + '. ' + stage.name;

    const detail = document.createElement('div');
    detail.className = 'muted';

    detail.textContent = stage.type === 'free'
      ? '각 팀 ' + clock(stage.seconds * 1000) +
        ' / 연속 ' + clock(stage.burst_limit * 1000)
      : clock(stage.seconds * 1000) +
        ' · ' +
        (stage.target ? stage.target + ' ← ' : '') +
        (stage.speaker || '발언자 없음');

    const buttons = document.createElement('div');
    buttons.className = 'actions';

    const addButton = (text, fn) => {
      const button = document.createElement('button');

      button.type = 'button';
      button.textContent = text;
      button.onclick = fn;

      buttons.append(button);
    };

    addButton('편집', () => selectStage(index));

    addButton('위로', () => {
      if (index > 0) {
        [stages[index - 1], stages[index]] =
          [stages[index], stages[index - 1]];

        selected = -1;
        renderStages();
      }
    });

    addButton('아래로', () => {
      if (index < stages.length - 1) {
        [stages[index + 1], stages[index]] =
          [stages[index], stages[index + 1]];

        selected = -1;
        renderStages();
      }
    });

    addButton('삭제', () => {
      stages.splice(index, 1);
      selected = -1;
      renderStages();
    });

    item.append(title, detail, buttons);
    $('stageList').append(item);
  });
}

/* ---------- 방 생성·입장 ---------- */

async function createRoom() {
  requireConnection();

  if (busy) return;

  const config = configFromForm();

  if (
    editing &&
    !confirm(
      '현재 진행 시간을 초기화하고 설정을 적용할까요?'
    )
  ) {
    return;
  }

  const code = editing
    ? roomCode
    : validCode($('createRoomCode').value);

  busy = true;

  try {
    const result = await runTransaction(
      ref(db, 'rooms/' + code),
      current => {
        if (editing) {
          if (
            !current ||
            current.ownerUid !== user.uid
          ) {
            return;
          }

          return {
            ...current,
            config,
            state: fresh(config, 0, now())
          };
        }

        if (current) {
          return current.ownerUid === user.uid
            ? current
            : undefined;
        }

        return {
          ownerUid: user.uid,
          createdAt: serverTimestamp(),
          config,
          state: fresh(config, 0, now())
        };
      },
      { applyLocally: false }
    );

    if (!result.committed) {
      throw new Error(
        '다른 사회자가 사용 중인 방 코드입니다. ' +
        '다른 코드를 입력해주세요.'
      );
    }

    editing = false;
    await enterRoom(code, true);

  } finally {
    busy = false;
  }
}

async function enterRoom(code, wantHost = false) {
  requireConnection();

  code = validCode(code);

  const snapshot = await get(
    ref(db, 'rooms/' + code)
  );

  if (!snapshot.exists()) {
    throw new Error(
      '해당 코드의 방이 없습니다. ' +
      '사회자가 먼저 방을 만들어주세요.'
    );
  }

  const data = snapshot.val();

  if (
    wantHost &&
    data.ownerUid !== user.uid
  ) {
    throw new Error(
      '이 브라우저에는 해당 방의 조작 권한이 없습니다.'
    );
  }

  if (unsubscribe) {
    unsubscribe();
  }

  roomCode = code;
  host = wantHost;
  room = data;
  seenState = false;
  lastAlarm = '';

  remember({ code, host });

  $('roomCode').textContent = code;
  $('roleLabel').textContent = host
    ? '사회자 · 조작 가능'
    : '표시 화면 · 보기 전용';

  hide('hostControls', !host);
  hide('copyViewerButton', !host);

  show('timerScreen');
  render();

  unsubscribe = onValue(
    ref(db, 'rooms/' + code),
    snapshot => {
      if (!snapshot.exists()) {
        if (unsubscribe) unsubscribe();

        unsubscribe = null;
        room = null;
        host = false;
        roomCode = '';

        remember(null);
        show('homeScreen');

        $('status').textContent =
          '사회자가 방을 종료했습니다.';

        return;
      }

      room = snapshot.val();

      if (
        host &&
        room.ownerUid !== user.uid
      ) {
        host = false;
        hide('hostControls', true);
      }

      render();
    },
    e => {
      error(e);

      $('connection').textContent =
        '상태 수신 오류';
    }
  );

  requestWakeLock();
}

async function leaveRoom() {
  if (busy) return;

  if (host) {
    if (
      !confirm(
        '방을 종료하고 나갈까요? ' +
        '표시 화면 연결도 종료됩니다.'
      )
    ) {
      return;
    }

    requireConnection();
    busy = true;

    try {
      await runTransaction(
        ref(db, 'rooms/' + roomCode),
        current =>
          current && current.ownerUid === user.uid
            ? null
            : undefined,
        { applyLocally: false }
      );
    } finally {
      busy = false;
    }

    try {
      localStorage.removeItem('humanism-timer-host');
    } catch (_) {}
  }

  if (unsubscribe) {
    unsubscribe();
  }

  unsubscribe = null;
  room = null;
  host = false;
  roomCode = '';

  remember(null);

  if (wakeLock) {
    await wakeLock.release().catch(() => {});
    wakeLock = null;
  }

  history.replaceState(
    null,
    '',
    location.pathname
  );

  show('homeScreen');
  $('status').textContent = '';
}

/* ---------- 사회자 조작 ---------- */

async function act(action) {
  requireConnection();

  if (!host || !room || busy) {
    return;
  }

  busy = true;

  try {
    const result = await runTransaction(
      ref(db, 'rooms/' + roomCode),
      current => {
        if (
          !current ||
          current.ownerUid !== user.uid
        ) {
          return;
        }

        const state = changed(
          current.state,
          current.config,
          action,
          now()
        );

        if (!state) {
          return;
        }

        return { ...current, state };
      },
      { applyLocally: false }
    );

    if (!result.committed) {
      throw new Error(
        '조작할 수 없습니다. ' +
        '단계 또는 남은 시간을 확인해주세요.'
      );
    }
  } finally {
    busy = false;
  }
}

/* ---------- 타이머 화면 ---------- */

function render() {
  if (
    !room ||
    $('timerScreen').classList.contains('hidden')
  ) {
    return;
  }

  const config = room.config;
  const raw = room.state;
  const state = projected(raw, config, now());
  const step = config.steps[state.index];
  const free = step.type === 'free';

  $('stageTitle').textContent =
    (state.index + 1) +
    ' / ' +
    config.steps.length +
    ' · ' +
    step.name;

  $('topicDisplay').textContent = config.topic;

  $('speakerDisplay').textContent = step.target
    ? step.target + ' ← ' + step.speaker
    : step.speaker;

  const color = step.color_role === 'A'
    ? '#4295ff'
    : step.color_role === 'B'
      ? '#ff6678'
      : '#f2f5fc';

  $('stageTitle').style.color = color;
  $('fixedClock').style.color = color;

  hide('fixedDisplay', free);
  hide('freeDisplay', !free);
  hide('fixedControls', free);
  hide('freeControls', !free);

  $('fixedClock').textContent =
    clock(state.remaining);

  $('teamALabel').textContent = config.sideALabel;
  $('teamBLabel').textContent = config.sideBLabel;

  $('teamAClock').textContent = clock(state.a);
  $('teamBClock').textContent = clock(state.b);

  $('teamABurst').textContent = clock(state.ba);
  $('teamBBurst').textContent = clock(state.bb);

  $('teamANames').textContent =
    config.sideANames.join(' · ');

  $('teamBNames').textContent =
    config.sideBNames.join(' · ');

  $('teamAPanel').classList.toggle(
    'active',
    state.active === 'A'
  );

  $('teamBPanel').classList.toggle(
    'active',
    state.active === 'B'
  );

  $('startAButton').textContent =
    config.sideALabel + ' 시작';

  $('startBButton').textContent =
    config.sideBLabel + ' 시작';

  $('addAButton').textContent =
    config.sideALabel + ' +10초';

  $('subtractAButton').textContent =
    config.sideALabel + ' -10초';

  $('addBButton').textContent =
    config.sideBLabel + ' +10초';

  $('subtractBButton').textContent =
    config.sideBLabel + ' -10초';

  let label = state.running
    ? '진행 중'
    : '일시정지 · 시작 대기';

  if (free && state.active) {
    label =
      (
        state.active === 'A'
          ? config.sideALabel
          : config.sideBLabel
      ) +
      ' · ' +
      label;
  }

  const ended = free
    ? !!state.active && (
      state.active === 'A'
        ? state.a <= 0 || state.ba <= 0
        : state.b <= 0 || state.bb <= 0
    )
    : state.remaining <= 0;

  if (ended) {
    label = free
      ? '총 시간 또는 연속발언 제한 도달'
      : '시간 종료';
  }

  if (!online) {
    label +=
      ' · 연결 끊김: 마지막 수신 상태 기준';
  }

  $('runStatus').textContent = label;

  $('previousButton').disabled =
    state.index === 0;

  $('nextButton').disabled =
    state.index === config.steps.length - 1;

  $('nextButton').textContent =
    state.index === config.steps.length - 1
      ? '마지막 단계'
      : '다음 단계';

  if (ended && raw.running && seenState) {
    const key =
      roomCode + ':' +
      raw.index + ':' +
      raw.revision;

    if (lastAlarm !== key) {
      lastAlarm = key;
      beep();
    }
  }

  seenState = true;
}

/* ---------- 알림음·화면 유지 ---------- */

async function enableSound() {
  if (!audio) {
    audio = new (
      window.AudioContext ||
      window.webkitAudioContext
    )();
  }

  await audio.resume();

  sound = !sound;

  $('soundButton').textContent = sound
    ? '알림음 끄기'
    : '알림음 켜기';
}

function beep() {
  if (
    !sound ||
    !audio ||
    audio.state !== 'running'
  ) {
    return;
  }

  const oscillator = audio.createOscillator();
  const gain = audio.createGain();

  oscillator.frequency.value = 880;
  gain.gain.value = 0.08;

  oscillator.connect(gain);
  gain.connect(audio.destination);

  oscillator.start();
  oscillator.stop(audio.currentTime + 1);
}

async function requestWakeLock() {
  if (
    'wakeLock' in navigator &&
    document.visibilityState === 'visible' &&
    room
  ) {
    try {
      if (!wakeLock || wakeLock.released) {
        wakeLock = await navigator.wakeLock
          .request('screen');
      }
    } catch (_) {}
  }
}

/* ---------- 버튼 연결 ---------- */

function bind(id, fn) {
  $(id).addEventListener(
    'click',
    () => Promise.resolve()
      .then(fn)
      .catch(error)
  );
}

bind('hostButton', async () => {
  requireConnection();

  const old = remembered();

  if (old && old.host) {
    const snapshot = await get(
      ref(db, 'rooms/' + old.code)
    );

    if (
      snapshot.exists() &&
      snapshot.val().ownerUid === user.uid
    ) {
      await enterRoom(old.code, true);
      return;
    }
  }

  editing = false;
  codeBox.classList.remove('hidden');

  $('createRoomButton').textContent =
    '토론 방 생성';

  show('setupScreen');
});

bind('viewerButton', () => {
  show('joinScreen');
});

document.querySelectorAll('.backHome')
  .forEach(button => {
    button.onclick = () => {
      if (editing && room) {
        editing = false;
        show('timerScreen');
        render();
      } else {
        show('homeScreen');
      }
    };
  });

$('joinForm').onsubmit = event => {
  event.preventDefault();

  enterRoom(
    $('joinCode').value,
    false
  ).catch(error);
};

$('debateMode').onchange = modeChanged;
$('stageType').onchange = stageTypeChanged;

function configFromFormForTemplate() {
  return {
    sideALabel:
      $('sideALabel').value.trim() || 'A측',

    sideBLabel:
      $('sideBLabel').value.trim() || 'B측',

    sideANames: $('sideANames').value
      .split('\n')
      .map(value => value.trim())
      .filter(Boolean),

    sideBNames: $('sideBNames').value
      .split('\n')
      .map(value => value.trim())
      .filter(Boolean)
  };
}

bind('loadCedaButton', () => {
  if (
    stages.length &&
    !confirm(
      '현재 단계 목록을 CEDA 구성으로 바꿀까요?'
    )
  ) {
    return;
  }

  stages = ceda(configFromFormForTemplate());
  clearEditor();
});

bind('addStageButton', () => {
  if (stages.length >= 60) {
    throw new Error(
      '최대 60단계까지 추가할 수 있습니다.'
    );
  }

  stages.push(stageInput());
  clearEditor();
});

bind('updateStageButton', () => {
  if (selected < 0) {
    throw new Error(
      '수정할 단계를 선택해주세요.'
    );
  }

  stages[selected] = stageInput();
  renderStages();
});

bind('clearStageButton', clearEditor);
bind('createRoomButton', createRoom);

bind('startButton', () => {
  return act({ type: 'start' });
});

bind('pauseButton', () => {
  return act({ type: 'pause' });
});

bind('startAButton', () => {
  return act({ type: 'side', side: 'A' });
});

bind('startBButton', () => {
  return act({ type: 'side', side: 'B' });
});

bind('toggleFreeButton', () => {
  return act({ type: 'toggle' });
});

bind('previousButton', () => {
  return act({ type: 'prev' });
});

bind('nextButton', () => {
  return act({ type: 'next' });
});

bind('resetButton', () => {
  if (
    confirm('현재 단계 시간을 초기화할까요?')
  ) {
    return act({ type: 'reset' });
  }
});

[
  ['addAButton', 'A', 10],
  ['subtractAButton', 'A', -10],
  ['addBButton', 'B', 10],
  ['subtractBButton', 'B', -10]
].forEach(([id, side, delta]) => {
  bind(id, () => {
    return act({
      type: 'adjust',
      side,
      delta
    });
  });
});

bind('backToSetupButton', async () => {
  await act({ type: 'pause' });

  if (busy) return;

  fillForm(room.config);
  editing = true;

  codeBox.classList.add('hidden');

  $('createRoomButton').textContent =
    '설정 적용 · 첫 단계로';

  show('setupScreen');
});

bind('leaveRoomButton', leaveRoom);

bind('copyViewerButton', async () => {
  const url = new URL(location.href);

  url.search = '';
  url.hash = '';
  url.searchParams.set('room', roomCode);

  await navigator.clipboard.writeText(url.href);

  $('status').textContent =
    '표시 화면 링크를 복사했습니다.';
});

bind('soundButton', enableSound);

bind('fullscreenButton', async () => {
  if (document.fullscreenElement) {
    await document.exitFullscreen();
  } else {
    await document.documentElement
      .requestFullscreen();
  }
});

document.addEventListener(
  'visibilitychange',
  () => {
    requestWakeLock();
    render();
  }
);

/* ---------- 단축키 ---------- */

document.addEventListener('keydown', event => {
  if (
    !host ||
    !room ||
    $('timerScreen').classList.contains('hidden') ||
    /INPUT|TEXTAREA|SELECT|BUTTON/
      .test(event.target.tagName) ||
    event.ctrlKey ||
    event.metaKey ||
    event.altKey ||
    event.repeat
  ) {
    return;
  }

  const free =
    room.config.steps[room.state.index].type === 'free';

  let action;

  if (event.code === 'Space') {
    action = { type: 'toggle' };
  }

  if (event.code === 'ArrowLeft') {
    action = free
      ? { type: 'side', side: 'A' }
      : { type: 'prev' };
  }

  if (event.code === 'ArrowRight') {
    action = free
      ? { type: 'side', side: 'B' }
      : { type: 'next' };
  }

  if (event.code === 'Enter' && !free) {
    action = { type: 'start' };
  }

  if (action) {
    event.preventDefault();
    act(action).catch(error);
  }
});

/* ---------- 서버 연결 ---------- */

modeChanged();
stageTypeChanged();
renderStages();

setInterval(render, 100);

onValue(
  ref(db, '.info/connected'),
  snapshot => {
    online = snapshot.val() === true;
    connectedLabel();
    render();
  }
);

onValue(
  ref(db, '.info/serverTimeOffset'),
  snapshot => {
    offset = Number(snapshot.val()) || 0;
    timeReady = true;
    connectedLabel();
  }
);

async function boot() {
  await auth.authStateReady();

  user = auth.currentUser ||
    (await signInAnonymously(auth)).user;

  connectedLabel();

  if (!online || !timeReady) {
    await new Promise(resolve => {
      const interval = setInterval(() => {
        if (online && timeReady) {
          clearInterval(interval);
          clearTimeout(timeout);
          resolve();
        }
      }, 100);

      const timeout = setTimeout(() => {
        clearInterval(interval);
        resolve();
      }, 10000);
    });
  }

  const query = new URLSearchParams(
    location.search
  ).get('room');

  const saved = remembered();

  if (query) {
    await enterRoom(query, false);

  } else if (saved) {
    try {
      await enterRoom(saved.code, saved.host);
    } catch (e) {
      remember(null);
      error(e);
    }
  }
}

boot().catch(error);
