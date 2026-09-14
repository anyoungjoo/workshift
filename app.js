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

// 주 52시간 상한제 법정 실근무 시간 정의 (근로기준법 휴게시간 적용: 기본 일 8h, 야 5.5h, 조 8h, 비 0h)
let SHIFT_HOURS = {
  '일': 8,
  '야': 5.5,
  '조': 8,
  '비': 0
};
const MAX_WEEKLY_HOURS = 52;

// 대근 자동 배정 기본 규칙 (일근 휴가 ➔ 비번자, 야근 휴가 ➔ 일근자, 조근 휴가 ➔ 비번자, 야/조 휴가 ➔ 조근자)
const DEFAULT_SUB_RULES = {
  '일': '비',
  '야': '일',
  '조': '비',
  '야조': '조'
};

// 입력된 시간 문자열(예: 09:00~18:00, 18:00~24:00 등)에서 실근무 시간을 계산하는 유틸리티
function calculateShiftHoursFromTime(timeStr, defaultHours = 8) {
  if (!timeStr) return defaultHours;
  if (timeStr.includes('비') || timeStr.includes('휴')) return 0.0;
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

  // 근로기준법 제54조 휴게시간 적용:
  // - 8시간 이상 체류 근무 시 법정 휴게시간 1시간 차감 (일근 09~18시는 9-1=8.0시간, 조근 00~09시는 9-1=8.0시간)
  // - 4시간 이상 8시간 미만 체류 시 법정 휴게시간 30분(0.5시간) 차감 (야근 18~24시는 6-0.5=5.5시간)
  let workHours = durationHours;
  if (durationHours >= 8) {
    workHours = durationHours - 1;
  } else if (durationHours >= 4) {
    workHours = durationHours - 0.5;
  }

  return Math.max(0, Math.round(workHours * 10) / 10);
}


// 2. 기본 상태 (Default State)
// [정답 초기화 데이터]: 1번 이준희 일근, 2번 최혜진 비번, 3번 오승연 조근, 4번 안영주 야근
const DEFAULT_MEMBERS = [
  { id: 0, name: '이준희', baseShift: '일' },
  { id: 1, name: '최혜진', baseShift: '비' },
  { id: 2, name: '오승연', baseShift: '조' },
  { id: 3, name: '안영주', baseShift: '야' }
];

// 스마트폰/아이폰 터치 시 더블 탭, 고스트 클릭 및 2인 동시 선택 원천 차단용 쿨다운 가드
let isActionLocked = false;
let lastActionTime = 0;

function canExecuteAction(cooldownMs = 350) {
  const now = Date.now();
  if (isActionLocked || (now - lastActionTime < cooldownMs)) {
    return false;
  }
  isActionLocked = true;
  lastActionTime = now;
  setTimeout(() => {
    isActionLocked = false;
  }, cooldownMs);
  return true;
}

// 멤버 이름으로 조회 (배치 순서 및 ID 무관)
function getMemberByName(name) {
  if (!name || !Array.isArray(appState.members)) return null;
  const trimmed = String(name).trim();
  return appState.members.find(m => m && m.name === trimmed) || null;
}

// 멤버 ID로 조회
function getMemberById(id) {
  if (id === null || id === undefined || !Array.isArray(appState.members)) return null;
  return appState.members.find(m => m && m.id === id) || null;
}

// 특정 일자, 특정 멤버의 휴가/대근 정보 안전 조회 (이름/ID/배치 순서 독립적)
function getMemberLeaveInfo(dateStr, member) {
  if (!appState.leaves || !appState.leaves[dateStr]) return null;
  const dayLeaves = appState.leaves[dateStr];
  const name = typeof member === 'string' ? member.trim() : (member?.name ? member.name.trim() : '');
  const id = typeof member === 'object' ? member?.id : (typeof member === 'number' ? member : null);

  // 1) 이름 키 우선 조회
  if (name && dayLeaves[name] && dayLeaves[name].isLeave) {
    return dayLeaves[name];
  }
  // 2) ID 키 조회 (하위 호환)
  if (id !== null && id !== undefined && dayLeaves[id] && dayLeaves[id].isLeave) {
    return dayLeaves[id];
  }
  // 3) 객체 내부 memberName 일치 여부 순회 확인
  for (const k of Object.keys(dayLeaves)) {
    const item = dayLeaves[k];
    if (item && item.isLeave && item.memberName === name) {
      return item;
    }
  }
  return null;
}

// 4인 순환 교대근무 4인 멤버 보장 함수 (기기별 사용자 지정 순서 보존 & 누락 방지)
function ensureFourMembers() {
  if (!Array.isArray(appState.members) || appState.members.length === 0) {
    appState.members = JSON.parse(JSON.stringify(DEFAULT_MEMBERS));
  }

  // 예전 5인 잔여 데이터 등 필터링
  appState.members = appState.members.filter(m => m && m.name !== '정수진' && m.id !== 4);

  const defaultList = [
    { name: '이준희', baseShift: '일' },
    { name: '최혜진', baseShift: '비' },
    { name: '오승연', baseShift: '조' },
    { name: '안영주', baseShift: '야' }
  ];

  // 로컬에 저장된 사용자 고유 멤버 배치 순서가 있다면 우선 적용
  try {
    const savedOrderStr = localStorage.getItem('SONGCHUL_LOCAL_MEMBER_ORDER');
    if (savedOrderStr) {
      const savedOrder = JSON.parse(savedOrderStr);
      if (Array.isArray(savedOrder) && savedOrder.length > 0) {
        const sorted = [];
        savedOrder.forEach(name => {
          const m = appState.members.find(x => x.name === name);
          if (m && !sorted.some(x => x.name === m.name)) {
            sorted.push(m);
          }
        });
        appState.members.forEach(m => {
          if (!sorted.some(x => x.name === m.name)) {
            sorted.push(m);
          }
        });
        if (sorted.length > 0) {
          appState.members = sorted;
        }
      }
    }
  } catch (e) {}

  // 4인 필수 멤버 누락 확인 및 보완
  defaultList.forEach(defM => {
    let m = appState.members.find(x => x.name === defM.name);
    if (!m) {
      if (defM.name === '최혜진') m = appState.members.find(x => x.name === '최희진');
      if (m) {
        m.name = defM.name;
      } else {
        appState.members.push({ id: appState.members.length, name: defM.name, baseShift: defM.baseShift });
      }
    }
    if (m && !m.baseShift) {
      m.baseShift = defM.baseShift;
    }
  });

  // 4명 유지 및 인덱스 기반 ID 재매핑 (배치 순서 보존)
  if (appState.members.length > 4) {
    appState.members = appState.members.slice(0, 4);
  }
  appState.members.forEach((m, idx) => {
    m.id = idx;
  });
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
  "2024-02-09": "연휴",
  "2024-02-10": "설날",
  "2024-02-11": "연휴",
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
  "2024-09-16": "연휴",
  "2024-09-17": "추석",
  "2024-09-18": "연휴",
  "2024-10-01": "임시공휴일",
  "2024-10-03": "개천절",
  "2024-10-09": "한글날",
  "2024-12-25": "성탄절",

  // 2025년
  "2025-01-01": "신정",
  "2025-01-28": "연휴",
  "2025-01-29": "설날",
  "2025-01-30": "연휴",
  "2025-03-01": "3·1절",
  "2025-03-03": "창립기념일",
  "2025-03-04": "대체공휴일",
  "2025-05-05": "어린이날·석가탄신일",
  "2025-05-06": "대체공휴일",
  "2025-05-20": "노조창립일",
  "2025-06-06": "현충일",
  "2025-08-15": "광복절",
  "2025-09-03": "방송의 날",
  "2025-10-03": "개천절",
  "2025-10-05": "연휴",
  "2025-10-06": "추석",
  "2025-10-07": "연휴",
  "2025-10-08": "대체공휴일",
  "2025-10-09": "한글날",
  "2025-12-25": "성탄절",

  // 2026년
  "2026-01-01": "신정",
  "2026-02-16": "연휴",
  "2026-02-17": "설날",
  "2026-02-18": "연휴",
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
  "2026-09-24": "연휴",
  "2026-09-25": "추석",
  "2026-09-26": "연휴",
  "2026-10-03": "개천절",
  "2026-10-05": "대체공휴일",
  "2026-10-09": "한글날",
  "2026-12-25": "성탄절",

  // 2027년
  "2027-01-01": "신정",
  "2027-02-06": "연휴",
  "2027-02-07": "설날",
  "2027-02-08": "연휴",
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
  "2027-09-14": "연휴",
  "2027-09-15": "추석",
  "2027-09-16": "연휴",
  "2027-10-03": "개천절",
  "2027-10-04": "대체공휴일",
  "2027-10-09": "한글날",
  "2027-10-11": "대체공휴일",
  "2027-12-25": "성탄절",
  "2027-12-27": "대체공휴일",

  // 2028년
  "2028-01-01": "신정",
  "2028-01-26": "연휴",
  "2028-01-27": "설날",
  "2028-01-28": "연휴",
  "2028-03-01": "3·1절",
  "2028-03-03": "창립기념일",
  "2028-05-02": "석가탄신일",
  "2028-05-05": "어린이날",
  "2028-05-20": "노조창립일",
  "2028-06-06": "현충일",
  "2028-08-15": "광복절",
  "2028-09-03": "방송의 날",
  "2028-10-02": "연휴",
  "2028-10-03": "추석·개천절",
  "2028-10-04": "연휴",
  "2028-10-05": "대체공휴일",
  "2028-10-09": "한글날",
  "2028-12-25": "성탄절",

  // 2029년
  "2029-01-01": "신정",
  "2029-02-12": "연휴",
  "2029-02-13": "설날",
  "2029-02-14": "연휴",
  "2029-03-01": "3·1절",
  "2029-03-03": "창립기념일",
  "2029-05-05": "어린이날",
  "2029-05-07": "대체공휴일",
  "2029-05-20": "석가탄신일·노조창립일",
  "2029-05-21": "대체공휴일",
  "2029-06-06": "현충일",
  "2029-08-15": "광복절",
  "2029-09-03": "방송의 날",
  "2029-09-21": "연휴",
  "2029-09-22": "추석",
  "2029-09-23": "연휴",
  "2029-09-24": "대체공휴일",
  "2029-10-03": "개천절",
  "2029-10-09": "한글날",
  "2029-12-25": "성탄절",

  // 2030년
  "2030-01-01": "신정",
  "2030-02-02": "연휴",
  "2030-02-03": "설날",
  "2030-02-04": "연휴",
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
  "2030-09-11": "연휴",
  "2030-09-12": "추석",
  "2030-09-13": "연휴",
  "2030-10-03": "개천절",
  "2030-10-09": "한글날",
  "2030-12-25": "성탄절"
};

// 특정 일자의 공휴일 정보 조회 (법정 공휴일 + 대체공휴일 + 방송국 지정 휴일)
function getHolidayInfo(dateStr) {
  let name = HOLIDAYS_MAP[dateStr] || null;

  // 2024~2030년 외 연도 대비 고정 양력 휴일 폴백
  if (!name) {
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
        name = fixed[mmdd];
      }
    }
  }

  if (name) {
    // 추석연휴, 설날연휴는 사용자 요청에 따라 당일만 '추석', '설날'로 하고 연휴는 2글자 '연휴'로 통일
    if (name === '추석연휴' || name === '설날연휴') {
      name = '연휴';
    }
    return { isHoliday: true, name: name };
  }

  return { isHoliday: false, name: null };
}

// 기준일 (2025년 9월 3일 기초 데이터: 1번 이준희 일, 2번 최혜진 비, 3번 오승연 조, 4번 안영주 야)
const DEFAULT_REF_DATE = '2025-09-03';

// 송출부장님 전용 설정 변경 권한 비밀번호 (7591)
const ADMIN_PASSWORD = '7591';
let isSettingsEditMode = false;

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
  // 기준일자별 근무자 변경 이력 타임라인 관리 (2025년 9월 3일 기초 데이터 기준)
  scheduleHistory: [
    {
      effectiveDate: DEFAULT_REF_DATE,
      refDate: DEFAULT_REF_DATE,
      members: JSON.parse(JSON.stringify(DEFAULT_MEMBERS)),
      shiftTimes: {
        '일': '09:00~18:00',
        '야': '18:00~24:00',
        '조': '00:00~09:00'
      }
    }
  ],
  lastModifiedDate: null, // 동시성 충돌 방지 날짜 추적용
  activeModalDate: null,
  font: 'Pretendard',
  // 근무 형태별 시간 설정 (수기 변경 가능)
  shiftTimes: {
    '일': '09:00~18:00',
    '야': '18:00~24:00',
    '조': '00:00~09:00'
  },
  // 대근 자동 배정 규칙 설정 (수기 변경 가능)
  subRules: {
    '일': '비',
    '야': '일',
    '조': '비',
    '야조': '조'
  }
};

