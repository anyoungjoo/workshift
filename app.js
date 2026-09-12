/**
 * 송출센터 4교대 스마트 근무표 애플리케이션 (app.js)
 * 
 * 근무 주기: 일(09-18) -> 야(18-24) -> 조(00-09) -> 비(비번)
 * 4인 순환 교대근무 및 대근 자동 배정/수기 변경 로직
 */

// 1. 상수 정의
const SHIFT_TYPES = ['일', '야', '조', '비'];
const SHIFT_DETAILS = {
  '일': { name: '일근', time: '09:00 ~ 18:00', class: 'pill-il', color: '#475569' }, // 단정한 회색
  '야': { name: '야근', time: '18:00 ~ 24:00', class: 'pill-ya', color: '#475569' }, // 단정한 회색
  '조': { name: '조근', time: '00:00 ~ 09:00', class: 'pill-jo', color: '#475569' }, // 단정한 회색
  '비': { name: '비번', time: '휴무 (Off)',   class: 'pill-bi', color: '#34d399' }  // 한 톤 더 흐리고 은은한 소프트 민트
};

// 주 52시간 상한제 법정 실근무 시간 정의 (근로기준법 휴게시간 적용: 기본 일 8h, 야 6h, 조 8h, 비 0h)
let SHIFT_HOURS = {
  '일': 8,
  '야': 6,
  '조': 8,
  '비': 0
};
const MAX_WEEKLY_HOURS = 52;

// 입력된 시간 문자열(예: 09:00~18:00, 09:00~17:00 등)에서 실근무 시간을 계산하는 유틸리티
function calculateShiftHoursFromTime(timeStr, defaultHours = 8) {
  if (!timeStr) return defaultHours;
  // 시간 추출 정규식: HH:MM ~ HH:MM 또는 HH ~ HH
  const matches = timeStr.match(/(\d{1,2})(?::(\d{2}))?\s*[-~]\s*(\d{1,2})(?::(\d{2}))?/);
  if (!matches) return defaultHours;

  const startH = parseInt(matches[1], 10);
  const startM = parseInt(matches[2] || '0', 10);
  const endH = parseInt(matches[3], 10);
  const endM = parseInt(matches[4] || '0', 10);

  let startMin = startH * 60 + startM;
  let endMin = endH * 60 + endM;
  if (endMin <= startMin) {
    endMin += 24 * 60; // 자정을 넘기는 교대근무 처리
  }

  const durationHours = (endMin - startMin) / 60;

  // 근로기준법상 8시간 이상 체류 근무 시 법정 휴게시간 1시간 차감 (예: 09~18시는 9-1=8시간, 09~17시는 8-1=7시간)
  let workHours = durationHours;
  if (durationHours >= 8) {
    workHours = durationHours - 1;
  }

  return Math.max(0, Math.round(workHours * 10) / 10);
}

// 2. 기본 상태 (Default State)
const DEFAULT_MEMBERS = [
  { id: 0, name: '최혜진', baseShift: '일' },
  { id: 1, name: '이준희', baseShift: '야' },
  { id: 2, name: '안영주', baseShift: '조' },
  { id: 3, name: '오승연', baseShift: '비' }
];

// 4인 순환 교대근무 4인 멤버 보장 함수 (오승연/비번 누락 방지 및 순서 정렬)
function ensureFourMembers() {
  if (!Array.isArray(appState.members)) {
    appState.members = JSON.parse(JSON.stringify(DEFAULT_MEMBERS));
    return;
  }

  // 예전 5인 잔여 데이터 등 필터링
  appState.members = appState.members.filter(m => m && m.name !== '정수진' && m.id !== 4);

  const defaultList = [
    { id: 0, name: '최혜진', baseShift: '일' },
    { id: 1, name: '이준희', baseShift: '야' },
    { id: 2, name: '안영주', baseShift: '조' },
    { id: 3, name: '오승연', baseShift: '비' }
  ];

  defaultList.forEach(defM => {
    let m = appState.members.find(x => x.id === defM.id || x.name === defM.name);
    if (!m) {
      appState.members.push(JSON.parse(JSON.stringify(defM)));
    } else {
      m.id = defM.id;
      if (!m.name || m.name === '최희진') m.name = defM.name;
      if (!m.baseShift) m.baseShift = defM.baseShift;
    }
  });

  // 4번째 멤버(오승연) 누락 시 강제 보정
  if (appState.members[3]) {
    if (!appState.members[3].name) appState.members[3].name = '오승연';
    if (!appState.members[3].baseShift) appState.members[3].baseShift = '비';
  }

  // ID 순 정렬 및 4명 유지
  appState.members.sort((a, b) => a.id - b.id);
  if (appState.members.length > 4) {
    appState.members = appState.members.slice(0, 4);
  }
}

// 날짜 포맷팅 유틸리티 (YYYY-MM-DD)
function formatDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// 대한민국 법정 공휴일, 대체공휴일 및 방송국 특별 휴일 (3/3 창립기념일, 5/20 노조창립일, 9/3 방송의 날)
const HOLIDAYS_MAP = {
  // 2024년
  "2024-01-01": "신정",
  "2024-02-09": "설날연휴",
  "2024-02-10": "설날",
  "2024-02-11": "설날연휴",
  "2024-02-12": "대체공휴일",
  "2024-03-01": "3·1절",
  "2024-03-03": "창립기념일",
  "2024-04-10": "국회의원선거",
  "2024-05-05": "어린이날",
  "2024-05-06": "대체공휴일",
  "2024-05-15": "석가탄신일",
  "2024-05-20": "노조창립일",
  "2024-06-06": "현충일",
  "2024-08-15": "광복절",
  "2024-09-03": "방송의 날",
  "2024-09-16": "추석연휴",
  "2024-09-17": "추석",
  "2024-09-18": "추석연휴",
  "2024-10-01": "임시공휴일",
  "2024-10-03": "개천절",
  "2024-10-09": "한글날",
  "2024-12-25": "성탄절",

  // 2025년
  "2025-01-01": "신정",
  "2025-01-28": "설날연휴",
  "2025-01-29": "설날",
  "2025-01-30": "설날연휴",
  "2025-03-01": "3·1절",
  "2025-03-03": "창립기념일",
  "2025-03-04": "대체공휴일",
  "2025-05-05": "어린이날",
  "2025-05-06": "대체공휴일",
  "2025-05-20": "노조창립일",
  "2025-06-06": "현충일",
  "2025-08-15": "광복절",
  "2025-09-03": "방송의 날",
  "2025-10-03": "개천절",
  "2025-10-05": "추석연휴",
  "2025-10-06": "추석",
  "2025-10-07": "추석연휴",
  "2025-10-08": "대체공휴일",
  "2025-10-09": "한글날",
  "2025-12-25": "성탄절",

  // 2026년
  "2026-01-01": "신정",
  "2026-02-16": "설날연휴",
  "2026-02-17": "설날",
  "2026-02-18": "설날연휴",
  "2026-03-01": "3·1절",
  "2026-03-02": "대체공휴일",
  "2026-03-03": "창립기념일", // 방송국 창립기념일
  "2026-05-05": "어린이날",
  "2026-05-20": "노조창립일", // 방송국 노조창립일
  "2026-05-24": "석가탄신일",
  "2026-05-25": "대체공휴일",
  "2026-06-06": "현충일",
  "2026-08-15": "광복절",
  "2026-08-17": "대체공휴일",
  "2026-09-03": "방송의 날", // 방송국 방송의 날
  "2026-09-24": "추석연휴",
  "2026-09-25": "추석",
  "2026-09-26": "추석연휴",
  "2026-10-03": "개천절",
  "2026-10-05": "대체공휴일",
  "2026-10-09": "한글날",
  "2026-12-25": "성탄절",

  // 2027년
  "2027-01-01": "신정",
  "2027-02-06": "설날연휴",
  "2027-02-07": "설날",
  "2027-02-08": "설날연휴",
  "2027-02-09": "대체공휴일",
  "2027-03-01": "3·1절",
  "2027-03-03": "창립기념일",
  "2027-05-05": "어린이날",
  "2027-05-13": "석가탄신일",
  "2027-05-20": "노조창립일",
  "2027-06-06": "현충일",
  "2027-08-15": "광복절",
  "2027-08-16": "대체공휴일",
  "2027-09-03": "방송의 날",
  "2027-09-14": "추석연휴",
  "2027-09-15": "추석",
  "2027-09-16": "추석연휴",
  "2027-10-03": "개천절",
  "2027-10-04": "대체공휴일",
  "2027-10-09": "한글날",
  "2027-10-11": "대체공휴일",
  "2027-12-25": "성탄절",
  "2027-12-27": "대체공휴일",

  // 2028년
  "2028-01-01": "신정",
  "2028-01-26": "설날연휴",
  "2028-01-27": "설날",
  "2028-01-28": "설날연휴",
  "2028-03-01": "3·1절",
  "2028-03-03": "창립기념일",
  "2028-05-02": "석가탄신일",
  "2028-05-05": "어린이날",
  "2028-05-20": "노조창립일",
  "2028-06-06": "현충일",
  "2028-08-15": "광복절",
  "2028-09-03": "방송의 날",
  "2028-10-02": "추석연휴",
  "2028-10-03": "추석·개천절",
  "2028-10-04": "추석연휴",
  "2028-10-05": "대체공휴일",
  "2028-10-09": "한글날",
  "2028-12-25": "성탄절",

  // 2029년
  "2029-01-01": "신정",
  "2029-02-12": "설날연휴",
  "2029-02-13": "설날",
  "2029-02-14": "설날연휴",
  "2029-03-01": "3·1절",
  "2029-03-03": "창립기념일",
  "2029-05-05": "어린이날",
  "2029-05-07": "대체공휴일",
  "2029-05-20": "석가탄신일·노조창립일",
  "2029-05-21": "대체공휴일",
  "2029-06-06": "현충일",
  "2029-08-15": "광복절",
  "2029-09-03": "방송의 날",
  "2029-09-21": "추석연휴",
  "2029-09-22": "추석",
  "2029-09-23": "추석연휴",
  "2029-09-24": "대체공휴일",
  "2029-10-03": "개천절",
  "2029-10-09": "한글날",
  "2029-12-25": "성탄절",

  // 2030년
  "2030-01-01": "신정",
  "2030-02-02": "설날연휴",
  "2030-02-03": "설날",
  "2030-02-04": "설날연휴",
  "2030-02-05": "대체공휴일",
  "2030-03-01": "3·1절",
  "2030-03-03": "창립기념일",
  "2030-05-05": "어린이날",
  "2030-05-06": "대체공휴일",
  "2030-05-09": "석가탄신일",
  "2030-05-20": "노조창립일",
  "2030-06-06": "현충일",
  "2030-08-15": "광복절",
  "2030-09-03": "방송의 날",
  "2030-09-11": "추석연휴",
  "2030-09-12": "추석",
  "2030-09-13": "추석연휴",
  "2030-10-03": "개천절",
  "2030-10-09": "한글날",
  "2030-12-25": "성탄절"
};