// 특정 일자(dateStr)에 유효한 근무 기준 및 4인 멤버 명단 조회 (과거 근무 이력 보존)
function getConfigForDate(dateStr) {
  if (!Array.isArray(appState.scheduleHistory) || appState.scheduleHistory.length === 0) {
    return {
      effectiveDate: appState.refDate || DEFAULT_REF_DATE,
      refDate: appState.refDate || DEFAULT_REF_DATE,
      members: appState.members || DEFAULT_MEMBERS,
      shiftTimes: appState.shiftTimes || { '일': '09:00~18:00', '야': '18:00~24:00', '조': '00:00~09:00' }
    };
  }

  // effectiveDate 기준 오름차순 정렬 후, effectiveDate <= dateStr 인 항목 중 가장 최근 항목 도출
  const sorted = [...appState.scheduleHistory].sort((a, b) => a.effectiveDate.localeCompare(b.effectiveDate));
  let matched = sorted[0];
  for (const entry of sorted) {
    if (entry.effectiveDate <= dateStr) {
      matched = entry;
    } else {
      break;
    }
  }
  return matched;
}

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
    SHIFT_HOURS['야'] = calculateShiftHoursFromTime(times['야'], 5.5);
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
let storedClientId = null;
try {
  storedClientId = sessionStorage.getItem('SONGCHUL_CLIENT_ID');
} catch (e) {}
if (!storedClientId) {
  storedClientId = 'user_' + Math.random().toString(36).substring(2, 9) + '_' + Date.now().toString(36);
  try {
    sessionStorage.setItem('SONGCHUL_CLIENT_ID', storedClientId);
  } catch (e) {}
}
const MY_CLIENT_ID = storedClientId;
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

// ==========================================
// 스마트폰(갤럭시, 아이폰), PC(윈도우, 맥), 태블릿 전 기종 호환
// 맑은 "띵동~" 알림음 듀얼 오디오 엔진 & Web Notification 시스템 알림
// ==========================================
let sharedAudioContext = null;
let isAudioUnlocked = false;
let chimeWavUrl = null;
let chimeAudioElement = null;

// 브라우저 자체 생성 고음질 "띵-동" WAV 오디오 (외부 파일 다운로드 없이 100% 즉시 로드)
function initChimeAudio() {
  if (chimeAudioElement) return;
  try {
    const sampleRate = 44100;
    const duration = 0.65;
    const numSamples = Math.floor(sampleRate * duration);
    const buffer = new ArrayBuffer(44 + numSamples * 2);
    const view = new DataView(buffer);

    function writeString(v, offset, str) {
      for (let i = 0; i < str.length; i++) {
        v.setUint8(offset + i, str.charCodeAt(i));
      }
    }

    writeString(view, 0, 'RIFF');
    view.setUint32(4, 36 + numSamples * 2, true);
    writeString(view, 8, 'WAVE');
    writeString(view, 12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true); // PCM
    view.setUint16(22, 1, true); // Mono
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true); // 16-bit
    writeString(view, 36, 'data');
    view.setUint32(40, numSamples * 2, true);

    let offset = 44;
    for (let i = 0; i < numSamples; i++) {
      const t = i / sampleRate;
      let sample = 0;

      // 1차 톤 (E5: 659.25Hz) - 맑은 차임벨
      if (t < 0.35) {
        const env1 = Math.exp(-t * 12);
        sample += Math.sin(2 * Math.PI * 659.25 * t) * env1 * 0.45;
      }
      // 2차 톤 (A5: 880Hz) - "띵-동" 화음 울림
      if (t >= 0.12 && t < 0.65) {
        const t2 = t - 0.12;
        const env2 = Math.exp(-t2 * 8);
        sample += Math.sin(2 * Math.PI * 880 * t2) * env2 * 0.45;
      }

      const s = Math.max(-1, Math.min(1, sample));
      view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
      offset += 2;
    }

    const blob = new Blob([buffer], { type: 'audio/wav' });
    chimeWavUrl = URL.createObjectURL(blob);
    chimeAudioElement = new Audio(chimeWavUrl);
    chimeAudioElement.preload = 'auto';
  } catch (e) {
    console.warn('WAV 오디오 생성 불가:', e);
  }
}

function getSharedAudioContext() {
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  if (!AudioCtx) return null;
  if (!sharedAudioContext) {
    try {
      sharedAudioContext = new AudioCtx();
    } catch (e) {
      console.warn('AudioContext 생성 오류:', e);
    }
  }
  return sharedAudioContext;
}

// 모바일 브라우저(iOS Safari / Galaxy Chrome / 삼성 인터넷 / Mac) 오디오 잠금 해제 리스너 목록
const AUDIO_UNLOCK_EVENTS = ['click', 'touchstart', 'touchend', 'pointerdown', 'keydown'];

function cleanupAudioUnlockListeners() {
  AUDIO_UNLOCK_EVENTS.forEach(evt => {
    window.removeEventListener(evt, unlockAudioSession, { passive: true });
  });
}

// 오디오 잠금 해제 (User Gesture 시 1회만 안전하게 실행하여 터치 시 스피커 팝 노이즈 원천 차단)
function unlockAudioSession() {
  // 이미 성공적으로 언락된 상태라면 즉시 리스너를 해제하고 종료 (터치 시 불필요한 오디오 조작 100% 방지)
  if (isAudioUnlocked) {
    cleanupAudioUnlockListeners();
    return;
  }

  // 1) Web Audio API 컨텍스트 활성화
  const ctx = getSharedAudioContext();
  if (ctx) {
    if (ctx.state === 'suspended') {
      ctx.resume().then(() => {
        if (ctx.state === 'running') {
          isAudioUnlocked = true;
          cleanupAudioUnlockListeners();
        }
      }).catch(() => {});
    } else if (ctx.state === 'running') {
      isAudioUnlocked = true;
      cleanupAudioUnlockListeners();
    }
  }

  // 2) HTML5 Audio 요소 프리로드 (무음 상태로 안전하게 1회 언락)
  initChimeAudio();
  if (chimeAudioElement && !isAudioUnlocked) {
    try {
      chimeAudioElement.muted = true;
      const p = chimeAudioElement.play();
      if (p !== undefined) {
        p.then(() => {
          chimeAudioElement.pause();
          chimeAudioElement.currentTime = 0;
          chimeAudioElement.muted = false;
          chimeAudioElement.volume = 1.0;
          isAudioUnlocked = true;
          cleanupAudioUnlockListeners();
        }).catch(() => {
          chimeAudioElement.muted = false;
        });
      }
    } catch (e) {
      chimeAudioElement.muted = false;
    }
  }
}

// 스마트폰 및 PC 인터랙션 시 1회만 동작하도록 이벤트 등록
AUDIO_UNLOCK_EVENTS.forEach(evt => {
  window.addEventListener(evt, unlockAudioSession, { passive: true });
});

// "띵동~" 알림음 효과음 재생 (Web Audio 단일 맑은 톤 + 실패 시 HTML5 Audio 안전 백업)
function playNotificationSound() {
  // 1) 스마트폰 햅틱 진동 피드백 (갤럭시, 안드로이드 폰/태블릿)
  try {
    if (typeof navigator !== 'undefined' && navigator.vibrate) {
      navigator.vibrate([160, 80, 160]);
    }
  } catch (e) {}

  let webAudioPlayed = false;

  // 2) 1차 시도: Web Audio API 고음질 합성 오디오 (클릭 노이즈 방지 소프트 어택 적용)
  try {
    const ctx = getSharedAudioContext();
    if (ctx) {
      if (ctx.state === 'suspended') {
        ctx.resume().catch(() => {});
      }
      if (ctx.state === 'running') {
        const now = ctx.currentTime;

        // 1차 톤 (E5: 659.25Hz) - "띵" (부드러운 어택으로 팝 노이즈 차단)
        const osc1 = ctx.createOscillator();
        const gain1 = ctx.createGain();
        osc1.type = 'sine';
        osc1.frequency.setValueAtTime(659.25, now);
        gain1.gain.setValueAtTime(0.0001, now);
        gain1.gain.linearRampToValueAtTime(0.28, now + 0.015);
        gain1.gain.exponentialRampToValueAtTime(0.0001, now + 0.38);
        osc1.connect(gain1);
        gain1.connect(ctx.destination);
        osc1.start(now);
        osc1.stop(now + 0.38);

        // 2차 톤 (A5: 880.00Hz) - "동" (조화로운 잔향 울림)
        const osc2 = ctx.createOscillator();
        const gain2 = ctx.createGain();
        osc2.type = 'sine';
        osc2.frequency.setValueAtTime(880.0, now + 0.12);
        gain2.gain.setValueAtTime(0.0001, now + 0.12);
        gain2.gain.linearRampToValueAtTime(0.28, now + 0.135);
        gain2.gain.exponentialRampToValueAtTime(0.0001, now + 0.70);
        osc2.connect(gain2);
        gain2.connect(ctx.destination);
        osc2.start(now + 0.12);
        osc2.stop(now + 0.70);

        webAudioPlayed = true;
        isAudioUnlocked = true;
        cleanupAudioUnlockListeners();
      }
    }
  } catch (e) {
    console.warn('Web Audio 재생 실패, 백업 오디오로 전환:', e);
  }

  // 3) 2차 백업: Web Audio가 실패했을 때만 HTML5 Audio 재생 (중복 재생으로 인한 음 왜곡 및 지지직 노이즈 원천 차단)
  if (!webAudioPlayed) {
    try {
      initChimeAudio();
      if (chimeAudioElement) {
        chimeAudioElement.currentTime = 0;
        chimeAudioElement.muted = false;
        chimeAudioElement.volume = 1.0;
        const p = chimeAudioElement.play();
        if (p !== undefined) {
          p.catch(() => {
            if (chimeWavUrl) {
              const fallbackAudio = new Audio(chimeWavUrl);
              fallbackAudio.play().catch(() => {});
            }
          });
        }
      }
    } catch (err) {}
  }
}

// 스마트폰/PC/태블릿 OS 시스템 알림 문자 발송 (Web Notification API)
function sendSystemNotification(title, body) {
  try {
    if (!('Notification' in window)) return;
    if (Notification.permission === 'granted') {
      const options = {
        body: body,
        icon: 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 24 24" fill="%232563eb"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2" stroke="%23ffffff" stroke-width="2"/></svg>'),
        badge: 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 24 24" fill="%232563eb"><circle cx="12" cy="12" r="10"/></svg>'),
        tag: 'songchul-shift-realtime',
        renotify: true,
        silent: false,
        requireInteraction: true // PC/엣지에서 사용자가 확인할 때까지 우측 하단에 알림 배너 유지
      };
      const noti = new Notification(title, options);
      noti.onclick = function() {
        window.focus();
        noti.close();
      };
    }
  } catch (e) {
    console.warn('Notification 발송 오류:', e);
  }
}

// 브라우저 시스템 알림 권한 요청 함수 (PC 엣지/크롬/스마트폰 대응)
function requestNotificationPermission(showFeedback = true) {
  if (!('Notification' in window)) {
    if (showFeedback) showToast('이 브라우저는 시스템 알림 문자를 지원하지 않습니다.');
    return;
  }
  if (Notification.permission === 'granted') {
    if (showFeedback) {
      showToast('🔔 알림과 소리가 모두 정상 활성화되어 있습니다.');
      sendSystemNotification('송출센터 근무표', '실시간 알림 및 알림음이 정상 연결되어 있습니다.');
    }
    return;
  }
  if (Notification.permission === 'denied') {
    if (showFeedback) {
      showToast('⚠️ 알림이 차단되어 있습니다. 상단 자물쇠(🔒) 클릭 후 [알림] 및 [소리]를 "허용"해주세요.');
    }
    return;
  }
  Notification.requestPermission().then(permission => {
    if (permission === 'granted') {
      showToast('🔔 알림 권한이 허용되었습니다! (변경 시 실시간 알림음/배너 수신)');
      sendSystemNotification('송출센터 근무표', '근무표 변경 시 실시간으로 알림과 소리가 전송됩니다.');
    } else if (permission === 'denied') {
      if (showFeedback) {
        showToast('⚠️ 알림이 차단되었습니다. 상단 자물쇠(🔒) 클릭 후 [알림] 및 [소리]를 "허용"해주세요.');
      }
    }
  }).catch(() => {});
}