// 특정 일자의 공휴일 정보 조회 (법정 공휴일 + 대체공휴일 + 방송국 지정 휴일)
function getHolidayInfo(dateStr) {
  if (HOLIDAYS_MAP[dateStr]) {
    return { isHoliday: true, name: HOLIDAYS_MAP[dateStr] };
  }
  // 2024~2030년 외 연도 대비 고정 양력 휴일 폴백
  const parts = dateStr.split('-');
  if (parts.length === 3) {
    const mmdd = `${parts[1]}-${parts[2]}`;
    const fixed = {
      '01-01': '신정',
      '03-01': '3·1절',
      '03-03': '창립기념일', // 방송국 창립기념일
      '05-05': '어린이날',
      '05-20': '노조창립일', // 방송국 노조창립일
      '06-06': '현충일',
      '08-15': '광복절',
      '09-03': '방송의 날', // 방송국 방송의 날
      '10-03': '개천절',
      '10-09': '한글날',
      '12-25': '성탄절'
    };
    if (fixed[mmdd]) {
      return { isHoliday: true, name: fixed[mmdd] };
    }
  }
  return { isHoliday: false, name: null };
}

// 기준일 (9월 11일 기준: 1번 최혜진 일, 2번 이준희 야, 3번 안영주 조, 4번 오승연 비)
const DEFAULT_REF_DATE = '2026-09-11';

// 현재 시간 기준 동적 상태 초기화 (시스템 시각 및 날짜 정확히 추적)
const nowInit = new Date();
const todayDateStr = formatDate(nowInit);

// 상태 관리 객체
let appState = {
  currentYear: nowInit.getFullYear(),
  currentMonth: nowInit.getMonth(), // 0-indexed (8 = 9월)
  selectedMemberId: 'ALL', // 'ALL' or member.id
  refDate: DEFAULT_REF_DATE,
  activeWeekDate: todayDateStr, // 하단 주간 통계 기준일: 실제 오늘 날짜
  lastRenderedTodayStr: todayDateStr,
  members: JSON.parse(JSON.stringify(DEFAULT_MEMBERS)),
  // leaves: { 'YYYY-MM-DD': { [memberId]: { isLeave: true, subId: number|null, isManual: boolean, subType: string } } }
  leaves: {},
  activeModalDate: null,
  font: 'Pretendard',
  // 근무 형태별 시간 설정 (수기 변경 가능)
  shiftTimes: {
    '일': '09:00~18:00',
    '야': '18:00~24:00',
    '조': '00:00~09:00'
  }
};

function updateShiftTimes(times) {
  if (!times) return;
  if (!appState.shiftTimes) appState.shiftTimes = {};
  if (times['일']) {
    SHIFT_DETAILS['일'].time = times['일'];
    appState.shiftTimes['일'] = times['일'];
    SHIFT_HOURS['일'] = calculateShiftHoursFromTime(times['일'], 8);
  }
  if (times['야']) {
    SHIFT_DETAILS['야'].time = times['야'];
    appState.shiftTimes['야'] = times['야'];
    SHIFT_HOURS['야'] = calculateShiftHoursFromTime(times['야'], 6);
  }
  if (times['조']) {
    SHIFT_DETAILS['조'].time = times['조'];
    appState.shiftTimes['조'] = times['조'];
    SHIFT_HOURS['조'] = calculateShiftHoursFromTime(times['조'], 8);
  }
}

function applyFont(fontName) {
  appState.font = fontName || 'Pretendard';
  document.documentElement.style.setProperty('--app-font', `'${appState.font}', -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`);
}

// ==========================================
// 3. 로컬 스토리지 & Firebase 실시간 클라우드 DB 연동
// ==========================================
const STORAGE_KEY = 'SONGCHUL_SHIFT_SCHEDULE_V1';
const CUSTOM_DEFAULT_KEY = 'SONGCHUL_CUSTOM_DEFAULT_V1';

// Firebase 웹 앱 설정 (구글 클라우드 Firestore)
const firebaseConfig = {
  apiKey: "AIzaSyDLl9O-BYi494GPsqmkPfTPwO_vsAPIeEg",
  authDomain: "workshift-6ca5d.firebaseapp.com",
  projectId: "workshift-6ca5d",
  storageBucket: "workshift-6ca5d.firebasestorage.app",
  messagingSenderId: "722189852354",
  appId: "1:722189852354:web:592e99549a3b97f6e6a55b"
};

let db = null;
const MY_CLIENT_ID = 'user_' + Math.random().toString(36).substring(2, 9);
let isInitialFirebaseSyncDone = false;
let firebaseUploadTimer = null;

// 실시간 동기화 상태 뱃지 업데이트
function updateSyncStatus(isOnline, text = '실시간') {
  const badge = document.getElementById('sync-status');
  const textEl = document.getElementById('sync-status-text');
  if (!badge || !textEl) return;
  if (isOnline) {
    badge.classList.remove('offline');
    textEl.textContent = text;
    badge.title = '구글 파이어베이스 실시간 동기화 연결됨';
  } else {
    badge.classList.add('offline');
    textEl.textContent = text;
    badge.title = '클라우드 연결 대기 중 (오프라인 모드)';
  }
}

// "띵동~" 알림 차임벨 효과음 (Web Audio API 기반 무지연 사운드)
function playNotificationSound() {
  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = new AudioCtx();
    if (ctx.state === 'suspended') {
      ctx.resume();
    }
    const now = ctx.currentTime;
    
    // 1차 톤 (E5: 659.25Hz)
    const osc1 = ctx.createOscillator();
    const gain1 = ctx.createGain();
    osc1.type = 'sine';
    osc1.frequency.setValueAtTime(659.25, now);
    gain1.gain.setValueAtTime(0.18, now);
    gain1.gain.exponentialRampToValueAtTime(0.001, now + 0.32);
    osc1.connect(gain1);
    gain1.connect(ctx.destination);
    osc1.start(now);
    osc1.stop(now + 0.32);
    
    // 2차 톤 (A5: 880Hz) - "띵-동" 여운
    const osc2 = ctx.createOscillator();
    const gain2 = ctx.createGain();
    osc2.type = 'sine';
    osc2.frequency.setValueAtTime(880, now + 0.14);
    gain2.gain.setValueAtTime(0.18, now + 0.14);
    gain2.gain.exponentialRampToValueAtTime(0.001, now + 0.58);
    osc2.connect(gain2);
    gain2.connect(ctx.destination);
    osc2.start(now + 0.14);
    osc2.stop(now + 0.58);
  } catch (e) {
    console.warn('알림음 재생 불가(브라우저 정책):', e);
  }
}

// leaves 객체 내 빈 날짜, undefined 필드, 비정상 데이터를 안전하게 정제하는 유틸리티
function sanitizeLeaves(leaves) {
  if (!leaves || typeof leaves !== 'object') return {};
  const cleaned = {};
  Object.keys(leaves).forEach(dateStr => {
    const dayData = leaves[dateStr];
    if (!dayData || typeof dayData !== 'object') return;
    const cleanDay = {};
    Object.keys(dayData).forEach(memberId => {
      const item = dayData[memberId];
      if (item && item.isLeave) {
        cleanDay[memberId] = {
          isLeave: true,
          subId: (item.subId !== undefined && item.subId !== null) ? item.subId : null,
          isManual: Boolean(item.isManual),
          customSubName: item.customSubName ? String(item.customSubName).trim() : null
        };
      }
    });
    if (Object.keys(cleanDay).length > 0) {
      cleaned[dateStr] = cleanDay;
    }
  });
  return cleaned;
}

// 키 정렬 기반 안전한 휴가 데이터 직렬화 (키 순서 차이로 인한 거짓 변경 감지 원천 차단)
function canonicalLeavesString(leaves) {
  if (!leaves || typeof leaves !== 'object') return '{}';
  const clean = sanitizeLeaves(leaves);
  const sortedDates = Object.keys(clean).sort();
  const sortedObj = {};
  sortedDates.forEach(d => {
    const day = clean[d];
    const sortedMembers = Object.keys(day).sort();
    const sortedDay = {};
    sortedMembers.forEach(mId => {
      sortedDay[mId] = day[mId];
    });
    sortedObj[d] = sortedDay;
  });
  return JSON.stringify(sortedObj);
}

// 근무 시간 데이터 정확한 값 비교 (키 순서 무관)
function areShiftTimesEqual(t1, t2) {
  if (!t1 || !t2) return false;
  return t1['일'] === t2['일'] && t1['야'] === t2['야'] && t1['조'] === t2['조'];
}

// 멤버 목록 정확한 값 비교
function areMembersEqual(m1, m2) {
  if (!m1 || !m2 || !Array.isArray(m1) || !Array.isArray(m2) || m1.length !== m2.length) return false;
  return m1.every((m, idx) => {
    const target = m2[idx];
    return target && m.id === target.id && m.name === target.name && m.baseShift === target.baseShift;
  });
}

// 중복 알람 차단용 디바운스 타임스탬프
let lastToastNotificationTime = 0;
function notifyRemoteChange() {
  const now = Date.now();
  if (now - lastToastNotificationTime < 3000) return; // 3초 내 중복 알람 원천 차단
  lastToastNotificationTime = now;
  playNotificationSound();
  showToast('🔔 팀원이 변경한 근무표가 실시간 반영되었습니다.');
}

// 원격 Firestore 변경 사항을 로컬 상태에 안전하게 적용하는 공통 함수
function applyRemoteData(remoteData, playSound = true) {
  if (!remoteData) return;
  // 내가 방금 변경하여 올린 이벤트라면 알림 및 재랜더링 생략 (무한루프 방지)
  if (remoteData.lastEditorId === MY_CLIENT_ID) {
    isInitialFirebaseSyncDone = true;
    return;
  }

  const remoteLeaves = sanitizeLeaves(remoteData.leaves);
  const localLeaves = sanitizeLeaves(appState.leaves);

  const remoteTime = remoteData.clientUpdatedAt || 0;
  const localTime = appState.lastLocalUpdated || 0;

  // 최초 로드 시 로컬에 유효한 휴가가 있고 원격이 비어 있는 경우 로컬 데이터 업로드
  const remoteLeavesCount = Object.keys(remoteLeaves).length;
  const localLeavesCount = Object.keys(localLeaves).length;

  if (!isInitialFirebaseSyncDone && localTime > remoteTime && localLeavesCount > 0 && remoteLeavesCount === 0) {
    console.log('로컬의 최신 휴가 데이터를 클라우드로 자동 복구/동기화합니다.');
    uploadStateToFirebase();
    isInitialFirebaseSyncDone = true;
    return;
  }

  // 정확한 값 기반 동등성 비교 (키 순서로 인한 무한 루프 버그 해결)
  const leavesChanged = canonicalLeavesString(remoteLeaves) !== canonicalLeavesString(localLeaves);
  const refChanged = Boolean(remoteData.refDate && remoteData.refDate !== appState.refDate);
  const membersChanged = Boolean(remoteData.members && !areMembersEqual(remoteData.members, appState.members));
  const timesChanged = Boolean(remoteData.shiftTimes && !areShiftTimesEqual(remoteData.shiftTimes, appState.shiftTimes));

  if (leavesChanged || refChanged || membersChanged || timesChanged) {
    appState.leaves = remoteLeaves;
    if (remoteData.refDate) appState.refDate = remoteData.refDate;
    if (remoteData.members && Array.isArray(remoteData.members) && remoteData.members.length > 0) {
      appState.members = remoteData.members;
    }
    if (remoteData.shiftTimes) {
      updateShiftTimes(remoteData.shiftTimes);
    }
    ensureFourMembers();

    // 원격 시간 기준 로컬 저장소 동기화
    appState.lastLocalUpdated = remoteTime || Date.now();
    saveLocalOnly();

    // 실시간 변경 수신 시 디바운스된 알림 1회만 재생 (초기 로드 제외)
    if (playSound && isInitialFirebaseSyncDone) {
      notifyRemoteChange();
    }

    invalidateScheduleCache();
    renderCalendar();
    renderWeeklyStats();
    updateBottomStats();

    // 스마트폰이나 PC에서 모달 창이 열려 있는 상태라면 모달 내부도 즉시 실시간 갱신!
    if (appState.activeModalDate) {
      renderDayModalBody(appState.activeModalDate);
    }
  }
  isInitialFirebaseSyncDone = true;
}