// leaves 객체 내 빈 날짜, undefined 필드, 비정상 데이터를 안전하게 정제하는 유틸리티
// ★ 핵심: 배치 순서와 ID에 무관하도록 키를 '근무자 이름(memberName)'으로 통일/정규화
function sanitizeLeaves(leaves) {
  if (!leaves || typeof leaves !== 'object') return {};
  const cleaned = {};
  Object.keys(leaves).forEach(dateStr => {
    const dayData = leaves[dateStr];
    if (!dayData || typeof dayData !== 'object') return;
    const cleanDay = {};
    Object.keys(dayData).forEach(key => {
      const item = dayData[key];
      if (item && item.isLeave) {
        // 1) 대상 근무자 이름 식별 (배치 순서 및 ID 독립성 보장)
        let memberName = item.memberName;
        if (!memberName) {
          if (isNaN(Number(key))) {
            memberName = String(key).trim();
          } else {
            const m = getMemberById(Number(key)) || DEFAULT_MEMBERS.find(d => d.id === Number(key));
            memberName = m ? m.name : String(key);
          }
        }
        if (!memberName) return;

        // 2) 대근자 이름 식별
        let subMemberName = item.subMemberName || null;
        if (!subMemberName && item.subId !== null && item.subId !== undefined && item.subId !== 'CUSTOM') {
          const subM = getMemberById(Number(item.subId)) || DEFAULT_MEMBERS.find(d => d.id === Number(item.subId));
          if (subM) subMemberName = subM.name;
        }
        if (item.subId === 'CUSTOM' && item.customSubName) {
          subMemberName = item.customSubName;
        }

        cleanDay[memberName] = {
          isLeave: true,
          memberName: memberName,
          subMemberName: subMemberName,
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

// ==========================================
// 알림 및 소리 수신 ON/OFF 토글 관리
// (초록색 = 수신 켜짐 / 회색 = 수신 안 함)
// ==========================================
const NOTIFICATION_SETTING_KEY = 'SONGCHUL_NOTIFICATION_ENABLED';
let isNotificationEnabled = false; // 기본값 회색(수신 안 함)

function initNotificationSetting() {
  try {
    const saved = localStorage.getItem(NOTIFICATION_SETTING_KEY);
    if (saved !== null) {
      isNotificationEnabled = (saved === 'true');
    } else {
      isNotificationEnabled = false; // 기본값 회색 (수신 안 함)
    }
  } catch (e) {
    isNotificationEnabled = false;
  }
  updateSoundToggleButtonUI();

  // 이미 알림이 켜져 있는데 브라우저 알림 권한이 아직 미설정인 경우 자연스럽게 권한 요청 시도
  if (isNotificationEnabled && typeof window !== 'undefined' && 'Notification' in window && Notification.permission === 'default') {
    setTimeout(() => {
      requestNotificationPermission(false);
    }, 1200);
  }
}

function updateSoundToggleButtonUI() {
  const btn = document.getElementById('btn-sound-toggle');
  if (!btn) return;

  if (isNotificationEnabled) {
    btn.className = 'icon-btn sound-on';
    btn.title = '알림음 및 알림 문자 켜짐 (클릭 시 끄기)';
    btn.setAttribute('aria-label', '알림 수신 중 (클릭 시 끄기)');
    btn.innerHTML = `
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"></path>
        <path d="M13.73 21a2 2 0 0 1-3.46 0"></path>
      </svg>
    `;
  } else {
    btn.className = 'icon-btn sound-off';
    btn.title = '알림음 및 알림 문자 꺼짐 (클릭 시 켜기)';
    btn.setAttribute('aria-label', '알림 수신 안 함 (클릭 시 켜기)');
    btn.innerHTML = `
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M13.73 21a2 2 0 0 1-3.46 0"></path>
        <path d="M18.63 13A17.89 17.89 0 0 1 18 8"></path>
        <path d="M6.26 6.26A5.86 5.86 0 0 0 6 8c0 7-3 9-3 9h14"></path>
        <path d="M18 8a6 6 0 0 0-9.33-5"></path>
        <line x1="1" y1="1" x2="23" y2="23"></line>
      </svg>
    `;
  }
}

function toggleNotificationSetting() {
  isNotificationEnabled = !isNotificationEnabled;
  try {
    localStorage.setItem(NOTIFICATION_SETTING_KEY, String(isNotificationEnabled));
  } catch (e) {}

  updateSoundToggleButtonUI();

  if (isNotificationEnabled) {
    unlockAudioSession();
    playNotificationSound();
    requestNotificationPermission(false);
    showToast('🔔 알림(소리 및 문자) 수신이 켜졌습니다.');
  } else {
    showToast('🔕 알림(소리 및 문자) 수신이 꺼졌습니다.');
  }
}

// 중복 알람 차단용 디바운스 타임스탬프
let lastToastNotificationTime = 0;
function notifyRemoteChange(detailMsg = '팀원이 변경한 근무표가 실시간 반영되었습니다.') {
  // 알림 수신이 꺼져 있으면(회색) 소리와 알림 문자를 수신/발송하지 않음!
  if (!isNotificationEnabled) {
    return;
  }

  const now = Date.now();
  if (now - lastToastNotificationTime < 2500) return; // 2.5초 내 중복 알람 원천 차단
  lastToastNotificationTime = now;

  // 1) 맑은 "띵동~" 알림음 재생 및 스마트폰 햅틱 진동
  playNotificationSound();

  // 2) 화면 토스트 알림 팝업
  showToast('🔔 ' + detailMsg);

  // 3) 스마트폰/PC/태블릿 OS 시스템 알림 문자 발송 (윈도우, 맥, 갤럭시, 아이폰 배너)
  sendSystemNotification('송출센터 근무표 알림', detailMsg);
}

// 다중 기기(스마트폰/PC 등 10여 대) 동시 수정 충돌 방지: 날짜 누적 추적 및 안전 병합
const pendingModifiedDates = new Set();

function markDateModified(dateStr) {
  if (dateStr) {
    pendingModifiedDates.add(dateStr);
  }
}

// 날짜 단위 안전 병합 (Safe Date-level Merge): 다른 기기가 작성한 다른 날짜의 최신 데이터 100% 보존
function mergeLeavesSafely(serverLeaves, localLeaves, modifiedDates = null) {
  const cleanServer = sanitizeLeaves(serverLeaves);
  const cleanLocal = sanitizeLeaves(localLeaves);
  const merged = {};

  // 1) 서버에 등록되어 있는 모든 날짜의 최신 휴가 데이터를 기본으로 온전히 보존
  Object.keys(cleanServer).forEach(date => {
    merged[date] = JSON.parse(JSON.stringify(cleanServer[date]));
  });

  // 2) 이번 조작에서 명시적으로 변경된 날짜(들)가 있다면, 해당 날짜들만 로컬 변경본으로 정확히 교체 (추가/취소 반영)
  if (modifiedDates) {
    const datesToMerge = Array.isArray(modifiedDates) || modifiedDates instanceof Set
      ? Array.from(modifiedDates)
      : [modifiedDates];

    datesToMerge.forEach(dateStr => {
      if (cleanLocal[dateStr]) {
        merged[dateStr] = JSON.parse(JSON.stringify(cleanLocal[dateStr]));
      } else {
        // 로컬에서 해당 날짜의 모든 휴가가 취소되어 비워졌다면 서버에서도 삭제
        delete merged[dateStr];
      }
    });
  } else {
    // 특정 날짜가 지정되지 않은 일괄 설정인 경우 로컬 데이터 반영
    Object.keys(cleanLocal).forEach(date => {
      merged[date] = JSON.parse(JSON.stringify(cleanLocal[date]));
    });
  }

  return sanitizeLeaves(merged);
}

// 클라우드 Firestore 비동기 업로드 큐 및 상태 관리
let isUploadingToFirebase = false;
let hasPendingUploadRequest = false;

// 원격 Firestore 변경 사항을 로컬 상태에 안전하게 적용하는 공통 함수
function applyRemoteData(remoteData, playSound = true) {
  if (!remoteData) return;
  // 내가 방금 변경하여 올린 이벤트라면 무시 (무한 루프 방지)
  if (remoteData.lastEditorId === MY_CLIENT_ID) {
    return;
  }

  // 구버전 서버 데이터(2025년 9월 3일 [1:이준희 일, 2:최혜진 비, 3:오승연 조, 4:안영주 야] 미적용본) 수신 시, 최신 기초 데이터로 클라우드 자동 갱신
  if (!remoteData.hasResetRefDate20250903OrderFix) {
    uploadStateToFirebase();
    return;
  }

  const remoteLeaves = sanitizeLeaves(remoteData.leaves);
  const localLeaves = sanitizeLeaves(appState.leaves);

  // 정확한 값 기반 동등성 비교
  const leavesChanged = canonicalLeavesString(remoteLeaves) !== canonicalLeavesString(localLeaves);
  const refChanged = Boolean(remoteData.refDate && remoteData.refDate !== appState.refDate);
  const membersChanged = Boolean(remoteData.members && !areMembersEqual(remoteData.members, appState.members));
  const timesChanged = Boolean(remoteData.shiftTimes && !areShiftTimesEqual(remoteData.shiftTimes, appState.shiftTimes));
  const rulesChanged = Boolean(remoteData.subRules && JSON.stringify(remoteData.subRules) !== JSON.stringify(appState.subRules));

  if (leavesChanged || refChanged || membersChanged || timesChanged || rulesChanged) {
    let nextLeaves = remoteLeaves;
    // 다중 기기 동시 작업 시, 내가 로컬에서 수정하여 업로드 대기 중인 날짜는 온전히 보존
    if (pendingModifiedDates.size > 0 || isUploadingToFirebase) {
      nextLeaves = mergeLeavesSafely(remoteLeaves, appState.leaves, pendingModifiedDates);
    }
    appState.leaves = nextLeaves;
    if (remoteData.refDate) appState.refDate = remoteData.refDate;
    if (remoteData.members && Array.isArray(remoteData.members) && remoteData.members.length > 0) {
      appState.members = remoteData.members.map((m, idx) => ({
        id: idx,
        name: m.name,
        baseShift: m.baseShift
      }));
      try {
        localStorage.setItem('SONGCHUL_LOCAL_MEMBER_ORDER', JSON.stringify(appState.members.map(m => m.name)));
      } catch (e) {}
    }
    if (remoteData.shiftTimes) {
      updateShiftTimes(remoteData.shiftTimes);
    }
    if (remoteData.subRules) {
      appState.subRules = Object.assign({}, DEFAULT_SUB_RULES, remoteData.subRules);
    }
    if (remoteData.scheduleHistory && Array.isArray(remoteData.scheduleHistory) && remoteData.scheduleHistory.length > 0) {
      appState.scheduleHistory = remoteData.scheduleHistory;
    }
    ensureFourMembers();
    loadSelectedMemberPref();

    const remoteTime = remoteData.clientUpdatedAt || Date.now();
    appState.lastLocalUpdated = remoteTime;
    saveLocalOnly();

    // 변경 내용에 따른 맞춤형 알림 문자 생성
    let detailMsg = '팀원이 변경한 근무표가 실시간 반영되었습니다.';
    if (refChanged || membersChanged) {
      detailMsg = '근무 순번 및 기준일자가 새로 변경되었습니다.';
    } else if (timesChanged) {
      detailMsg = '근무 시간 설정이 새로 변경되었습니다.';
    } else if (rulesChanged) {
      detailMsg = '대근 자동 배정 규칙이 새로 변경되었습니다.';
    } else if (leavesChanged) {
      const allDates = new Set([...Object.keys(remoteLeaves), ...Object.keys(localLeaves)]);
      let changedDate = null;
      for (const d of allDates) {
        if (JSON.stringify(remoteLeaves[d]) !== JSON.stringify(localLeaves[d])) {
          changedDate = d;
          break;
        }
      }
      if (changedDate) {
        const parts = changedDate.split('-');
        if (parts.length === 3) {
          detailMsg = `${parseInt(parts[1], 10)}월 ${parseInt(parts[2], 10)}일 근무/휴가 변경 사항이 반영되었습니다.`;
        } else {
          detailMsg = `${changedDate} 근무/휴가 변경 사항이 반영되었습니다.`;
        }
      } else {
        detailMsg = '근무/휴가 변경 사항이 실시간 반영되었습니다.';
      }
    }

    // 다른 기기에서 온 실시간 변경일 때만 알림음(소리) 및 시스템 알림 문자 발송
    if (playSound) {
      notifyRemoteChange(detailMsg);
    }

    invalidateScheduleCache();
    renderCalendar();
    updateBottomStats();

    // 스마트폰이나 PC에서 모달 창이 열려 있는 상태라면 모달 내부도 즉시 실시간 갱신!
    if (appState.activeModalDate) {
      renderDayModalBody(appState.activeModalDate);
    }
  }
}

// 클라우드 최신 데이터를 즉시 조회하여 동기화하는 함수 (에러 복구 및 정기 동기화용)
function fetchLatestCloudData(playSound = false) {
  if (!db) return;
  db.collection('schedules').doc('songchul_shift').get({ source: 'server' })
    .then(doc => {
      if (!doc.exists) return;
      applyRemoteData(doc.data(), playSound);
    })
    .catch(() => {
      db.collection('schedules').doc('songchul_shift').get()
        .then(doc => {
          if (doc.exists) applyRemoteData(doc.data(), playSound);
        })
        .catch(e => console.warn('클라우드 동기화 조회 실패:', e));
    });
}

let firestoreUnsubscribe = null;

function setupFirestoreListener() {
  if (!db) return;
  if (typeof firestoreUnsubscribe === 'function') {
    try { firestoreUnsubscribe(); } catch (e) {}
    firestoreUnsubscribe = null;
  }

  const docRef = db.collection('schedules').doc('songchul_shift');
  firestoreUnsubscribe = docRef.onSnapshot((doc) => {
    updateSyncStatus(true, '실시간 🔄');
    if (!doc.exists) {
      uploadStateToFirebase();
      return;
    }
    // 로컬 쓰기 직후의 미확정 로컬 스냅샷은 건너뜀
    if (doc.metadata && doc.metadata.hasPendingWrites) {
      return;
    }
    applyRemoteData(doc.data(), true);
  }, (error) => {
    console.warn('Firebase 실시간 동기화 상태:', error);
    updateSyncStatus(false, '동기화 지연');
  });
}

// Firebase 클라우드 초기화 및 다중 기기 실시간 리스너 구독
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
    db.settings({ ignoreUndefinedProperties: true });
    updateSyncStatus(true, '실시간 🔄');

    // 1) 다중 기기 실시간 스냅샷 리스너 개시
    setupFirestoreListener();

    // 2) 스마트폰/PC 화면 복귀 시 1회 최신 동기화 (Sleep/Tab 복귀)
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        setupFirestoreListener();
        fetchLatestCloudData(false);
      }
    });
    window.addEventListener('focus', () => {
      fetchLatestCloudData(false);
    });
    window.addEventListener('pageshow', () => {
      setupFirestoreListener();
      fetchLatestCloudData(false);
    });

    // 3) 네트워크 연결 복구(Wi-Fi/LTE 재연결) 시 리스너 재연결 및 즉시 최신 데이터 동기화
    window.addEventListener('online', () => {
      showToast('🌐 네트워크가 복구되어 클라우드 최신 데이터를 동기화합니다.');
      setupFirestoreListener();
      fetchLatestCloudData(false);
    });

    // 4) [사용자 요청: 모든 기기 최신 정답 동기화] 2분 주기 정기 자동 점검 및 자가 치유(Self-Healing)
    setInterval(() => {
      if (document.visibilityState === 'visible') {
        fetchLatestCloudData(false);
      }
    }, 120000); // 2분마다 조용히 서버 정답 값으로 전체 일치

    // 5) 상단 '실시간' 뱃지 터치 시 즉시 수동 동기화 & 사운드 테스트
    const syncBadge = document.getElementById('sync-status');
    if (syncBadge) {
      syncBadge.style.cursor = 'pointer';
      syncBadge.addEventListener('click', () => {
        unlockAudioSession();
        playNotificationSound();
        showToast('🔄 클라우드 최신 정답 데이터로 동기화합니다...');
        setupFirestoreListener();
        fetchLatestCloudData(false);
      });
    }

  } catch (err) {
    console.error('Firebase 초기화 실패:', err);
    updateSyncStatus(false, '오프라인');
  }
}

// 클라우드 Firestore에 동시성 충돌 방지 트랜잭션 및 큐 기반 안전 업로드
async function uploadStateToFirebase(isFullSync = false) {
  if (!db) return;

  // 이미 업로드 중이면 플래그를 세워두고 현재 작업 완료 즉시 최신 상태 재업로드
  if (isUploadingToFirebase) {
    hasPendingUploadRequest = true;
    return;
  }

  isUploadingToFirebase = true;
  hasPendingUploadRequest = false;

  const datesToUpload = new Set(pendingModifiedDates);
  pendingModifiedDates.clear();

  try {
    const docRef = db.collection('schedules').doc('songchul_shift');
    const nowMs = Date.now();
    appState.lastLocalUpdated = nowMs;

    const localLeaves = sanitizeLeaves(appState.leaves);
    const localRefDate = appState.refDate;
    const localMembers = appState.members;
    const localShiftTimes = appState.shiftTimes;

    // Firestore runTransaction을 사용하여 서버 최신 상태를 읽고 안전 병합 후 저장 (다중 기기 동시 충돌 100% 방지)
    await db.runTransaction(async (transaction) => {
      const serverDoc = await transaction.get(docRef);
      let finalLeaves = localLeaves;

      if (serverDoc.exists && !isFullSync) {
        const serverData = serverDoc.data() || {};
        const serverLeaves = sanitizeLeaves(serverData.leaves);
        // 다른 기기가 방금 등록한 다른 날짜 휴가를 온전히 보존하며 내 변경 날짜만 안전하게 병합!
        finalLeaves = mergeLeavesSafely(serverLeaves, localLeaves, datesToUpload);
      } else {
        finalLeaves = localLeaves;
      }

      const payload = {
        leaves: finalLeaves,
        refDate: localRefDate,
        members: localMembers,
        shiftTimes: localShiftTimes,
        subRules: appState.subRules || DEFAULT_SUB_RULES,
        scheduleHistory: appState.scheduleHistory || [],
        hasResetRefDate20250903OrderFix: true,
        lastEditorId: MY_CLIENT_ID,
        clientUpdatedAt: nowMs,
        updatedAt: nowMs
      };

      transaction.set(docRef, payload);
      // 로컬 상태도 안전 병합된 최종본으로 업데이트
      appState.leaves = finalLeaves;
    });

    saveLocalOnly();
    invalidateScheduleCache();
    renderCalendar();
    updateBottomStats();
    updateSyncStatus(true, '실시간 🔄');

  } catch (e) {
    console.warn('트랜잭션 실행 오류, 일반 set으로 폴백:', e);
    try {
      const cleanLeaves = sanitizeLeaves(appState.leaves);
      const nowMs = Date.now();
      const fallbackPayload = {
        leaves: cleanLeaves,
        refDate: appState.refDate,
        members: appState.members,
        shiftTimes: appState.shiftTimes,
        subRules: appState.subRules || DEFAULT_SUB_RULES,
        scheduleHistory: appState.scheduleHistory || [],
        hasResetRefDate20250903OrderFix: true,
        lastEditorId: MY_CLIENT_ID,
        clientUpdatedAt: nowMs,
        updatedAt: nowMs
      };
      await db.collection('schedules').doc('songchul_shift').set(fallbackPayload);
      updateSyncStatus(true, '실시간 🔄');
    } catch (fallbackErr) {
      console.error('Firestore 최종 업로드 실패:', fallbackErr);
      updateSyncStatus(false, '저장 지연');
    }
  } finally {
    isUploadingToFirebase = false;
    // 업로드 도중 사용자가 또 클릭해서 변경한 내역이 있다면 순차적으로 즉시 후속 업로드 수행
    if (hasPendingUploadRequest) {
      uploadStateToFirebase();
    }
  }
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
      subRules: appState.subRules || DEFAULT_SUB_RULES,
      scheduleHistory: appState.scheduleHistory || [],
      updatedAt: nowMs,
      hasResetRefDate20250903OrderFix: true,
      hasSavedDefault20260912: true
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(dataToSave));
    try {
      localStorage.setItem('SONGCHUL_LOCAL_MEMBER_ORDER', JSON.stringify(appState.members.map(m => m.name)));
    } catch (err) {}
  } catch (e) {
    console.error('LocalStorage 저장 실패:', e);
  }
}

// 통합 상태 저장: 로컬 저장 + 클라우드 업로드
function saveState(isFullSync = false) {
  invalidateScheduleCache();
  saveLocalOnly();
  uploadStateToFirebase(isFullSync);
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
      if (parsed.subRules) {
        appState.subRules = Object.assign({}, DEFAULT_SUB_RULES, parsed.subRules);
      }
      if (parsed.scheduleHistory && Array.isArray(parsed.scheduleHistory) && parsed.scheduleHistory.length > 0) {
        appState.scheduleHistory = parsed.scheduleHistory;
      } else {
        // 기본 2025-09-03 기준 기초 데이터 등록
        appState.scheduleHistory = [
          {
            effectiveDate: DEFAULT_REF_DATE,
            refDate: DEFAULT_REF_DATE,
            members: JSON.parse(JSON.stringify(DEFAULT_MEMBERS)),
            shiftTimes: JSON.parse(JSON.stringify(appState.shiftTimes || { '일': '09:00~18:00', '야': '18:00~24:00', '조': '00:00~09:00' }))
          }
        ];
      }

      // 2025년 9월 3일 기준 기초 데이터 1회 초기화 (기존 구버전 로컬 데이터 마이그레이션용)
      if (!parsed.hasResetRefDate20250903OrderFix) {
        appState.refDate = DEFAULT_REF_DATE; // '2025-09-03'
        appState.members = JSON.parse(JSON.stringify(DEFAULT_MEMBERS));
        try {
          localStorage.setItem('SONGCHUL_LOCAL_MEMBER_ORDER', JSON.stringify(appState.members.map(m => m.name)));
        } catch (e) {}
        appState.scheduleHistory = [
          {
            effectiveDate: DEFAULT_REF_DATE,
            refDate: DEFAULT_REF_DATE,
            members: JSON.parse(JSON.stringify(DEFAULT_MEMBERS)),
            shiftTimes: JSON.parse(JSON.stringify(appState.shiftTimes || { '일': '09:00~18:00', '야': '18:00~24:00', '조': '00:00~09:00' }))
          }
        ];
        saveState();
      }

      applyFont(appState.font || 'Pretendard');
      // 페이지 새로고침 시 클라우드 데이터를 덮어쓰지 않도록 로컬 데이터만 로드
    } else {
      // 초기 데모 데이터 및 영구 저장
      appState.members = JSON.parse(JSON.stringify(DEFAULT_MEMBERS));
      appState.refDate = DEFAULT_REF_DATE;
      appState.scheduleHistory = [
        {
          effectiveDate: DEFAULT_REF_DATE,
          refDate: DEFAULT_REF_DATE,
          members: JSON.parse(JSON.stringify(DEFAULT_MEMBERS)),
          shiftTimes: JSON.parse(JSON.stringify(appState.shiftTimes || { '일': '09:00~18:00', '야': '18:00~24:00', '조': '00:00~09:00' }))
        }
      ];
      initDemoData();
      applyFont('Pretendard');
      saveState();
    }
  } catch (e) {
    console.error('LocalStorage 로드 실패:', e);
    appState.members = JSON.parse(JSON.stringify(DEFAULT_MEMBERS));
    appState.refDate = DEFAULT_REF_DATE;
    appState.scheduleHistory = [
      {
        effectiveDate: DEFAULT_REF_DATE,
        refDate: DEFAULT_REF_DATE,
        members: JSON.parse(JSON.stringify(DEFAULT_MEMBERS)),
        shiftTimes: JSON.parse(JSON.stringify(appState.shiftTimes || { '일': '09:00~18:00', '야': '18:00~24:00', '조': '00:00~09:00' }))
      }
    ];
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

// 특정 날짜의 기본 4교대 근무 계산 (기준일자별 근무자 변경 이력 타임라인 자동 반영)
function getBaseShiftForMember(member, dateStr) {
  const config = getConfigForDate(dateStr);
  const diffDays = getDayDifference(dateStr, config.refDate);

  const memberName = typeof member === 'string' ? member.trim() : (member?.name ? member.name.trim() : '');
  const memberId = typeof member === 'object' ? member?.id : (typeof member === 'number' ? member : null);

  let targetMember = null;
  if (memberName) {
    targetMember = config.members.find(m => m.name === memberName);
  }
  if (!targetMember && memberId !== null && memberId !== undefined) {
    targetMember = config.members.find(m => m.id === memberId);
  }
  if (!targetMember) {
    targetMember = member;
  }

  const baseShift = targetMember?.baseShift || '일';
  const baseIdx = SHIFT_TYPES.indexOf(baseShift);
  if (baseIdx === -1) return '비';

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

  // 2단계: 7일간 기본 순환 근무 산출 및 휴가자 기본 근무 제외 (일자별 이력 명단 자동 적용)
  const weekRosters = {};
  weekDates.forEach(dateStr => {
    const dayConfig = getConfigForDate(dateStr);
    const dayMembers = dayConfig.members;

    weekRosters[dateStr] = dayMembers.map(m => {
      const baseShift = getBaseShiftForMember(m, dateStr);
      const leaveInfo = getMemberLeaveInfo(dateStr, m);
      const isLeave = Boolean(leaveInfo && leaveInfo.isLeave);
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
        subMemberName: null,
        isManualSub: false,
        customSubName: null,
        autoSubFailReason: null
      };
    });

    // 기본 근무시간 가산 (휴가가 아닌 경우에만)
    weekRosters[dateStr].forEach(item => {
      if (!item.isLeave) {
        if (memberWeekHours[item.memberId] === undefined) {
          memberWeekHours[item.memberId] = 0;
        }
        memberWeekHours[item.memberId] += (SHIFT_HOURS[item.baseShift] || 0);
      }
    });
  });

  // 3단계: 수기 지정된 대근자(Manual Sub) 우선 반영 (이름 기반 정확한 매핑)
  weekDates.forEach(dateStr => {
    const roster = weekRosters[dateStr];

    roster.forEach(item => {
      if (!item.isLeave) return;
      const leaveInfo = getMemberLeaveInfo(dateStr, item.name);
      if (!leaveInfo || !leaveInfo.isManual) return;

      const subId = leaveInfo.subId;
      const subMemberName = leaveInfo.subMemberName;

      if ((subId === 'CUSTOM' || subMemberName) && leaveInfo.customSubName) {
        item.substituteId = 'CUSTOM';
        item.customSubName = leaveInfo.customSubName;
        item.subMemberName = leaveInfo.customSubName;
        item.isManualSub = true;
      } else if (subMemberName || (subId !== null && subId !== undefined)) {
        // 이름으로 먼저 찾고, 없으면 ID로 찾음 (배치 순서 및 ID 독립성 보장)
        const subMember = (subMemberName ? roster.find(r => r.name === subMemberName) : null)
          || (subId !== null && subId !== undefined ? roster.find(r => r.memberId === subId) : null);

        if (subMember) {
          subMember.isSubstitute = true;
          subMember.isManualSub = true;
          subMember.subForMemberId = item.memberId;
          subMember.subForShiftType = item.baseShift;
          subMember.effectiveShift = subMember.baseShift !== '비' 
            ? `${subMember.baseShift}+${item.baseShift}(대)` 
            : `${item.baseShift}(대)`;
          item.substituteId = subMember.memberId;
          item.subMemberName = subMember.name;
          item.isManualSub = true;

          // 수기 지정 대근시간 가산
          memberWeekHours[subMember.memberId] += (SHIFT_HOURS[item.baseShift] || 0);
        }
      } else {
        // subId === null (사용자가 대근 해제를 누른 경우 -> 결원 발생)
        item.substituteId = null;
        item.subMemberName = null;
        item.isManualSub = true;
        item.autoSubFailReason = '대근 해제됨 (24시간 근무 결원 발생 - 수동 지정 필요)';
      }
    });
  });

  // 4단계: 자동 대근자 배정 (월요일부터 일요일까지 순서대로, 규칙 전담자 엄격 배정)
  // 규칙에 지정된 전담자가 52시간 초과 시 임의 지정하지 않고 비워둠 -> 경광등 🚨 발생
  weekDates.forEach(dateStr => {
    const roster = weekRosters[dateStr];

    roster.forEach(item => {
      if (!item.isLeave) return;
      const leaveInfo = getMemberLeaveInfo(dateStr, item.name);
      // 수기 지정/해제 건은 3단계에서 처리됨
      if (leaveInfo && leaveInfo.isManual) return;

      const origShift = item.baseShift;
      const neededHours = SHIFT_HOURS[origShift] || 0;

      const nextDate = getNextDateStr(dateStr);
      const nextLeaveInfo = getMemberLeaveInfo(nextDate, item.name);
      const isNextJoLeave = Boolean(nextLeaveInfo && nextLeaveInfo.isLeave);

      const prevDate = getPrevDateStr(dateStr);
      const prevLeaveInfo = getMemberLeaveInfo(prevDate, item.name);
      const isPrevYaLeave = Boolean(prevLeaveInfo && prevLeaveInfo.isLeave);

      // 규칙별 전담 자동 배정 대상자(단 1인) 도출
      let targetCand = null;
      const subRules = appState.subRules || DEFAULT_SUB_RULES;

      if (origShift === '일') {
        // [규칙 1: 일근 단독 휴가] ➡️ 설정된 대근자 (기본: 비번자)
        const targetShift = subRules['일'] || '비';
        targetCand = roster.find(r => r.memberId !== item.memberId && r.baseShift === targetShift);
      } else if (origShift === '야') {
        if (isNextJoLeave) {
          // [규칙 4: 야/조근 연속 휴가 - 첫째날 야근] ➡️ 설정된 대근자 (기본: 조근자)
          const targetShift = subRules['야조'] || '조';
          targetCand = roster.find(r => r.memberId !== item.memberId && r.baseShift === targetShift);
        } else {
          // [규칙 2: 야근 단독 휴가] ➡️ 설정된 대근자 (기본: 일근자)
          const targetShift = subRules['야'] || '일';
          targetCand = roster.find(r => r.memberId !== item.memberId && r.baseShift === targetShift);
        }
      } else if (origShift === '조') {
        if (isPrevYaLeave) {
          // [규칙 4: 야/조근 연속 휴가 - 둘째날 조근] ➡️ 전날 야근 대근자 (당일 비번자)
          const prevDayRoster = weekRosters[prevDate] || getDayShiftRoster(prevDate);
          const prevDayLeaveItem = prevDayRoster?.find(r => r.name === item.name && r.isLeave);
          const prevSubName = prevDayLeaveItem?.subMemberName;
          const prevSubId = prevDayLeaveItem?.substituteId;

          if (prevSubName) {
            targetCand = roster.find(r => r.name === prevSubName);
          } else if (prevSubId !== null && prevSubId !== undefined && prevSubId !== 'CUSTOM') {
            targetCand = roster.find(r => r.memberId === prevSubId);
          } else {
            const targetShift = subRules['조'] || '비';
            targetCand = roster.find(r => r.memberId !== item.memberId && r.baseShift === targetShift);
          }
        } else {
          // [규칙 3: 조근 단독 휴가] ➡️ 설정된 대근자 (기본: 비번자)
          const targetShift = subRules['조'] || '비';
          targetCand = roster.find(r => r.memberId !== item.memberId && r.baseShift === targetShift);
        }
      }

      // 대상자 검증: 부재, 휴가, 타 대근 중, 주 52시간 초과 시 임의 지정 금지 -> 결원(미배정) 처리
      if (!targetCand) {
        item.substituteId = null;
        item.subMemberName = null;
        item.autoSubFailReason = '대근 대상자 없음 (수동 지정 필요)';
      } else if (targetCand.isLeave) {
        item.substituteId = null;
        item.subMemberName = null;
        item.autoSubFailReason = `자동 배정 대상자(${targetCand.name}) 휴가로 인한 결원 (수동 지정 필요)`;
      } else if (targetCand.isSubstitute) {
        item.substituteId = null;
        item.subMemberName = null;
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
          item.subMemberName = targetCand.name;

          // 주간 누적 근무시간 가산
          memberWeekHours[targetCand.memberId] += neededHours;
        } else {
          // 52시간 초과 시 임의 지정하지 않고 비워둠 (관리자 수동 지정 필요)
          item.substituteId = null;
          item.subMemberName = null;
          item.autoSubFailReason = `자동 배정 대상자(${targetCand.name}) 주 52시간 초과 (${expectedHours}시간 / 52시간) - 수동 지정 필요`;
        }
      }
    });
  });

  // 부동소수점 오차 방지 (소수점 첫째자리 정리)
  Object.keys(memberWeekHours).forEach(id => {
    memberWeekHours[id] = Math.round(memberWeekHours[id] * 10) / 10;
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
// 5. 날짜 선택 3분 자동 복귀 (Auto-Revert to Today) 타이머
// 사용자가 다른 날짜나 근무를 클릭한 후 3분(180초) 동안 추가 조작이 없으면 오늘 날짜(오늘 주간)로 자동 복귀
// ==========================================
let autoRevertTimer = null;
const AUTO_REVERT_DELAY_MS = 3 * 60 * 1000; // 3분 (180,000ms)

function triggerAutoRevertTimer() {
  if (autoRevertTimer) {
    clearTimeout(autoRevertTimer);
    autoRevertTimer = null;
  }

  const todayStr = formatDate(new Date());
  // 선택된 날짜가 오늘이 아닌 경우에만 3분 타이머 가동
  if (appState.activeWeekDate && appState.activeWeekDate !== todayStr) {
    autoRevertTimer = setTimeout(() => {
      revertToTodaySelection();
    }, AUTO_REVERT_DELAY_MS);
  }
}

function revertToTodaySelection() {
  if (autoRevertTimer) {
    clearTimeout(autoRevertTimer);
    autoRevertTimer = null;
  }

  const now = new Date();
  const todayStr = formatDate(now);
  const todayYear = now.getFullYear();
  const todayMonth = now.getMonth();

  const monthChanged = (appState.currentYear !== todayYear || appState.currentMonth !== todayMonth);
  appState.currentYear = todayYear;
  appState.currentMonth = todayMonth;
  appState.activeWeekDate = todayStr;

  if (monthChanged) {
    renderCalendar();
  } else {
    updateCalendarSelection();
    updateBottomStats();
  }
}

// 주별 좌측(일요일 앞) 4인 이름 열 셀 생성
function createWeekMemberHeaderCell(sundayDateStr, weekIdx) {
  const cell = document.createElement('div');
  cell.className = 'week-member-header-cell';
  cell.dataset.weekStart = sundayDateStr;
  cell.dataset.weekIndex = weekIdx;
  cell.title = `${weekIdx + 1}주차 4인 근무 순번 (터치/클릭 시 해당 주간 근무 현황 조회)`;

  // 상단 헤더 영역 (날짜 셀의 day-cell-top과 정확히 일치하는 높이)
  const topBar = document.createElement('div');
  topBar.className = 'member-header-top';
  topBar.innerHTML = `<span>${weekIdx + 1}주</span>`;
  cell.appendChild(topBar);

  // 하단 4인 이름 목록 (해당 주의 기준일자 멤버 순서대로 동적 렌더링)
  const namesContainer = document.createElement('div');
  namesContainer.className = 'member-header-names';

  const dayConfig = getConfigForDate(sundayDateStr);
  const weekMembers = dayConfig && Array.isArray(dayConfig.members) ? dayConfig.members : appState.members;

  weekMembers.forEach(m => {
    const row = document.createElement('div');
    row.className = 'member-name-row';
    row.textContent = m.name;
    row.title = `${m.name} (${weekIdx + 1}주차)`;
    namesContainer.appendChild(row);
  });
  cell.appendChild(namesContainer);

  // 셀 터치/클릭 시: 해당 주의 주간 통계 조회 및 3분 복귀 타이머 가동
  cell.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (!canExecuteAction(200)) return;
    appState.activeWeekDate = sundayDateStr;
    updateCalendarSelection();
    updateBottomStats();
    highlightBottomStats();
    triggerAutoRevertTimer();
  });

  return cell;
}