// 클라우드 최신 데이터를 즉시 조회하여 동기화하는 함수 (모바일 화면 복귀 / 포커스 / 주기적 체크)
function fetchLatestCloudData(playSound = false) {
  if (!db) return;
  db.collection('schedules').doc('songchul_shift').get({ source: 'server' })
    .then(doc => {
      if (!doc.exists) return;
      applyRemoteData(doc.data(), playSound);
    })
    .catch(err => {
      // 서버 직접 조회가 오프라인 등으로 실패할 경우 캐시/기본 get으로 재시도
      db.collection('schedules').doc('songchul_shift').get()
        .then(doc => {
          if (doc.exists) applyRemoteData(doc.data(), playSound);
        })
        .catch(e => console.warn('클라우드 동기화 조회 실패:', e));
    });
}

// Firebase 클라우드 초기화 및 실시간 리스너 구독
function initFirebase() {
  if (typeof firebase === 'undefined') {
    console.warn('Firebase SDK가 로드되지 않아 로컬 저장소 모드로 작동합니다.');
    updateSyncStatus(false, '로컬전용');
    return;
  }
  try {
    if (!firebase.apps.length) {
      firebase.initializeApp(firebaseConfig);
    }
    db = firebase.firestore();
    // undefined 필드로 인한 set() 실패 원천 방지
    db.settings({ ignoreUndefinedProperties: true });
    updateSyncStatus(true, '실시간');

    const docRef = db.collection('schedules').doc('songchul_shift');
    docRef.onSnapshot((doc) => {
      updateSyncStatus(true, '실시간');
      if (!doc.exists) {
        console.log('Firebase에 첫 기본 데이터 업로드');
        uploadStateToFirebase();
        isInitialFirebaseSyncDone = true;
        return;
      }
      applyRemoteData(doc.data(), true);
    }, (error) => {
      console.warn('Firebase 실시간 동기화 상태:', error);
      updateSyncStatus(false, '동기화 지연');
    });

    // [모바일 대응] 스마트폰 화면이 꺼졌다가 켜지거나, 다른 앱에서 돌아올 때 최신 클라우드 데이터 조용히 동기화
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        fetchLatestCloudData(false);
      }
    });
    window.addEventListener('focus', () => {
      fetchLatestCloudData(false);
    });

    // 스마트폰 백그라운드 절전으로 인한 웹소켓 단절 대비 6초 간격 무음 헬스체크 폴링
    setInterval(() => {
      if (document.visibilityState === 'visible') {
        fetchLatestCloudData(false);
      }
    }, 6000);

    // 상단 '실시간' 뱃지 터치 시 즉시 수동 동기화 트리거
    const syncBadge = document.getElementById('sync-status');
    if (syncBadge) {
      syncBadge.style.cursor = 'pointer';
      syncBadge.addEventListener('click', () => {
        showToast('🔄 클라우드 최신 데이터를 동기화합니다...');
        fetchLatestCloudData(false);
      });
    }

  } catch (err) {
    console.error('Firebase 초기화 실패:', err);
    updateSyncStatus(false, '오프라인');
  }
}

// 클라우드 Firestore에 비동기 디바운스 업로드 (삭제된 항목까지 완전 동기화)
function uploadStateToFirebase() {
  if (!db) return;
  if (firebaseUploadTimer) clearTimeout(firebaseUploadTimer);
  firebaseUploadTimer = setTimeout(() => {
    try {
      const cleanLeaves = sanitizeLeaves(appState.leaves);
      const nowMs = Date.now();
      appState.lastLocalUpdated = nowMs;

      const payload = {
        leaves: cleanLeaves,
        refDate: appState.refDate,
        members: appState.members,
        shiftTimes: appState.shiftTimes,
        lastEditorId: MY_CLIENT_ID,
        clientUpdatedAt: nowMs,
        updatedAt: firebase.firestore.FieldValue.serverTimestamp()
      };

      // merge: true 대신 전체 문서 덮어쓰기로 삭제된 휴가도 원격에 즉각 반영
      db.collection('schedules').doc('songchul_shift').set(payload)
        .then(() => {
          updateSyncStatus(true, '실시간');
        })
        .catch(err => {
          console.error('Firestore 업로드 실패:', err);
          updateSyncStatus(false, '저장 지연');
        });
    } catch (e) {
      console.error('Firestore set error:', e);
    }
  }, 100);
}

// 로컬 저장소 전용 저장
function saveLocalOnly() {
  try {
    const cleanLeaves = sanitizeLeaves(appState.leaves);
    appState.leaves = cleanLeaves;
    const nowMs = appState.lastLocalUpdated || Date.now();
    appState.lastLocalUpdated = nowMs;

    const dataToSave = {
      members: appState.members,
      refDate: appState.refDate,
      leaves: cleanLeaves,
      font: appState.font,
      shiftTimes: appState.shiftTimes,
      updatedAt: nowMs,
      hasSavedDefault20260912: true
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(dataToSave));
  } catch (e) {
    console.error('LocalStorage 저장 실패:', e);
  }
}

// 통합 상태 저장: 로컬 저장 + 클라우드 업로드
function saveState() {
  invalidateScheduleCache();
  saveLocalOnly();
  uploadStateToFirebase();
}

function loadState() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) {
      const parsed = JSON.parse(saved);
      if (parsed.updatedAt) {
        appState.lastLocalUpdated = parsed.updatedAt;
      }
      if (parsed.members && Array.isArray(parsed.members)) {
        appState.members = parsed.members;
      } else {
        appState.members = JSON.parse(JSON.stringify(DEFAULT_MEMBERS));
      }
      ensureFourMembers();
      if (parsed.refDate) appState.refDate = parsed.refDate;
      if (parsed.leaves) {
        appState.leaves = sanitizeLeaves(parsed.leaves);
      }
      if (parsed.font) {
        appState.font = parsed.font;
      }
      if (parsed.shiftTimes) {
        updateShiftTimes(parsed.shiftTimes);
      }
      applyFont(appState.font || 'Pretendard');
      // 페이지 새로고침 시 클라우드 데이터를 덮어쓰지 않도록 로컬 데이터만 로드
    } else {
      // 초기 데모 데이터 및 영구 저장
      appState.members = JSON.parse(JSON.stringify(DEFAULT_MEMBERS));
      appState.refDate = DEFAULT_REF_DATE;
      initDemoData();
      applyFont('Pretendard');
      saveState();
    }
  } catch (e) {
    console.error('LocalStorage 로드 실패:', e);
    appState.members = JSON.parse(JSON.stringify(DEFAULT_MEMBERS));
    appState.refDate = DEFAULT_REF_DATE;
    initDemoData();
    applyFont('Pretendard');
    saveState();
  }
}

function initDemoData() {
  // 기본 초기 데이터
  appState.leaves = {};
}

// ==========================================
// 4. 교대 근무 및 대근 계산 핵심 알고리즘
// ==========================================

// 두 날짜 간 일수 차이 계산
function getDayDifference(dateStr1, dateStr2) {
  const d1 = new Date(dateStr1 + 'T00:00:00');
  const d2 = new Date(dateStr2 + 'T00:00:00');
  const diffTime = d1 - d2;
  return Math.round(diffTime / (1000 * 60 * 60 * 24));
}

// 다음 날짜 구하기 (YYYY-MM-DD)
function getNextDateStr(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  d.setDate(d.getDate() + 1);
  return formatDate(d);
}

// 이전 날짜 구하기 (YYYY-MM-DD)
function getPrevDateStr(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  d.setDate(d.getDate() - 1);
  return formatDate(d);
}

// 특정 날짜의 기본 4교대 근무 계산 (휴가/대근 제외 기본값)
function getBaseShiftForMember(member, dateStr) {
  const diffDays = getDayDifference(dateStr, appState.refDate);
  const baseIdx = SHIFT_TYPES.indexOf(member.baseShift);
  // 양수/음수 모듈러 연산 안전 처리
  const shiftIdx = ((baseIdx + diffDays) % 4 + 4) % 4;
  return SHIFT_TYPES[shiftIdx];
}

// ==========================================
// 주간 스케줄 캐시 및 초기화
// ==========================================
let weekScheduleCache = {};

function invalidateScheduleCache() {
  weekScheduleCache = {};
}

// 주어진 날짜가 속한 주의 월요일~일요일(7일) 날짜 배열 반환 (예: 9월 7일 ~ 9월 13일)
function getWeekDates(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  const day = d.getDay(); // 0(일) ~ 6(토)
  const diffToMon = (day === 0 ? -6 : 1 - day);
  const mon = new Date(d);
  mon.setDate(d.getDate() + diffToMon);

  const dates = [];
  for (let i = 0; i < 7; i++) {
    const curr = new Date(mon);
    curr.setDate(mon.getDate() + i);
    dates.push(formatDate(curr));
  }
  return dates;
}

// 특정 주간(월~일 7일)의 4인 근무, 대근 배정 및 주간 누적 근무시간 산출
function getWeekSchedule(targetDateStr) {
  const weekDates = getWeekDates(targetDateStr);
  const cacheKey = weekDates[0];
  if (weekScheduleCache[cacheKey]) {
    return weekScheduleCache[cacheKey];
  }

  // 1단계: 각 멤버의 주간 누적 근무시간 초기화
  const memberWeekHours = {};
  appState.members.forEach(m => {
    memberWeekHours[m.id] = 0;
  });

  // 2단계: 7일간 기본 순환 근무 산출 및 휴가자 기본 근무 제외
  const weekRosters = {};
  weekDates.forEach(dateStr => {
    const dayLeaves = appState.leaves[dateStr] || {};
    weekRosters[dateStr] = appState.members.map(m => {
      const baseShift = getBaseShiftForMember(m, dateStr);
      const isLeave = Boolean(dayLeaves[m.id]?.isLeave);
      return {
        memberId: m.id,
        name: m.name,
        baseShift: baseShift,
        effectiveShift: isLeave ? '휴가' : baseShift,
        isLeave: isLeave,
        isSubstitute: false,
        subForMemberId: null,
        subForShiftType: null,
        substituteId: null,
        isManualSub: false,
        customSubName: null,
        autoSubFailReason: null
      };
    });

    // 기본 근무시간 가산 (휴가가 아닌 경우에만)
    weekRosters[dateStr].forEach(item => {
      if (!item.isLeave) {
        memberWeekHours[item.memberId] += (SHIFT_HOURS[item.baseShift] || 0);
      }
    });
  });

  // 3단계: 수기 지정된 대근자(Manual Sub) 우선 반영
  weekDates.forEach(dateStr => {
    const dayLeaves = appState.leaves[dateStr] || {};
    const roster = weekRosters[dateStr];

    roster.forEach(item => {
      if (!item.isLeave) return;
      const leaveInfo = dayLeaves[item.memberId];
      if (!leaveInfo || !leaveInfo.isManual) return;

      const subId = leaveInfo.subId;
      if (subId === 'CUSTOM' && leaveInfo.customSubName) {
        item.substituteId = 'CUSTOM';
        item.customSubName = leaveInfo.customSubName;
        item.isManualSub = true;
      } else if (subId !== null && subId !== undefined) {
        const subMember = roster.find(r => r.memberId === subId);
        if (subMember) {
          subMember.isSubstitute = true;
          subMember.subForMemberId = item.memberId;
          subMember.subForShiftType = item.baseShift;
          subMember.effectiveShift = subMember.baseShift !== '비' 
            ? `${subMember.baseShift}+${item.baseShift}(대)` 
            : `${item.baseShift}(대)`;
          item.substituteId = subId;
          item.isManualSub = true;

          // 수기 지정 대근시간 가산
          memberWeekHours[subId] += (SHIFT_HOURS[item.baseShift] || 0);
        }
      } else {
        // subId === null (사용자가 대근 해제를 누른 경우 -> 결원 발생)
        item.substituteId = null;
        item.isManualSub = true;
        item.autoSubFailReason = '대근 해제됨 (24시간 근무 결원 발생 - 수동 지정 필요)';
      }
    });
  });

  // 4단계: 자동 대근자 배정 (월요일부터 일요일까지 순서대로, 규칙 전담자 엄격 배정)
  // 규칙에 지정된 전담자가 52시간 초과 시 임의 지정하지 않고 비워둠 -> 경광등 🚨 발생
  weekDates.forEach(dateStr => {
    const dayLeaves = appState.leaves[dateStr] || {};
    const roster = weekRosters[dateStr];

    roster.forEach(item => {
      if (!item.isLeave) return;
      const leaveInfo = dayLeaves[item.memberId];
      // 수기 지정/해제 건은 3단계에서 처리됨
      if (leaveInfo && leaveInfo.isManual) return;

      const origShift = item.baseShift;
      const neededHours = SHIFT_HOURS[origShift] || 0;

      const nextDate = getNextDateStr(dateStr);
      const isNextJoLeave = Boolean(appState.leaves[nextDate]?.[item.memberId]?.isLeave);
      const prevDate = getPrevDateStr(dateStr);
      const isPrevYaLeave = Boolean(appState.leaves[prevDate]?.[item.memberId]?.isLeave);

      // 규칙별 전담 자동 배정 대상자(단 1인) 도출
      let targetCand = null;

      if (origShift === '일') {
        // [규칙 1: 일근 단독 휴가] ➡️ 당일 비번자
        targetCand = roster.find(r => r.memberId !== item.memberId && r.baseShift === '비');
      } else if (origShift === '야') {
        if (isNextJoLeave) {
          // [규칙 4: 야/조근 연속 휴가 - 첫째날 야근] ➡️ 당일 조근자
          targetCand = roster.find(r => r.memberId !== item.memberId && r.baseShift === '조');
        } else {
          // [규칙 2: 야근 단독 휴가] ➡️ 당일 일근자
          targetCand = roster.find(r => r.memberId !== item.memberId && r.baseShift === '일');
        }
      } else if (origShift === '조') {
        if (isPrevYaLeave) {
          // [규칙 4: 야/조근 연속 휴가 - 둘째날 조근] ➡️ 전날 야근 대근자 (당일 비번자)
          const prevDayRoster = weekRosters[prevDate] || getDayShiftRoster(prevDate);
          const prevDayLeaveItem = prevDayRoster?.find(r => r.memberId === item.memberId && r.isLeave);
          const prevSubId = prevDayLeaveItem?.substituteId;

          if (prevSubId !== null && prevSubId !== undefined && prevSubId !== 'CUSTOM') {
            targetCand = roster.find(r => r.memberId === prevSubId);
          } else {
            targetCand = roster.find(r => r.memberId !== item.memberId && r.baseShift === '비');
          }
        } else {
          // [규칙 3: 조근 단독 휴가] ➡️ 당일 비번자
          targetCand = roster.find(r => r.memberId !== item.memberId && r.baseShift === '비');
        }
      }

      // 대상자 검증: 부재, 휴가, 타 대근 중, 주 52시간 초과 시 임의 지정 금지 -> 결원(미배정) 처리
      if (!targetCand) {
        item.substituteId = null;
        item.autoSubFailReason = '대근 대상자 없음 (수동 지정 필요)';
      } else if (targetCand.isLeave) {
        item.substituteId = null;
        item.autoSubFailReason = `자동 배정 대상자(${targetCand.name}) 휴가로 인한 결원 (수동 지정 필요)`;
      } else if (targetCand.isSubstitute) {
        item.substituteId = null;
        item.autoSubFailReason = `자동 배정 대상자(${targetCand.name}) 타 근무 대근 중 (수동 지정 필요)`;
      } else {
        const currentHours = memberWeekHours[targetCand.memberId] || 0;
        const expectedHours = currentHours + neededHours;

        if (expectedHours <= MAX_WEEKLY_HOURS) {
          // 52시간 이하! 규칙에 따라 정상 배정
          targetCand.isSubstitute = true;
          targetCand.subForMemberId = item.memberId;
          targetCand.subForShiftType = origShift;
          targetCand.effectiveShift = targetCand.baseShift !== '비'
            ? `${targetCand.baseShift}+${origShift}(대)`
            : `${origShift}(대)`;
          item.substituteId = targetCand.memberId;

          // 주간 누적 근무시간 가산
          memberWeekHours[targetCand.memberId] += neededHours;
        } else {
          // 52시간 초과 시 임의 지정하지 않고 비워둠 (관리자 수동 지정 필요)
          item.substituteId = null;
          item.autoSubFailReason = `자동 배정 대상자(${targetCand.name}) 주 52시간 초과 (${expectedHours}시간 / 52시간) - 수동 지정 필요`;
        }
      }
    });
  });

  const result = {
    weekDates,
    weekRosters,
    memberWeekHours
  };

  weekScheduleCache[cacheKey] = result;
  return result;
}

// 특정 날짜의 4인 전체 근무 및 대근 현황 계산
function getDayShiftRoster(dateStr) {
  const schedule = getWeekSchedule(dateStr);
  return schedule.weekRosters[dateStr];
}

/**
 * 24시간 연속 근무(00:00 ~ 24:00) 결원 여부 엄격 검사
 * 송출센터는 00시부터 24시까지 3교대(조근 00-09, 일근 09-18, 야근 18-24)가 1초의 공백도 없이 연속되어야 합니다.
 * 필수 3개 근무 중 어느 하나라도 미배정(결원) 상태일 때만 경광등(🚨)이 켜집니다.
 *
 * @param {Array} roster - 해당 일자의 4인 근무 현황 배열
 * @returns {Object} { hasGap: boolean, missingShifts: Array<string>, unassignedLeaves: Array<Object> }
 */
function checkDayCoverageGap(roster) {
  const requiredShifts = ['조', '일', '야'];
  const coveredShifts = new Set();
  const unassignedLeaves = [];

  roster.forEach(r => {
    // 1) 정상 근무자 (휴가가 아니고 실제 근무 조, 일, 야 수행)
    if (!r.isLeave && requiredShifts.includes(r.baseShift)) {
      coveredShifts.add(r.baseShift);
    }
    // 2) 내부 직원이 대근을 서주는 경우
    if (r.isSubstitute && r.subForShiftType) {
      coveredShifts.add(r.subForShiftType);
    }
    // 3) 외부 수기 입력 대근자(CUSTOM)가 배정된 경우
    if (r.isLeave && r.substituteId === 'CUSTOM' && r.customSubName) {
      coveredShifts.add(r.baseShift);
    }
    // 4) 내부 직원이 수기/자동으로 대근자로 지정되어 있는 경우
    if (r.isLeave && r.substituteId !== null && r.substituteId !== undefined && r.substituteId !== 'CUSTOM') {
      coveredShifts.add(r.baseShift);
    }
    // 5) 대근자가 미배정된 실제 근무(조, 일, 야) 휴가 확인
    if (r.isLeave && requiredShifts.includes(r.baseShift) && !r.substituteId) {
      unassignedLeaves.push(r);
    }
  });

  const missingShifts = requiredShifts.filter(s => !coveredShifts.has(s));
  return {
    hasGap: missingShifts.length > 0,
    missingShifts: missingShifts,
    unassignedLeaves: unassignedLeaves
  };
}

// 특정 멤버의 해당 주간 총 근무시간 계산
function calculateMemberWeekHours(memberId, weekDates) {
  const schedule = getWeekSchedule(weekDates[0]);
  return schedule.memberWeekHours[memberId] || 0;
}

// ==========================================
// 5. 캘린더 렌더링 함수
// ==========================================
function renderCalendar() {
  const year = appState.currentYear;
  const month = appState.currentMonth;

  // 헤더 년/월 텍스트 업데이트
  document.getElementById('display-year-month').textContent = `${year}년 ${month + 1}월`;

  const daysGrid = document.getElementById('calendar-days-grid');
  daysGrid.innerHTML = '';

  const firstDayOfMonth = new Date(year, month, 1);
  const lastDayOfMonth = new Date(year, month + 1, 0);
  const startDayOfWeek = firstDayOfMonth.getDay(); // 0(일) ~ 6(토)
  const totalDays = lastDayOfMonth.getDate();

  // 지난달 채우기 날짜
  const prevMonthLastDay = new Date(year, month, 0).getDate();
  for (let i = startDayOfWeek - 1; i >= 0; i--) {
    const dayNum = prevMonthLastDay - i;
    const dateStr = formatDate(new Date(year, month - 1, dayNum));
    const cell = createDayCell(dateStr, dayNum, true);
    daysGrid.appendChild(cell);
  }

  // 이번 달 날짜 채우기 (시스템의 실제 현재 시각 및 날짜를 정확히 추적)
  const todayStr = formatDate(new Date());
  for (let d = 1; d <= totalDays; d++) {
    const dateStr = formatDate(new Date(year, month, d));
    const isToday = (dateStr === todayStr);
    const cell = createDayCell(dateStr, d, false, isToday);
    daysGrid.appendChild(cell);
  }

  // 다음 달 채우기 (총 35칸 또는 42칸 맞춤)
  const currentCellsCount = startDayOfWeek + totalDays;
  const nextDaysNeeded = (currentCellsCount <= 35 ? 35 : 42) - currentCellsCount;
  for (let d = 1; d <= nextDaysNeeded; d++) {
    const dateStr = formatDate(new Date(year, month + 1, d));
    const cell = createDayCell(dateStr, d, true);
    daysGrid.appendChild(cell);
  }

  updateBottomStats();
  updateCalendarSelection();
}