// ==========================================
// 6. 캘린더 렌더링 함수
// ==========================================
function renderCalendar() {
  const year = appState.currentYear;
  const month = appState.currentMonth;

  // 헤더 년/월 텍스트 업데이트
  document.getElementById('display-year-month').textContent = `${year}년 ${month + 1}월`;

  const calendarWrapper = document.querySelector('.calendar-wrapper');
  if (calendarWrapper) {
    if (appState.selectedMemberId === 'ALL') {
      calendarWrapper.classList.remove('single-member-mode');
    } else {
      calendarWrapper.classList.add('single-member-mode');
    }
  }

  const daysGrid = document.getElementById('calendar-days-grid');
  daysGrid.innerHTML = '';

  const firstDayOfMonth = new Date(year, month, 1);
  const lastDayOfMonth = new Date(year, month + 1, 0);
  const startDayOfWeek = firstDayOfMonth.getDay(); // 0(일) ~ 6(토)
  const totalDays = lastDayOfMonth.getDate();

  // 날짜 데이터 목록(지난달 + 이번달 + 다음달) 생성
  const allDaysData = [];

  // 지난달 채우기 날짜
  const prevMonthLastDay = new Date(year, month, 0).getDate();
  for (let i = startDayOfWeek - 1; i >= 0; i--) {
    const dayNum = prevMonthLastDay - i;
    const dateStr = formatDate(new Date(year, month - 1, dayNum));
    allDaysData.push({ dateStr, dayNum, isOtherMonth: true, isToday: false });
  }

  // 이번 달 날짜 채우기 (시스템의 실제 현재 시각 및 날짜를 정확히 추적)
  const todayStr = formatDate(new Date());
  for (let d = 1; d <= totalDays; d++) {
    const dateStr = formatDate(new Date(year, month, d));
    const isToday = (dateStr === todayStr);
    allDaysData.push({ dateStr, dayNum: d, isOtherMonth: false, isToday });
  }

  // 다음 달 채우기 (총 35칸 또는 42칸 맞춤)
  const currentCellsCount = startDayOfWeek + totalDays;
  const nextDaysNeeded = (currentCellsCount <= 35 ? 35 : 42) - currentCellsCount;
  for (let d = 1; d <= nextDaysNeeded; d++) {
    const dateStr = formatDate(new Date(year, month + 1, d));
    allDaysData.push({ dateStr, dayNum: d, isOtherMonth: true, isToday: false });
  }

  // 주(Week) 단위로 7일씩 쪼개어 그리드에 삽입
  const totalWeeks = Math.ceil(allDaysData.length / 7);
  daysGrid.style.setProperty('--week-count', totalWeeks);
  for (let w = 0; w < totalWeeks; w++) {
    const weekDays = allDaysData.slice(w * 7, (w + 1) * 7);
    const sundayDateStr = weekDays[0].dateStr;

    // '전체 근무' 모드일 때만 맨 앞 1열에 주별 4인 이름 열 셀 삽입
    if (appState.selectedMemberId === 'ALL') {
      const headerCell = createWeekMemberHeaderCell(sundayDateStr, w);
      daysGrid.appendChild(headerCell);
    }

    // 7개 날짜 셀 삽입 (일~토)
    weekDays.forEach(dayInfo => {
      const cell = createDayCell(dayInfo.dateStr, dayInfo.dayNum, dayInfo.isOtherMonth, dayInfo.isToday);
      daysGrid.appendChild(cell);
    });
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
    </div>
    ${sirenHtml}
    ${isToday ? '<span class="badge-today-mark">오늘</span>' : ''}
  `;
  
  // 상단 날짜 영역 터치/클릭: 모달을 절대 열지 않고, 하단 주간 통계만 이동!
  cellTop.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (!canExecuteAction(200)) return;
    appState.activeWeekDate = dateStr;
    updateCalendarSelection();
    updateBottomStats();
    highlightBottomStats();
    triggerAutoRevertTimer();
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

      // 전체 근무 달력: 좌측에 주별 4인 이름이 표시되므로 날짜 셀 안에는 성을 빼고 근무만 중앙에 깔끔하게 표시
      if (r.isLeave) {
        pill.classList.add('is-leave');
        pill.innerHTML = `<span class="shift-pill-type">휴</span>`;
      } else if (r.isSubstitute) {
        pill.classList.add('is-substitute');
        // 수동으로 지정한 대근자인 경우: 전체 근무 달력에서 이름 + 근무 형태 함께 표기 (예: 홍길동 조, 이준희 조)
        if (r.isManualSub) {
          pill.classList.add('has-member');
          const nameLen = r.name ? r.name.length : 0;
          const lenClass = nameLen >= 4 ? 'len-4' : (nameLen === 3 ? 'len-3' : '');
          if (r.baseShift === '일' || r.baseShift === '조') {
            const origTagClass = r.baseShift === '일' ? 'tag-il' : 'tag-jo';
            pill.innerHTML = `
              <span class="shift-pill-member ${lenClass}">${r.name}</span>
              <span class="dual-tags-wrap">
                <span class="mini-tag ${origTagClass}">${r.baseShift}</span>
                <span class="mini-tag-plus">+</span>
                <span class="mini-tag tag-sub">${r.subForShiftType}</span>
              </span>
            `;
          } else {
            pill.innerHTML = `
              <span class="shift-pill-member ${lenClass}">${r.name}</span>
              <span class="shift-pill-type">${r.subForShiftType}</span>
            `;
          }
        } else {
          // 자동 배정 대근자인 경우 (기존대로 근무만 중앙 깔끔 표기)
          if (r.baseShift === '일' || r.baseShift === '조') {
            const origTagClass = r.baseShift === '일' ? 'tag-il' : 'tag-jo';
            pill.innerHTML = `
              <span class="dual-tags-wrap">
                <span class="mini-tag ${origTagClass}">${r.baseShift}</span>
                <span class="mini-tag-plus">+</span>
                <span class="mini-tag tag-sub">${r.subForShiftType}</span>
              </span>
            `;
          } else {
            // 비번 날 대근하는 경우 (대근 종류 1글자 주황색 박스)
            pill.innerHTML = `<span class="shift-pill-type">${r.subForShiftType}</span>`;
          }
        }
      } else {
        pill.innerHTML = `<span class="shift-pill-type">${r.baseShift}</span>`;
      }

      pill.title = `${r.name} (${r.shiftName || r.baseShift}) - 터치/클릭 시 휴가·대근 관리`;
      shiftList.appendChild(pill);
    });

    // 외부 수기 대근자가 있는 경우 추가 칩 렌더링 (이름 + 근무 형태 표기, 예: 홍길동 조)
    roster.forEach(r => {
      if (r.isLeave && r.substituteId === 'CUSTOM' && r.customSubName) {
        const customPill = document.createElement('div');
        customPill.className = `shift-pill is-substitute has-member custom-sub-pill`;
        let subClass = 'pill-bi';
        if (r.baseShift === '일') subClass = 'pill-il';
        else if (r.baseShift === '야') subClass = 'pill-ya';
        else if (r.baseShift === '조') subClass = 'pill-jo';
        customPill.classList.add(subClass);
        customPill.title = `${r.customSubName} (${r.baseShift} 대근) - 터치/클릭 시 휴가·대근 관리`;
        const nameLen = r.customSubName.length;
        const lenClass = nameLen >= 4 ? 'len-4' : (nameLen === 3 ? 'len-3' : '');
        customPill.innerHTML = `
          <span class="shift-pill-member ${lenClass}">${r.customSubName}</span>
          <span class="shift-pill-type">${r.baseShift}</span>
        `;
        shiftList.appendChild(customPill);
      }
    });

    // 하단 근무 뱃지 영역 터치/클릭 시: 휴가/대근 관리 모달 열기!
    shiftList.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (!canExecuteAction(350)) return;
      appState.activeWeekDate = dateStr;
      updateCalendarSelection();
      updateBottomStats();
      triggerAutoRevertTimer();
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
      e.preventDefault();
      e.stopPropagation();
      if (!canExecuteAction(350)) return;
      appState.activeWeekDate = dateStr;
      updateCalendarSelection();
      updateBottomStats();
      triggerAutoRevertTimer();
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
    if (!canExecuteAction(200)) return;
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

  // 24시간 연속 근무 결원 발생 또는 대근 미배정 시 상단에 독립된 전용 카드 노출
  const unassignedLeaves = roster.filter(r => r.isLeave && !r.substituteId && !r.customSubName);
  if (coverage.hasGap || unassignedLeaves.length > 0) {
    const missingShiftsArr = (coverage.missingShifts && coverage.missingShifts.length > 0) 
      ? coverage.missingShifts 
      : unassignedLeaves.map(r => r.baseShift);
    const fallbackMissingTime = missingShiftsArr.map(s => SHIFT_DETAILS[s]?.time || '').filter(Boolean).join(', ') || '시간대 결원';

    if (unassignedLeaves.length > 0) {
      unassignedLeaves.forEach(unassignedMember => {
        const rawTime = SHIFT_DETAILS[unassignedMember.baseShift]?.time || fallbackMissingTime;
        const shiftTime = (rawTime || '').replace(/\s*~\s*/, '~');
        const leaveInfo = getMemberLeaveInfo(dateStr, unassignedMember.name);
        
        let reasonBadgeHtml = '';
        if (leaveInfo?.isManual && !leaveInfo?.subId && !leaveInfo?.customSubName) {
          reasonBadgeHtml = `<span class="coverage-reason-badge">대근 해제됨</span>`;
        } else if (unassignedMember.autoSubFailReason && unassignedMember.autoSubFailReason.includes('52시간')) {
          reasonBadgeHtml = `<span class="coverage-reason-badge">52시간 초과</span>`;
        }

        let optionsHtml = `<option value="">-- 대근자 선택 --</option>`;
        appState.members.forEach(m => {
          if (m.name !== unassignedMember.name) {
            optionsHtml += `<option value="${m.id}">${m.name} (현재 ${getBaseShiftForMember(m, dateStr)})</option>`;
          }
        });
        optionsHtml += `<option value="CUSTOM_INPUT">직접 입력</option>`;

        const alertCard = document.createElement('div');
        alertCard.className = 'modal-coverage-alert-card';
        alertCard.innerHTML = `
          <div class="coverage-card-top">
            <div class="coverage-title-wrap">
              <span class="coverage-siren-icon">🚨</span>
              <span class="coverage-main-title">근무 공백</span>
              <span class="coverage-time-tag">(${shiftTime})</span>
            </div>
            ${reasonBadgeHtml}
          </div>
          <div class="coverage-card-action">
            <span class="coverage-action-label">대근 수동 지정:</span>
            <select class="select-sub-manual coverage-sub-select" data-for-member="${unassignedMember.memberId}" data-for-name="${unassignedMember.name}">
              ${optionsHtml}
            </select>
          </div>
          <div class="sub-custom-row coverage-custom-row" data-for-member="${unassignedMember.memberId}" style="display:none; margin-top:4px;">
            <input type="text" class="input-sub-custom" data-for-member="${unassignedMember.memberId}" placeholder="대근자 이름 입력 (예: 홍길동)" value="">
            <button type="button" class="btn-sub-custom-save" data-for-member="${unassignedMember.memberId}" data-for-name="${unassignedMember.name}">확인</button>
          </div>
        `;
        container.appendChild(alertCard);
      });
    } else {
      const alertCard = document.createElement('div');
      alertCard.className = 'modal-coverage-alert-card';
      const fallbackTimeFormatted = (fallbackMissingTime || '').replace(/\s*~\s*/, '~');
      alertCard.innerHTML = `
        <div class="coverage-card-top">
          <div class="coverage-title-wrap">
            <span class="coverage-siren-icon">🚨</span>
            <span class="coverage-main-title">근무 공백</span>
            <span class="coverage-time-tag">(${fallbackTimeFormatted})</span>
          </div>
        </div>
      `;
      container.appendChild(alertCard);
    }
  }

  roster.forEach(memberItem => {
    const card = document.createElement('div');
    card.className = 'member-card';
    if (memberItem.isLeave) card.classList.add('has-leave');
    if (memberItem.isSubstitute) card.classList.add('has-substitute');

    const shiftInfo = SHIFT_DETAILS[memberItem.baseShift];
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
        <button type="button" class="leave-toggle-btn ${memberItem.isLeave ? 'active' : ''}" data-member-id="${memberItem.memberId}" data-member-name="${memberItem.name}">
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

    // 만약 이 사람이 휴가 중이고 대근자가 지정되어 있다면 ➡️ 대근자 배정/해제 바 표시
    if (memberItem.isLeave) {
      const leaveInfo = getMemberLeaveInfo(dateStr, memberItem.name);
      const customSubName = leaveInfo?.customSubName || memberItem.customSubName;
      const subMemberName = leaveInfo?.subMemberName || memberItem.subMemberName;
      const currentSubId = memberItem.substituteId;
      const subMember = roster.find(r => (subMemberName && r.name === subMemberName) || (currentSubId !== null && r.memberId === currentSubId));

      if (customSubName || subMember) {
        const subBox = document.createElement('div');
        subBox.className = 'substitute-control-box';
        const displayName = customSubName ? `${customSubName} (수기 입력)` : subMember.name;
        subBox.innerHTML = `
          <div class="sub-status-row">
            <span><strong class="sub-tag">대근자:</strong> <span class="sub-name-highlight">${displayName}</span> <span class="sub-type-badge">${memberItem.baseShift}근무 대근</span></span>
            <button type="button" class="btn-mini-cancel btn-cancel-sub" data-for-member="${memberItem.memberId}" data-for-name="${memberItem.name}">대근 해제</button>
          </div>
        `;
        card.appendChild(subBox);
      }
      // 미배정 상태일 때는 상단 전용 카드로 올라갔으므로 휴가자 카드 아래에는 아무것도 붙이지 않고 깔끔하게 유지!
    }

    container.appendChild(card);
  });

  // 이벤트 바인딩: 휴가 토글 버튼 (아이폰 고스트 클릭 및 2인 동시 선택 완벽 차단)
  container.querySelectorAll('.leave-toggle-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (!canExecuteAction(350)) return;
      const targetBtn = e.target.closest('.leave-toggle-btn');
      if (!targetBtn) return;
      const memberId = parseInt(targetBtn.dataset.memberId);
      const memberName = targetBtn.dataset.memberName;
      toggleLeave(dateStr, memberId, memberName);
    });
  });

  // 이벤트 바인딩: 대근 해제 버튼
  container.querySelectorAll('.btn-cancel-sub').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (!canExecuteAction(350)) return;
      const targetBtn = e.target.closest('.btn-cancel-sub');
      if (!targetBtn) return;
      const forMemberId = parseInt(targetBtn.dataset.forMember);
      const forName = targetBtn.dataset.forName;
      cancelSubstitute(dateStr, forMemberId, forName);
    });
  });

  // 이벤트 바인딩: 대근 선택 드롭다운 (수동 선택 / 직접 입력)
  container.querySelectorAll('.select-sub-manual').forEach(sel => {
    sel.addEventListener('change', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (!canExecuteAction(300)) return;
      const forMemberId = parseInt(e.target.dataset.forMember);
      const forName = e.target.dataset.forName;
      const val = e.target.value;
      const customRow = container.querySelector(`.sub-custom-row[data-for-member="${forMemberId}"]`);

      if (val === 'CUSTOM_INPUT') {
        if (customRow) {
          customRow.style.display = 'flex';
          const input = customRow.querySelector('.input-sub-custom');
          if (input) input.focus();
        }
      } else {
        if (customRow) {
          customRow.style.display = 'none';
        }
        const chosenSubId = val === '' ? null : parseInt(val);
        manuallySetSubstitute(dateStr, forMemberId, chosenSubId, forName);
      }
    });
  });

  // 이벤트 바인딩: 기타/외부 대근자 직접 입력 버튼
  container.querySelectorAll('.btn-sub-custom-save').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (!canExecuteAction(350)) return;
      const targetBtn = e.target.closest('.btn-sub-custom-save');
      if (!targetBtn) return;
      const forMemberId = parseInt(targetBtn.dataset.forMember);
      const forName = targetBtn.dataset.forName;
      const input = container.querySelector(`.input-sub-custom[data-for-member="${forMemberId}"]`);
      if (input) {
        manuallySetCustomSubstitute(dateStr, forMemberId, input.value, forName);
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

// 휴가 신청/취소 토글 (근무자 이름 기반 안전 등록 & 터치 고스트 클릭 방지)
function toggleLeave(dateStr, memberId, memberNameHint = null) {
  const member = getMemberById(memberId) || (memberNameHint ? getMemberByName(memberNameHint) : null);
  const memberName = member ? member.name : (memberNameHint || String(memberId));

  markDateModified(dateStr);
  if (!appState.leaves[dateStr]) {
    appState.leaves[dateStr] = {};
  }

  const current = getMemberLeaveInfo(dateStr, member || memberName);
  if (current && current.isLeave) {
    // 휴가 취소
    delete appState.leaves[dateStr][memberName];
    if (member) delete appState.leaves[dateStr][member.id];
    delete appState.leaves[dateStr][memberId];
    if (Object.keys(appState.leaves[dateStr]).length === 0) {
      delete appState.leaves[dateStr];
    }
  } else {
    // 휴가 등록 (이름 및 대근자명 확실히 보장)
    appState.leaves[dateStr][memberName] = {
      isLeave: true,
      memberName: memberName,
      subMemberName: null,
      subId: null,
      isManual: false,
      customSubName: null
    };
  }

  appState.lastLocalUpdated = Date.now();
  saveState();

  // 비동기 렌더링으로 터치 이벤트 루프 분리 -> 아이폰 유령 더블 클릭 완벽 방어
  setTimeout(() => {
    renderDayModalBody(dateStr);
    renderCalendar();
  }, 40);
}

// 대근 해제
function cancelSubstitute(dateStr, forMemberId, forNameHint = null) {
  const member = getMemberById(forMemberId) || (forNameHint ? getMemberByName(forNameHint) : null);
  const memberName = member ? member.name : (forNameHint || String(forMemberId));

  const leaveItem = getMemberLeaveInfo(dateStr, member || memberName);
  if (!leaveItem) return;

  markDateModified(dateStr);
  leaveItem.subId = null;
  leaveItem.subMemberName = null;
  leaveItem.customSubName = null;
  leaveItem.isManual = true;

  appState.lastLocalUpdated = Date.now();
  saveState();

  setTimeout(() => {
    renderDayModalBody(dateStr);
    renderCalendar();
  }, 40);
}

// 대근 수기 지정 (내부 멤버)
function manuallySetSubstitute(dateStr, forMemberId, chosenSubId, forNameHint = null) {
  const member = getMemberById(forMemberId) || (forNameHint ? getMemberByName(forNameHint) : null);
  const memberName = member ? member.name : (forNameHint || String(forMemberId));

  const leaveItem = getMemberLeaveInfo(dateStr, member || memberName);
  if (!leaveItem) return;

  markDateModified(dateStr);

  const subMember = getMemberById(chosenSubId);
  leaveItem.subId = chosenSubId;
  leaveItem.subMemberName = subMember ? subMember.name : null;
  leaveItem.customSubName = null;
  leaveItem.isManual = true;

  appState.lastLocalUpdated = Date.now();
  saveState();

  setTimeout(() => {
    renderDayModalBody(dateStr);
    renderCalendar();
  }, 40);
}

// 대근 수기 직접 입력 (외부/기타 인원)
function manuallySetCustomSubstitute(dateStr, forMemberId, customName, forNameHint = null) {
  const member = getMemberById(forMemberId) || (forNameHint ? getMemberByName(forNameHint) : null);
  const memberName = member ? member.name : (forNameHint || String(forMemberId));

  const leaveItem = getMemberLeaveInfo(dateStr, member || memberName);
  if (!leaveItem) return;

  const trimmed = (customName || '').trim();
  if (!trimmed) {
    alert('대근자 이름을 입력해 주세요.');
    return;
  }
  markDateModified(dateStr);

  leaveItem.subId = 'CUSTOM';
  leaveItem.subMemberName = trimmed;
  leaveItem.customSubName = trimmed;
  leaveItem.isManual = true;

  appState.lastLocalUpdated = Date.now();
  saveState();

  setTimeout(() => {
    renderDayModalBody(dateStr);
    renderCalendar();
  }, 40);
}

function closeDayModal() {
  document.getElementById('day-modal-overlay').classList.remove('active');
  appState.activeModalDate = null;
}

// ==========================================
// 7. 상단 필터 및 하단 통계 바
// ==========================================
const LAST_SELECTED_MEMBER_KEY = 'SONGCHUL_LAST_SELECTED_MEMBER';

function saveSelectedMemberPref(val) {
  try {
    localStorage.setItem(LAST_SELECTED_MEMBER_KEY, String(val));
  } catch (e) {}
}

function loadSelectedMemberPref() {
  try {
    const saved = localStorage.getItem(LAST_SELECTED_MEMBER_KEY);
    if (!saved || saved === 'ALL') {
      appState.selectedMemberId = 'ALL';
      return;
    }
    // 이름으로 먼저 멤버 검색 (순서 변경/재배치 시에도 안전)
    const memByName = getMemberByName(saved);
    if (memByName) {
      appState.selectedMemberId = memByName.id;
      return;
    }
    // ID 숫자로 폴백 검색
    const memById = getMemberById(parseInt(saved, 10));
    if (memById) {
      appState.selectedMemberId = memById.id;
      return;
    }
    appState.selectedMemberId = 'ALL';
  } catch (e) {
    appState.selectedMemberId = 'ALL';
  }
}

function renderMemberFilterChips() {
  const container = document.getElementById('member-filter-container');
  if (!container) return;
  container.innerHTML = '';

  // 1) 전체 근무 칩
  const allChip = document.createElement('button');
  allChip.type = 'button';
  allChip.className = `filter-chip ${appState.selectedMemberId === 'ALL' ? 'active' : ''}`;
  allChip.textContent = '전체 근무';
  allChip.dataset.filterType = 'ALL';
  allChip.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (!canExecuteAction(200)) return;
    appState.selectedMemberId = 'ALL';
    saveSelectedMemberPref('ALL');
    updateFilterChipsActiveState();
    renderCalendar();
  });
  container.appendChild(allChip);

  // 2) 개별 멤버 4명 칩
  appState.members.forEach(m => {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = `filter-chip ${appState.selectedMemberId === m.id ? 'active' : ''}`;
    chip.textContent = m.name;
    chip.dataset.memberId = m.id;
    chip.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (!canExecuteAction(200)) return;
      appState.selectedMemberId = m.id;
      saveSelectedMemberPref(m.name);
      updateFilterChipsActiveState();
      renderCalendar();
    });
    container.appendChild(chip);
  });
}

function updateFilterChipsActiveState() {
  const container = document.getElementById('member-filter-container');
  if (!container) return;
  const chips = container.querySelectorAll('.filter-chip');
  chips.forEach(chip => {
    if (chip.dataset.filterType === 'ALL') {
      chip.classList.toggle('active', appState.selectedMemberId === 'ALL');
    } else {
      const memId = parseInt(chip.dataset.memberId);
      chip.classList.toggle('active', appState.selectedMemberId === memId);
    }
  });
}

function renderWeeklyStats() {
  updateBottomStats();
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

  // A. '전체 근무' 선택 모드: 주 52시간 근무 현황 미니 그리드
  if (appState.selectedMemberId === 'ALL') {
    let chipsHtml = '';
    appState.members.forEach(m => {
      const hours = Math.round((schedule.memberWeekHours[m.id] || 0) * 10) / 10;
      const remain = Math.round((MAX_WEEKLY_HOURS - hours) * 10) / 10;
      const isOver = hours > MAX_WEEKLY_HOURS;
      
      // 누적 근무시간 강조 색상
      let hoursColor = '#16a34a';
      if (hours >= 45 && hours <= 52) {
        hoursColor = '#d97706';
      } else if (isOver) {
        hoursColor = '#dc2626';
      }

      // 대근 상태 텍스트 및 색상: 52시간 초과 시 '불가' (빨간색), 52시간 이하(0 이상) 시 '+Nh 가능'
      let subStatusText = '';
      let subStatusColor = '';
      if (isOver) {
        subStatusText = '불가';
        subStatusColor = '#dc2626';
      } else {
        subStatusText = `+${remain}h 가능`;
        subStatusColor = (hours >= 45) ? '#d97706' : '#16a34a';
      }

      chipsHtml += `
        <div class="weekly-member-stat-chip ${isOver ? 'is-max' : ''}" data-member-id="${m.id}" title="${m.name} 클릭 시 개인 근무표로 전환">
          <div class="stat-chip-row stat-chip-top">
            <span class="stat-chip-name">${m.name}</span>
            <span class="stat-chip-hours-wrap">
              <span class="stat-chip-hours" style="color:${hoursColor};">${hours}</span>
              <span class="stat-chip-limit">/ 52</span>
            </span>
          </div>
          <div class="stat-chip-row stat-chip-bottom">
            <span class="stat-chip-label">대근</span>
            <span class="stat-chip-sub-status" style="color:${subStatusColor};">${subStatusText}</span>
          </div>
        </div>
      `;
    });

    statsContainer.innerHTML = `
      <div class="weekly-all-header">
        <div class="weekly-title-wrap">
          <strong class="weekly-main-title">주 52시간 근무 현황</strong>
          <span class="weekly-sub-title">(대근 가능 잔여시간)</span>
        </div>
        <span class="weekly-range-tag">📅 주간 ${weekLabel}</span>
      </div>
      <div class="weekly-members-grid">
        ${chipsHtml}
      </div>
    `;

    statsContainer.querySelectorAll('.weekly-member-stat-chip').forEach(chip => {
      chip.addEventListener('click', () => {
        const memId = parseInt(chip.dataset.memberId);
        const targetMem = appState.members.find(x => x.id === memId);
        appState.selectedMemberId = memId;
        saveSelectedMemberPref(targetMem ? targetMem.name : memId);
        renderMemberFilterChips();
        renderCalendar();
      });
    });
  } 
  // B. '특정 1인' 선택 모드: 개인 주간 누적 근무시간 + 52시간 잔여 대근 가능 시간 + 프로그레스 바
  else {
    const member = appState.members.find(m => m.id === appState.selectedMemberId);
    if (!member) return;

    const hours = Math.round((schedule.memberWeekHours[member.id] || 0) * 10) / 10;
    const remain = Math.max(0, Math.round((MAX_WEEKLY_HOURS - hours) * 10) / 10);
    const isOver = hours > MAX_WEEKLY_HOURS;
    const overHours = Math.round((hours - MAX_WEEKLY_HOURS) * 10) / 10;
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
      badgeText = `52시간 초과! (+${overHours}시간 초과)`;
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

  // 주별 이름 열 셀(week-member-header-cell)의 활성 상태 갱신
  // 선택된 날짜(targetDateStr)가 위치한 해당 달력 가로 행(라인)의 이름 열만 또렷하고 선명하게(is-active-week), 다른 행은 은은하게 흐릿하게 표시
  document.querySelectorAll('.week-member-header-cell').forEach(headerCell => {
    const weekStart = headerCell.dataset.weekStart;
    if (!weekStart) return;

    // 해당 행(일요일~토요일 7일간)의 날짜 범위 계산
    const sunD = new Date(weekStart + 'T00:00:00');
    const satD = new Date(sunD);
    satD.setDate(sunD.getDate() + 6);
    const satStr = formatDate(satD);

    const isThisRowActive = (targetDateStr >= weekStart && targetDateStr <= satStr);

    if (isThisRowActive) {
      headerCell.classList.add('is-active-week');
    } else {
      headerCell.classList.remove('is-active-week');
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
// 8. 설정 모달 (멤버 이름 및 기본 순번, 비밀번호 잠금 관리)
// ==========================================
function setSettingsFieldsDisabled(disabled) {
  const refDateInput = document.getElementById('setting-ref-date');
  if (refDateInput) refDateInput.disabled = disabled;

  document.querySelectorAll('.setup-input-name').forEach(el => el.disabled = disabled);
  document.querySelectorAll('.setup-select-shift').forEach(el => el.disabled = disabled);

  const timeIlInput = document.getElementById('setting-time-il');
  const timeYaInput = document.getElementById('setting-time-ya');
  const timeJoInput = document.getElementById('setting-time-jo');
  if (timeIlInput) timeIlInput.disabled = disabled;
  if (timeYaInput) timeYaInput.disabled = disabled;
  if (timeJoInput) timeJoInput.disabled = disabled;

  const ruleIlInput = document.getElementById('setting-rule-il');
  const ruleYaInput = document.getElementById('setting-rule-ya');
  const ruleJoInput = document.getElementById('setting-rule-jo');
  const ruleYajoInput = document.getElementById('setting-rule-yajo');
  if (ruleIlInput) ruleIlInput.disabled = disabled;
  if (ruleYaInput) ruleYaInput.disabled = disabled;
  if (ruleJoInput) ruleJoInput.disabled = disabled;
  if (ruleYajoInput) ruleYajoInput.disabled = disabled;
}

function openSettingsModal() {
  ensureFourMembers();
  isSettingsEditMode = false;

  // 비밀번호 인증 상자 초기화 및 숨김
  const authBox = document.getElementById('setting-auth-box');
  if (authBox) authBox.style.display = 'none';
  const pwdInput = document.getElementById('setting-admin-pwd');
  if (pwdInput) pwdInput.value = '';
  const errorMsg = document.getElementById('setting-auth-error');
  if (errorMsg) errorMsg.style.display = 'none';

  // 메인 버튼 기본 상태: "변경"
  const saveBtn = document.getElementById('btn-save-settings');
  if (saveBtn) {
    saveBtn.textContent = '변경';
    saveBtn.classList.remove('is-saving-mode');
  }

  // 기준일자 및 근무시간 필드 세팅
  const refDateInput = document.getElementById('setting-ref-date');
  if (refDateInput) refDateInput.value = appState.refDate || DEFAULT_REF_DATE;

  const timeIlInput = document.getElementById('setting-time-il');
  const timeYaInput = document.getElementById('setting-time-ya');
  const timeJoInput = document.getElementById('setting-time-jo');
  if (timeIlInput) timeIlInput.value = appState.shiftTimes?.['일'] || '09:00~18:00';
  if (timeYaInput) timeYaInput.value = appState.shiftTimes?.['야'] || '18:00~24:00';
  if (timeJoInput) timeJoInput.value = appState.shiftTimes?.['조'] || '00:00~09:00';

  // 대근 자동 배정 규칙 필드 세팅
  const subRules = appState.subRules || DEFAULT_SUB_RULES;
  const ruleIlInput = document.getElementById('setting-rule-il');
  const ruleYaInput = document.getElementById('setting-rule-ya');
  const ruleJoInput = document.getElementById('setting-rule-jo');
  const ruleYajoInput = document.getElementById('setting-rule-yajo');
  if (ruleIlInput) ruleIlInput.value = subRules['일'] || '비';
  if (ruleYaInput) ruleYaInput.value = subRules['야'] || '일';
  if (ruleJoInput) ruleJoInput.value = subRules['조'] || '비';
  if (ruleYajoInput) ruleYajoInput.value = subRules['야조'] || '조';

  // 4인 멤버 행 렌더링 (기본 비활성화 disabled 적용)
  const rowsContainer = document.getElementById('members-setup-rows');
  rowsContainer.innerHTML = '';

  appState.members.forEach((m, idx) => {
    const row = document.createElement('div');
    row.className = 'setup-row';
    row.innerHTML = `
      <span class="col-num-text">#${idx + 1}</span>
      <input type="text" class="setup-input-name" data-id="${m.id}" value="${m.name}" placeholder="이름" maxlength="6" disabled>
      <select class="setup-select-shift" data-id="${m.id}" disabled>
        <option value="일" ${m.baseShift === '일' ? 'selected' : ''}>일근</option>
        <option value="야" ${m.baseShift === '야' ? 'selected' : ''}>야근</option>
        <option value="조" ${m.baseShift === '조' ? 'selected' : ''}>조근</option>
        <option value="비" ${m.baseShift === '비' ? 'selected' : ''}>비번</option>
      </select>
    `;
    rowsContainer.appendChild(row);
  });

  // 모든 인풋 비활성화 잠금
  setSettingsFieldsDisabled(true);

  document.getElementById('settings-modal-overlay').classList.add('active');
}

function closeSettingsModal() {
  isSettingsEditMode = false;
  const authBox = document.getElementById('setting-auth-box');
  if (authBox) authBox.style.display = 'none';
  const saveBtn = document.getElementById('btn-save-settings');
  if (saveBtn) {
    saveBtn.textContent = '변경';
    saveBtn.classList.remove('is-saving-mode');
  }
  setSettingsFieldsDisabled(true);
  document.getElementById('settings-modal-overlay').classList.remove('active');
}

function showAdminAuthBox() {
  const authBox = document.getElementById('setting-auth-box');
  const pwdInput = document.getElementById('setting-admin-pwd');
  const errorMsg = document.getElementById('setting-auth-error');
  if (!authBox || !pwdInput) return;

  authBox.style.display = 'flex';
  pwdInput.value = '';
  if (errorMsg) errorMsg.style.display = 'none';
  pwdInput.focus();
}

function hideAdminAuthBox() {
  const authBox = document.getElementById('setting-auth-box');
  const pwdInput = document.getElementById('setting-admin-pwd');
  const errorMsg = document.getElementById('setting-auth-error');
  if (authBox) authBox.style.display = 'none';
  if (pwdInput) pwdInput.value = '';
  if (errorMsg) errorMsg.style.display = 'none';
}

function verifyAdminPassword() {
  const pwdInput = document.getElementById('setting-admin-pwd');
  const errorMsg = document.getElementById('setting-auth-error');
  const saveBtn = document.getElementById('btn-save-settings');
  if (!pwdInput) return;

  const entered = pwdInput.value.trim();
  if (entered === ADMIN_PASSWORD) {
    // 인증 성공: 편집 모드 전환
    isSettingsEditMode = true;
    hideAdminAuthBox();
    setSettingsFieldsDisabled(false);

    if (saveBtn) {
      saveBtn.textContent = '변경 저장';
      saveBtn.classList.add('is-saving-mode');
    }

    const firstInput = document.querySelector('.setup-input-name');
    if (firstInput) firstInput.focus();

    showToast('송출부장님 권한 인증 완료: 변경 후 [변경 저장]을 누르세요.');
  } else {
    // 비밀번호 불일치
    if (errorMsg) errorMsg.style.display = 'block';
    pwdInput.select();
  }
}

function saveSettings() {
  if (!isSettingsEditMode) {
    // 변경 모드가 아닐 때 변경 버튼을 누른 경우: 비밀번호 입력 상자 노출
    showAdminAuthBox();
    return;
  }

  const refDateInput = document.getElementById('setting-ref-date');
  const newRefDate = refDateInput?.value?.trim();
  if (!newRefDate || !/^\d{4}-\d{2}-\d{2}$/.test(newRefDate)) {
    showToast('유효한 기준일자(YYYY-MM-DD)를 입력해 주세요.');
    if (refDateInput) refDateInput.focus();
    return;
  }

  appState.refDate = newRefDate;

  const nameInputs = document.querySelectorAll('.setup-input-name');
  const shiftSelects = document.querySelectorAll('.setup-select-shift');

  const updatedMembers = [];
  nameInputs.forEach((input, idx) => {
    const newName = input.value.trim() || `멤버${idx + 1}`;
    const newShift = shiftSelects[idx]?.value || '일';
    updatedMembers.push({
      id: idx,
      name: newName,
      baseShift: newShift
    });
  });

  appState.members = updatedMembers;

  // 기기별 로컬 멤버 순서(배치) 영구 보존
  try {
    localStorage.setItem('SONGCHUL_LOCAL_MEMBER_ORDER', JSON.stringify(appState.members.map(m => m.name)));
  } catch (e) {}

  // 근무 형태별 시간 수기 변경값 반영
  const timeIl = document.getElementById('setting-time-il')?.value?.trim() || '09:00~18:00';
  const timeYa = document.getElementById('setting-time-ya')?.value?.trim() || '18:00~24:00';
  const timeJo = document.getElementById('setting-time-jo')?.value?.trim() || '00:00~09:00';

  updateShiftTimes({
    '일': timeIl,
    '야': timeYa,
    '조': timeJo
  });

  // 대근 자동 배정 규칙 수기 변경값 반영
  const ruleIl = document.getElementById('setting-rule-il')?.value || '비';
  const ruleYa = document.getElementById('setting-rule-ya')?.value || '일';
  const ruleJo = document.getElementById('setting-rule-jo')?.value || '비';
  const ruleYajo = document.getElementById('setting-rule-yajo')?.value || '조';

  appState.subRules = {
    '일': ruleIl,
    '야': ruleYa,
    '조': ruleJo,
    '야조': ruleYajo
  };

  // [핵심 기능] 기준일자별 근무자 변경 이력 타임라인 관리
  // 사용자 요구: 기준일자 이전의 과거 기록은 보존하고, 새 기준일자 당일부터 미래의 모든 날짜는 지금 변경된 새 근무자와 근무형태로 100% 덮어쓰기 갱신
  if (!Array.isArray(appState.scheduleHistory)) {
    appState.scheduleHistory = [];
  }

  const effectiveKey = newRefDate;
  const historyItem = {
    effectiveDate: effectiveKey,
    refDate: effectiveKey,
    members: JSON.parse(JSON.stringify(updatedMembers)),
    shiftTimes: JSON.parse(JSON.stringify(appState.shiftTimes))
  };

  // 새 기준일자 이전(effectiveDate < effectiveKey)의 과거 이력만 남기고,
  // 새 기준일자 이후(effectiveDate >= effectiveKey)의 기존 이력은 완전히 정리하여 방금 설정한 새 설정으로 100% 통합
  appState.scheduleHistory = appState.scheduleHistory.filter(h => h && h.effectiveDate < effectiveKey);
  appState.scheduleHistory.push(historyItem);
  appState.scheduleHistory.sort((a, b) => a.effectiveDate.localeCompare(b.effectiveDate));

  // [핵심] 새 기준일자 이후(dateStr >= effectiveKey)의 기존 휴가/대근/수동배정 잔여 데이터 싹 정리
  // (기존에 다른 사람이 대근/휴가로 표시되어 있던 것을 새 기준일자 이후는 방금 변경된 새 설정 순번대로 완전히 갱신)
  // 단, 기준일자 이전(dateStr < effectiveKey)의 과거 근무 및 휴가 기록은 100% 온전히 보존
  if (appState.leaves && typeof appState.leaves === 'object') {
    const cleanedLeaves = {};
    Object.keys(appState.leaves).forEach(dateStr => {
      if (dateStr < effectiveKey) {
        cleanedLeaves[dateStr] = appState.leaves[dateStr];
      }
    });
    appState.leaves = cleanedLeaves;
  }

  // 주간 스케줄 캐시 즉시 완전 초기화 (새 기준일자 이후 미래 달력 전면 갱신 보장)
  invalidateScheduleCache();

  // 현재 설정을 기본값(CUSTOM_DEFAULT_KEY)으로도 함께 안전하게 저장
  try {
    localStorage.setItem(CUSTOM_DEFAULT_KEY, JSON.stringify({
      members: appState.members,
      refDate: appState.refDate,
      font: appState.font,
      shiftTimes: appState.shiftTimes,
      subRules: appState.subRules,
      scheduleHistory: appState.scheduleHistory
    }));
  } catch (e) {}

  // 저장 완료 후 다시 비활성화 상태로 복귀
  isSettingsEditMode = false;
  setSettingsFieldsDisabled(true);
  const saveBtn = document.getElementById('btn-save-settings');
  if (saveBtn) {
    saveBtn.textContent = '변경';
    saveBtn.classList.remove('is-saving-mode');
  }

  // 클라우드 및 로컬 전체 동기화 저장 (isFullSync = true로 전달하여 서버의 과거 미래 잔여 데이터 안전 덮어쓰기)
  saveState(true);
  closeSettingsModal();

  // 현재 선택된 멤버 필터가 변경된 4인 멤버 목록에 없으면 '전체 근무(ALL)'로 리셋
  if (appState.selectedMemberId !== 'ALL' && !appState.members.some(m => m.id === appState.selectedMemberId)) {
    appState.selectedMemberId = 'ALL';
    saveSelectedMemberPref('ALL');
  }

  // 상단 필터 칩, 달력, 하단 주간 52시간 통계 바 즉시 리렌더링
  renderMemberFilterChips();
  renderCalendar();
  updateBottomStats();
  showToast('설정 및 기준일자 이후 근무표가 새 근무자로 갱신되었습니다.');
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

// HUD 스타일 둥근 정사각형 알림 토스트 (스마트폰 및 PC 화면 120px 라운드 정사각형 완벽 보장)
function showToast(message) {
  let toast = document.getElementById('app-toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'app-toast';
    toast.className = 'app-toast';
    document.body.appendChild(toast);
  }

  let text = String(message || '').trim();
  let icon = '🔔';
  let title = '근무표 알림';
  let desc = text;

  if (text.includes('팀원이 변경한')) {
    icon = '🔔';
    title = '근무표 반영';
    desc = '팀원 변경사항이<br>반영되었습니다';
  } else if (text.includes('네트워크가 복구')) {
    icon = '🌐';
    title = '네트워크 복구';
    desc = '클라우드 최신본과<br>동기화되었습니다';
  } else if (text.includes('동기화') || text.includes('정답')) {
    icon = '🔄';
    title = '동기화 완료';
    desc = '최신 근무표로<br>일치되었습니다';
  } else if (text.startsWith('🔔') || text.startsWith('🌐') || text.startsWith('🔄')) {
    icon = text.substring(0, 2);
    desc = text.substring(2).trim();
  }

  // 외부 CSS 캐시 여부와 무관하게 브라우저 렌더링 1순위로 100% 강제되는 인라인 스타일
  toast.style.cssText = `
    position: fixed !important;
    top: 50% !important;
    left: 50% !important;
    transform: translate(-50%, -50%) scale(0.85) !important;
    width: 120px !important;
    height: 120px !important;
    min-width: 120px !important;
    max-width: 120px !important;
    min-height: 120px !important;
    max-height: 120px !important;
    aspect-ratio: 1 / 1 !important;
    background: rgba(15, 23, 42, 0.94) !important;
    backdrop-filter: blur(16px) !important;
    -webkit-backdrop-filter: blur(16px) !important;
    color: #ffffff !important;
    border-radius: 24px !important;
    box-shadow: 0 16px 36px rgba(0, 0, 0, 0.4), 0 0 0 1px rgba(255, 255, 255, 0.18) !important;
    display: flex !important;
    align-items: center !important;
    justify-content: center !important;
    z-index: 999999 !important;
    opacity: 0 !important;
    visibility: hidden !important;
    pointer-events: none !important;
    transition: opacity 0.22s ease, transform 0.22s ease, visibility 0.22s !important;
    text-align: center !important;
    box-sizing: border-box !important;
    padding: 10px !important;
    margin: 0 !important;
  `;

  toast.innerHTML = `
    <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;width:100%;height:100%;gap:3px;box-sizing:border-box;">
      <div style="font-size:26px;line-height:1;margin-bottom:2px;filter:drop-shadow(0 2px 4px rgba(0,0,0,0.3));">${icon}</div>
      <div style="font-size:12.5px;font-weight:700;color:#ffffff;letter-spacing:-0.2px;white-space:nowrap;">${title}</div>
      <div style="font-size:10.5px;font-weight:500;color:#94a3b8;line-height:1.25;letter-spacing:-0.2px;word-break:keep-all;">${desc}</div>
    </div>
  `;

  // 토스트 표시 애니메이션 실행
  requestAnimationFrame(() => {
    toast.style.opacity = '1';
    toast.style.visibility = 'visible';
    toast.style.transform = 'translate(-50%, -50%) scale(1)';
  });

  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.visibility = 'hidden';
    toast.style.transform = 'translate(-50%, -50%) scale(0.85)';
  }, 1900);
}

// ==========================================
// 10. 이벤트 리스너 등록 및 초기화
// ==========================================
document.addEventListener('DOMContentLoaded', () => {
  loadState();
  loadSelectedMemberPref();
  initNotificationSetting();
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

  // 알림음 및 시스템 알림 문자 수신 ON/OFF 토글 버튼 (초록색 = 수신 켜짐 / 회색 = 수신 안 함)
  const btnSoundToggle = document.getElementById('btn-sound-toggle');
  if (btnSoundToggle) {
    btnSoundToggle.addEventListener('click', () => {
      toggleNotificationSetting();
    });
  }

  // 설정 모달 열기/닫기/저장
  document.getElementById('btn-settings').addEventListener('click', openSettingsModal);
  document.getElementById('btn-close-settings').addEventListener('click', closeSettingsModal);
  document.getElementById('settings-modal-overlay').addEventListener('click', (e) => {
    if (e.target.id === 'settings-modal-overlay') closeSettingsModal();
  });
  document.getElementById('btn-save-settings').addEventListener('click', saveSettings);

  // 송출부장님 전용 권한 인증 버튼 및 키보드 엔터 이벤트
  const btnAuthConfirm = document.getElementById('btn-auth-confirm');
  if (btnAuthConfirm) {
    btnAuthConfirm.addEventListener('click', verifyAdminPassword);
  }

  const btnAuthCancel = document.getElementById('btn-auth-cancel');
  if (btnAuthCancel) {
    btnAuthCancel.addEventListener('click', hideAdminAuthBox);
  }

  const pwdInput = document.getElementById('setting-admin-pwd');
  if (pwdInput) {
    pwdInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        verifyAdminPassword();
      }
    });
  }

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