// 개별 날짜 셀 생성
function createDayCell(dateStr, dayNum, isOtherMonth, isToday = false) {
  const cell = document.createElement('div');
  cell.className = 'day-cell';
  cell.dataset.date = dateStr;
  if (isOtherMonth) cell.classList.add('other-month');
  if (isToday) cell.classList.add('today');

  const dateObj = new Date(dateStr + 'T00:00:00');
  const dayOfWeek = dateObj.getDay();
  if (dayOfWeek === 0) cell.classList.add('is-sun');
  if (dayOfWeek === 6) cell.classList.add('is-sat');

  // 대한민국 법정 공휴일 & 대체공휴일 & 방송국 특별 휴일 (3/3 창립기념일, 5/20 노조창립일, 9/3 방송의 날)
  const holidayInfo = getHolidayInfo(dateStr);
  if (holidayInfo.isHoliday) {
    cell.classList.add('is-holiday');
  }

  // 근무자 데이터 계산 및 24시간 연속 근무 결원(공백) 검사
  const roster = getDayShiftRoster(dateStr);
  const coverage = checkDayCoverageGap(roster);

  if (coverage.hasGap) {
    cell.classList.add('has-unassigned');
  }

  // 툴팁 안내 문구 생성
  let sirenHtml = '';
  if (coverage.hasGap) {
    const shiftLabels = { '조': '조근(00~09시)', '일': '일근(09~18시)', '야': '야근(18~24시)' };
    const missingText = coverage.missingShifts.map(s => shiftLabels[s] || s).join(', ');
    const tooltipText = `🚨 24시간 근무 결원 발생!\n[미배정]: ${missingText}\n(52시간 초과 또는 대근 해제로 인한 공백 - 수동 배정 필요)`;
    sirenHtml = `<span class="badge-siren" title="${tooltipText}">🚨</span>`;
  }

  // 공휴일 라벨 배지 생성 (숫자 옆 표시 - 글자수에 따라 4글자, 5글자 이상 축소 클래스 적용)
  let holidayHtml = '';
  if (holidayInfo.isHoliday) {
    const rawLen = holidayInfo.name.replace(/\s+/g, '').length;
    let lenClass = '';
    if (rawLen === 4) {
      lenClass = 'len-4';
    } else if (rawLen >= 5) {
      lenClass = 'len-5';
    }
    holidayHtml = `<span class="badge-holiday-name ${lenClass}" title="${holidayInfo.name}">${holidayInfo.name}</span>`;
  }

  // 1. 상단 날짜 영역 (주간 52시간 근무 현황 조회 전용)
  const cellTop = document.createElement('div');
  cellTop.className = 'day-cell-top';
  cellTop.title = holidayInfo.isHoliday 
    ? `${holidayInfo.name} (공휴일) - 터치/클릭 시 해당 주의 주간 근무 현황 조회` 
    : '터치/클릭 시 해당 주의 주간 근무 현황 조회';
  cellTop.innerHTML = `
    <div class="day-num-wrap">
      <span class="day-num">${dayNum}</span>
      ${holidayHtml}
      ${sirenHtml}
    </div>
    ${isToday ? '<span class="badge-today-mark">오늘</span>' : ''}
  `;
  
  // 상단 날짜 영역 터치/클릭: 모달을 절대 열지 않고, 하단 주간 통계만 이동!
  cellTop.addEventListener('click', (e) => {
    e.stopPropagation();
    appState.activeWeekDate = dateStr;
    updateCalendarSelection();
    updateBottomStats();
    highlightBottomStats();
  });
  cell.appendChild(cellTop);

  // 2. 하단 근무 뱃지 영역 (휴가/대근 관리 모달 오픈 전용)
  // A. '전체 근무' 보기 모드인 경우
  if (appState.selectedMemberId === 'ALL') {
    const shiftList = document.createElement('div');
    shiftList.className = 'day-shift-list';

    roster.forEach(r => {
      const pill = document.createElement('div');
      pill.className = `shift-pill`;
      
      let shiftClass = 'pill-bi';
      if (r.baseShift === '일') shiftClass = 'pill-il';
      else if (r.baseShift === '야') shiftClass = 'pill-ya';
      else if (r.baseShift === '조') shiftClass = 'pill-jo';

      pill.classList.add(shiftClass);

      // 전체 근무 달력: 기본 4명(최혜진, 이준희, 안영주, 오승연)은 '성(1글자)'만 표시하여 모바일 공간 확보
      const displayName = r.name ? r.name.charAt(0) : '';

      if (r.isLeave) {
        pill.classList.add('is-leave');
        pill.innerHTML = `
          <span class="shift-pill-member">${displayName}</span>
          <span class="shift-pill-type">휴</span>
        `;
      } else if (r.isSubstitute) {
        pill.classList.add('is-substitute');
        if (r.baseShift === '일' || r.baseShift === '조') {
          // 본래 근무 + 대근 (예: 일 + 야)
          const origTagClass = r.baseShift === '일' ? 'tag-il' : 'tag-jo';
          pill.innerHTML = `
            <span class="shift-pill-member">${displayName}</span>
            <span class="dual-tags-wrap">
              <span class="mini-tag ${origTagClass}">${r.baseShift}</span>
              <span class="mini-tag-plus">+</span>
              <span class="mini-tag tag-sub">${r.subForShiftType}</span>
            </span>
          `;
        } else {
          // 비번 날 대근하는 경우 (대근 종류 1글자 주황색 박스)
          pill.innerHTML = `
            <span class="shift-pill-member">${displayName}</span>
            <span class="shift-pill-type">${r.subForShiftType}</span>
          `;
        }
      } else {
        pill.innerHTML = `
          <span class="shift-pill-member">${displayName}</span>
          <span class="shift-pill-type">${r.baseShift}</span>
        `;
      }

      pill.title = `${r.name} (${r.shiftName || r.baseShift}) - 터치/클릭 시 휴가·대근 관리`;
      shiftList.appendChild(pill);
    });

    // 외부 수기 대근자가 있는 경우 추가 칩 렌더링
    roster.forEach(r => {
      if (r.isLeave && r.substituteId === 'CUSTOM' && r.customSubName) {
        const customPill = document.createElement('div');
        customPill.className = `shift-pill is-substitute`;
        let subClass = 'pill-bi';
        if (r.baseShift === '일') subClass = 'pill-il';
        else if (r.baseShift === '야') subClass = 'pill-ya';
        else if (r.baseShift === '조') subClass = 'pill-jo';
        customPill.classList.add(subClass);
        customPill.title = `${r.customSubName} (대근) - 터치/클릭 시 휴가·대근 관리`;
        customPill.innerHTML = `
          <span class="shift-pill-member">${r.customSubName}</span>
          <span class="shift-pill-type">${r.baseShift}</span>
        `;
        shiftList.appendChild(customPill);
      }
    });

    // 하단 근무 뱃지 영역 터치/클릭 시: 휴가/대근 관리 모달 열기!
    shiftList.addEventListener('click', (e) => {
      e.stopPropagation();
      appState.activeWeekDate = dateStr;
      updateCalendarSelection();
      updateBottomStats();
      openDayModal(dateStr);
    });

    cell.appendChild(shiftList);
  } 
  // B. '특정 1인' 선택 보기 모드인 경우 (선색 테두리 아웃라인 뱃지)
  else {
    cell.classList.add('single-view');
    const singleShiftWrap = document.createElement('div');
    singleShiftWrap.className = 'single-shift-wrap';
    singleShiftWrap.title = '터치/클릭 시 해당 주의 주간 근무 현황 조회';

    // 근무 박스(안쪽) 클릭 시 실행할 핸들러: 휴가/대근 관리 팝업 오픈
    const openBadgeModalHandler = (e) => {
      e.stopPropagation();
      appState.activeWeekDate = dateStr;
      updateCalendarSelection();
      updateBottomStats();
      openDayModal(dateStr);
    };

    const target = roster.find(r => r.memberId === appState.selectedMemberId);
    if (target) {
      if (target.isLeave) {
        const badge = document.createElement('div');
        badge.className = 'single-shift-badge';
        badge.style.borderColor = '#dc2626';
        badge.style.color = '#dc2626';
        badge.style.backgroundColor = '#fef2f2';
        badge.textContent = '휴'; // 사용자 요청: 한 글자 '휴'로 통일
        badge.title = '터치/클릭 시 근무·휴가·대근 관리';
        badge.addEventListener('click', openBadgeModalHandler);
        singleShiftWrap.appendChild(badge);
      } else if (target.isSubstitute) {
        if (target.baseShift === '일' || target.baseShift === '조') {
          // [사용자 요청] 위 [원래근무], 중간 '+', 아래 [대근(주황색)] 두 박스로 분리 (한 글자씩)
          const wrap = document.createElement('div');
          wrap.className = 'single-double-badge-wrap';
          wrap.title = '터치/클릭 시 근무·휴가·대근 관리';

          // 1. 위 박스: 원래 근무 (일 또는 조) -> 단정한 회색
          const origBadge = document.createElement('div');
          origBadge.className = 'single-shift-badge';
          origBadge.style.borderColor = '#cbd5e1';
          origBadge.style.color = '#475569';
          origBadge.style.backgroundColor = '#f1f5f9';
          origBadge.textContent = target.baseShift;
          wrap.appendChild(origBadge);

          // 2. 중간 '+' 기호
          const plusSpan = document.createElement('span');
          plusSpan.className = 'single-badge-plus';
          plusSpan.textContent = '+';
          wrap.appendChild(plusSpan);

          // 3. 아래 박스: 대근 -> 눈에 띄는 웜 오렌지 (한 글자)
          const subBadge = document.createElement('div');
          subBadge.className = 'single-shift-badge';
          subBadge.style.borderColor = '#ea580c';
          subBadge.style.color = '#ea580c';
          subBadge.style.backgroundColor = '#fff7ed';
          subBadge.textContent = target.subForShiftType;
          wrap.appendChild(subBadge);

          wrap.addEventListener('click', openBadgeModalHandler);
          singleShiftWrap.appendChild(wrap);
        } else {
          // 비번 날 대근하는 경우 -> 웜 오렌지 (한 글자)
          const badge = document.createElement('div');
          badge.className = 'single-shift-badge';
          badge.style.borderColor = '#ea580c';
          badge.style.color = '#ea580c';
          badge.style.backgroundColor = '#fff7ed';
          badge.textContent = target.subForShiftType;
          badge.title = '터치/클릭 시 근무·휴가·대근 관리';
          badge.addEventListener('click', openBadgeModalHandler);
          singleShiftWrap.appendChild(badge);
        }
      } else {
        // 일반 기본 근무
        const badge = document.createElement('div');
        badge.className = 'single-shift-badge';
        if (target.baseShift === '비') {
          // 비번 -> 한 톤 더 흐리고 은은한 소프트 민트
          badge.style.borderColor = '#d1fae5';
          badge.style.color = '#34d399';
          badge.style.backgroundColor = '#f4fbf8';
          badge.style.opacity = '0.85';
        } else {
          // 일, 야, 조 -> 단정한 옅은 회색
          badge.style.borderColor = '#cbd5e1';
          badge.style.color = '#475569';
          badge.style.backgroundColor = '#f1f5f9';
        }
        badge.textContent = target.baseShift;
        badge.title = '터치/클릭 시 근무·휴가·대근 관리';
        badge.addEventListener('click', openBadgeModalHandler);
        singleShiftWrap.appendChild(badge);
      }
    }

    cell.appendChild(singleShiftWrap);
  }

  // 3. 셀 전체 배경/여백 클릭 시: 모달 없이 주간 근무 현황만 즉시 이동하여 표시
  cell.addEventListener('click', () => {
    appState.activeWeekDate = dateStr;
    updateCalendarSelection();
    updateBottomStats();
    highlightBottomStats();
  });

  return cell;
}

// ==========================================
// 6. 상세 & 휴가/대근 관리 모달 (바텀시트)
// ==========================================
function openDayModal(dateStr) {
  appState.activeModalDate = dateStr;
  const dateObj = new Date(dateStr + 'T00:00:00');
  const dayNames = ['일', '월', '화', '수', '목', '금', '토'];
  const dayName = dayNames[dateObj.getDay()];

  const holidayInfo = getHolidayInfo(dateStr);
  const holidaySuffix = holidayInfo.isHoliday ? ` · ${holidayInfo.name}` : '';

  document.getElementById('modal-date-title').textContent = 
    `${dateObj.getMonth() + 1}월 ${dateObj.getDate()}일 (${dayName})${holidaySuffix}`;

  renderDayModalBody(dateStr);

  const modalOverlay = document.getElementById('day-modal-overlay');
  modalOverlay.classList.add('active');
}

function renderDayModalBody(dateStr) {
  const roster = getDayShiftRoster(dateStr);
  const coverage = checkDayCoverageGap(roster);
  const container = document.getElementById('shift-detail-list');
  container.innerHTML = '';

  // 24시간 연속 근무 결원 발생 시 상단 알림 배너 노출
  if (coverage.hasGap) {
    const shiftLabels = { '조': '조근(00~09시)', '일': '일근(09~18시)', '야': '야근(18~24시)' };
    const missingText = coverage.missingShifts.map(s => shiftLabels[s] || s).join(', ');
    const banner = document.createElement('div');
    banner.className = 'modal-coverage-alert-banner';
    banner.innerHTML = `
      <span class="badge-siren">🚨</span>
      <div class="modal-coverage-alert-text">
        <strong>24시간 연속 근무 결원 발생 (공백 시간대: ${missingText})</strong>
        <span>52시간 초과 또는 대근 해제로 대근자가 지정되지 않았습니다. 아래에서 수동으로 대근자를 지정해 주세요.</span>
      </div>
    `;
    container.appendChild(banner);
  }

  const dayLeaves = appState.leaves[dateStr] || {};

  roster.forEach(memberItem => {
    const card = document.createElement('div');
    card.className = 'member-card';
    if (memberItem.isLeave) card.classList.add('has-leave');
    if (memberItem.isSubstitute) card.classList.add('has-substitute');

    const shiftInfo = SHIFT_DETAILS[memberItem.baseShift];
    let badgeColor = shiftInfo.color;
    let badgeBg = '#ffffff';
    let badgeText = `${shiftInfo.name} (${memberItem.baseShift})`;
    let timeHint = shiftInfo.time;

    let badgeHtml = '';
    if (memberItem.isLeave) {
      badgeHtml = `<span class="member-shift-badge" style="border: 1.5px solid #dc2626; color: #dc2626; background-color: #fef2f2;">휴(휴가)</span>`;
    } else if (memberItem.isSubstitute) {
      if (memberItem.baseShift !== '비') {
        timeHint = `${shiftInfo.time} + ${SHIFT_DETAILS[memberItem.subForShiftType].time}`;
        badgeHtml = `
          <div style="display:inline-flex; align-items:center; gap:4px;">
            <span class="member-shift-badge" style="border: 1.5px solid #cbd5e1; color: #475569; background-color: #f1f5f9;">${shiftInfo.name} (${memberItem.baseShift})</span>
            <span style="font-size:11px; font-weight:800; color:#94a3b8;">+</span>
            <span class="member-shift-badge" style="border: 1.5px solid #ea580c; color: #ea580c; background-color: #fff7ed;">${memberItem.subForShiftType}대근</span>
          </div>
        `;
      } else {
        timeHint = SHIFT_DETAILS[memberItem.subForShiftType].time;
        badgeHtml = `<span class="member-shift-badge" style="border: 1.5px solid #ea580c; color: #ea580c; background-color: #fff7ed;">${memberItem.subForShiftType}대근</span>`;
      }
    } else {
      if (memberItem.baseShift === '비') {
        badgeHtml = `<span class="member-shift-badge" style="border: 1.5px solid #d1fae5; color: #34d399; background-color: #f4fbf8; opacity: 0.85;">비번 (비)</span>`;
      } else {
        badgeHtml = `<span class="member-shift-badge" style="border: 1.5px solid #cbd5e1; color: #475569; background-color: #f1f5f9;">${shiftInfo.name} (${memberItem.baseShift})</span>`;
      }
    }

    // 비번자(휴무일)는 원래 근무가 없으므로 휴가 신청 대신 '휴무일' 태그 표시 (기존 휴가 신청 건이 있으면 취소 가능)
    let leaveBtnHtml = '';
    if (memberItem.baseShift === '비' && !memberItem.isLeave) {
      leaveBtnHtml = `<span class="badge-off-tag" title="비번(휴무일)은 쉬는 날이므로 휴가 신청 대상이 아닙니다.">휴무일 (비번)</span>`;
    } else {
      leaveBtnHtml = `
        <button class="leave-toggle-btn ${memberItem.isLeave ? 'active' : ''}" data-member-id="${memberItem.memberId}">
          ${memberItem.isLeave ? '✕ 휴가 취소' : '+ 휴가 신청'}
        </button>
      `;
    }

    // 메인 줄: 이름, 원근무 뱃지, 시간, 휴가 신청 버튼
    card.innerHTML = `
      <div class="member-card-main">
        <div class="member-name-wrap">
          <span class="member-name">${memberItem.name}</span>
          ${badgeHtml}
          <span class="member-time-hint">${timeHint}</span>
        </div>
        <div>
          ${leaveBtnHtml}
        </div>
      </div>
    `;

    // 만약 이 사람이 휴가 중이라면 ➡️ 대근자 배정/해제/수기 박스 표시
    if (memberItem.isLeave) {
      const subBox = document.createElement('div');
      subBox.className = 'substitute-control-box';

      const currentSubId = memberItem.substituteId;
      const customSubName = dayLeaves[memberItem.memberId]?.customSubName;
      const subMember = roster.find(r => r.memberId === currentSubId);

      let subStatusHtml = '';
      if (customSubName) {
        subStatusHtml = `
          <div class="sub-status-row">
            <span><strong class="sub-tag">대근자:</strong> <span class="sub-name-highlight">${customSubName} (수기 입력)</span> <span class="sub-type-badge">${memberItem.baseShift}근무 대근</span></span>
            <button class="btn-mini-cancel btn-cancel-sub" data-for-member="${memberItem.memberId}">대근 해제</button>
          </div>
        `;
      } else if (subMember) {
        subStatusHtml = `
          <div class="sub-status-row">
            <span><strong class="sub-tag">대근자:</strong> <span class="sub-name-highlight">${subMember.name}</span> <span class="sub-type-badge">${memberItem.baseShift}근무 대근</span></span>
            <button class="btn-mini-cancel btn-cancel-sub" data-for-member="${memberItem.memberId}">대근 해제</button>
          </div>
        `;
      } else {
        const failReason = memberItem.autoSubFailReason || '자동 배정 대상자 주 52시간 초과';
        subStatusHtml = `
          <div class="sub-status-row alert-unassigned-row">
            <div>
              <span style="display:flex; align-items:center; gap:5px; color:#dc2626; font-weight:800; font-size:12.5px;">
                <span class="badge-siren alert-siren-icon">🚨</span> [24시간 근무 결원] 대근자 미배정 상태
              </span>
              <span class="unassigned-hint-text">사유: ${failReason}</span>
              <span class="unassigned-hint-text" style="color:#64748b; font-weight:500; margin-top:2px;">※ 임의 지정 없이 비워둔 상태입니다. 아래 '대근 선택'에서 수동으로 지정해 주세요.</span>
            </div>
          </div>
        `;
      }

      // 수기 변경 드롭다운 옵션 (수동 선택)
      let optionsHtml = `<option value="">-- 수동 선택 --</option>`;
      appState.members.forEach(m => {
        if (m.id !== memberItem.memberId) {
          const isSelected = (!customSubName && m.id === currentSubId) ? 'selected' : '';
          optionsHtml += `<option value="${m.id}" ${isSelected}>${m.name} (현재 ${getBaseShiftForMember(m, dateStr)})</option>`;
        }
      });
      // 사람 이름 맨 밑에 '직접 입력' 옵션 추가
      optionsHtml += `<option value="CUSTOM_INPUT" ${customSubName ? 'selected' : ''}>직접 입력</option>`;

      const isCustomVisible = Boolean(customSubName);

      subBox.innerHTML = `
        ${subStatusHtml}
        <div class="sub-actions-row">
          <label style="font-size:11px; color:#64748b; font-weight:600;">대근 선택:</label>
          <select class="select-sub-manual" data-for-member="${memberItem.memberId}">
            ${optionsHtml}
          </select>
        </div>
        <div class="sub-custom-row" data-for-member="${memberItem.memberId}" style="${isCustomVisible ? 'display:flex;' : 'display:none;'}">
          <input type="text" class="input-sub-custom" data-for-member="${memberItem.memberId}" placeholder="대근자 이름 입력 (예: 홍길동)" value="${customSubName || ''}">
          <button class="btn-sub-custom-save" data-for-member="${memberItem.memberId}">확인</button>
        </div>
      `;

      card.appendChild(subBox);
    }

    container.appendChild(card);
  });

  // 이벤트 바인딩: 휴가 토글 버튼
  container.querySelectorAll('.leave-toggle-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const memberId = parseInt(e.target.dataset.memberId);
      toggleLeave(dateStr, memberId);
    });
  });

  // 이벤트 바인딩: 대근 해제 버튼
  container.querySelectorAll('.btn-cancel-sub').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const forMemberId = parseInt(e.target.dataset.forMember);
      cancelSubstitute(dateStr, forMemberId);
    });
  });

  // 이벤트 바인딩: 대근 선택 드롭다운 (수동 선택 / 직접 입력)
  container.querySelectorAll('.select-sub-manual').forEach(sel => {
    sel.addEventListener('change', (e) => {
      const forMemberId = parseInt(e.target.dataset.forMember);
      const val = e.target.value;
      const customRow = container.querySelector(`.sub-custom-row[data-for-member="${forMemberId}"]`);

      if (val === 'CUSTOM_INPUT') {
        // '직접 입력'을 누른 경우 입력란 노출 및 포커스
        if (customRow) {
          customRow.style.display = 'flex';
          const input = customRow.querySelector('.input-sub-custom');
          if (input) input.focus();
        }
      } else {
        // 기존 멤버를 선택하거나 '-- 수동 선택 --'을 누른 경우
        if (customRow) {
          customRow.style.display = 'none';
        }
        const chosenSubId = val === '' ? null : parseInt(val);
        manuallySetSubstitute(dateStr, forMemberId, chosenSubId);
      }
    });
  });

  // 이벤트 바인딩: 기타/외부 대근자 직접 입력 버튼
  container.querySelectorAll('.btn-sub-custom-save').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const forMemberId = parseInt(e.target.dataset.forMember);
      const input = container.querySelector(`.input-sub-custom[data-for-member="${forMemberId}"]`);
      if (input) {
        manuallySetCustomSubstitute(dateStr, forMemberId, input.value);
      }
    });
  });

  // 엔터 키 이벤트 바인딩
  container.querySelectorAll('.input-sub-custom').forEach(input => {
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        const forMemberId = parseInt(e.target.dataset.forMember);
        manuallySetCustomSubstitute(dateStr, forMemberId, input.value);
      }
    });
  });
}

// 휴가 신청/취소 토글
function toggleLeave(dateStr, memberId) {
  if (!appState.leaves[dateStr]) {
    appState.leaves[dateStr] = {};
  }

  const current = appState.leaves[dateStr][memberId];
  if (current && current.isLeave) {
    // 휴가 취소
    delete appState.leaves[dateStr][memberId];
    if (Object.keys(appState.leaves[dateStr]).length === 0) {
      delete appState.leaves[dateStr];
    }
  } else {
    // 휴가 등록 (자동 대근자 배정 플래그 - null로 안전하게 초기화)
    appState.leaves[dateStr][memberId] = {
      isLeave: true,
      subId: null,
      isManual: false,
      customSubName: null
    };
  }

  appState.lastLocalUpdated = Date.now();
  saveState();
  renderDayModalBody(dateStr);
  renderCalendar();
}

// 대근 해제
function cancelSubstitute(dateStr, forMemberId) {
  if (!appState.leaves[dateStr] || !appState.leaves[dateStr][forMemberId]) return;

  appState.leaves[dateStr][forMemberId].subId = null;
  appState.leaves[dateStr][forMemberId].customSubName = null;
  appState.leaves[dateStr][forMemberId].isManual = true;

  appState.lastLocalUpdated = Date.now();
  saveState();
  renderDayModalBody(dateStr);
  renderCalendar();
}

// 대근 수기 지정 (내부 멤버)
function manuallySetSubstitute(dateStr, forMemberId, chosenSubId) {
  if (!appState.leaves[dateStr] || !appState.leaves[dateStr][forMemberId]) return;

  appState.leaves[dateStr][forMemberId].subId = chosenSubId;
  appState.leaves[dateStr][forMemberId].customSubName = null;
  appState.leaves[dateStr][forMemberId].isManual = true;

  appState.lastLocalUpdated = Date.now();
  saveState();
  renderDayModalBody(dateStr);
  renderCalendar();
}

// 대근 수기 직접 입력 (외부/기타 인원)
function manuallySetCustomSubstitute(dateStr, forMemberId, customName) {
  if (!appState.leaves[dateStr] || !appState.leaves[dateStr][forMemberId]) return;
  const trimmed = (customName || '').trim();
  if (!trimmed) {
    alert('대근자 이름을 입력해 주세요.');
    return;
  }

  appState.leaves[dateStr][forMemberId].subId = 'CUSTOM';
  appState.leaves[dateStr][forMemberId].customSubName = trimmed;
  appState.leaves[dateStr][forMemberId].isManual = true;

  appState.lastLocalUpdated = Date.now();
  saveState();
  renderDayModalBody(dateStr);
  renderCalendar();
}

function closeDayModal() {
  document.getElementById('day-modal-overlay').classList.remove('active');
  appState.activeModalDate = null;
}

// ==========================================
// 7. 상단 필터 및 하단 통계 바
// ==========================================
function renderMemberFilterChips() {
  const container = document.getElementById('member-filter-container');
  container.innerHTML = '';

  // 1) 전체 근무 칩
  const allChip = document.createElement('button');
  allChip.className = `filter-chip ${appState.selectedMemberId === 'ALL' ? 'active' : ''}`;
  allChip.textContent = '전체 근무';
  allChip.addEventListener('click', () => {
    appState.selectedMemberId = 'ALL';
    renderMemberFilterChips();
    renderCalendar();
  });
  container.appendChild(allChip);

  // 2) 개별 멤버 4명 칩
  appState.members.forEach(m => {
    const chip = document.createElement('button');
    chip.className = `filter-chip ${appState.selectedMemberId === m.id ? 'active' : ''}`;
    chip.textContent = m.name;
    chip.addEventListener('click', () => {
      appState.selectedMemberId = m.id;
      renderMemberFilterChips();
      renderCalendar();
    });
    container.appendChild(chip);
  });
}

function updateBottomStats() {
  const statsContainer = document.getElementById('bottom-stats');
  if (!statsContainer) return;

  const targetDateStr = appState.activeWeekDate || formatDate(new Date());
  const schedule = getWeekSchedule(targetDateStr);
  const weekDates = schedule.weekDates;
  const startD = new Date(weekDates[0] + 'T00:00:00');
  const endD = new Date(weekDates[6] + 'T00:00:00');
  const weekLabel = `${startD.getMonth() + 1}.${startD.getDate()}(월) ~ ${endD.getMonth() + 1}.${endD.getDate()}(일)`;

  // A. '전체 근무' 선택 모드: 4인 주 52시간 근무 현황 미니 그리드
  if (appState.selectedMemberId === 'ALL') {
    let chipsHtml = '';
    appState.members.forEach(m => {
      const hours = schedule.memberWeekHours[m.id] || 0;
      const remain = Math.max(0, MAX_WEEKLY_HOURS - hours);
      const isOver = hours > MAX_WEEKLY_HOURS;
      
      let badgeColor = '#16a34a';
      let remText = `+${remain}h 가능`;
      if (hours >= 45 && hours <= 52) {
        badgeColor = '#d97706';
        remText = `+${remain}h 여유`;
      } else if (isOver) {
        badgeColor = '#dc2626';
        remText = `${hours - 52}h 초과!`;
      }

      chipsHtml += `
        <div class="weekly-member-stat-chip" data-member-id="${m.id}" title="${m.name} 클릭 시 개인 근무표로 전환">
          <div style="display:flex; justify-content:space-between; width:100%; font-size:11px; font-weight:700;">
            <span>${m.name}</span>
            <span style="color:${badgeColor}; font-weight:800;">${hours}h</span>
          </div>
          <div style="display:flex; justify-content:space-between; width:100%; font-size:10px; color:#64748b;">
            <span>한도 52h</span>
            <span style="color:${badgeColor}; font-weight:700;">${remText}</span>
          </div>
        </div>
      `;
    });

    statsContainer.innerHTML = `
      <div class="weekly-all-header">
        <span><strong>4인 주 52시간 근무 현황</strong> (대근 가능 잔여시간)</span>
        <span class="weekly-range-tag">📅 주간 ${weekLabel}</span>
      </div>
      <div class="weekly-members-grid">
        ${chipsHtml}
      </div>
    `;

    statsContainer.querySelectorAll('.weekly-member-stat-chip').forEach(chip => {
      chip.addEventListener('click', () => {
        const memId = parseInt(chip.dataset.memberId);
        appState.selectedMemberId = memId;
        renderMemberFilterChips();
        renderCalendar();
      });
    });
  } 
  // B. '특정 1인' 선택 모드: 개인 주간 누적 근무시간 + 52시간 잔여 대근 가능 시간 + 프로그레스 바
  else {
    const member = appState.members.find(m => m.id === appState.selectedMemberId);
    if (!member) return;

    const hours = schedule.memberWeekHours[member.id] || 0;
    const remain = Math.max(0, MAX_WEEKLY_HOURS - hours);
    const isOver = hours > MAX_WEEKLY_HOURS;
    const pct = Math.min(100, Math.round((hours / MAX_WEEKLY_HOURS) * 100));

    let badgeClass = 'safe';
    let badgeText = `대근 가능 여유: +${remain}시간`;
    let fillClass = 'fill-safe';

    if (hours >= 45 && hours <= 52) {
      badgeClass = 'warn';
      badgeText = `대근 여유: +${remain}시간 (한도 임박)`;
      fillClass = 'fill-warn';
    } else if (isOver) {
      badgeClass = 'danger';
      badgeText = `52시간 초과! (+${hours - 52}시간 초과)`;
      fillClass = 'fill-danger';
    }

    statsContainer.innerHTML = `
      <div class="weekly-stat-header">
        <span><strong>${member.name}</strong> 님 주간 근무 현황</span>
        <span class="weekly-range-tag">📅 주간 ${weekLabel}</span>
      </div>
      <div class="weekly-stat-body">
        <div class="stat-hour-box">
          <span class="hour-label">주간 누적:</span>
          <span class="hour-value" style="color: ${isOver ? '#dc2626' : '#0f172a'};">${hours} <small>/ 52시간</small></span>
        </div>
        <div class="stat-remain-badge ${badgeClass}">
          ${badgeText}
        </div>
      </div>
      <div class="weekly-progress-wrap" title="${hours}시간 / 52시간 (${pct}%)">
        <div class="weekly-progress-fill ${fillClass}" style="width: ${pct}%;"></div>
      </div>
    `;
  }
}

// 달력 내 활성 주간 및 선택 날짜 시각적 강조 갱신
function updateCalendarSelection() {
  const targetDateStr = appState.activeWeekDate || formatDate(new Date());
  const schedule = getWeekSchedule(targetDateStr);
  const activeWeekDates = new Set(schedule.weekDates);

  document.querySelectorAll('.day-cell').forEach(cell => {
    const dStr = cell.dataset.date;
    if (!dStr) return;

    if (dStr === appState.activeWeekDate) {
      cell.classList.add('is-selected-day');
    } else {
      cell.classList.remove('is-selected-day');
    }

    if (activeWeekDates.has(dStr)) {
      cell.classList.add('in-active-week');
    } else {
      cell.classList.remove('in-active-week');
    }
  });
}

// 하단 주간 통계 영역 시각적 피드백 (부드러운 펄스 애니메이션 및 모바일 스크롤 지원)
function highlightBottomStats() {
  const statsContainer = document.getElementById('bottom-stats');
  if (statsContainer) {
    statsContainer.classList.remove('stats-pulse');
    void statsContainer.offsetWidth; // reflow 트리거
    statsContainer.classList.add('stats-pulse');

    // 모바일 환경에서 화면 하단에 바로 보이도록 필요 시 부드럽게 스크롤
    if (window.innerWidth <= 500) {
      statsContainer.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }
}

// ==========================================
// 8. 설정 모달 (멤버 이름 및 기본 순번)
// ==========================================
function openSettingsModal() {
  ensureFourMembers();
  document.getElementById('setting-ref-date').value = appState.refDate;
  const fontSelect = document.getElementById('setting-font-select');
  if (fontSelect) fontSelect.value = appState.font || 'Pretendard';

  const timeIlInput = document.getElementById('setting-time-il');
  const timeYaInput = document.getElementById('setting-time-ya');
  const timeJoInput = document.getElementById('setting-time-jo');
  if (timeIlInput) timeIlInput.value = appState.shiftTimes?.['일'] || '09:00~18:00';
  if (timeYaInput) timeYaInput.value = appState.shiftTimes?.['야'] || '18:00~24:00';
  if (timeJoInput) timeJoInput.value = appState.shiftTimes?.['조'] || '00:00~09:00';

  const rowsContainer = document.getElementById('members-setup-rows');
  rowsContainer.innerHTML = '';

  appState.members.forEach((m, idx) => {
    const row = document.createElement('div');
    row.className = 'setup-row';
    row.innerHTML = `
      <span class="col-num-text">#${idx + 1}</span>
      <input type="text" class="setup-input-name" data-id="${m.id}" value="${m.name}" placeholder="이름" maxlength="6">
      <select class="setup-select-shift" data-id="${m.id}">
        <option value="일" ${m.baseShift === '일' ? 'selected' : ''}>일근</option>
        <option value="야" ${m.baseShift === '야' ? 'selected' : ''}>야근</option>
        <option value="조" ${m.baseShift === '조' ? 'selected' : ''}>조근</option>
        <option value="비" ${m.baseShift === '비' ? 'selected' : ''}>비번</option>
      </select>
    `;
    rowsContainer.appendChild(row);
  });

  document.getElementById('settings-modal-overlay').classList.add('active');
}

function closeSettingsModal() {
  document.getElementById('settings-modal-overlay').classList.remove('active');
}

function saveSettings() {
  const newRefDate = document.getElementById('setting-ref-date').value;
  if (newRefDate) appState.refDate = newRefDate;

  const fontSelect = document.getElementById('setting-font-select');
  if (fontSelect && fontSelect.value) {
    applyFont(fontSelect.value);
  }

  const nameInputs = document.querySelectorAll('.setup-input-name');
  const shiftSelects = document.querySelectorAll('.setup-select-shift');

  nameInputs.forEach((input, idx) => {
    const id = parseInt(input.dataset.id);
    const newName = input.value.trim() || `멤버${id + 1}`;
    const newShift = shiftSelects[idx].value;

    const target = appState.members.find(m => m.id === id);
    if (target) {
      target.name = newName;
      target.baseShift = newShift;
    }
  });

  // 근무 형태별 시간 수기 변경값 반영
  const timeIl = document.getElementById('setting-time-il')?.value?.trim() || '09:00~18:00';
  const timeYa = document.getElementById('setting-time-ya')?.value?.trim() || '18:00~24:00';
  const timeJo = document.getElementById('setting-time-jo')?.value?.trim() || '00:00~09:00';

  updateShiftTimes({
    '일': timeIl,
    '야': timeYa,
    '조': timeJo
  });

  // 현재 설정을 기본값(CUSTOM_DEFAULT_KEY)으로도 함께 안전하게 저장
  localStorage.setItem(CUSTOM_DEFAULT_KEY, JSON.stringify({
    members: appState.members,
    refDate: appState.refDate,
    font: appState.font,
    shiftTimes: appState.shiftTimes
  }));

  saveState();
  closeSettingsModal();
  renderMemberFilterChips();
  renderCalendar();
  updateBottomStats();
  showToast('설정 및 근무 시간이 성공적으로 저장되었습니다.');
}

// ==========================================
// 8-1. 연도 및 월 간편 선택 모달 (Quick Datepicker)
// ==========================================
let pickerYear = 2026;

function initMonthPickerSelect() {
  const select = document.getElementById('picker-year-select');
  if (!select || select.options.length > 0) return;

  // 2020년부터 2035년까지 폭넓은 연도 지원 (2년 후, 5년 후 등 자유로운 이동)
  for (let y = 2020; y <= 2035; y++) {
    const opt = document.createElement('option');
    opt.value = y;
    opt.textContent = `${y}년`;
    select.appendChild(opt);
  }
}

function openMonthPicker() {
  initMonthPickerSelect();
  pickerYear = appState.currentYear;
  updatePickerView();
  document.getElementById('month-picker-modal-overlay').classList.add('active');
}

function closeMonthPicker() {
  const overlay = document.getElementById('month-picker-modal-overlay');
  if (overlay) overlay.classList.remove('active');
}

function updatePickerView() {
  if (pickerYear < 2020) pickerYear = 2020;
  if (pickerYear > 2035) pickerYear = 2035;

  const select = document.getElementById('picker-year-select');
  if (select) select.value = pickerYear;

  const grid = document.getElementById('picker-months-grid');
  if (!grid) return;
  grid.innerHTML = '';

  const now = new Date();
  const realYear = now.getFullYear();
  const realMonth = now.getMonth();

  for (let m = 0; m < 12; m++) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'picker-month-chip';
    if (pickerYear === appState.currentYear && m === appState.currentMonth) {
      btn.classList.add('active');
    }
    if (pickerYear === realYear && m === realMonth) {
      btn.title = '이번 달 (현재)';
    }
    btn.textContent = `${m + 1}월`;

    btn.addEventListener('click', () => {
      appState.currentYear = pickerYear;
      appState.currentMonth = m;
      renderCalendar();
      closeMonthPicker();
      showToast(`${pickerYear}년 ${m + 1}월로 이동했습니다.`);
    });

    grid.appendChild(btn);
  }
}

// ==========================================
// 9. 실시간 시계 & 유틸리티
// ==========================================

// 실시간 시계 & 날짜 연동 (1초마다 업데이트 및 자정 자동 갱신)
function initLiveClock() {
  function tick() {
    const now = new Date();
    const days = ['일', '월', '화', '수', '목', '금', '토'];
    const m = now.getMonth() + 1;
    const d = now.getDate();
    const dayName = days[now.getDay()];
    const hh = String(now.getHours()).padStart(2, '0');
    const mm = String(now.getMinutes()).padStart(2, '0');
    const ss = String(now.getSeconds()).padStart(2, '0');

    const clockText = document.getElementById('live-clock-text');
    if (clockText) {
      clockText.textContent = `${m}.${d}(${dayName}) ${hh}:${mm}:${ss}`;
    }

    // 자정(00시)이 지나 오늘 날짜가 바뀌면 달력 오늘 뱃지 자동 갱신
    const currentTodayStr = formatDate(now);
    if (appState.lastRenderedTodayStr && appState.lastRenderedTodayStr !== currentTodayStr) {
      appState.lastRenderedTodayStr = currentTodayStr;
      renderCalendar();
    }
  }

  appState.lastRenderedTodayStr = formatDate(new Date());
  tick();
  setInterval(tick, 1000);
}

// Toast 알림 함수
function showToast(message) {
  let toast = document.getElementById('app-toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'app-toast';
    toast.className = 'app-toast';
    document.body.appendChild(toast);
  }
  toast.innerHTML = `<span>✓</span> <span>${message}</span>`;
  toast.classList.add('show');
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => {
    toast.classList.remove('show');
  }, 2400);
}

// ==========================================
// 10. 이벤트 리스너 등록 및 초기화
// ==========================================
document.addEventListener('DOMContentLoaded', () => {
  loadState();
  initFirebase();
  initLiveClock();
  renderMemberFilterChips();
  renderCalendar();

  // 이전달 / 다음달 버튼
  document.getElementById('btn-prev-month').addEventListener('click', () => {
    if (appState.currentMonth === 0) {
      appState.currentYear--;
      appState.currentMonth = 11;
    } else {
      appState.currentMonth--;
    }
    renderCalendar();
  });

  document.getElementById('btn-next-month').addEventListener('click', () => {
    if (appState.currentMonth === 11) {
      appState.currentYear++;
      appState.currentMonth = 0;
    } else {
      appState.currentMonth++;
    }
    renderCalendar();
  });

  // 오늘 버튼 (실제 현재 시각/날짜로 이동 - UI에 존재할 경우)
  const btnToday = document.getElementById('btn-today');
  if (btnToday) {
    btnToday.addEventListener('click', () => {
      const now = new Date();
      appState.currentYear = now.getFullYear();
      appState.currentMonth = now.getMonth();
      appState.activeWeekDate = formatDate(now);
      renderCalendar();
      showToast(`오늘 (${now.getMonth() + 1}월 ${now.getDate()}일)로 이동했습니다.`);
    });
  }

  // 모달 닫기 이벤트
  document.getElementById('btn-close-day-modal').addEventListener('click', closeDayModal);
  document.getElementById('day-modal-overlay').addEventListener('click', (e) => {
    if (e.target.id === 'day-modal-overlay') closeDayModal();
  });

  // 설정 모달 열기/닫기/저장
  document.getElementById('btn-settings').addEventListener('click', openSettingsModal);
  document.getElementById('btn-close-settings').addEventListener('click', closeSettingsModal);
  document.getElementById('settings-modal-overlay').addEventListener('click', (e) => {
    if (e.target.id === 'settings-modal-overlay') closeSettingsModal();
  });
  document.getElementById('btn-save-settings').addEventListener('click', saveSettings);

  // 연도 및 월 간편 선택 모달 (달력 아이콘 및 헤더 년월 클릭)
  const btnOpenDatePicker = document.getElementById('btn-open-datepicker');
  if (btnOpenDatePicker) {
    btnOpenDatePicker.addEventListener('click', openMonthPicker);
  }

  const btnCloseMonthPicker = document.getElementById('btn-close-month-picker');
  if (btnCloseMonthPicker) {
    btnCloseMonthPicker.addEventListener('click', closeMonthPicker);
  }

  const monthPickerOverlay = document.getElementById('month-picker-modal-overlay');
  if (monthPickerOverlay) {
    monthPickerOverlay.addEventListener('click', (e) => {
      if (e.target.id === 'month-picker-modal-overlay') closeMonthPicker();
    });
  }

  const pickerYearSelect = document.getElementById('picker-year-select');
  if (pickerYearSelect) {
    pickerYearSelect.addEventListener('change', (e) => {
      pickerYear = parseInt(e.target.value, 10);
      updatePickerView();
    });
  }

  const pickerPrevYear = document.getElementById('picker-prev-year');
  if (pickerPrevYear) {
    pickerPrevYear.addEventListener('click', () => {
      pickerYear--;
      updatePickerView();
    });
  }

  const pickerNextYear = document.getElementById('picker-next-year');
  if (pickerNextYear) {
    pickerNextYear.addEventListener('click', () => {
      pickerYear++;
      updatePickerView();
    });
  }

  const pickerGotoToday = document.getElementById('picker-btn-goto-today');
  if (pickerGotoToday) {
    pickerGotoToday.addEventListener('click', () => {
      const now = new Date();
      appState.currentYear = now.getFullYear();
      appState.currentMonth = now.getMonth();
      appState.activeWeekDate = formatDate(now);
      renderCalendar();
      closeMonthPicker();
      showToast(`오늘 (${now.getMonth() + 1}월 ${now.getDate()}일)로 이동했습니다.`);
    });
  }

  // PC / 데스크톱 키보드 단축키 지원 (ESC: 모달 닫기, 좌/우 방향키: 월 이동)
  window.addEventListener('keydown', (e) => {
    const isEditingInput = ['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement?.tagName);
    if (e.key === 'Escape') {
      closeDayModal();
      closeSettingsModal();
      closeMonthPicker();
    } else if (!isEditingInput) {
      if (e.key === 'ArrowLeft') {
        document.getElementById('btn-prev-month').click();
      } else if (e.key === 'ArrowRight') {
        document.getElementById('btn-next-month').click();
      }
    }
  });

  const fontSelect = document.getElementById('setting-font-select');
  if (fontSelect) {
    fontSelect.addEventListener('change', (e) => {
      applyFont(e.target.value);
    });
  }
});
