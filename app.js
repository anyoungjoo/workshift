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

// 대근 자동 배정 기본 규칙 (일근 휴가 ➔ 비번자, 오전/오후 일근 반차 ➔ 비번자, 조근 휴가 ➔ 비번자, 야근 휴가 ➔ 일근자, 야조 휴가 ➔ 조근자)
const DEFAULT_SUB_RULES = {
  '일': '비',
  '오전일반': '비',
  '오후일반': '비',
  '조': '비',
  '야': '일',
  '야조': '조'
};

// 근무 시간대 우선순위 (00~09시 조근: 1 -> 09~18시 일근: 2 -> 18~24시 야근: 3)
const SHIFT_CHRONO_ORDER = {
  '조': 1,
  '일': 2,
  '야': 3,
  '비': 99
};

// 특정 근무자의 당일 유효 근무 목록을 시간 순서대로 정렬하여 반환 (원근무 + 대근 결합 처리)
function getMemberActiveShifts(rosterItem) {
  const shifts = [];
  if (!rosterItem || rosterItem.isLeave) return shifts;

  // 1) 본인 원래 근무 (휴가가 아니고 비번이 아닌 경우)
  if (!rosterItem.isLeave && rosterItem.baseShift && rosterItem.baseShift !== '비') {
    shifts.push({
      type: rosterItem.baseShift,
      isSub: false,
      name: SHIFT_DETAILS[rosterItem.baseShift]?.name || `${rosterItem.baseShift}근`,
      time: SHIFT_DETAILS[rosterItem.baseShift]?.time || '',
      order: SHIFT_CHRONO_ORDER[rosterItem.baseShift] || 50
    });
  }

  // 2) 대근 근무 (수기/자동 지정된 모든 대근 반영)
  if (rosterItem.isSubstitute) {
    if (Array.isArray(rosterItem.assignedSubs) && rosterItem.assignedSubs.length > 0) {
      rosterItem.assignedSubs.forEach(s => {
        const leaveType = s.leaveType || '전일';
        let subName = SHIFT_DETAILS[s.shiftType]?.name || `${s.shiftType}근`;
        let subLabel = s.shiftType;
        if (s.shiftType === '일') {
          if (leaveType === '오전반차') {
            subName = '오전일근';
            subLabel = '오전일근';
          } else if (leaveType === '오후반차') {
            subName = '오후일근';
            subLabel = '오후일근';
          }
        }
        shifts.push({
          type: s.shiftType,
          subLabel: subLabel,
          leaveType: leaveType,
          isSub: true,
          forMemberId: s.forMemberId,
          forName: s.forName,
          name: subName,
          time: SHIFT_DETAILS[s.shiftType]?.time || '',
          order: SHIFT_CHRONO_ORDER[s.shiftType] || 50
        });
      });
    } else if (rosterItem.subForShiftType) {
      const leaveType = rosterItem.subForLeaveType || '전일';
      let subName = SHIFT_DETAILS[rosterItem.subForShiftType]?.name || `${rosterItem.subForShiftType}근`;
      let subLabel = rosterItem.subForShiftType;
      if (rosterItem.subForShiftType === '일') {
        if (leaveType === '오전반차') {
          subName = '오전일근';
          subLabel = '오전일근';
        } else if (leaveType === '오후반차') {
          subName = '오후일근';
          subLabel = '오후일근';
        }
      }
      shifts.push({
        type: rosterItem.subForShiftType,
        subLabel: subLabel,
        leaveType: leaveType,
        isSub: true,
        forMemberId: rosterItem.subForMemberId,
        name: subName,
        time: SHIFT_DETAILS[rosterItem.subForShiftType]?.time || '',
        order: SHIFT_CHRONO_ORDER[rosterItem.subForShiftType] || 50
      });
    }
  }

  // 시간 우선순위(조 -> 일 -> 야)에 따라 오름차순 정렬
  shifts.sort((a, b) => a.order - b.order);
  return shifts;
}

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
  { id: 0, name: '이준희', empNo: '', phone: '', email: '', baseShift: '일' },
  { id: 1, name: '최혜진', empNo: '', phone: '', email: '', baseShift: '비' },
  { id: 2, name: '오승연', empNo: '', phone: '', email: '', baseShift: '조' },
  { id: 3, name: '안영주', empNo: '', phone: '', email: '', baseShift: '야' }
];

// 관리자 (송출부장) 및 정비팀 기본 데이터
const DEFAULT_CHIEF_NAME = '우건제';
const DEFAULT_CHIEF_EMPNO = '';
const DEFAULT_CHIEF_PHONE = '';
const DEFAULT_CHIEF_EMAIL = '';
const DEFAULT_MAINTENANCE_MEMBERS = [
  { id: 0, role: '송신소', name: '조성기', empNo: '', phone: '', email: '' },
  { id: 1, role: '송신소', name: '정현식', empNo: '', phone: '', email: '' },
  { id: 2, role: 'TVR', name: '김천일', empNo: '', phone: '', email: '' },
  { id: 3, role: 'TVR', name: '이명주', empNo: '', phone: '', email: '' }
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

// ==========================================
// 사람(이름) 고유 연락처 레지스트리 유틸리티 (Person-bound)
// 연락처(사번, 전화번호, 이메일)는 슬롯 자리가 아닌 '사람'에게 종속된 고유값입니다.
// 자리가 바뀌거나 이동해도 사람 이름을 따라 함께 이동합니다.
// ==========================================

function getContactForPerson(name) {
  if (!name || typeof name !== 'string') return { empNo: '', phone: '', email: '' };
  const trimmed = name.trim();
  if (!trimmed) return { empNo: '', phone: '', email: '' };

  // 1순위: 이름 키 기반 연락처 레지스트리 조회
  if (appState.personContacts && appState.personContacts[trimmed]) {
    const c = appState.personContacts[trimmed];
    return {
      empNo: c.empNo || '',
      phone: c.phone || '',
      email: c.email || ''
    };
  }

  // 2순위: 현재 송출센터 4인 슬롯에서 해당 이름 탐색
  if (Array.isArray(appState.members)) {
    const m = appState.members.find(x => x && x.name === trimmed);
    if (m && (m.empNo || m.phone || m.email)) {
      return { empNo: m.empNo || '', phone: m.phone || '', email: m.email || '' };
    }
  }

  // 3순위: 정비팀 슬롯에서 해당 이름 탐색
  if (Array.isArray(appState.maintenanceMembers)) {
    const m = appState.maintenanceMembers.find(x => x && x.name === trimmed);
    if (m && (m.empNo || m.phone || m.email)) {
      return { empNo: m.empNo || '', phone: m.phone || '', email: m.email || '' };
    }
  }

  // 4순위: 송출부장 이름 일치 여부 확인
  if (appState.chiefName === trimmed && (appState.chiefEmpNo || appState.chiefPhone || appState.chiefEmail)) {
    return {
      empNo: appState.chiefEmpNo || '',
      phone: appState.chiefPhone || '',
      email: appState.chiefEmail || ''
    };
  }

  // 5순위: 과거 scheduleHistory 이력에서 해당 이름의 연락처 탐색
  if (Array.isArray(appState.scheduleHistory)) {
    for (let i = appState.scheduleHistory.length - 1; i >= 0; i--) {
      const h = appState.scheduleHistory[i];
      if (h) {
        if (Array.isArray(h.members)) {
          const hm = h.members.find(x => x && x.name === trimmed);
          if (hm && (hm.empNo || hm.phone || hm.email)) {
            return { empNo: hm.empNo || '', phone: hm.phone || '', email: hm.email || '' };
          }
        }
        if (Array.isArray(h.maintenanceMembers)) {
          const hm = h.maintenanceMembers.find(x => x && x.name === trimmed);
          if (hm && (hm.empNo || hm.phone || hm.email)) {
            return { empNo: hm.empNo || '', phone: hm.phone || '', email: hm.email || '' };
          }
        }
        if (h.chiefName === trimmed && (h.chiefEmpNo || h.chiefPhone || h.chiefEmail)) {
          return { empNo: h.chiefEmpNo || '', phone: h.chiefPhone || '', email: h.chiefEmail || '' };
        }
      }
    }
  }

  return { empNo: '', phone: '', email: '' };
}

function setContactForPerson(name, contact) {
  if (!name || typeof name !== 'string') return;
  const trimmed = name.trim();
  if (!trimmed) return;

  if (!appState.personContacts || typeof appState.personContacts !== 'object') {
    appState.personContacts = {};
  }

  const empNo = (contact?.empNo || '').trim();
  const phone = (contact?.phone || '').trim();
  const email = (contact?.email || '').trim();

  appState.personContacts[trimmed] = { empNo, phone, email };

  // 현재 활성 송출센터 멤버 중 이름 일치자 동기화
  if (Array.isArray(appState.members)) {
    appState.members.forEach(m => {
      if (m && m.name === trimmed) {
        m.empNo = empNo;
        m.phone = phone;
        m.email = email;
      }
    });
  }

  // 정비팀 멤버 중 이름 일치자 동기화
  if (Array.isArray(appState.maintenanceMembers)) {
    appState.maintenanceMembers.forEach(m => {
      if (m && m.name === trimmed) {
        m.empNo = empNo;
        m.phone = phone;
        m.email = email;
      }
    });
  }

  // 송출부장 일치 시 동기화
  if (appState.chiefName === trimmed) {
    appState.chiefEmpNo = empNo;
    appState.chiefPhone = phone;
    appState.chiefEmail = email;
  }

  // 최신 scheduleHistory 항목 동기화
  if (Array.isArray(appState.scheduleHistory) && appState.scheduleHistory.length > 0) {
    const latest = appState.scheduleHistory[appState.scheduleHistory.length - 1];
    if (latest) {
      if (Array.isArray(latest.members)) {
        latest.members.forEach(m => {
          if (m && m.name === trimmed) {
            m.empNo = empNo;
            m.phone = phone;
            m.email = email;
          }
        });
      }
      if (Array.isArray(latest.maintenanceMembers)) {
        latest.maintenanceMembers.forEach(m => {
          if (m && m.name === trimmed) {
            m.empNo = empNo;
            m.phone = phone;
            m.email = email;
          }
        });
      }
      if (latest.chiefName === trimmed) {
        latest.chiefEmpNo = empNo;
        latest.chiefPhone = phone;
        latest.chiefEmail = email;
      }
    }
  }
}

function initPersonContactsRegistry() {
  if (!appState.personContacts || typeof appState.personContacts !== 'object') {
    appState.personContacts = {};
  }
  // 송출센터 멤버에서 연락처 수집
  if (Array.isArray(appState.members)) {
    appState.members.forEach(m => {
      if (m && m.name && (m.empNo || m.phone || m.email)) {
        if (!appState.personContacts[m.name] || (!appState.personContacts[m.name].phone && m.phone)) {
          appState.personContacts[m.name] = { empNo: m.empNo || '', phone: m.phone || '', email: m.email || '' };
        }
      }
    });
  }
  // 정비팀 멤버에서 연락처 수집
  if (Array.isArray(appState.maintenanceMembers)) {
    appState.maintenanceMembers.forEach(m => {
      if (m && m.name && (m.empNo || m.phone || m.email)) {
        if (!appState.personContacts[m.name] || (!appState.personContacts[m.name].phone && m.phone)) {
          appState.personContacts[m.name] = { empNo: m.empNo || '', phone: m.phone || '', email: m.email || '' };
        }
      }
    });
  }
  // 송출부장에서 연락처 수집
  if (appState.chiefName && (appState.chiefEmpNo || appState.chiefPhone || appState.chiefEmail)) {
    if (!appState.personContacts[appState.chiefName] || (!appState.personContacts[appState.chiefName].phone && appState.chiefPhone)) {
      appState.personContacts[appState.chiefName] = {
        empNo: appState.chiefEmpNo || '',
        phone: appState.chiefPhone || '',
        email: appState.chiefEmail || ''
      };
    }
  }
  // 과거 이력에서 연락처 수집
  if (Array.isArray(appState.scheduleHistory)) {
    appState.scheduleHistory.forEach(h => {
      if (h) {
        if (Array.isArray(h.members)) {
          h.members.forEach(m => {
            if (m && m.name && (m.empNo || m.phone || m.email)) {
              if (!appState.personContacts[m.name]) {
                appState.personContacts[m.name] = { empNo: m.empNo || '', phone: m.phone || '', email: m.email || '' };
              }
            }
          });
        }
        if (Array.isArray(h.maintenanceMembers)) {
          h.maintenanceMembers.forEach(m => {
            if (m && m.name && (m.empNo || m.phone || m.email)) {
              if (!appState.personContacts[m.name]) {
                appState.personContacts[m.name] = { empNo: m.empNo || '', phone: m.phone || '', email: m.email || '' };
              }
            }
          });
        }
        if (h.chiefName && (h.chiefEmpNo || h.chiefPhone || h.chiefEmail)) {
          if (!appState.personContacts[h.chiefName]) {
            appState.personContacts[h.chiefName] = { empNo: h.chiefEmpNo || '', phone: h.chiefPhone || '', email: h.chiefEmail || '' };
          }
        }
      }
    });
  }
}

// 4인 순환 교대근무 4인 멤버 슬롯 보장 함수
// 사용자 요청 핵심: 특정 사람 이름이 아닌 '슬롯 위치값(0, 1, 2, 3 = 넘버 1, 2, 3, 4번 자리)' 기반으로 계산 및 보장!
function ensureFourMembers() {
  if (!Array.isArray(appState.members)) {
    appState.members = JSON.parse(JSON.stringify(DEFAULT_MEMBERS));
  }

  // 예전 5인 잔여 데이터 등 필터링
  appState.members = appState.members.filter(m => m && m.name !== '정수진' && m.id !== 4);

  // 정확히 4개 슬롯 (0, 1, 2, 3) 보장 (이름 검색으로 재추가하지 않고 위치 기반으로 보충)
  for (let i = 0; i < 4; i++) {
    if (!appState.members[i]) {
      appState.members[i] = JSON.parse(JSON.stringify(DEFAULT_MEMBERS[i]));
    }
    appState.members[i].id = i;
    if (!appState.members[i].name || !appState.members[i].name.trim()) {
      appState.members[i].name = DEFAULT_MEMBERS[i].name;
    }
    if (!appState.members[i].baseShift) {
      appState.members[i].baseShift = DEFAULT_MEMBERS[i].baseShift;
    }
    // 사람(이름)에 종속된 고유 연락처 자동 보완
    const contact = getContactForPerson(appState.members[i].name);
    if (typeof appState.members[i].empNo === 'undefined' || !appState.members[i].empNo) {
      appState.members[i].empNo = contact.empNo || '';
    }
    if (typeof appState.members[i].phone === 'undefined' || !appState.members[i].phone) {
      appState.members[i].phone = contact.phone || '';
    }
    if (typeof appState.members[i].email === 'undefined' || !appState.members[i].email) {
      appState.members[i].email = contact.email || '';
    }
  }

  // 4인 슬롯 초과분 제거
  if (appState.members.length > 4) {
    appState.members = appState.members.slice(0, 4);
  }

  // 정비팀 (4인) 멤버 및 직무명 슬롯(0~3) 정규화
  if (!Array.isArray(appState.maintenanceMembers) || appState.maintenanceMembers.length !== 4) {
    appState.maintenanceMembers = JSON.parse(JSON.stringify(DEFAULT_MAINTENANCE_MEMBERS));
  } else {
    const defaultRoles = ['송신소', '송신소', 'TVR', 'TVR'];
    const defaultNames = ['조성기', '정현식', '김천일', '이명주'];
    appState.maintenanceMembers.forEach((m, idx) => {
      if (m) {
        m.id = idx;
        m.role = defaultRoles[idx] || m.role || (idx < 2 ? '송신소' : 'TVR');
        if (!m.name || !m.name.trim() || m.name === '이명중') {
          m.name = defaultNames[idx];
        }
        const contact = getContactForPerson(m.name);
        if (typeof m.empNo === 'undefined' || !m.empNo) m.empNo = contact.empNo || '';
        if (typeof m.phone === 'undefined' || !m.phone) m.phone = contact.phone || '';
        if (typeof m.email === 'undefined' || !m.email) m.email = contact.email || '';
      }
    });
  }

  // 송출부장 슬롯 정규화
  if (!appState.chiefName || !appState.chiefName.trim() || appState.chiefName === '송출부장') {
    appState.chiefName = DEFAULT_CHIEF_NAME;
  }
  const chiefContact = getContactForPerson(appState.chiefName);
  if (typeof appState.chiefEmpNo === 'undefined' || !appState.chiefEmpNo) {
    appState.chiefEmpNo = chiefContact.empNo || '';
  }
  if (typeof appState.chiefPhone === 'undefined' || !appState.chiefPhone) {
    appState.chiefPhone = chiefContact.phone || '';
  }
  if (typeof appState.chiefEmail === 'undefined' || !appState.chiefEmail) {
    appState.chiefEmail = chiefContact.email || '';
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
    '오전일반': '비',
    '오후일반': '비',
    '조': '비',
    '야': '일',
    '야조': '조'
  },
  // 업무 공유 메모 ({ 'YYYY-MM-DD': '공유 내용' })
  workMemos: {},
  // 개인 일정 메모 ({ 'YYYY-MM-DD_memberId': { text, alertDay, alertHour, alertMin, updatedAt, fired } })
  personalMemos: {},
  // 정비 근무표 날짜별 근무 형태 ({ 'YYYY-MM-DD': '일'|'야'|'조'|'비'|'휴' })
  maintenanceShifts: {},
  // [신규] 정비팀 5인 슬롯별 개별 근무 형태 ({ [slot]: { 'YYYY-MM-DD': '일'|'야'|'조'|'비'|'휴' } })
  maintMemberShifts: {},
  // 현재 선택된 정비팀 슬롯 (0: 송출부장/우건제, 1: 조성기, 2: 정현식, 3: 김천일, 4: 이명주)
  selectedMaintSlot: 0,
  // 관리자 (송출부장) 및 정비팀 (4인) 멤버 정보
  chiefName: DEFAULT_CHIEF_NAME,
  chiefEmpNo: DEFAULT_CHIEF_EMPNO,
  chiefPhone: DEFAULT_CHIEF_PHONE,
  chiefEmail: DEFAULT_CHIEF_EMAIL,
  maintenanceMembers: JSON.parse(JSON.stringify(DEFAULT_MAINTENANCE_MEMBERS)),
  // 사람(이름) 기준 고유 연락처 저장소 ({ [name]: { empNo, phone, email } })
  personContacts: {}
};

// ==========================================
// 2-1. 정비 개인 근무표 유틸리티
// ==========================================
const MAINTENANCE_ID = 'MAINTENANCE';

// 설정창의 송출부장 및 정비팀 4인 순서대로 5인 슬롯 정보 반환
function getMaintSlotMembers() {
  const chiefName = (appState.chiefName || '').trim() || DEFAULT_CHIEF_NAME || '우건제';
  const m0 = (appState.maintenanceMembers?.[0]?.name || '').trim() || '조성기';
  const m1 = (appState.maintenanceMembers?.[1]?.name || '').trim() || '정현식';
  const m2 = (appState.maintenanceMembers?.[2]?.name || '').trim() || '김천일';
  const m3 = (appState.maintenanceMembers?.[3]?.name || '').trim() || '이명주';

  return [
    { slot: 0, role: '송출부장', defaultName: '우건제', name: chiefName, isChief: true },
    { slot: 1, role: '송신소', defaultName: '조성기', name: m0, isChief: false, maintIdx: 0 },
    { slot: 2, role: '송신소', defaultName: '정현식', name: m1, isChief: false, maintIdx: 1 },
    { slot: 3, role: 'TVR', defaultName: '김천일', name: m2, isChief: false, maintIdx: 2 },
    { slot: 4, role: 'TVR', defaultName: '이명주', name: m3, isChief: false, maintIdx: 3 }
  ];
}

// 현재 활성화된 멤버의 메모/일정 저장 키 반환 (정비팀 5인은 슬롯별로 MAINT_0 ~ MAINT_4 분리)
function getActiveMemberStorageKey() {
  if (appState.selectedMemberId === 'MAINTENANCE') {
    const slot = (appState.selectedMaintSlot !== undefined) ? appState.selectedMaintSlot : 0;
    return `MAINT_${slot}`;
  }
  return appState.selectedMemberId;
}

// 특정 슬롯(0~4) 또는 현재 슬롯의 특정 일자 정비 근무 형태 조회
function getMaintenanceShiftForDate(dateStr, slot = null) {
  const currentSlot = (slot !== null && slot !== undefined) 
    ? slot 
    : (appState.selectedMaintSlot !== undefined ? appState.selectedMaintSlot : 0);

  if (appState.maintMemberShifts && appState.maintMemberShifts[currentSlot] && appState.maintMemberShifts[currentSlot][dateStr]) {
    return appState.maintMemberShifts[currentSlot][dateStr];
  }

  // 하위 호환: 기존 maintenanceShifts가 단일 맵일 때 (슬롯 0)
  if (currentSlot === 0 && appState.maintenanceShifts && typeof appState.maintenanceShifts[dateStr] === 'string') {
    return appState.maintenanceShifts[dateStr];
  }

  // 공휴일 및 방송국 지정 휴일인 경우 '비'(휴무)
  const holidayInfo = getHolidayInfo(dateStr);
  if (holidayInfo.isHoliday) {
    return '비';
  }
  // 주말(토/일)인 경우 '비'(휴무)
  const d = new Date(dateStr + 'T00:00:00');
  const dayOfWeek = d.getDay(); // 0(일) ~ 6(토)
  if (dayOfWeek === 0 || dayOfWeek === 6) {
    return '비';
  }
  // 평일(월~금) 기본 근무: '일'(상일근 09:00~18:00)
  return '일';
}

// 특정 슬롯(0~4) 또는 현재 슬롯의 특정 일자 정비 근무 형태 설정
function setMaintenanceShift(dateStr, shiftType, slot = null) {
  const currentSlot = (slot !== null && slot !== undefined) 
    ? slot 
    : (appState.selectedMaintSlot !== undefined ? appState.selectedMaintSlot : 0);

  if (!appState.maintMemberShifts) {
    appState.maintMemberShifts = {};
  }
  if (!appState.maintMemberShifts[currentSlot]) {
    appState.maintMemberShifts[currentSlot] = {};
  }
  appState.maintMemberShifts[currentSlot][dateStr] = shiftType;

  // 슬롯 0 하위 호환
  if (currentSlot === 0) {
    if (!appState.maintenanceShifts) appState.maintenanceShifts = {};
    appState.maintenanceShifts[dateStr] = shiftType;
  }

  appState.lastLocalUpdated = Date.now();
  saveState();
  renderCalendar();
  updateBottomStats();
}

// 특정 슬롯(0~4) 또는 현재 슬롯의 특정 주간 누적 근무시간 계산 (월~일)
function getMaintenanceWeekHours(dateStr, slot = null) {
  const schedule = getWeekSchedule(dateStr);
  const weekDates = schedule.weekDates || [];
  let totalHours = 0;
  weekDates.forEach(dStr => {
    const shift = getMaintenanceShiftForDate(dStr, slot);
    if (shift && shift !== '비' && shift !== '휴' && shift !== '휴가') {
      totalHours += (SHIFT_HOURS[shift] || 8);
    }
  });
  return Math.round(totalHours * 10) / 10;
}

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
function sendSystemNotification(title, body, tag = 'songchul-shift-realtime') {
  try {
    if (!('Notification' in window)) return;
    if (Notification.permission === 'granted') {
      const options = {
        body: body,
        icon: 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 24 24" fill="%232563eb"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2" stroke="%23ffffff" stroke-width="2"/></svg>'),
        badge: 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 24 24" fill="%232563eb"><circle cx="12" cy="12" r="10"/></svg>'),
        tag: tag,
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
      sendSystemNotification('송출 근무표', '실시간 알림 및 알림음이 정상 연결되어 있습니다.');
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
      sendSystemNotification('송출 근무표', '근무표 변경 시 실시간으로 알림과 소리가 전송됩니다.');
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
          leaveType: (item.leaveType === '오전반차' || item.leaveType === '오후반차') ? item.leaveType : '전일',
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
    return target &&
      m.id === target.id &&
      m.name === target.name &&
      m.baseShift === target.baseShift &&
      (m.empNo || '') === (target.empNo || '') &&
      (m.phone || '') === (target.phone || '') &&
      (m.email || '') === (target.email || '');
  });
}

// 대근 자동 배정 규칙 정확한 값 비교 (키 순서 및 null 안전 처리)
function areSubRulesEqual(r1, r2) {
  const target1 = Object.assign({}, DEFAULT_SUB_RULES, r1 || {});
  const target2 = Object.assign({}, DEFAULT_SUB_RULES, r2 || {});
  const norm = (v) => (v === '수동' ? '미지정' : v);
  return target1['일'] === target2['일'] &&
         norm(target1['오전일반']) === norm(target2['오전일반']) &&
         target1['오후일반'] === target2['오후일반'] &&
         target1['조'] === target2['조'] &&
         target1['야'] === target2['야'] &&
         target1['야조'] === target2['야조'];
}

// ==========================================
// 업무 공지 확인(읽음) 상태 로컬 추적
// (새 공지: 하늘색 + 천천히 움직임 / 확인 완료: 회색 + 정지)
// ==========================================
const WORK_NOTICE_READS_KEY = 'SONGCHUL_WORK_NOTICE_READS';

function getWorkNoticeReads() {
  try {
    const raw = localStorage.getItem(WORK_NOTICE_READS_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch (e) {
    return {};
  }
}

function getWorkMemoInfo(dateStr) {
  if (!dateStr || !appState.workMemos) return { text: '', isUrgent: false, confirmedMembers: [] };
  const raw = appState.workMemos[dateStr];
  if (!raw) return { text: '', isUrgent: false, confirmedMembers: [] };
  if (typeof raw === 'string') {
    return { text: raw.trim(), isUrgent: false, confirmedMembers: [] };
  }
  if (typeof raw === 'object') {
    return {
      text: (raw.text || '').trim(),
      isUrgent: Boolean(raw.isUrgent),
      confirmedMembers: Array.isArray(raw.confirmedMembers) ? raw.confirmedMembers : []
    };
  }
  return { text: '', isUrgent: false, confirmedMembers: [] };
}

// 특정 멤버의 확인 여부 확인
function isMemberConfirmedWorkNotice(dateStr, memberName) {
  if (!dateStr || !memberName) return false;
  const info = getWorkMemoInfo(dateStr);
  return info.confirmedMembers.includes(memberName);
}

// 특정 멤버 확인 완료 처리 (조용히 저장 및 동기화)
function confirmWorkNoticeForMember(dateStr, memberName) {
  if (!dateStr || !memberName) return;
  const raw = appState.workMemos && appState.workMemos[dateStr];
  if (!raw) return;

  let text = '';
  let isUrgent = false;
  let confirmedMembers = [];

  if (typeof raw === 'string') {
    text = raw.trim();
  } else if (typeof raw === 'object') {
    text = (raw.text || '').trim();
    isUrgent = Boolean(raw.isUrgent);
    confirmedMembers = Array.isArray(raw.confirmedMembers) ? [...raw.confirmedMembers] : [];
  }

  if (!text) return;
  if (!confirmedMembers.includes(memberName)) {
    confirmedMembers.push(memberName);
    appState.workMemos[dateStr] = {
      text,
      isUrgent,
      confirmedMembers,
      updatedAt: Date.now()
    };
    saveState();
    renderCalendar();
  }
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
  sendSystemNotification('송출 근무표 알림', detailMsg);
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
  const rulesChanged = Boolean(remoteData.subRules && !areSubRulesEqual(remoteData.subRules, appState.subRules));
  const remoteWorkMemos = (remoteData.workMemos && typeof remoteData.workMemos === 'object') ? remoteData.workMemos : {};
  const localWorkMemos = (appState.workMemos && typeof appState.workMemos === 'object') ? appState.workMemos : {};
  const workMemosChanged = JSON.stringify(remoteWorkMemos) !== JSON.stringify(localWorkMemos);

  const remoteMaint = (remoteData.maintenanceShifts && typeof remoteData.maintenanceShifts === 'object') ? remoteData.maintenanceShifts : {};
  const localMaint = (appState.maintenanceShifts && typeof appState.maintenanceShifts === 'object') ? appState.maintenanceShifts : {};
  const maintChanged = JSON.stringify(remoteMaint) !== JSON.stringify(localMaint);

  const remoteMaintMembers = (remoteData.maintMemberShifts && typeof remoteData.maintMemberShifts === 'object') ? remoteData.maintMemberShifts : {};
  const localMaintMembers = (appState.maintMemberShifts && typeof appState.maintMemberShifts === 'object') ? appState.maintMemberShifts : {};
  const maintMembersChanged = JSON.stringify(remoteMaintMembers) !== JSON.stringify(localMaintMembers);

  const chiefChanged = Boolean(
    (remoteData.chiefName && remoteData.chiefName !== appState.chiefName) ||
    (typeof remoteData.chiefEmpNo !== 'undefined' && remoteData.chiefEmpNo !== (appState.chiefEmpNo || '')) ||
    (typeof remoteData.chiefPhone !== 'undefined' && remoteData.chiefPhone !== (appState.chiefPhone || '')) ||
    (typeof remoteData.chiefEmail !== 'undefined' && remoteData.chiefEmail !== (appState.chiefEmail || ''))
  );

  const maintMembersListChanged = Boolean(
    remoteData.maintenanceMembers &&
    JSON.stringify(remoteData.maintenanceMembers) !== JSON.stringify(appState.maintenanceMembers)
  );

  const remotePersonContacts = (remoteData.personContacts && typeof remoteData.personContacts === 'object') ? remoteData.personContacts : {};
  const localPersonContacts = (appState.personContacts && typeof appState.personContacts === 'object') ? appState.personContacts : {};
  const personContactsChanged = JSON.stringify(remotePersonContacts) !== JSON.stringify(localPersonContacts);

  if (leavesChanged || refChanged || membersChanged || timesChanged || rulesChanged || workMemosChanged || maintChanged || maintMembersChanged || chiefChanged || maintMembersListChanged || personContactsChanged) {
    let nextLeaves = remoteLeaves;
    // 다중 기기 동시 작업 시, 내가 로컬에서 수정하여 업로드 대기 중인 날짜는 온전히 보존
    if (pendingModifiedDates.size > 0 || isUploadingToFirebase) {
      nextLeaves = mergeLeavesSafely(remoteLeaves, appState.leaves, pendingModifiedDates);
    }
    appState.leaves = nextLeaves;
    if (remoteData.refDate) appState.refDate = remoteData.refDate;

    // 원격 사람 고유 연락처 레지스트리 병합
    if (remoteData.personContacts && typeof remoteData.personContacts === 'object') {
      if (!appState.personContacts || typeof appState.personContacts !== 'object') {
        appState.personContacts = {};
      }
      Object.assign(appState.personContacts, remoteData.personContacts);
    }

    if (remoteData.members && Array.isArray(remoteData.members) && remoteData.members.length > 0) {
      appState.members = remoteData.members.map((m, idx) => {
        const localM = (appState.members && appState.members[idx]) || {};
        const memberName = m.name || localM.name || `멤버${idx + 1}`;
        const contact = getContactForPerson(memberName);
        return {
          id: idx,
          name: memberName,
          baseShift: m.baseShift || localM.baseShift || '일',
          // 원격 연락처 우선 -> 로컬 연락처 -> 사람 레지스트리 연락처 순 보존
          empNo: (typeof m.empNo !== 'undefined' && m.empNo !== '') ? m.empNo : (localM.empNo || contact.empNo || ''),
          phone: (typeof m.phone !== 'undefined' && m.phone !== '') ? m.phone : (localM.phone || contact.phone || ''),
          email: (typeof m.email !== 'undefined' && m.email !== '') ? m.email : (localM.email || contact.email || '')
        };
      });
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
    if (remoteData.workMemos && typeof remoteData.workMemos === 'object') {
      appState.workMemos = remoteData.workMemos;
    } else if (remoteData.workMemos) {
      appState.workMemos = {};
    }
    if (remoteData.maintenanceShifts && typeof remoteData.maintenanceShifts === 'object') {
      appState.maintenanceShifts = remoteData.maintenanceShifts;
    }
    if (remoteData.maintMemberShifts && typeof remoteData.maintMemberShifts === 'object') {
      appState.maintMemberShifts = remoteData.maintMemberShifts;
    }
    if (remoteData.chiefName) {
      appState.chiefName = remoteData.chiefName;
    }
    const chiefContact = getContactForPerson(appState.chiefName);
    if (typeof remoteData.chiefEmpNo !== 'undefined') {
      if (remoteData.chiefEmpNo !== '' || !appState.chiefEmpNo) {
        appState.chiefEmpNo = remoteData.chiefEmpNo;
      }
    } else if (!appState.chiefEmpNo && chiefContact.empNo) {
      appState.chiefEmpNo = chiefContact.empNo;
    }
    if (typeof remoteData.chiefPhone !== 'undefined') {
      if (remoteData.chiefPhone !== '' || !appState.chiefPhone) {
        appState.chiefPhone = remoteData.chiefPhone;
      }
    } else if (!appState.chiefPhone && chiefContact.phone) {
      appState.chiefPhone = chiefContact.phone;
    }
    if (typeof remoteData.chiefEmail !== 'undefined') {
      if (remoteData.chiefEmail !== '' || !appState.chiefEmail) {
        appState.chiefEmail = remoteData.chiefEmail;
      }
    } else if (!appState.chiefEmail && chiefContact.email) {
      appState.chiefEmail = chiefContact.email;
    }
    if (remoteData.maintenanceMembers && Array.isArray(remoteData.maintenanceMembers)) {
      appState.maintenanceMembers = remoteData.maintenanceMembers.map((m, idx) => {
        const localM = (appState.maintenanceMembers && appState.maintenanceMembers[idx]) || {};
        const maintName = m.name || localM.name || '';
        const contact = getContactForPerson(maintName);
        return {
          id: idx,
          role: m.role || localM.role || (idx < 2 ? '송신소' : 'TVR'),
          name: maintName,
          empNo: (typeof m.empNo !== 'undefined' && m.empNo !== '') ? m.empNo : (localM.empNo || contact.empNo || ''),
          phone: (typeof m.phone !== 'undefined' && m.phone !== '') ? m.phone : (localM.phone || contact.phone || ''),
          email: (typeof m.email !== 'undefined' && m.email !== '') ? m.email : (localM.email || contact.email || '')
        };
      });
    }
    // [개인정보 보호] 개인 일정은 공용 문서에서 덮어쓰지 않고, 독립된 비밀번호 동기화(personal_sync)를 통해서만 본인 기기 간 공유됩니다.
    ensureFourMembers();
    initPersonContactsRegistry();
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

    // 다른 기기에서 온 실시간 변경일 때 알림음(소리) 및 시스템 알림 문자 발송
    // [사용자 지침] 일반적인 업무 공지는 알림 메시지가 가지 않고, '긴급 공지'만 알림 발송!
    let hasNewUrgentNotice = false;
    let urgentNoticeText = '';
    if (workMemosChanged) {
      for (const d of Object.keys(remoteWorkMemos)) {
        const rItem = remoteWorkMemos[d];
        const lItem = localWorkMemos[d];
        const isUrgent = Boolean(typeof rItem === 'object' && rItem && rItem.isUrgent);
        if (isUrgent && JSON.stringify(rItem) !== JSON.stringify(lItem)) {
          hasNewUrgentNotice = true;
          urgentNoticeText = (typeof rItem === 'object' ? rItem.text : rItem) || '';
          break;
        }
      }
    }

    const onlyWorkMemosChanged = workMemosChanged && !leavesChanged && !refChanged && !membersChanged && !timesChanged && !rulesChanged;
    if (playSound) {
      if (onlyWorkMemosChanged) {
        if (hasNewUrgentNotice) {
          notifyRemoteChange(`🚨 긴급 업무 공지: ${urgentNoticeText}`);
        }
      } else {
        notifyRemoteChange(detailMsg);
      }
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
let isInitialFirestoreSnapshot = true;

function setupFirestoreListener() {
  if (!db) return;
  if (typeof firestoreUnsubscribe === 'function') {
    try { firestoreUnsubscribe(); } catch (e) {}
    firestoreUnsubscribe = null;
  }

  isInitialFirestoreSnapshot = true;

  const docRef = db.collection('schedules').doc('songchul_shift');
  firestoreUnsubscribe = docRef.onSnapshot((doc) => {
    updateSyncStatus(true, '실시간 🔄');
    if (!doc.exists) {
      uploadStateToFirebase();
      isInitialFirestoreSnapshot = false;
      return;
    }
    // 로컬 쓰기 직후의 미확정 로컬 스냅샷은 건너뜀
    if (doc.metadata && doc.metadata.hasPendingWrites) {
      return;
    }

    // 앱 실행 직후 최초 1회 스냅샷은 '초기 로딩'이므로 알림을 울리지 않고 데이터만 조용히 동기화
    const shouldPlaySound = !isInitialFirestoreSnapshot;
    isInitialFirestoreSnapshot = false;

    applyRemoteData(doc.data(), shouldPlaySound);
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

    // 초기 선택된 멤버의 개인 일정 기기 간 동기화 리스너 개시
    setupPersonalSyncListener(appState.selectedMemberId);

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
        workMemos: appState.workMemos || {},
        maintenanceShifts: appState.maintenanceShifts || {},
        maintMemberShifts: appState.maintMemberShifts || {},
        chiefName: appState.chiefName || DEFAULT_CHIEF_NAME,
        chiefEmpNo: appState.chiefEmpNo || '',
        chiefPhone: appState.chiefPhone || '',
        chiefEmail: appState.chiefEmail || '',
        maintenanceMembers: appState.maintenanceMembers || DEFAULT_MAINTENANCE_MEMBERS,
        // 사람(이름) 고유 연락처 레지스트리 클라우드 동기화
        personContacts: appState.personContacts || {},
        // [개인정보 보호] personalMemos는 공용 문서에 업로드하지 않고 완전 격리!
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
        workMemos: appState.workMemos || {},
        maintenanceShifts: appState.maintenanceShifts || {},
        maintMemberShifts: appState.maintMemberShifts || {},
        chiefName: appState.chiefName || DEFAULT_CHIEF_NAME,
        chiefEmpNo: appState.chiefEmpNo || '',
        chiefPhone: appState.chiefPhone || '',
        chiefEmail: appState.chiefEmail || '',
        maintenanceMembers: appState.maintenanceMembers || DEFAULT_MAINTENANCE_MEMBERS,
        // 사람(이름) 고유 연락처 레지스트리 클라우드 동기화
        personContacts: appState.personContacts || {},
        // [개인정보 보호] personalMemos는 공용 문서에 업로드하지 않고 완전 격리!
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
      workMemos: appState.workMemos || {},
      personalMemos: appState.personalMemos || {},
      maintenanceShifts: appState.maintenanceShifts || {},
      maintMemberShifts: appState.maintMemberShifts || {},
      selectedMaintSlot: (appState.selectedMaintSlot !== undefined) ? appState.selectedMaintSlot : 0,
      chiefName: appState.chiefName || DEFAULT_CHIEF_NAME,
      chiefEmpNo: appState.chiefEmpNo || '',
      chiefPhone: appState.chiefPhone || '',
      chiefEmail: appState.chiefEmail || '',
      maintenanceMembers: appState.maintenanceMembers || DEFAULT_MAINTENANCE_MEMBERS,
      // 사람(이름) 고유 연락처 레지스트리 영구 저장
      personContacts: appState.personContacts || {},
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
      if (parsed.workMemos && typeof parsed.workMemos === 'object') {
        appState.workMemos = parsed.workMemos;
      }
      if (parsed.personalMemos && typeof parsed.personalMemos === 'object') {
        appState.personalMemos = parsed.personalMemos;
      }
      if (parsed.maintenanceShifts && typeof parsed.maintenanceShifts === 'object') {
        appState.maintenanceShifts = parsed.maintenanceShifts;
      }
      if (parsed.maintMemberShifts && typeof parsed.maintMemberShifts === 'object') {
        appState.maintMemberShifts = parsed.maintMemberShifts;
      }
      if (typeof parsed.selectedMaintSlot === 'number') {
        appState.selectedMaintSlot = parsed.selectedMaintSlot;
      }
      if (parsed.chiefName) {
        appState.chiefName = parsed.chiefName;
      }
      if (typeof parsed.chiefEmpNo !== 'undefined') {
        appState.chiefEmpNo = parsed.chiefEmpNo;
      }
      if (typeof parsed.chiefPhone !== 'undefined') {
        appState.chiefPhone = parsed.chiefPhone;
      }
      if (typeof parsed.chiefEmail !== 'undefined') {
        appState.chiefEmail = parsed.chiefEmail;
      }
      if (parsed.maintenanceMembers && Array.isArray(parsed.maintenanceMembers)) {
        appState.maintenanceMembers = parsed.maintenanceMembers;
      }
      if (parsed.personContacts && typeof parsed.personContacts === 'object') {
        appState.personContacts = parsed.personContacts;
      }
      initPersonContactsRegistry();
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
      initPersonContactsRegistry();
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
    initPersonContactsRegistry();
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
      const leaveType = isLeave ? ((leaveInfo.leaveType === '오전반차' || leaveInfo.leaveType === '오후반차') ? leaveInfo.leaveType : '전일') : null;
      return {
        memberId: m.id,
        name: m.name,
        baseShift: baseShift,
        effectiveShift: isLeave ? '휴가' : baseShift,
        isLeave: isLeave,
        leaveType: leaveType,
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

    // 기본 근무시간 가산 (휴가가 아니거나 일근 반차인 경우)
    weekRosters[dateStr].forEach(item => {
      if (!item.isLeave) {
        if (memberWeekHours[item.memberId] === undefined) {
          memberWeekHours[item.memberId] = 0;
        }
        memberWeekHours[item.memberId] += (SHIFT_HOURS[item.baseShift] || 0);
      } else if (item.baseShift === '일' && (item.leaveType === '오전반차' || item.leaveType === '오후반차')) {
        if (memberWeekHours[item.memberId] === undefined) {
          memberWeekHours[item.memberId] = 0;
        }
        memberWeekHours[item.memberId] += 4;
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

        // 핵심: 대근 대상자가 존재하더라도 본인이 당일 휴가(isLeave) 중이면 대근 불가 -> 자동 해제!
        if (subMember && !subMember.isLeave) {
          subMember.isSubstitute = true;
          subMember.isManualSub = true;
          if (!subMember.assignedSubs) {
            subMember.assignedSubs = [];
          }
          subMember.assignedSubs.push({
            forMemberId: item.memberId,
            forName: item.name,
            shiftType: item.baseShift,
            leaveType: item.leaveType || '전일'
          });
          subMember.subForMemberId = item.memberId;
          subMember.subForShiftType = item.baseShift;
          subMember.subForLeaveType = item.leaveType || '전일';
          const allSubsStr = subMember.assignedSubs.map(s => `${s.shiftType}(대)`).join('+');
          subMember.effectiveShift = subMember.baseShift !== '비' 
            ? `${subMember.baseShift}+${allSubsStr}` 
            : allSubsStr;
          item.substituteId = subMember.memberId;
          item.subMemberName = subMember.name;
          item.isManualSub = true;

          // 수기 지정 대근시간 가산
          const subHours = (item.baseShift === '일' && (item.leaveType === '오전반차' || item.leaveType === '오후반차')) ? 4 : (SHIFT_HOURS[item.baseShift] || 0);
          memberWeekHours[subMember.memberId] += subHours;
        } else if (subMember && subMember.isLeave) {
          // 수기 지정된 대근자가 당일 휴가인 경우: 대근 자동 해제 (다른 직원이 자동 배정될 수 있도록 초기화)
          item.substituteId = null;
          item.subMemberName = null;
          item.isManualSub = false;
          item.autoSubFailReason = `지정 대근자(${subMember.name}) 휴가로 인한 대근 해제 (자동 재배정 진행)`;
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
      // 이미 대근자가 유효하게 배정된 경우 건너뜀
      if (item.substituteId !== null && item.substituteId !== undefined) return;
      // 사용자가 수기로 명시적 '대근 해제'한 건(결원 의도)만 건너뜀
      if (leaveInfo && leaveInfo.isManual && (leaveInfo.cancelledSubId !== null || leaveInfo.cancelledSubName !== null)) return;

      const origShift = item.baseShift;
      let neededHours = SHIFT_HOURS[origShift] || 0;
      if (origShift === '일' && (item.leaveType === '오전반차' || item.leaveType === '오후반차')) {
        neededHours = 4;
      }

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
        const leaveType = item.leaveType || leaveInfo?.leaveType || '전일';
        let ruleKey = '일';
        if (leaveType === '오전반차') {
          ruleKey = '오전일반';
        } else if (leaveType === '오후반차') {
          ruleKey = '오후일반';
        }
        const targetShift = subRules[ruleKey] || (ruleKey === '일' ? '비' : null);
        if (targetShift && targetShift !== '미지정' && targetShift !== '수동') {
          targetCand = roster.find(r => r.memberId !== item.memberId && r.baseShift === targetShift);
        } else {
          targetCand = null;
        }
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
          if (!targetCand.assignedSubs) {
            targetCand.assignedSubs = [];
          }
          targetCand.assignedSubs.push({
            forMemberId: item.memberId,
            forName: item.name,
            shiftType: origShift,
            leaveType: item.leaveType || '전일'
          });
          targetCand.subForMemberId = item.memberId;
          targetCand.subForShiftType = origShift;
          targetCand.subForLeaveType = item.leaveType || '전일';
          const allSubsStr = targetCand.assignedSubs.map(s => `${s.shiftType}(대)`).join('+');
          targetCand.effectiveShift = targetCand.baseShift !== '비'
            ? `${targetCand.baseShift}+${allSubsStr}`
            : allSubsStr;
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

  // 휴가자 불변식 보장: 휴가자는 어떤 경우에도 대근을 서지 않으며 '휴가'로 단독 표기
  weekDates.forEach(dStr => {
    weekRosters[dStr].forEach(r => {
      if (r.isLeave) {
        r.isSubstitute = false;
        r.assignedSubs = [];
        r.effectiveShift = '휴가';
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
 * 특정 연/월의 4인 멤버별 월간 총 누계 근무시간(1일 ~ 말일) 계산 함수
 * - 해당 월 1일부터 마지막 날까지 실제 배정된 기본 근무 및 대근 시간을 모두 합산하여 반환
 */
function getMonthMemberHours(year, month) {
  const lastDay = new Date(year, month + 1, 0).getDate();
  const totals = {};
  appState.members.forEach(m => {
    totals[m.id] = 0;
  });

  for (let d = 1; d <= lastDay; d++) {
    const dateStr = `${year}-${String(month + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    const roster = getDayShiftRoster(dateStr);
    if (!roster) continue;

    roster.forEach(r => {
      // 1) 본인 근무 (휴가가 아니거나 일근 반차인 경우)
      if (!r.isLeave && r.baseShift && r.baseShift !== '비') {
        const h = SHIFT_HOURS[r.baseShift] || 0;
        totals[r.memberId] = (totals[r.memberId] || 0) + h;
      } else if (r.isLeave && r.baseShift === '일' && (r.leaveType === '오전반차' || r.leaveType === '오후반차')) {
        totals[r.memberId] = (totals[r.memberId] || 0) + 4;
      }
      // 2) 대근 수행 시 (다중 대근 완벽 합산)
      if (r.isSubstitute) {
        if (Array.isArray(r.assignedSubs) && r.assignedSubs.length > 0) {
          r.assignedSubs.forEach(s => {
            const h = (s.shiftType === '일' && (s.leaveType === '오전반차' || s.leaveType === '오후반차')) ? 4 : (SHIFT_HOURS[s.shiftType] || 0);
            totals[r.memberId] = (totals[r.memberId] || 0) + h;
          });
        } else if (r.subForShiftType) {
          const h = (r.subForShiftType === '일' && (r.subForLeaveType === '오전반차' || r.subForLeaveType === '오후반차')) ? 4 : (SHIFT_HOURS[r.subForShiftType] || 0);
          totals[r.memberId] = (totals[r.memberId] || 0) + h;
        }
      }
    });
  }

  // 소수점 첫째자리 반올림 정리
  Object.keys(totals).forEach(id => {
    totals[id] = Math.round(totals[id] * 10) / 10;
  });

  return totals;
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
    // 2) 내부 직원이 대근을 서주는 경우 (다중 대근 완벽 반영)
    if (r.isSubstitute) {
      if (Array.isArray(r.assignedSubs) && r.assignedSubs.length > 0) {
        r.assignedSubs.forEach(s => coveredShifts.add(s.shiftType));
      } else if (r.subForShiftType) {
        coveredShifts.add(r.subForShiftType);
      }
    }
    // 3) 외부 수기 입력 대근자(CUSTOM)가 배정된 경우
    if (r.isLeave && r.substituteId === 'CUSTOM' && r.customSubName) {
      coveredShifts.add(r.baseShift);
    }
    // 4) 내부 직원이 수기/자동으로 대근자로 지정되어 있는 경우
    if (r.isLeave && r.substituteId !== null && r.substituteId !== undefined && r.substituteId !== 'CUSTOM') {
      coveredShifts.add(r.baseShift);
    }
    // 5) 대근자가 미배정된 실제 근무(조, 일, 야) 휴가 확인 (0번 ID 멤버 및 수기 대근자 null/undefined 엄격 검사)
    const hasAssignedSub = (r.substituteId !== null && r.substituteId !== undefined) || Boolean(r.customSubName);
    if (r.isLeave && requiredShifts.includes(r.baseShift) && !hasAssignedSub) {
      unassignedLeaves.push(r);
    }
  });

  const missingShifts = requiredShifts.filter(s => !coveredShifts.has(s));
  return {
    hasGap: missingShifts.length > 0 || unassignedLeaves.length > 0,
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
function createWeekMemberHeaderCell(sundayDateStr, weekIdx, weekDays = []) {
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

  // 해당 주(일~토)에 외부 수기 대근자(CUSTOM)가 지정된 날이 있는 경우에만 5번째 대근 줄 동적 할당
  let hasWeeklyCustomSub = false;
  if (Array.isArray(weekDays)) {
    for (const day of weekDays) {
      const roster = getDayShiftRoster(day.dateStr);
      if (roster && roster.some(r => r.isLeave && r.substituteId === 'CUSTOM' && r.customSubName)) {
        hasWeeklyCustomSub = true;
        break;
      }
    }
  }
  if (hasWeeklyCustomSub) {
    const subRow = document.createElement('div');
    subRow.className = 'member-name-row is-custom-sub-row';
    subRow.textContent = '대근';
    subRow.title = `${weekIdx + 1}주차 외부 대근자 행`;
    namesContainer.appendChild(subRow);
  }

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
function renderCalendar(animDirection = null, isMonthChange = false) {
  const year = appState.currentYear;
  const month = appState.currentMonth;

  // 헤더 년/월 텍스트 업데이트 (월 변경 시에만 부드러운 전환 효과)
  const displayYearMonthEl = document.getElementById('display-year-month');
  if (displayYearMonthEl) {
    displayYearMonthEl.textContent = `${year}년 ${month + 1}월`;
    if (isMonthChange && animDirection) {
      displayYearMonthEl.classList.remove('month-change-pulse');
      void displayYearMonthEl.offsetWidth;
      displayYearMonthEl.classList.add('month-change-pulse');
    }
  }

  const calendarWrapper = document.querySelector('.calendar-wrapper');
  const weekdayGrid = document.getElementById('weekday-grid');
  const isSingle = (appState.selectedMemberId !== 'ALL');
  if (calendarWrapper) {
    calendarWrapper.classList.toggle('single-member-mode', isSingle);
  }
  if (weekdayGrid) {
    weekdayGrid.classList.toggle('single-member-mode', isSingle);
  }

  const daysGrid = document.getElementById('calendar-days-grid');
  daysGrid.innerHTML = '';
  daysGrid.classList.remove('slide-from-left', 'slide-from-right');
  if (animDirection === 'slide-from-left' || animDirection === 'slide-from-right') {
    void daysGrid.offsetWidth; // 리플로우 강제 트리거로 애니메이션 즉시 재실행
    daysGrid.classList.add(animDirection);
  }

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
      const headerCell = createWeekMemberHeaderCell(sundayDateStr, w, weekDays);
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
  updateStickyHeaderOffset();
  if (window.calendarZoomCtrl) {
    window.calendarZoomCtrl.setMode(appState.selectedMemberId === 'ALL' ? 'ALL' : 'SINGLE');
    window.calendarZoomCtrl.clampPan();
  }
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

  // 정비 달력은 송출 교대근무 결원 경광등 대상에서 완전 제외
  const isMaintenanceMode = (appState.selectedMemberId === 'MAINTENANCE');

  if (coverage.hasGap && !isMaintenanceMode) {
    cell.classList.add('has-unassigned');
  }

  // 툴팁 안내 문구 생성 (정비 달력에서는 경광등 표시 완전 제거)
  let sirenHtml = '';
  if (coverage.hasGap && !isMaintenanceMode) {
    const shiftLabels = { '조': '조근(00~09시)', '일': '일근(09~18시)', '야': '야근(18~24시)' };
    const missingText = coverage.missingShifts.map(s => shiftLabels[s] || s).join(', ');
    const tooltipText = `🚨 24시간 근무 결원 발생!\n[미배정]: ${missingText}\n(52시간 초과, 대근 해제 또는 대근 미지정으로 인한 공백 - 수동 배정 필요)`;
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

  // [신규] 업무 공지 바 (날짜 숫자와 근무 아이콘 사이의 공간에 배치)
  const memoInfo = getWorkMemoInfo(dateStr);
  const hasWorkNotice = (memoInfo.text.length > 0);
  if (hasWorkNotice && appState.selectedMemberId !== 'ALL') {
    let isRead = false;
    let titleText = '';

    if (appState.selectedMemberId === 'ALL') {
      // 전체 근무 페이지: 4인 전원이 확인한 경우에만 회색 정지, 1명이라도 미확인이면 계속 움직임
      const totalCount = appState.members.length;
      const confirmedCount = memoInfo.confirmedMembers.length;
      isRead = (totalCount > 0 && confirmedCount >= totalCount);
      const unconfirmedList = appState.members.map(m => m.name).filter(n => !memoInfo.confirmedMembers.includes(n));
      titleText = `${memoInfo.isUrgent ? '🚨 긴급 공지' : '📋 업무 공지'}: ${memoInfo.text}\n[확인 현황: ${confirmedCount}/${totalCount}명]\n· 확인: ${memoInfo.confirmedMembers.join(', ') || '없음'}\n· 미확인: ${unconfirmedList.join(', ') || '전원 확인 완료'}`;
    } else {
      // 개별 멤버 페이지 (이준희, 최혜진, 오승연, 안영주, 정비팀 5인 등):
      // [사용자 핵심 지침] 확인한 사람 페이지에서만 회색(정지)으로 표시되고, 확인하지 않은 사람 페이지에선 계속 움직임!
      let memberName = '';
      if (appState.selectedMemberId === 'MAINTENANCE') {
        const slotMembers = getMaintSlotMembers();
        const currentSlot = (appState.selectedMaintSlot !== undefined) ? appState.selectedMaintSlot : 0;
        const currentMaint = slotMembers.find(m => m.slot === currentSlot) || slotMembers[0];
        memberName = currentMaint ? currentMaint.name : '정비팀';
      } else {
        const currentMember = appState.members.find(m => m.id === appState.selectedMemberId);
        memberName = currentMember ? currentMember.name : '';
      }
      const isMemberConfirmed = Boolean(memberName && memoInfo.confirmedMembers.includes(memberName));
      isRead = isMemberConfirmed;
      titleText = `${memoInfo.isUrgent ? '🚨 긴급 공지' : '📋 업무 공지'}: ${memoInfo.text}\n[${memberName} 페이지]: ${isMemberConfirmed ? '✓ 확인 완료' : '미확인 (터치/클릭 시 확인)'}`;
    }

    const noticeBar = document.createElement('div');
    const urgentClass = memoInfo.isUrgent ? ' urgent' : '';
    noticeBar.className = `cell-work-notice-bar ${isRead ? 'read' : 'unread'}${urgentClass}`;
    noticeBar.textContent = memoInfo.isUrgent ? '🚨 긴급 공지' : '업무 공지';
    noticeBar.title = titleText;

    noticeBar.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      // 개별 멤버 페이지에서 공지 버튼을 누르면 해당 멤버 확인 처리
      if (appState.selectedMemberId !== 'ALL') {
        let memberName = '';
        if (appState.selectedMemberId === 'MAINTENANCE') {
          const slotMembers = getMaintSlotMembers();
          const currentSlot = (appState.selectedMaintSlot !== undefined) ? appState.selectedMaintSlot : 0;
          const currentMaint = slotMembers.find(m => m.slot === currentSlot) || slotMembers[0];
          memberName = currentMaint ? currentMaint.name : '정비팀';
        } else {
          const currentMember = appState.members.find(m => m.id === appState.selectedMemberId);
          memberName = currentMember ? currentMember.name : '';
        }
        if (memberName) {
          confirmWorkNoticeForMember(dateStr, memberName);
        }
      }
      openDayModal(dateStr);
    });
    cell.appendChild(noticeBar);
  }

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

      const activeShifts = getMemberActiveShifts(r);

      // 전체 근무 달력: 좌측에 주별 4인 이름이 표시되므로 날짜 셀 안에는 성을 빼고 근무만 중앙에 깔끔하게 표시
      if (r.isLeave) {
        pill.classList.add('is-leave');
        const leaveInfo = getMemberLeaveInfo(dateStr, r.name);
        const lType = r.leaveType || leaveInfo?.leaveType;
        if (lType === '오전반차') {
          pill.innerHTML = `<span class="pill-half-wrap"><span>오전</span><span>반차</span></span>`;
        } else if (lType === '오후반차') {
          pill.innerHTML = `<span class="pill-half-wrap"><span>오후</span><span>반차</span></span>`;
        } else {
          pill.innerHTML = `<span class="shift-pill-type">휴</span>`;
        }
      } else if (activeShifts.length >= 2) {
        pill.classList.add('is-substitute');
        const s1 = activeShifts[0];
        const s2 = activeShifts[1];
        const tag1Class = s1.isSub ? 'tag-sub' : (s1.type === '일' ? 'tag-il' : (s1.type === '조' ? 'tag-jo' : 'tag-ya'));
        const tag2Class = s2.isSub ? 'tag-sub' : (s2.type === '일' ? 'tag-il' : (s2.type === '조' ? 'tag-jo' : 'tag-ya'));
        const formatTagContent = (s) => {
          if (s.isSub && s.type === '일') {
            if (s.leaveType === '오전반차') return `<span class="mini-half-wrap"><span>오전</span><span>일근</span></span>`;
            if (s.leaveType === '오후반차') return `<span class="mini-half-wrap"><span>오후</span><span>일근</span></span>`;
          }
          return s.type;
        };
        const dualTagsHtml = `
          <span class="dual-tags-wrap">
            <span class="mini-tag ${tag1Class}">${formatTagContent(s1)}</span>
            <span class="mini-tag-plus">+</span>
            <span class="mini-tag ${tag2Class}">${formatTagContent(s2)}</span>
          </span>
        `;
        if (r.isManualSub) {
          pill.classList.add('has-member');
          const nameLen = r.name ? r.name.length : 0;
          const lenClass = nameLen >= 4 ? 'len-4' : (nameLen === 3 ? 'len-3' : '');
          pill.innerHTML = `
            <span class="shift-pill-member ${lenClass}">${r.name}</span>
            ${dualTagsHtml}
          `;
        } else {
          pill.innerHTML = dualTagsHtml;
        }
      } else if (activeShifts.length === 1 && activeShifts[0].isSub) {
        pill.classList.add('is-substitute');
        const s = activeShifts[0];
        let subTypeHtml = `<span class="shift-pill-type">${s.type}</span>`;
        if (s.type === '일') {
          if (s.leaveType === '오전반차') {
            subTypeHtml = `<span class="pill-half-wrap"><span>오전</span><span>일근</span></span>`;
          } else if (s.leaveType === '오후반차') {
            subTypeHtml = `<span class="pill-half-wrap"><span>오후</span><span>일근</span></span>`;
          }
        }
        if (r.isManualSub) {
          pill.classList.add('has-member');
          const nameLen = r.name ? r.name.length : 0;
          const lenClass = nameLen >= 4 ? 'len-4' : (nameLen === 3 ? 'len-3' : '');
          pill.innerHTML = `
            <span class="shift-pill-member ${lenClass}">${r.name}</span>
            ${subTypeHtml}
          `;
        } else {
          pill.innerHTML = subTypeHtml;
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

    if (appState.selectedMemberId === 'MAINTENANCE') {
      const slotMembers = getMaintSlotMembers();
      const currentSlot = (appState.selectedMaintSlot !== undefined) ? appState.selectedMaintSlot : 0;
      const currentMemberInfo = slotMembers.find(m => m.slot === currentSlot) || slotMembers[0];
      const shift = getMaintenanceShiftForDate(dateStr, currentSlot);
      const badge = document.createElement('div');
      badge.className = 'single-shift-badge';
      if (shift === '휴' || shift === '휴가') {
        badge.style.borderColor = '#dc2626';
        badge.style.color = '#dc2626';
        badge.style.backgroundColor = '#fef2f2';
        badge.textContent = '휴';
      } else if (shift === '비') {
        badge.style.borderColor = '#d1fae5';
        badge.style.color = '#10b981';
        badge.style.backgroundColor = '#f4fbf8';
        badge.textContent = '비';
      } else if (shift === '야') {
        badge.style.borderColor = '#cbd5e1';
        badge.style.color = '#475569';
        badge.style.backgroundColor = '#f1f5f9';
        badge.textContent = '야';
      } else if (shift === '조') {
        badge.style.borderColor = '#cbd5e1';
        badge.style.color = '#475569';
        badge.style.backgroundColor = '#f1f5f9';
        badge.textContent = '조';
      } else {
        // 일근 (기본)
        badge.style.borderColor = '#cbd5e1';
        badge.style.color = '#475569';
        badge.style.backgroundColor = '#f1f5f9';
        badge.textContent = '일';
      }
      badge.title = `${currentMemberInfo.name} (${currentMemberInfo.role}): ${shift === '비' ? '비번 (휴무)' : (shift === '휴' || shift === '휴가' ? '휴가' : `${shift}근`)} - 터치/클릭 시 근무 변경 및 일정 관리`;
      badge.addEventListener('click', openBadgeModalHandler);
      singleShiftWrap.appendChild(badge);
    } else {
      const target = roster.find(r => r.memberId === appState.selectedMemberId);
      if (target) {
        const activeShifts = getMemberActiveShifts(target);
        if (target.isLeave) {
          const badge = document.createElement('div');
          badge.className = 'single-shift-badge';
          badge.style.borderColor = '#dc2626';
          badge.style.color = '#dc2626';
          badge.style.backgroundColor = '#fef2f2';
          const leaveInfo = getMemberLeaveInfo(dateStr, target.name);
          const lType = target.leaveType || leaveInfo?.leaveType;
          if (lType === '오전반차') {
            badge.innerHTML = `<span class="single-half-wrap"><span>오전</span><span>반차</span></span>`;
          } else if (lType === '오후반차') {
            badge.innerHTML = `<span class="single-half-wrap"><span>오후</span><span>반차</span></span>`;
          } else {
            badge.textContent = '휴'; // 사용자 요청: 한 글자 '휴'로 통일
          }
          badge.title = '터치/클릭 시 근무·휴가·대근 관리';
          badge.addEventListener('click', openBadgeModalHandler);
          singleShiftWrap.appendChild(badge);
        } else if (activeShifts.length >= 2) {
          // [시간 우선순위대로 2개 근무 정렬] 위 [이른 근무], 중간 '+', 아래 [늦은 근무]
          const wrap = document.createElement('div');
          wrap.className = 'single-double-badge-wrap';
          wrap.title = '터치/클릭 시 근무·휴가·대근 관리';

          const s1 = activeShifts[0];
          const s2 = activeShifts[1];

          // 1. 위 박스 (이른 시간 근무: 예) 09~18시 일근)
          const topBadge = document.createElement('div');
          topBadge.className = 'single-shift-badge';
          if (s1.isSub) {
            topBadge.style.borderColor = '#ea580c';
            topBadge.style.color = '#ea580c';
            topBadge.style.backgroundColor = '#fff7ed';
            if (s1.type === '일' && s1.leaveType === '오전반차') {
              topBadge.innerHTML = `<span class="single-half-wrap"><span>오전</span><span>일근</span></span>`;
            } else if (s1.type === '일' && s1.leaveType === '오후반차') {
              topBadge.innerHTML = `<span class="single-half-wrap"><span>오후</span><span>일근</span></span>`;
            } else {
              topBadge.textContent = s1.type;
            }
          } else {
            topBadge.style.borderColor = '#cbd5e1';
            topBadge.style.color = '#475569';
            topBadge.style.backgroundColor = '#f1f5f9';
            topBadge.textContent = s1.type;
          }
          wrap.appendChild(topBadge);

          // 2. 중간 '+' 기호
          const plusSpan = document.createElement('span');
          plusSpan.className = 'single-badge-plus';
          plusSpan.textContent = '+';
          wrap.appendChild(plusSpan);

          // 3. 아래 박스 (늦은 시간 근무: 예) 18~24시 야근)
          const bottomBadge = document.createElement('div');
          bottomBadge.className = 'single-shift-badge';
          if (s2.isSub) {
            bottomBadge.style.borderColor = '#ea580c';
            bottomBadge.style.color = '#ea580c';
            bottomBadge.style.backgroundColor = '#fff7ed';
            if (s2.type === '일' && s2.leaveType === '오전반차') {
              bottomBadge.innerHTML = `<span class="single-half-wrap"><span>오전</span><span>일근</span></span>`;
            } else if (s2.type === '일' && s2.leaveType === '오후반차') {
              bottomBadge.innerHTML = `<span class="single-half-wrap"><span>오후</span><span>일근</span></span>`;
            } else {
              bottomBadge.textContent = s2.type;
            }
          } else {
            bottomBadge.style.borderColor = '#cbd5e1';
            bottomBadge.style.color = '#475569';
            bottomBadge.style.backgroundColor = '#f1f5f9';
            bottomBadge.textContent = s2.type;
          }
          wrap.appendChild(bottomBadge);

          wrap.addEventListener('click', openBadgeModalHandler);
          singleShiftWrap.appendChild(wrap);
        } else if (activeShifts.length === 1 && activeShifts[0].isSub) {
          // 비번 날 단독 대근 등 -> 웜 오렌지
          const badge = document.createElement('div');
          badge.className = 'single-shift-badge';
          badge.style.borderColor = '#ea580c';
          badge.style.color = '#ea580c';
          badge.style.backgroundColor = '#fff7ed';
          const s = activeShifts[0];
          if (s.type === '일' && s.leaveType === '오전반차') {
            badge.innerHTML = `<span class="single-half-wrap"><span>오전</span><span>일근</span></span>`;
          } else if (s.type === '일' && s.leaveType === '오후반차') {
            badge.innerHTML = `<span class="single-half-wrap"><span>오후</span><span>일근</span></span>`;
          } else {
            badge.textContent = s.type;
          }
          badge.title = '터치/클릭 시 근무·휴가·대근 관리';
          badge.addEventListener('click', openBadgeModalHandler);
          singleShiftWrap.appendChild(badge);
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
    }

    cell.appendChild(singleShiftWrap);

    // [개인 캘린더 전용] 해당 멤버의 개인 일정이 있으면 달력 셀에 표시 (전체 근무 모드 또는 타인 달력에는 비표시)
    const memKey = getActiveMemberStorageKey();
    const pKey = `${dateStr}_${memKey}`;
    const pData = appState.personalMemos && appState.personalMemos[pKey];
    if (pData) {
      let items = pData.items;
      if (!items && pData.text) {
        items = pData.text.split('\n').filter(l => l.trim()).map(line => {
          const m = line.match(/^(\d{1,2}(?::\d{2}|시)?)\s*(.*)$/);
          return m ? { time: m[1], text: m[2] } : { time: '', text: line };
        });
      }
      const validItems = (items || []).filter(it => it && it.text && it.text.trim());
      if (validItems.length > 0) {
        // [사용자 요구사항] 맨 위 첫 번째 개인 일정 딱 1줄만 표기
        // 시간 포함(시간 없을 땐 글자만)하여 최대 10자, 줄바꿈/접힘 없이 까만 글자로만 깔끔하게 표시
        const firstItem = validItems[0];
        const rawTime = firstItem.time ? firstItem.time.trim() : '';
        const rawText = firstItem.text ? firstItem.text.trim() : '';
        const fullStr = rawTime ? `${rawTime} ${rawText}`.trim() : rawText;
        const displayStr = fullStr.slice(0, 10);

        const schedLine = document.createElement('div');
        schedLine.className = 'cell-personal-schedule-line';
        schedLine.textContent = displayStr;

        let tip = `${rawTime ? '[' + rawTime + '] ' : ''}${rawText}`;
        if (validItems.length > 1) {
          tip += ` (외 ${validItems.length - 1}개 일정 더 있음)`;
        }
        tip += ' - 클릭 시 일정 관리';
        schedLine.title = tip;

        schedLine.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          if (!canExecuteAction(350)) return;
          openDayModal(dateStr);
        });

        // 근무 박스와 분리하여 날짜 셀 하단 전용 위치에 배치
        cell.appendChild(schedLine);
      }
    }
  }

  // 3. 셀 전체 배경/여백 클릭 시: 모달 없이 주간 근무 현황만 즉시 이동하여 표시
  cell.addEventListener('click', () => {
    if (!canExecuteAction(200)) return;
    appState.activeWeekDate = dateStr;
    updateCalendarSelection();
    updateBottomStats();
    highlightBottomStats();
    triggerAutoRevertTimer();
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

  // 업무 공지가 있는 경우
  const memoInfo = getWorkMemoInfo(dateStr);
  if (memoInfo.text) {
    // 개별 멤버 페이지에서 모달을 열었을 경우 해당 멤버 확인 완료 처리!
    if (appState.selectedMemberId !== 'ALL') {
      let memberName = '';
      if (appState.selectedMemberId === 'MAINTENANCE') {
        const slotMembers = getMaintSlotMembers();
        const currentSlot = (appState.selectedMaintSlot !== undefined) ? appState.selectedMaintSlot : 0;
        const currentMaint = slotMembers.find(m => m.slot === currentSlot) || slotMembers[0];
        memberName = currentMaint ? currentMaint.name : '정비팀';
      } else {
        const currentMember = appState.members.find(m => m.id === appState.selectedMemberId);
        memberName = currentMember ? currentMember.name : '';
      }
      if (memberName) {
        confirmWorkNoticeForMember(dateStr, memberName);
      }
    }
  }

  // 메모 바(업무 공지 & 개인 일정) 세팅
  const isIndividualMode = (appState.selectedMemberId !== 'ALL');
  const memoContainer = document.getElementById('modal-memo-container');
  const subtitleEl = document.getElementById('modal-subtitle');
  const workCard = memoContainer ? memoContainer.querySelector('.memo-work-card') : null;
  const personalCard = memoContainer ? memoContainer.querySelector('.memo-personal-card') : null;

  // 1. 업무 공지 메모 세팅 (전체 모드와 개인 모드 공통 제공)
  const workInput = document.getElementById('memo-work-text');
  const urgentCheck = document.getElementById('memo-work-urgent-check');
  if (workInput) {
    workInput.value = memoInfo.text;
    autoResizeMemoTextarea(workInput, 999);
  }
  if (urgentCheck) {
    urgentCheck.checked = memoInfo.isUrgent;
  }


  if (memoContainer) {
    memoContainer.style.display = 'flex';
  }
  if (workCard) {
    workCard.style.display = 'flex';
  }

  if (isIndividualMode) {
    if (subtitleEl) subtitleEl.style.display = 'none';
    if (personalCard) personalCard.style.display = 'flex';

    // 2. 개인 일정 메모 세팅 (선택된 멤버별 독립 저장, 최대 5줄, 종 모양 알람 토글)
    setupPersonalScheduleModalUI(dateStr);
  } else {
    // 전체 근무 모드일 때: 업무 공지 바 표시, 개인 일정 바는 숨김
    if (subtitleEl) subtitleEl.style.display = 'none';
    if (personalCard) personalCard.style.display = 'none';
  }

  renderDayModalBody(dateStr);

  const modalOverlay = document.getElementById('day-modal-overlay');
  const modal = document.getElementById('day-modal');
  if (modal) {
    modal.style.transform = '';
    modal.style.transition = '';
    modal.classList.remove('is-dragging');
  }
  if (modalOverlay) {
    modalOverlay.style.opacity = '';
    modalOverlay.style.transition = '';
    modalOverlay.classList.add('active');
  }
}

function renderDayModalBody(dateStr) {
  const roster = getDayShiftRoster(dateStr);
  const coverage = checkDayCoverageGap(roster);
  const container = document.getElementById('shift-detail-list');
  container.innerHTML = '';

  // 정비 개인 근무표 모달 전용 카드 렌더링
  if (appState.selectedMemberId === 'MAINTENANCE') {
    const maintCard = document.createElement('div');
    maintCard.className = 'member-card maintenance-modal-card';

    const slotMembers = getMaintSlotMembers();
    const currentSlot = (appState.selectedMaintSlot !== undefined) ? appState.selectedMaintSlot : 0;
    const currentMemberInfo = slotMembers.find(m => m.slot === currentSlot) || slotMembers[0];

    const curShift = getMaintenanceShiftForDate(dateStr, currentSlot);
    const maintHours = getMaintenanceWeekHours(dateStr, currentSlot);
    const isOver = maintHours > MAX_WEEKLY_HOURS;
    let hoursColor = isOver ? '#dc2626' : (maintHours >= 45 ? '#d97706' : '#16a34a');

    let curBadgeHtml = '';
    let curTimeHint = '09:00 ~ 18:00';
    if (curShift === '휴' || curShift === '휴가') {
      curBadgeHtml = `<span class="member-shift-badge" style="border: 1.5px solid #dc2626; color: #dc2626; background-color: #fef2f2;">휴가 (휴)</span>`;
      curTimeHint = '휴가';
    } else if (curShift === '비') {
      curBadgeHtml = `<span class="member-shift-badge" style="border: 1.5px solid #d1fae5; color: #10b981; background-color: #f4fbf8;">비번 (비)</span>`;
      curTimeHint = '휴무 (Off)';
    } else if (curShift === '야') {
      curBadgeHtml = `<span class="member-shift-badge" style="border: 1.5px solid #cbd5e1; color: #475569; background-color: #f1f5f9;">야근 (야)</span>`;
      curTimeHint = '18:00 ~ 24:00';
    } else if (curShift === '조') {
      curBadgeHtml = `<span class="member-shift-badge" style="border: 1.5px solid #cbd5e1; color: #475569; background-color: #f1f5f9;">조근 (조)</span>`;
      curTimeHint = '00:00 ~ 09:00';
    } else {
      curBadgeHtml = `<span class="member-shift-badge" style="border: 1.5px solid #cbd5e1; color: #475569; background-color: #f1f5f9;">일근 (일)</span>`;
      curTimeHint = '09:00 ~ 18:00';
    }

    maintCard.innerHTML = `
      <div class="member-card-main">
        <div class="member-name-wrap">
          <span class="member-name" style="color: #0284c7; font-weight: 800;">${currentMemberInfo.name} <small style="font-size:12px; font-weight:600; color:#64748b;">(${currentMemberInfo.role})</small></span>
          ${curBadgeHtml}
          <span class="member-time-hint">${curTimeHint}</span>
        </div>
        <div>
          <div class="member-modal-stat-pill ${isOver ? 'is-over' : ''}" title="${currentMemberInfo.name} 주간 누적: ${maintHours}시간 / 52시간">
            <span class="modal-stat-hours" style="color:${hoursColor};">${maintHours}</span>
            <span class="modal-stat-divider">/</span>
            <span class="modal-stat-limit">52h</span>
          </div>
        </div>
      </div>
      <div class="maint-shift-selector-wrap">
        <span class="maint-selector-label">당일 근무 설정:</span>
        <div class="maint-btn-group">
          <button type="button" class="btn-maint-shift ${curShift === '일' ? 'active' : ''}" data-shift="일">일근</button>
          <button type="button" class="btn-maint-shift ${curShift === '야' ? 'active' : ''}" data-shift="야">야근</button>
          <button type="button" class="btn-maint-shift ${curShift === '조' ? 'active' : ''}" data-shift="조">조근</button>
          <button type="button" class="btn-maint-shift ${curShift === '비' ? 'active' : ''}" data-shift="비">비번</button>
          <button type="button" class="btn-maint-shift ${curShift === '휴' || curShift === '휴가' ? 'active is-leave' : ''}" data-shift="휴">휴가</button>
        </div>
      </div>
    `;

    maintCard.querySelectorAll('.btn-maint-shift').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const selectedShift = btn.dataset.shift;
        setMaintenanceShift(dateStr, selectedShift, currentSlot);
        renderDayModalBody(dateStr);
        renderCalendar();
        showToast(`${currentMemberInfo.name}님 근무가 [${selectedShift === '비' ? '비번' : (selectedShift === '휴' ? '휴가' : selectedShift + '근')}]으로 설정되었습니다.`);
      });
    });

    container.appendChild(maintCard);

    // 송출센터 4인 현황 구분 헤더
    const dividerSection = document.createElement('div');
    dividerSection.className = 'modal-sub-section-title';
    dividerSection.style.cssText = 'padding: 10px 4px 6px; font-size: 12px; font-weight: 700; color: #64748b; border-bottom: 1px solid #e2e8f0; margin-top: 10px; margin-bottom: 8px;';
    dividerSection.textContent = '송출센터 4인 근무 현황 (참고)';
    container.appendChild(dividerSection);

    // 송출 4인의 참고 카드 렌더링
    roster.forEach(memberItem => {
      const card = document.createElement('div');
      card.className = 'member-card';
      if (memberItem.isLeave) card.classList.add('has-leave');
      if (memberItem.isSubstitute) card.classList.add('has-substitute');

      const activeShifts = getMemberActiveShifts(memberItem);
      const shiftInfo = SHIFT_DETAILS[memberItem.baseShift];
      let timeHint = shiftInfo.time;

      let badgeHtml = '';
      if (memberItem.isLeave) {
        badgeHtml = `<span class="member-shift-badge" style="border: 1.5px solid #dc2626; color: #dc2626; background-color: #fef2f2;">휴가 (휴)</span>`;
      } else if (activeShifts.length >= 2) {
        timeHint = activeShifts.map(s => s.time).filter(Boolean).join(' + ');
        const badges = activeShifts.map(s => {
          if (s.isSub) {
            return `<span class="member-shift-badge" style="border: 1.5px solid #ea580c; color: #ea580c; background-color: #fff7ed;">대근 (${s.type})</span>`;
          } else {
            return `<span class="member-shift-badge" style="border: 1.5px solid #cbd5e1; color: #475569; background-color: #f1f5f9;">${s.name} (${s.type})</span>`;
          }
        });
        badgeHtml = `
          <div style="display:inline-flex; align-items:center; gap:4px;">
            ${badges[0]}
            <span style="font-size:11px; font-weight:800; color:#94a3b8;">+</span>
            ${badges[1]}
          </div>
        `;
      } else if (activeShifts.length === 1 && activeShifts[0].isSub) {
        const s = activeShifts[0];
        timeHint = s.time;
        badgeHtml = `<span class="member-shift-badge" style="border: 1.5px solid #ea580c; color: #ea580c; background-color: #fff7ed;">대근 (${s.type})</span>`;
      } else {
        if (memberItem.baseShift === '비') {
          badgeHtml = `<span class="member-shift-badge" style="border: 1.5px solid #d1fae5; color: #34d399; background-color: #f4fbf8; opacity: 0.85;">비번 (비)</span>`;
        } else {
          badgeHtml = `<span class="member-shift-badge" style="border: 1.5px solid #cbd5e1; color: #475569; background-color: #f1f5f9;">${shiftInfo.name} (${memberItem.baseShift})</span>`;
        }
      }

      const schedule = getWeekSchedule(dateStr);
      const hours = Math.round((schedule.memberWeekHours[memberItem.memberId] || 0) * 10) / 10;
      const isOver = hours > MAX_WEEKLY_HOURS;
      let hoursColor = isOver ? '#dc2626' : (hours >= 45 ? '#d97706' : '#16a34a');

      card.innerHTML = `
        <div class="member-card-main">
          <div class="member-name-wrap">
            <span class="member-name">${memberItem.name}</span>
            ${badgeHtml}
            <span class="member-time-hint">${timeHint}</span>
          </div>
          <div>
            <div class="member-modal-stat-pill ${isOver ? 'is-over' : ''}" title="${memberItem.name} 주간 누적: ${hours}시간 / 52시간">
              <span class="modal-stat-hours" style="color:${hoursColor};">${hours}</span>
              <span class="modal-stat-divider">/</span>
              <span class="modal-stat-limit">52h</span>
            </div>
          </div>
        </div>
      `;
      container.appendChild(card);
    });
    return;
  }

  // 24시간 연속 근무 결원 발생 또는 대근 미배정 시 상단에 독립된 전용 카드 노출
  const unassignedLeaves = (coverage.unassignedLeaves && coverage.unassignedLeaves.length > 0)
    ? coverage.unassignedLeaves
    : roster.filter(r => r.isLeave && (r.substituteId === null || r.substituteId === undefined) && !r.customSubName);
  if (coverage.hasGap || unassignedLeaves.length > 0) {
    const missingShiftsArr = (coverage.missingShifts && coverage.missingShifts.length > 0) 
      ? coverage.missingShifts 
      : unassignedLeaves.map(r => r.baseShift);
    const fallbackMissingTime = missingShiftsArr.map(s => SHIFT_DETAILS[s]?.time || '').filter(Boolean).join(', ') || '시간대 결원';

    if (unassignedLeaves.length > 0) {
      unassignedLeaves.forEach(unassignedMember => {
        const shiftKey = unassignedMember.baseShift;
        const shiftName = SHIFT_DETAILS[shiftKey]?.name || `${shiftKey}근`;
        const rawTime = SHIFT_DETAILS[shiftKey]?.time || fallbackMissingTime;
        const shiftTime = (rawTime || '').replace(/\s*~\s*/, '~');
        const shiftLabelWithTime = shiftTime ? `${shiftName}, ${shiftTime}` : shiftName;
        const leaveInfo = getMemberLeaveInfo(dateStr, unassignedMember.name);
        
        let reasonBadgeHtml = '';
        const hasLeaveSub = (leaveInfo?.subId !== null && leaveInfo?.subId !== undefined) || Boolean(leaveInfo?.customSubName);
        if (leaveInfo?.isManual && !hasLeaveSub) {
          reasonBadgeHtml = `<span class="coverage-reason-badge">대근 해제됨</span>`;
        } else if (unassignedMember.autoSubFailReason && unassignedMember.autoSubFailReason.includes('52시간')) {
          reasonBadgeHtml = `<span class="coverage-reason-badge">52시간 초과</span>`;
        } else {
          reasonBadgeHtml = `<span class="coverage-reason-badge">대근 미지정</span>`;
        }

        const schedule = getWeekSchedule(dateStr);
        const defaultSubRules = appState.subRules || DEFAULT_SUB_RULES;
        let defaultSubCand = null;
        if (unassignedMember.baseShift === '일') {
          defaultSubCand = roster.find(r => r.memberId !== unassignedMember.memberId && r.baseShift === (defaultSubRules['일'] || '비'));
        } else if (unassignedMember.baseShift === '야') {
          defaultSubCand = roster.find(r => r.memberId !== unassignedMember.memberId && r.baseShift === (defaultSubRules['야'] || '일'));
        } else if (unassignedMember.baseShift === '조') {
          defaultSubCand = roster.find(r => r.memberId !== unassignedMember.memberId && r.baseShift === (defaultSubRules['조'] || '비'));
        }

        let optionsHtml = `<option value="">-- 대근자 선택 --</option>`;
        let menuItemsHtml = `<div class="custom-sub-item placeholder" data-value="">-- 대근자 선택 --</div>`;
        appState.members.forEach(m => {
          if (m.name !== unassignedMember.name) {
            const mRoster = roster.find(r => r.name === m.name || r.memberId === m.id);
            let statusText = '';
            let isSub = false;

            if (mRoster?.isLeave) {
              statusText = '현재 휴가';
            } else if (mRoster?.isSubstitute) {
              // 해당 날짜에 m이 대근을 맡고 있는 모든 휴가 건 조회
              const subbedLeaves = roster.filter(r => r.isLeave && (
                (r.substituteId !== null && r.substituteId === m.id) ||
                (r.subMemberName && r.subMemberName === m.name)
              ));
              const subShifts = subbedLeaves.map(l => l.baseShift).join('+') || mRoster.subForShiftType;
              if (mRoster.baseShift === '비') {
                statusText = `현재 대근 ${subShifts}`;
              } else {
                statusText = `현재 ${mRoster.baseShift} + 대근 ${subShifts}`;
              }
              isSub = true;
            } else {
              const curShift = mRoster ? mRoster.baseShift : getBaseShiftForMember(m, dateStr);
              statusText = `현재 ${curShift}`;
            }

            // 주간 누적 근무시간 계산 (현재 근무시간 + 이 결원 근무시간)
            const curHours = Math.round((schedule.memberWeekHours[m.id] || 0) * 10) / 10;
            const neededHours = SHIFT_HOURS[unassignedMember.baseShift] || 0;
            const expectedHours = Math.round((curHours + neededHours) * 10) / 10;
            const isOver52 = (expectedHours > MAX_WEEKLY_HOURS);

            // 대근 해제 여부 검사 (본인이 대근 해제를 한 직원인 경우)
            const hasLeaveSubInCand = (leaveInfo?.subId !== null && leaveInfo?.subId !== undefined) || Boolean(leaveInfo?.customSubName);
            const isCancelledSub = Boolean(
              leaveInfo?.isManual && !hasLeaveSubInCand && (
                (leaveInfo.cancelledSubName && m.name === leaveInfo.cancelledSubName) ||
                (leaveInfo.cancelledSubId !== null && leaveInfo.cancelledSubId !== undefined && m.id === leaveInfo.cancelledSubId) ||
                (!leaveInfo.cancelledSubName && (leaveInfo.cancelledSubId === null || leaveInfo.cancelledSubId === undefined) && defaultSubCand && (m.name === defaultSubCand.name || m.id === defaultSubCand.memberId))
              )
            );

            let extraHint = '';
            let disabledAttr = '';
            let optStyle = '';
            let itemClasses = 'custom-sub-item';
            let itemStyle = '';
            let disableReason = '';

            if (mRoster?.isLeave) {
              disabledAttr = 'disabled';
              optStyle = 'style="color: #475569; font-style: italic;"';
              itemClasses += ' is-disabled';
              itemStyle = 'color: #475569; font-style: italic; cursor: not-allowed;';
              disableReason = 'leave';
            } else if (isCancelledSub) {
              disabledAttr = 'disabled';
              extraHint = ' / 대근 불가';
              optStyle = 'style="color: #475569; font-style: italic;"';
              itemClasses += ' is-disabled';
              itemStyle = 'color: #475569; font-style: italic; cursor: not-allowed;';
              disableReason = 'cancelled';
            } else if (isOver52) {
              disabledAttr = 'disabled';
              extraHint = ` / 52시간 초과 [${expectedHours}h]`;
              optStyle = 'style="color: #475569; font-style: italic;"';
              itemClasses += ' is-disabled';
              itemStyle = 'color: #475569; font-style: italic; cursor: not-allowed;';
              disableReason = 'over52';
            } else if (isSub) {
              // 대근 전용 주황색 폰트 스타일
              optStyle = 'style="color: #ea580c; font-weight: 700;"';
              itemClasses += ' is-sub';
              itemStyle = 'color: #ea580c; font-weight: 700;';
            } else {
              itemStyle = 'color: #0f172a; font-weight: 600;';
            }

            const itemText = `${m.name} (${statusText})${extraHint}`;

            optionsHtml += `<option value="${m.id}" ${disabledAttr} ${optStyle} data-expected-hours="${expectedHours}">${itemText}</option>`;
            menuItemsHtml += `<div class="${itemClasses}" data-value="${m.id}" data-disabled="${Boolean(disabledAttr)}" data-disable-reason="${disableReason}" data-expected-hours="${expectedHours}" style="${itemStyle}">${itemText}</div>`;
          }
        });
        optionsHtml += `<option value="CUSTOM_INPUT">직접 입력</option>`;
        menuItemsHtml += `<div class="custom-sub-item is-custom" data-value="CUSTOM_INPUT" style="color: #2563eb; font-weight: 700; border-top: 1px solid #f1f5f9; margin-top: 2px; padding-top: 8px;">직접 입력</div>`;

        const alertCard = document.createElement('div');
        alertCard.className = 'modal-coverage-alert-card';
        alertCard.innerHTML = `
          <div class="coverage-card-top">
            <div class="coverage-title-wrap">
              <span class="coverage-siren-icon">🚨</span>
              <span class="coverage-main-title">근무 공백</span>
              <span class="coverage-time-tag">(${shiftLabelWithTime})</span>
            </div>
            ${reasonBadgeHtml}
          </div>
          <div class="coverage-card-action">
            <span class="coverage-action-label">대근 수동 지정:</span>
            <div class="custom-sub-dropdown" data-for-member="${unassignedMember.memberId}" data-for-name="${unassignedMember.name}">
              <button type="button" class="custom-sub-btn" aria-haspopup="listbox">
                <span class="custom-sub-label">-- 대근자 선택 --</span>
                <span class="custom-sub-chevron">▼</span>
              </button>
              <div class="custom-sub-menu" role="listbox" style="display:none;">
                ${menuItemsHtml}
              </div>
              <select class="select-sub-manual coverage-sub-select" style="display:none;" data-for-member="${unassignedMember.memberId}" data-for-name="${unassignedMember.name}">
                ${optionsHtml}
              </select>
            </div>
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
      const fallbackShiftLabels = missingShiftsArr.map(s => {
        const name = SHIFT_DETAILS[s]?.name || `${s}근`;
        const time = (SHIFT_DETAILS[s]?.time || '').replace(/\s*~\s*/, '~');
        return time ? `${name}, ${time}` : name;
      }).join(' / ') || '시간대 결원';
      alertCard.innerHTML = `
        <div class="coverage-card-top">
          <div class="coverage-title-wrap">
            <span class="coverage-siren-icon">🚨</span>
            <span class="coverage-main-title">근무 공백</span>
            <span class="coverage-time-tag">(${fallbackShiftLabels})</span>
          </div>
          <span class="coverage-reason-badge">대근 미지정</span>
        </div>
      `;
      container.appendChild(alertCard);
    }
  }

  // 개인 달력 모드일 때 선택된 멤버(본인)를 팝업 목록의 맨 위로 우선 배치
  let displayRoster = [...roster];
  if (appState.selectedMemberId !== 'ALL') {
    displayRoster.sort((a, b) => {
      if (a.memberId === appState.selectedMemberId) return -1;
      if (b.memberId === appState.selectedMemberId) return 1;
      return 0;
    });
  }

  displayRoster.forEach(memberItem => {
    const card = document.createElement('div');
    card.className = 'member-card';
    if (memberItem.isLeave) card.classList.add('has-leave');
    if (memberItem.isSubstitute) card.classList.add('has-substitute');

    const activeShifts = getMemberActiveShifts(memberItem);
    const shiftInfo = SHIFT_DETAILS[memberItem.baseShift];
    let timeHint = shiftInfo.time;

    let badgeHtml = '';
    if (memberItem.isLeave) {
      const leaveInfo = getMemberLeaveInfo(dateStr, memberItem.name);
      const lType = memberItem.leaveType || leaveInfo?.leaveType || '전일';
      let leaveLabel = '휴가 (휴)';
      if (lType === '오전반차') {
        leaveLabel = '휴가 (오전 반차)';
      } else if (lType === '오후반차') {
        leaveLabel = '휴가 (오후 반차)';
      }
      badgeHtml = `<span class="member-shift-badge" style="border: 1.5px solid #dc2626; color: #dc2626; background-color: #fef2f2;">${leaveLabel}</span>`;
    } else if (activeShifts.length >= 2) {
      // 시간 우선순위대로 정렬된 2개 근무 표시
      timeHint = activeShifts.map(s => s.time).filter(Boolean).join(' + ');
      const badges = activeShifts.map(s => {
        if (s.isSub) {
          const subText = s.subLabel || s.type;
          return `<span class="member-shift-badge" style="border: 1.5px solid #ea580c; color: #ea580c; background-color: #fff7ed;">대근 (${subText})</span>`;
        } else {
          return `<span class="member-shift-badge" style="border: 1.5px solid #cbd5e1; color: #475569; background-color: #f1f5f9;">${s.name} (${s.type})</span>`;
        }
      });
      badgeHtml = `
        <div style="display:inline-flex; align-items:center; gap:4px;">
          ${badges[0]}
          <span style="font-size:11px; font-weight:800; color:#94a3b8;">+</span>
          ${badges[1]}
        </div>
      `;
    } else if (activeShifts.length === 1 && activeShifts[0].isSub) {
      const s = activeShifts[0];
      timeHint = s.time;
      const subText = s.subLabel || s.type;
      badgeHtml = `<span class="member-shift-badge" style="border: 1.5px solid #ea580c; color: #ea580c; background-color: #fff7ed;">대근 (${subText})</span>`;
    } else {
      if (memberItem.baseShift === '비') {
        badgeHtml = `<span class="member-shift-badge" style="border: 1.5px solid #d1fae5; color: #34d399; background-color: #f4fbf8; opacity: 0.85;">비번 (비)</span>`;
      } else {
        badgeHtml = `<span class="member-shift-badge" style="border: 1.5px solid #cbd5e1; color: #475569; background-color: #f1f5f9;">${shiftInfo.name} (${memberItem.baseShift})</span>`;
      }
    }

    // 휴가 신청 버튼 / 주간 근무시간 뱃지 영역 렌더링
    let leaveBtnHtml = '';

    if (appState.selectedMemberId === 'ALL') {
      // 1. 전체 근무(ALL) 모드: 2안 (상/하 2열 정밀 스탯형)
      // 주간 근무시간(주 52시간 대비) 및 월간 누계 근무시간(1일~말일 총합) 정갈하게 2열로 표시
      const schedule = getWeekSchedule(dateStr);
      const weekHours = Math.round((schedule.memberWeekHours[memberItem.memberId] || 0) * 10) / 10;
      const isOver = weekHours > MAX_WEEKLY_HOURS;
      let weekHoursColor = '#16a34a';
      if (weekHours >= 45 && weekHours <= 52) {
        weekHoursColor = '#d97706';
      } else if (isOver) {
        weekHoursColor = '#dc2626';
      }

      const [yStr, mStr] = dateStr.split('-');
      const curYear = parseInt(yStr, 10);
      const curMonth = parseInt(mStr, 10) - 1; // 0-indexed
      const monthTotals = getMonthMemberHours(curYear, curMonth);
      const monthHours = monthTotals[memberItem.memberId] || 0;

      leaveBtnHtml = `
        <div class="member-dual-stat-box" title="${memberItem.name} 님 근무시간 통계 (주간: ${weekHours}/52h, ${curMonth + 1}월 총계: ${monthHours}h)">
          <div class="dual-stat-row">
            <span class="dual-stat-label">주간</span>
            <span class="dual-stat-val-group">
              <span class="dual-stat-hours" style="color:${weekHoursColor};">${weekHours}</span>
              <span class="dual-stat-limit">/ 52h</span>
            </span>
          </div>
          <div class="dual-stat-row">
            <span class="dual-stat-label">월간</span>
            <span class="dual-stat-val-group">
              <span class="dual-stat-month-hours">${monthHours}h</span>
            </span>
          </div>
        </div>
      `;
    } else if (memberItem.memberId !== appState.selectedMemberId) {
      // 2. 개인 달력 모드이고 본인이 아닌 다른 3인의 카드인 경우: 주간 누적 근무시간(예: 35/52h) 뱃지 표시
      const schedule = getWeekSchedule(dateStr);
      const hours = Math.round((schedule.memberWeekHours[memberItem.memberId] || 0) * 10) / 10;
      const remain = Math.max(0, Math.round((MAX_WEEKLY_HOURS - hours) * 10) / 10);
      const isOver = hours > MAX_WEEKLY_HOURS;

      let hoursColor = '#16a34a';
      if (hours >= 45 && hours <= 52) {
        hoursColor = '#d97706';
      } else if (isOver) {
        hoursColor = '#dc2626';
      }

      leaveBtnHtml = `
        <div class="member-modal-stat-pill ${isOver ? 'is-over' : ''}" title="${memberItem.name} 주간 누적: ${hours}시간 / 52시간">
          <span class="modal-stat-hours" style="color:${hoursColor};">${hours}</span>
          <span class="modal-stat-divider">/</span>
          <span class="modal-stat-limit">52h</span>
        </div>
      `;
    } else {
      // 3. 개인 달력 모드에서 본인 카드: 휴가 신청/취소 및 휴무일(비번) 안내 제공
      if (memberItem.baseShift === '비' && !memberItem.isLeave) {
        leaveBtnHtml = `<span class="badge-off-tag" title="비번(휴무일)은 쉬는 날이므로 휴가 신청 대상이 아닙니다.">휴무일 (비번)</span>`;
      } else {
        leaveBtnHtml = `
          <button type="button" class="leave-toggle-btn ${memberItem.isLeave ? 'active' : ''}" data-member-id="${memberItem.memberId}" data-member-name="${memberItem.name}" data-base-shift="${memberItem.baseShift}">
            ${memberItem.isLeave ? '✕ 휴가 취소' : '+ 휴가 신청'}
          </button>
        `;
      }
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

    // 1. 휴가자(memberItem.isLeave) 카드: 대근 상태 안내
    // 휴가자 카드 아래에는 대근 해제 바를 부착하지 않고 깨끗하게 유지 (대근 정보는 대근자 카드에서 표시)

    // 2. 대근자(memberItem.isSubstitute) 카드: 
    // 본인 페이지 휴가 팝업(또는 전체 근무 모드)에서 생성하되, 
    // 본인이 휴가가 아닐 때만 대근 컨트롤 및 정보 표시
    // 기존 멤버의 대근 해제 버튼은 오직 본인 페이지(isSelfPage)에서만 제공 (전체 근무 모드에서는 버튼 제거)
    if (memberItem.isSubstitute && !memberItem.isLeave) {
      const leaveMembers = roster.filter(r => 
        r.isLeave && (
          (r.substituteId !== null && r.substituteId === memberItem.memberId) ||
          (r.subMemberName && r.subMemberName === memberItem.name)
        )
      );

      if (leaveMembers.length > 0) {
        const isSelfPage = (appState.selectedMemberId === memberItem.memberId);

        // 첫 번째 대근: 본인 페이지일 때 대근 컨트롤 박스 추가
        const firstLeave = leaveMembers[0];
        if (isSelfPage) {
          const subBox = document.createElement('div');
          subBox.className = 'substitute-control-box sub-assignee-box';
          const firstSubRec = memberItem.assignedSubs?.find(s => s.forMemberId === firstLeave.memberId || s.forName === firstLeave.name);
          const shiftKey = firstSubRec?.shiftType || firstLeave.baseShift;
          let shiftName = SHIFT_DETAILS[shiftKey]?.name || `${shiftKey}근`;
          if (shiftKey === '일') {
            const lType = firstLeave.leaveType || (getMemberLeaveInfo(dateStr, firstLeave.name)?.leaveType);
            if (lType === '오전반차') shiftName = '오전일근';
            else if (lType === '오후반차') shiftName = '오후일근';
          }

          subBox.innerHTML = `
            <div class="sub-status-row">
              <span><span class="sub-name-highlight">${firstLeave.name}</span> 휴가로 <span class="sub-type-badge">${shiftName} 대근</span></span>
              <button type="button" class="btn-mini-cancel btn-cancel-sub" data-for-member="${firstLeave.memberId}" data-for-name="${firstLeave.name}">대근 해제</button>
            </div>
          `;
          card.appendChild(subBox);
        }

        // 동일 멤버의 추가 대근(2개 이상 대근 시): 밑에 추가 대근 카드 및 주간 근무시간 통계 생성
        if (leaveMembers.length > 1) {
          leaveMembers.slice(1).forEach(extraLeave => {
            const extraCard = document.createElement('div');
            extraCard.className = 'member-card has-substitute';
            const extraSubRec = memberItem.assignedSubs?.find(s => s.forMemberId === extraLeave.memberId || s.forName === extraLeave.name);
            const extraShiftKey = extraSubRec?.shiftType || extraLeave.baseShift;
            let extraSubLabel = extraShiftKey;
            if (extraShiftKey === '일') {
              const lType = extraLeave.leaveType || (getMemberLeaveInfo(dateStr, extraLeave.name)?.leaveType);
              if (lType === '오전반차') extraSubLabel = '오전일근';
              else if (lType === '오후반차') extraSubLabel = '오후일근';
            }
            const extraShiftInfo = SHIFT_DETAILS[extraShiftKey] || { name: `${extraShiftKey}근`, time: '' };
            const extraShiftName = (extraShiftKey === '일' && (extraSubLabel === '오전일근' || extraSubLabel === '오후일근')) ? extraSubLabel : (extraShiftInfo.name || `${extraShiftKey}근`);
            const extraTimeHint = extraShiftInfo.time || '';
            const extraBadgeHtml = `<span class="member-shift-badge" style="border: 1.5px solid #ea580c; color: #ea580c; background-color: #fff7ed;">대근 (${extraSubLabel})</span>`;

            let extraStatHtml = '';
            const schedule = getWeekSchedule(dateStr);
            const weekHours = Math.round((schedule.memberWeekHours[memberItem.memberId] || 0) * 10) / 10;
            const isOver = weekHours > MAX_WEEKLY_HOURS;
            let weekHoursColor = '#16a34a';
            if (weekHours >= 45 && weekHours <= 52) weekHoursColor = '#d97706';
            else if (isOver) weekHoursColor = '#dc2626';

            if (appState.selectedMemberId === 'ALL') {
              const [yStr, mStr] = dateStr.split('-');
              const curYear = parseInt(yStr, 10);
              const curMonth = parseInt(mStr, 10) - 1;
              const monthTotals = getMonthMemberHours(curYear, curMonth);
              const monthHours = monthTotals[memberItem.memberId] || 0;

              extraStatHtml = `
                <div class="member-dual-stat-box" title="${memberItem.name} 님 근무시간 통계 (주간: ${weekHours}/52h, ${curMonth + 1}월 총계: ${monthHours}h)">
                  <div class="dual-stat-row">
                    <span class="dual-stat-label">주간</span>
                    <span class="dual-stat-val-group">
                      <span class="dual-stat-hours" style="color:${weekHoursColor};">${weekHours}</span>
                      <span class="dual-stat-limit">/ 52h</span>
                    </span>
                  </div>
                  <div class="dual-stat-row">
                    <span class="dual-stat-label">월간</span>
                    <span class="dual-stat-val-group">
                      <span class="dual-stat-month-hours">${monthHours}h</span>
                    </span>
                  </div>
                </div>
              `;
            } else {
              extraStatHtml = `
                <div class="member-modal-stat-pill ${isOver ? 'is-over' : ''}" title="${memberItem.name} 주간 누적: ${weekHours}시간 / 52시간">
                  <span class="modal-stat-hours" style="color:${weekHoursColor};">${weekHours}</span>
                  <span class="modal-stat-divider">/</span>
                  <span class="modal-stat-limit">52h</span>
                </div>
              `;
            }

            extraCard.innerHTML = `
              <div class="member-card-main">
                <div class="member-name-wrap">
                  <span class="member-name">${memberItem.name}</span>
                  ${extraBadgeHtml}
                  <span class="member-time-hint">${extraTimeHint}</span>
                </div>
                <div>
                  ${extraStatHtml}
                </div>
              </div>
            `;

            if (isSelfPage) {
              const subBox = document.createElement('div');
              subBox.className = 'substitute-control-box sub-assignee-box';
              subBox.innerHTML = `
                <div class="sub-status-row">
                  <span><span class="sub-name-highlight">${extraLeave.name}</span> 휴가로 <span class="sub-type-badge">${extraShiftName} 대근</span></span>
                  <button type="button" class="btn-mini-cancel btn-cancel-sub" data-for-member="${extraLeave.memberId}" data-for-name="${extraLeave.name}">대근 해제</button>
                </div>
              `;
              extraCard.appendChild(subBox);
            }

            container.appendChild(extraCard);
          });
        }
      }
    }

    container.appendChild(card);
  });

  // 3. 외부 수기 대근자(기존 4인 팀원이 아닌 수기 입력 인원) 전용 대근 카드 생성
  // 내부 팀원 대근자 카드와 100% 동일한 일관된 레이아웃(이름, 대근 뱃지, 시간, 대근 안내 및 해제 버튼)으로 별도 카드 추가 표시
  roster.forEach(leaveMember => {
    if (!leaveMember.isLeave) return;
    const leaveInfo = getMemberLeaveInfo(dateStr, leaveMember.name);
    const customSubName = leaveInfo?.customSubName || leaveMember.customSubName;
    if (!customSubName) return;

    const customCard = document.createElement('div');
    customCard.className = 'member-card has-substitute';

    const shiftKey = leaveMember.baseShift;
    const shiftInfo = SHIFT_DETAILS[shiftKey] || { name: `${shiftKey}근`, time: '' };
    const shiftName = shiftInfo.name || `${shiftKey}근`;
    const timeHint = shiftInfo.time || '';

    // 대근자 뱃지: 대근 (조), 대근 (일), 대근 (야) 등 통일된 뱃지 형식
    const badgeHtml = `<span class="member-shift-badge" style="border: 1.5px solid #ea580c; color: #ea580c; background-color: #fff7ed;">대근 (${shiftKey})</span>`;

    customCard.innerHTML = `
      <div class="member-card-main">
        <div class="member-name-wrap">
          <span class="member-name">${customSubName}</span>
          ${badgeHtml}
          <span class="member-time-hint">${timeHint}</span>
        </div>
        <div></div>
      </div>
    `;

    // 하단 대근 상태 및 대근 해제 바: 휴가 신청자 본인 페이지(또는 전체 모드)에서만 표시
    // 다른 사람 페이지에서는 대근 해제 란을 표시하지 않고 깔끔하게 근무 정보만 표시
    const isLeaveMemberPage = (appState.selectedMemberId === leaveMember.memberId);
    const isAllMode = (appState.selectedMemberId === 'ALL');

    if (isLeaveMemberPage || isAllMode) {
      const subBox = document.createElement('div');
      subBox.className = 'substitute-control-box sub-assignee-box';
      subBox.innerHTML = `
        <div class="sub-status-row">
          <span><span class="sub-name-highlight">${leaveMember.name}</span> 휴가로 <span class="sub-type-badge">${shiftName} 대근</span></span>
          <button type="button" class="btn-mini-cancel btn-cancel-sub" data-for-member="${leaveMember.memberId}" data-for-name="${leaveMember.name}">대근 해제</button>
        </div>
      `;
      customCard.appendChild(subBox);
    }

    container.appendChild(customCard);
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
      const baseShift = targetBtn.dataset.baseShift;

      const current = getMemberLeaveInfo(dateStr, memberName);
      if (current && current.isLeave) {
        cancelLeave(dateStr, memberId, memberName);
        return;
      }

      if (baseShift === '일') {
        openLeaveTypePicker(dateStr, memberId, memberName);
      } else {
        registerLeaveWithType(dateStr, memberId, memberName, '전일');
      }
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
        if (chosenSubId !== null && !isNaN(chosenSubId)) {
          const chosenMember = getMemberById(chosenSubId);
          // 1) 당일 휴가 중인 직원 선택 차단 가드
          const mRoster = roster.find(r => r.memberId === chosenSubId || r.name === chosenMember?.name);
          if (mRoster?.isLeave) {
            alert(`[선택 불가] ${chosenMember?.name || '해당 직원'} 님은 당일 휴가 중이므로 대근자로 지정할 수 없습니다.`);
            e.target.value = '';
            return;
          }

          // 2) 대근 해제한 직원 선택 차단 가드
          const forMember = getMemberById(forMemberId) || (forName ? getMemberByName(forName) : null);
          const forShift = forMember?.baseShift || getBaseShiftForMember(forMember || forName, dateStr);
          const forLeaveInfo = getMemberLeaveInfo(dateStr, forName || forMemberId);
          const hasForLeaveSub = (forLeaveInfo?.subId !== null && forLeaveInfo?.subId !== undefined) || Boolean(forLeaveInfo?.customSubName);
          if (forLeaveInfo?.isManual && !hasForLeaveSub) {
            const defaultSubRules = appState.subRules || DEFAULT_SUB_RULES;
            let defaultCand = null;
            if (forShift === '일') defaultCand = roster.find(r => r.memberId !== forMemberId && r.baseShift === (defaultSubRules['일'] || '비'));
            else if (forShift === '야') defaultCand = roster.find(r => r.memberId !== forMemberId && r.baseShift === (defaultSubRules['야'] || '일'));
            else if (forShift === '조') defaultCand = roster.find(r => r.memberId !== forMemberId && r.baseShift === (defaultSubRules['조'] || '비'));

            const isCancelled = Boolean(
              (forLeaveInfo.cancelledSubName && chosenMember?.name === forLeaveInfo.cancelledSubName) ||
              (forLeaveInfo.cancelledSubId !== null && forLeaveInfo.cancelledSubId !== undefined && chosenSubId === forLeaveInfo.cancelledSubId) ||
              (!forLeaveInfo.cancelledSubName && (forLeaveInfo.cancelledSubId === null || forLeaveInfo.cancelledSubId === undefined) && defaultCand && (chosenMember?.name === defaultCand.name || chosenSubId === defaultCand.memberId))
            );
            if (isCancelled) {
              alert(`[선택 불가] ${chosenMember?.name || '해당 직원'} 님은 대근이 해제된 상태이므로 다시 선택할 수 없습니다.`);
              e.target.value = '';
              return;
            }
          }

          // 3) 주 52시간 초과 여부 안전 가드
          const schedule = getWeekSchedule(dateStr);
          const curHours = Math.round((schedule.memberWeekHours[chosenSubId] || 0) * 10) / 10;
          const neededHours = SHIFT_HOURS[forShift] || 8;
          const expectedHours = Math.round((curHours + neededHours) * 10) / 10;
          if (expectedHours > MAX_WEEKLY_HOURS) {
            alert(`[선택 불가] ${chosenMember?.name || '해당 직원'} 님은 해당 대근 배정 시 주간 근무시간이 ${expectedHours}시간으로 법정 상한(52시간)을 초과하여 배정할 수 없습니다.`);
            e.target.value = '';
            return;
          }
        }
        manuallySetSubstitute(dateStr, forMemberId, chosenSubId, forName);
      }
    });
  });

  // 이벤트 바인딩: 커스텀 대근 드롭다운 열기/닫기 토글
  container.querySelectorAll('.custom-sub-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const wrap = btn.closest('.custom-sub-dropdown');
      if (!wrap) return;
      const menu = wrap.querySelector('.custom-sub-menu');
      const isOpen = wrap.classList.contains('is-open');

      // 다른 열린 드롭다운들 닫기
      document.querySelectorAll('.custom-sub-dropdown.is-open').forEach(w => {
        w.classList.remove('is-open');
        const m = w.querySelector('.custom-sub-menu');
        if (m) m.style.display = 'none';
      });

      if (!isOpen && menu) {
        wrap.classList.add('is-open');
        menu.style.display = 'block';
      }
    });
  });

  // 이벤트 바인딩: 커스텀 대근 드롭다운 아이템 선택
  container.querySelectorAll('.custom-sub-item').forEach(item => {
    item.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const wrap = item.closest('.custom-sub-dropdown');
      if (!wrap) return;
      const menu = wrap.querySelector('.custom-sub-menu');
      const label = wrap.querySelector('.custom-sub-label');
      const sel = wrap.querySelector('.select-sub-manual');
      const val = item.dataset.value;
      const isDisabled = item.classList.contains('is-disabled');

      if (isDisabled) {
        const reason = item.dataset.disableReason;
        if (reason === 'over52') {
          const expH = item.dataset.expectedHours;
          alert(`[선택 불가] 해당 직원은 배정 시 주간 근무시간이 ${expH ? expH + '시간으로 ' : ''}법정 상한(52시간)을 초과하여 선택할 수 없습니다.`);
        } else if (reason === 'cancelled') {
          alert(`[선택 불가] 해당 직원은 대근이 해제된 상태이므로 다시 선택할 수 없습니다.`);
        } else if (reason === 'leave') {
          alert(`[선택 불가] 해당 직원은 당일 휴가 중이므로 대근자로 지정할 수 없습니다.`);
        }
        return;
      }

      // 메뉴 닫기
      wrap.classList.remove('is-open');
      if (menu) menu.style.display = 'none';

      if (label) {
        label.textContent = item.textContent;
      }

      if (sel) {
        sel.value = val;
        sel.dispatchEvent(new Event('change'));
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

// 일근 휴가 유형 선택 팝업 (전일 / 오전 반차 / 오후 반차 1줄 팝업) 제어
let pendingLeaveTarget = null;

function openLeaveTypePicker(dateStr, memberId, memberName) {
  pendingLeaveTarget = { dateStr, memberId, memberName };
  const overlay = document.getElementById('leave-type-modal-overlay');
  if (overlay) {
    overlay.style.display = 'flex';
    setTimeout(() => {
      overlay.classList.add('active');
    }, 10);
  }
}

function closeLeaveTypePicker() {
  const overlay = document.getElementById('leave-type-modal-overlay');
  if (overlay) {
    overlay.classList.remove('active');
    setTimeout(() => {
      overlay.style.display = 'none';
      pendingLeaveTarget = null;
    }, 200);
  } else {
    pendingLeaveTarget = null;
  }
}

// 특정 유형(전일, 오전반차, 오후반차)으로 휴가 신청/등록
function registerLeaveWithType(dateStr, memberId, memberNameHint = null, leaveType = '전일') {
  const member = getMemberById(memberId) || (memberNameHint ? getMemberByName(memberNameHint) : null);
  const memberName = member ? member.name : (memberNameHint || String(memberId));

  markDateModified(dateStr);
  if (!appState.leaves[dateStr]) {
    appState.leaves[dateStr] = {};
  }

  // 휴가 등록 (이름 및 유형 확실히 보장)
  appState.leaves[dateStr][memberName] = {
    isLeave: true,
    memberName: memberName,
    leaveType: (leaveType === '오전반차' || leaveType === '오후반차') ? leaveType : '전일',
    subMemberName: null,
    subId: null,
    isManual: false,
    customSubName: null
  };

  // [핵심 기능: 대근자 휴가 신청 시 기존 대근 자동 해제 및 타 직원 대근 자동 기회 부여]
  const dayLeaves = appState.leaves[dateStr];
  if (dayLeaves) {
    Object.keys(dayLeaves).forEach(k => {
      const otherLeave = dayLeaves[k];
      if (!otherLeave || !otherLeave.isLeave) return;
      if (otherLeave.memberName === memberName || k === String(memberId) || (member && k === String(member.id))) return;

      const isAssignedToThisMember =
        (member && otherLeave.subId !== null && otherLeave.subId !== undefined && otherLeave.subId === member.id) ||
        (otherLeave.subMemberName && otherLeave.subMemberName === memberName);

      if (isAssignedToThisMember) {
        otherLeave.subId = null;
        otherLeave.subMemberName = null;
        otherLeave.customSubName = null;
        otherLeave.isManual = false; // 다른 직원이 대근할 수 있도록 자동 배정 풀림
        otherLeave.cancelledSubId = null;
        otherLeave.cancelledSubName = null;
      }
    });
  }

  invalidateScheduleCache();
  appState.lastLocalUpdated = Date.now();
  saveState();

  // 비동기 렌더링으로 터치 이벤트 루프 분리 -> 아이폰 유령 더블 클릭 완벽 방어
  setTimeout(() => {
    renderDayModalBody(dateStr);
    renderCalendar();
  }, 40);
}

// 휴가 취소
function cancelLeave(dateStr, memberId, memberNameHint = null) {
  const member = getMemberById(memberId) || (memberNameHint ? getMemberByName(memberNameHint) : null);
  const memberName = member ? member.name : (memberNameHint || String(memberId));

  markDateModified(dateStr);
  if (appState.leaves && appState.leaves[dateStr]) {
    delete appState.leaves[dateStr][memberName];
    if (member) delete appState.leaves[dateStr][member.id];
    delete appState.leaves[dateStr][memberId];
    if (Object.keys(appState.leaves[dateStr]).length === 0) {
      delete appState.leaves[dateStr];
    }
  }

  invalidateScheduleCache();
  appState.lastLocalUpdated = Date.now();
  saveState();

  setTimeout(() => {
    renderDayModalBody(dateStr);
    renderCalendar();
  }, 40);
}

// 휴가 신청/취소 토글 (하위 호환)
function toggleLeave(dateStr, memberId, memberNameHint = null) {
  const member = getMemberById(memberId) || (memberNameHint ? getMemberByName(memberNameHint) : null);
  const memberName = member ? member.name : (memberNameHint || String(memberId));

  const current = getMemberLeaveInfo(dateStr, member || memberName);
  if (current && current.isLeave) {
    cancelLeave(dateStr, memberId, memberName);
  } else {
    registerLeaveWithType(dateStr, memberId, memberName, '전일');
  }
}

// 대근 해제
function cancelSubstitute(dateStr, forMemberId, forNameHint = null) {
  const member = getMemberById(forMemberId) || (forNameHint ? getMemberByName(forNameHint) : null);
  const memberName = member ? member.name : (forNameHint || String(forMemberId));

  const leaveItem = getMemberLeaveInfo(dateStr, member || memberName);
  if (!leaveItem) return;

  markDateModified(dateStr);

  // 해제 전 대근자 정보 기억 (대근자 선택 옵션 비활성화 및 '/ 대근 해제' 안내 표기용)
  const roster = getDayShiftRoster(dateStr);
  const prevRosterItem = roster?.find(r => r.isSubstitute && (
    (r.subForMemberId !== null && r.subForMemberId === forMemberId) ||
    (leaveItem.subId !== null && r.memberId === leaveItem.subId) ||
    (leaveItem.subMemberName && r.name === leaveItem.subMemberName)
  ));
  const prevSubId = (leaveItem.subId !== null && leaveItem.subId !== undefined) ? leaveItem.subId : (prevRosterItem ? prevRosterItem.memberId : null);
  const prevSubName = leaveItem.subMemberName || (prevRosterItem ? prevRosterItem.name : null);

  leaveItem.subId = null;
  leaveItem.subMemberName = null;
  leaveItem.customSubName = null;
  leaveItem.isManual = true;
  leaveItem.cancelledSubId = prevSubId;
  leaveItem.cancelledSubName = prevSubName;

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
  leaveItem.cancelledSubId = null;
  leaveItem.cancelledSubName = null;

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
  // 모달 닫히기 전 개인 일정 변경사항 자동 확정 저장
  if (appState.activeModalDate && appState.selectedMemberId !== 'ALL') {
    triggerAutoSavePersonalSchedule();
  }
  const overlay = document.getElementById('day-modal-overlay');
  const modal = document.getElementById('day-modal');
  if (overlay) {
    overlay.classList.remove('active');
    overlay.style.opacity = '';
    overlay.style.transition = '';
  }
  if (modal) {
    modal.style.transform = '';
    modal.style.transition = '';
    modal.classList.remove('is-dragging');
  }
  appState.activeModalDate = null;
  renderCalendar();
}

// 스마트폰 바텀 시트 손잡이(선) 및 상단 헤더 잡고 아래로 스와이프/드래그하여 닫기 제스처
function initBottomSheetSwipe() {
  const overlay = document.getElementById('day-modal-overlay');
  const modal = document.getElementById('day-modal');
  if (!overlay || !modal) return;

  let isDragging = false;
  let startY = 0;
  let currentY = 0;
  let startTime = 0;

  // 드래그 시작 가능한 타겟 확인 (손잡이 선 또는 모달 헤더, 닫기 버튼/입력창 제외)
  function canStartDrag(target) {
    if (!target) return false;
    if (target.closest('.modal-close-btn') || target.closest('button') || target.closest('input') || target.closest('select')) {
      return false;
    }
    if (target.closest('.sheet-handle')) return true;
    if (target.closest('.modal-header')) return true;
    return false;
  }

  function onDragStart(clientY, target) {
    if (!overlay.classList.contains('active')) return;
    if (!canStartDrag(target)) return;

    isDragging = true;
    startY = clientY;
    currentY = clientY;
    startTime = Date.now();

    modal.classList.add('is-dragging');
    modal.style.transition = 'none';
  }

  function onDragMove(clientY) {
    if (!isDragging) return;
    currentY = clientY;
    const deltaY = currentY - startY;

    if (deltaY > 0) {
      // 아래로 드래그 시 실시간 손가락 추종
      modal.style.transform = `translateY(${deltaY}px)`;
      const opacity = Math.max(0.15, 1 - (deltaY / 380));
      overlay.style.opacity = String(opacity);
    } else {
      // 위로는 살짝의 저항감만 제공
      modal.style.transform = `translateY(${deltaY * 0.15}px)`;
    }
  }

  function onDragEnd() {
    if (!isDragging) return;
    isDragging = false;
    modal.classList.remove('is-dragging');

    const deltaY = currentY - startY;
    const elapsed = Math.max(1, Date.now() - startTime);
    const velocity = deltaY / elapsed; // px/ms

    // 판정 임계치: 70px 이상 아래로 내렸거나, 빠르게 아래로 휙 내렸을 때 닫기
    const shouldClose = (deltaY > 70) || (velocity > 0.35 && deltaY > 20);

    if (shouldClose) {
      modal.style.transition = 'transform 0.22s cubic-bezier(0.16, 1, 0.3, 1)';
      modal.style.transform = 'translateY(100%)';
      overlay.style.transition = 'opacity 0.22s ease';
      overlay.style.opacity = '0';

      setTimeout(() => {
        closeDayModal();
        modal.style.transform = '';
        modal.style.transition = '';
        overlay.style.opacity = '';
        overlay.style.transition = '';
      }, 220);
    } else {
      // 원래 위치로 통통 튀며 복원 (스프링 백)
      modal.style.transition = 'transform 0.24s cubic-bezier(0.16, 1, 0.3, 1)';
      modal.style.transform = 'translateY(0)';
      overlay.style.transition = 'opacity 0.24s ease';
      overlay.style.opacity = '1';

      setTimeout(() => {
        modal.style.transform = '';
        modal.style.transition = '';
        overlay.style.opacity = '';
        overlay.style.transition = '';
      }, 240);
    }
  }

  // 모바일 터치 이벤트
  modal.addEventListener('touchstart', (e) => {
    if (e.touches.length === 1) {
      onDragStart(e.touches[0].clientY, e.target);
    }
  }, { passive: true });

  window.addEventListener('touchmove', (e) => {
    if (isDragging && e.touches.length === 1) {
      onDragMove(e.touches[0].clientY);
    }
  }, { passive: true });

  window.addEventListener('touchend', () => {
    if (isDragging) onDragEnd();
  });

  window.addEventListener('touchcancel', () => {
    if (isDragging) onDragEnd();
  });

  // PC 마우스 드래그 지원
  modal.addEventListener('mousedown', (e) => {
    if (e.button === 0) { // 좌클릭
      onDragStart(e.clientY, e.target);
    }
  });

  window.addEventListener('mousemove', (e) => {
    if (isDragging) {
      onDragMove(e.clientY);
    }
  });

  window.addEventListener('mouseup', () => {
    if (isDragging) onDragEnd();
  });
}

// ==========================================
// 6-1. 캘린더 월 이동 및 사람(개인/정비팀) 스와이프 제스처 전환
// 스마트폰 터치, 터치 PC/태블릿 및 PC 마우스 드래그 완벽 지원
// ==========================================
function goToPrevMonth(animDirection = 'slide-from-left') {
  if (appState.currentMonth === 0) {
    appState.currentYear--;
    appState.currentMonth = 11;
  } else {
    appState.currentMonth--;
  }
  renderCalendar(animDirection, true);
}

function goToNextMonth(animDirection = 'slide-from-right') {
  if (appState.currentMonth === 11) {
    appState.currentYear++;
    appState.currentMonth = 0;
  } else {
    appState.currentMonth++;
  }
  renderCalendar(animDirection, true);
}

// ==========================================
// 투핑거(2-touch: 핀치 줌, 더블 터치 등) 조작 감지 및 스와이프 오동작 방지용 쿨다운
// 사용자 요구: 투핑거 조작 중 손을 떼는 순간 1초 동안 스와이프 절대 차단
// ==========================================
let lastTwoFingerInteractionTime = 0;

function markTwoFingerInteraction() {
  lastTwoFingerInteractionTime = Date.now();
}

// 전역 터치 이벤트에서 2개 이상 손가락 터치 감지 시 즉시 시점 갱신 (캡처링 단계)
window.addEventListener('touchstart', (e) => {
  if (e.touches && e.touches.length >= 2) {
    markTwoFingerInteraction();
  }
}, { capture: true, passive: true });

window.addEventListener('touchmove', (e) => {
  if (e.touches && e.touches.length >= 2) {
    markTwoFingerInteraction();
  }
}, { capture: true, passive: true });

window.addEventListener('touchend', (e) => {
  if (Date.now() - lastTwoFingerInteractionTime < 1000) {
    markTwoFingerInteraction();
  }
}, { capture: true, passive: true });

window.addEventListener('touchcancel', (e) => {
  if (Date.now() - lastTwoFingerInteractionTime < 1000) {
    markTwoFingerInteraction();
  }
}, { capture: true, passive: true });

// ==========================================
// 사용자의 10단계 스와이프 순환 내비게이션
// 우측에서 좌측으로 밀 때 (Next 방향):
// 송출센터(ALL) -> 1번(슬롯0) -> 2번(슬롯1) -> 3번(슬롯2) -> 4번(슬롯3) ->
// 우건제(정비0) -> 조성기(정비1) -> 정현식(정비2) -> 김천일(정비3) -> 이명주(정비4) ->
// 다시 송출센터(ALL) 순환!
//
// 좌측에서 우측으로 당길 때 (Prev 방향, 역순):
// 송출센터(ALL) -> 이명주(정비4) -> 김천일(정비3) -> 정현식(정비2) -> 조성기(정비1) -> 우건제(정비0) ->
// 4번(슬롯3) -> 3번(슬롯2) -> 2번(슬롯1) -> 1번(슬롯0) ->
// 다시 송출센터(ALL) 순환!
// ==========================================
function getSwipeNavigationList() {
  const list = [];

  // 1) 송출센터 전체 (ALL)
  const allChip = document.querySelector('#member-filter-container .filter-chip[data-filter-type="ALL"]');
  list.push({
    type: 'ALL',
    id: 'ALL',
    name: '송출센터',
    element: allChip
  });

  // 2) 송출센터 4인 슬롯 (0, 1, 2, 3)
  (appState.members || []).forEach(m => {
    const chip = document.querySelector(`#member-filter-container .filter-chip[data-member-id="${m.id}"]`);
    list.push({
      type: 'SONGCHUL',
      id: m.id,
      name: m.name,
      element: chip
    });
  });

  // 3) 정비팀 5인 슬롯 (우건제, 조성기, 정현식, 김천일, 이명주)
  const maintSlotMembers = getMaintSlotMembers();
  const maintChip = document.querySelector('#member-filter-container .filter-chip[data-filter-type="MAINTENANCE"]');
  maintSlotMembers.forEach(slotItem => {
    const bottomChip = document.querySelector(`.maint-member-chip[data-maint-slot="${slotItem.slot}"]`);
    list.push({
      type: 'MAINTENANCE',
      id: 'MAINTENANCE',
      maintSlot: slotItem.slot,
      name: slotItem.name,
      element: maintChip,
      bottomElement: bottomChip
    });
  });

  return list;
}

// 하위 호환용 탭 목록 조회
function getFilterTabsList() {
  return getSwipeNavigationList();
}

// 현재 활성화된 스와이프 인덱스 조회 (0~9)
function getCurrentSwipeIndex(list) {
  if (!list || list.length === 0) return 0;

  if (appState.selectedMemberId === 'ALL') {
    return 0;
  }
  if (appState.selectedMemberId === 'MAINTENANCE') {
    const curSlot = (appState.selectedMaintSlot !== undefined) ? appState.selectedMaintSlot : 0;
    const idx = list.findIndex(item => item.type === 'MAINTENANCE' && item.maintSlot === curSlot);
    return idx >= 0 ? idx : 5;
  }
  // 송출센터 4인
  const idx = list.findIndex(item => item.type === 'SONGCHUL' && item.id === appState.selectedMemberId);
  return idx >= 0 ? idx : 0;
}

function getCurrentFilterTabIndex(tabs) {
  return getCurrentSwipeIndex(tabs);
}

// 지정된 사람/슬롯으로 스와이프 전환
function selectSwipeItem(targetItem, animDirection = null) {
  if (!targetItem) return;

  if (targetItem.type === 'ALL') {
    appState.selectedMemberId = 'ALL';
    saveSelectedMemberPref('ALL');
    setupPersonalSyncListener('ALL');
  } else if (targetItem.type === 'SONGCHUL') {
    appState.selectedMemberId = targetItem.id;
    saveSelectedMemberPref(targetItem.name);
    setupPersonalSyncListener(targetItem.id);
  } else if (targetItem.type === 'MAINTENANCE') {
    appState.selectedMemberId = 'MAINTENANCE';
    appState.selectedMaintSlot = targetItem.maintSlot;
    saveSelectedMemberPref('정비팀');
    setupPersonalSyncListener('MAINTENANCE');
  }

  // 상단 필터 칩 활성 상태 갱신
  updateFilterChipsActiveState();

  // 상단 필터 칩 스크롤 (현재 선택된 칩이 화면 중앙에 오도록)
  const filterContainer = document.getElementById('member-filter-container');
  if (filterContainer && targetItem.element) {
    const chipLeft = targetItem.element.offsetLeft;
    const chipWidth = targetItem.element.offsetWidth;
    const containerWidth = filterContainer.clientWidth;
    const scrollTarget = chipLeft - (containerWidth / 2) + (chipWidth / 2);
    filterContainer.scrollTo({ left: Math.max(0, scrollTarget), behavior: 'smooth' });
  }

  // 달력 렌더링 (사람 전환 슬라이드 애니메이션 적용)
  renderCalendar(animDirection, false);

  // 정비팀 슬롯 전환 시 하단 5인 칩 바 상태 및 스크롤 동기화
  if (targetItem.type === 'MAINTENANCE') {
    updateMaintBottomChipsActiveState();
    const bottomContainer = document.getElementById('maint-bottom-members-container');
    if (bottomContainer && targetItem.bottomElement) {
      const bLeft = targetItem.bottomElement.offsetLeft;
      const bWidth = targetItem.bottomElement.offsetWidth;
      const bContainerWidth = bottomContainer.clientWidth;
      const bScrollTarget = bLeft - (bContainerWidth / 2) + (bWidth / 2);
      bottomContainer.scrollTo({ left: Math.max(0, bScrollTarget), behavior: 'smooth' });
    }
  }
}

function selectMemberTab(targetTab, animDirection = null) {
  selectSwipeItem(targetTab, animDirection);
}

// 스와이프: 다음 사람으로 이동 (우->좌 밀기)
function goToNextMember(animDirection = 'slide-from-right') {
  const list = getSwipeNavigationList();
  if (!list || list.length <= 1) return;
  const curIdx = getCurrentSwipeIndex(list);
  const nextIdx = (curIdx + 1) % list.length;
  selectSwipeItem(list[nextIdx], animDirection);
}

// 스와이프: 이전 사람으로 이동 (좌->우 당기기 - 역순)
function goToPrevMember(animDirection = 'slide-from-left') {
  const list = getSwipeNavigationList();
  if (!list || list.length <= 1) return;
  const curIdx = getCurrentSwipeIndex(list);
  const prevIdx = (curIdx - 1 + list.length) % list.length;
  selectSwipeItem(list[prevIdx], animDirection);
}

function initCalendarSwipe() {
  const swipeArea = document.getElementById('calendar-wrapper') || document.getElementById('calendar-zoom-viewport') || document.body;
  if (!swipeArea) return;

  let isTouchSwiping = false;
  let isVerticalScroll = false;
  let touchStartX = 0;
  let touchStartY = 0;
  let touchStartTime = 0;
  let hasTouchMoved = false;

  let isMouseDown = false;
  let mouseStartX = 0;
  let mouseStartY = 0;
  let mouseStartTime = 0;
  let hasMouseMoved = false;

  let suppressClick = false;
  let lastSwitchTime = 0;

  function isModalOpen() {
    return Boolean(document.querySelector('.modal-overlay.active'));
  }

  function canStartSwipe(target) {
    if (isModalOpen()) return false;
    // 사용자 핵심 요구: 투핑거(2-touch: 핀치 줌, 더블 터치 등) 후 최소 1초 동안 스와이프 절대 차단
    if (Date.now() - lastTwoFingerInteractionTime < 1000) return false;
    // 줌 확대 상태(> 1.05)에서는 캘린더 드래그 팬(Pan) 이동이 우선이므로 스와이프 차단
    if (window.calendarZoomCtrl && window.calendarZoomCtrl.scale > 1.05) return false;
    // 줌 컨트롤러 버튼, 날짜 세부 설정 등 버튼/입력창 클릭 시 스와이프 차단
    if (target && (target.closest('.calendar-zoom-controls') || target.closest('button') || target.closest('input') || target.closest('select') || target.closest('textarea'))) {
      return false;
    }
    return true;
  }

  function handleSwipeAction(deltaX, elapsed) {
    // 사용자 핵심 요구: 투핑거 탭/핀치 조작 후 1초 이내 스와이프 100% 원천 차단
    if (Date.now() - lastTwoFingerInteractionTime < 1000) return false;

    const minDistance = 25; // 최소 스와이프 거리 (px) - 손가락/마우스 살짝 밀어도 즉각 반응
    const velocity = Math.abs(deltaX) / Math.max(1, elapsed); // 속도 (px/ms)
    const isFlick = (Math.abs(deltaX) > 15 && velocity > 0.18);
    const isDrag = (Math.abs(deltaX) >= minDistance);

    if (!isFlick && !isDrag) return false;

    const now = Date.now();
    if (now - lastSwitchTime < 350) return false; // 350ms 쿨다운
    lastSwitchTime = now;

    if (deltaX < 0) {
      // 오른쪽에서 왼쪽으로 밀기: 다음 사람(송출센터 -> 송출 4인 -> 정비팀 5인 -> 송출센터)으로 이동!
      goToNextMember('slide-from-right');
      return true;
    } else {
      // 왼쪽에서 오른쪽으로 당기기: 이전 사람(역순)으로 이동!
      goToPrevMember('slide-from-left');
      return true;
    }
  }

  // --- 1. 스마트폰 모바일 / 터치 이벤트 ---
  swipeArea.addEventListener('touchstart', (e) => {
    if (e.touches && e.touches.length >= 2) {
      markTwoFingerInteraction();
      isTouchSwiping = false;
      isVerticalScroll = false;
      hasTouchMoved = false;
      return;
    }
    if (Date.now() - lastTwoFingerInteractionTime < 1000) {
      isTouchSwiping = false;
      isVerticalScroll = false;
      hasTouchMoved = false;
      return;
    }
    if (e.touches.length !== 1) return;
    if (!canStartSwipe(e.target)) return;

    touchStartX = e.touches[0].clientX;
    touchStartY = e.touches[0].clientY;
    touchStartTime = Date.now();
    isTouchSwiping = false;
    isVerticalScroll = false;
    hasTouchMoved = false;
  }, { passive: true });

  swipeArea.addEventListener('touchmove', (e) => {
    if (e.touches && e.touches.length >= 2) {
      markTwoFingerInteraction();
      isTouchSwiping = false;
      return;
    }
    if (Date.now() - lastTwoFingerInteractionTime < 1000) {
      isTouchSwiping = false;
      return;
    }
    if (e.touches.length !== 1 || isVerticalScroll) return;

    const curX = e.touches[0].clientX;
    const curY = e.touches[0].clientY;
    const dx = curX - touchStartX;
    const dy = curY - touchStartY;

    if (!isTouchSwiping && !isVerticalScroll) {
      if (Math.hypot(dx, dy) > 6) {
        if (Math.abs(dx) >= Math.abs(dy)) {
          isTouchSwiping = true;
        } else {
          isVerticalScroll = true;
          return;
        }
      }
    }

    if (isTouchSwiping) {
      if (e.cancelable) {
        e.preventDefault(); // 스와이프 중 브라우저 페이지 뒤로가기 제스처 차단
      }
      if (Math.abs(dx) > 8) {
        hasTouchMoved = true;
      }
    }
  }, { passive: false });

  swipeArea.addEventListener('touchend', (e) => {
    if (Date.now() - lastTwoFingerInteractionTime < 1000) {
      isTouchSwiping = false;
      isVerticalScroll = false;
      hasTouchMoved = false;
      return;
    }

    const curX = (e.changedTouches && e.changedTouches[0]) ? e.changedTouches[0].clientX : touchStartX;
    const curY = (e.changedTouches && e.changedTouches[0]) ? e.changedTouches[0].clientY : touchStartY;
    const dx = curX - touchStartX;
    const dy = curY - touchStartY;
    const elapsed = Date.now() - touchStartTime;

    const wasSwiping = isTouchSwiping;
    const isHorizontal = Math.abs(dx) >= Math.abs(dy);

    isTouchSwiping = false;
    isVerticalScroll = false;

    if (wasSwiping || (isHorizontal && Math.abs(dx) >= 20)) {
      const triggered = handleSwipeAction(dx, elapsed);
      if (triggered || hasTouchMoved) {
        suppressClick = true;
        setTimeout(() => { suppressClick = false; }, 250);
      }
    }
  });

  swipeArea.addEventListener('touchcancel', (e) => {
    if (Date.now() - lastTwoFingerInteractionTime < 1000) {
      isTouchSwiping = false;
      isVerticalScroll = false;
      hasTouchMoved = false;
      return;
    }

    const curX = (e.changedTouches && e.changedTouches[0]) ? e.changedTouches[0].clientX : touchStartX;
    const curY = (e.changedTouches && e.changedTouches[0]) ? e.changedTouches[0].clientY : touchStartY;
    const dx = curX - touchStartX;
    const dy = curY - touchStartY;
    const elapsed = Date.now() - touchStartTime;

    if (isTouchSwiping || (Math.abs(dx) >= 20 && Math.abs(dx) >= Math.abs(dy))) {
      handleSwipeAction(dx, elapsed);
    }
    isTouchSwiping = false;
    isVerticalScroll = false;
  });

  // --- 2. PC 마우스 드래그 이벤트 (클릭 후 좌우 끌기) ---
  swipeArea.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return; // 마우스 좌클릭만
    if (!canStartSwipe(e.target)) return;

    mouseStartX = e.clientX;
    mouseStartY = e.clientY;
    mouseStartTime = Date.now();
    isMouseDown = true;
    hasMouseMoved = false;
  });

  window.addEventListener('mousemove', (e) => {
    if (!isMouseDown) return;

    const dx = e.clientX - mouseStartX;
    const dy = e.clientY - mouseStartY;

    if (Math.hypot(dx, dy) > 6) {
      hasMouseMoved = true;
    }
  });

  window.addEventListener('mouseup', (e) => {
    if (!isMouseDown) return;
    isMouseDown = false;

    const dx = e.clientX - mouseStartX;
    const dy = e.clientY - mouseStartY;
    const elapsed = Date.now() - mouseStartTime;

    const isHorizontal = Math.abs(dx) >= Math.abs(dy);
    const isDrag = Math.abs(dx) >= 25;
    const isFlick = Math.abs(dx) >= 15 && (Math.abs(dx) / Math.max(1, elapsed) > 0.18);

    if (isHorizontal && (isDrag || isFlick)) {
      const triggered = handleSwipeAction(dx, elapsed);
      if (triggered || hasMouseMoved) {
        suppressClick = true;
        setTimeout(() => { suppressClick = false; }, 250);
      }
    }
    hasMouseMoved = false;
  });

  // --- 3. 스와이프 완료 직후 날짜 셀 등이 오클릭되는 현상 차단 ---
  swipeArea.addEventListener('click', (e) => {
    if (suppressClick) {
      e.preventDefault();
      e.stopPropagation();
      suppressClick = false;
    }
  }, true);
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
    if (saved === '정비' || saved === '정비팀' || saved === 'MAINTENANCE') {
      appState.selectedMemberId = 'MAINTENANCE';
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

  // 1) 송출센터(전체 근무) 칩
  const allChip = document.createElement('button');
  allChip.type = 'button';
  allChip.className = `filter-chip ${appState.selectedMemberId === 'ALL' ? 'active' : ''}`;
  allChip.textContent = '송출센터';
  allChip.dataset.filterType = 'ALL';
  allChip.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (!canExecuteAction(200)) return;
    appState.selectedMemberId = 'ALL';
    saveSelectedMemberPref('ALL');
    setupPersonalSyncListener('ALL');
    updateFilterChipsActiveState();
    renderCalendar();
  });
  container.appendChild(allChip);

  // 2) 개별 멤버 4명 칩 (송출 4교대: 이준희, 최혜진, 오승연, 안영주)
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
      setupPersonalSyncListener(m.id);
      updateFilterChipsActiveState();
      renderCalendar();
    });
    container.appendChild(chip);
  });

  // 3) 세련된 구분선 (안영주 옆에 위치하여 기존 송출센터 4인과 정비 근무표를 예쁘게 분리)
  const divider = document.createElement('div');
  divider.className = 'filter-divider';
  divider.setAttribute('role', 'separator');
  divider.setAttribute('aria-orientation', 'vertical');
  container.appendChild(divider);

  // 4) 정비팀 개인 근무표 칩 (안영주 옆 구분선 뒤에 배치)
  const maintChip = document.createElement('button');
  maintChip.type = 'button';
  maintChip.className = `filter-chip chip-maintenance ${appState.selectedMemberId === 'MAINTENANCE' ? 'active' : ''}`;
  maintChip.textContent = '정비팀';
  maintChip.dataset.filterType = 'MAINTENANCE';
  maintChip.title = '정비팀 개인 근무표';
  maintChip.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (!canExecuteAction(200)) return;
    appState.selectedMemberId = 'MAINTENANCE';
    saveSelectedMemberPref('정비팀');
    setupPersonalSyncListener('MAINTENANCE');
    updateFilterChipsActiveState();
    renderCalendar();
  });
  container.appendChild(maintChip);
}

function updateFilterChipsActiveState() {
  const container = document.getElementById('member-filter-container');
  if (!container) return;
  const chips = container.querySelectorAll('.filter-chip');
  chips.forEach(chip => {
    if (chip.dataset.filterType === 'ALL') {
      chip.classList.toggle('active', appState.selectedMemberId === 'ALL');
    } else if (chip.dataset.filterType === 'MAINTENANCE') {
      chip.classList.toggle('active', appState.selectedMemberId === 'MAINTENANCE');
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
    statsContainer.className = 'bottom-stats-bar';
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
  // B. '정비' 선택 모드: 정비팀 5인 근무자 달력 바 (설정창 순서 동적 연동: 송출부장/관리자, 송신소 1번, 송신소 2번, TVR 1번, TVR 2번)
  // 상단 송출 5개 칩(송출센터, 이준희, 최혜진, 오승연, 안영주)과 크기, 폰트, 순서 1:1 완벽 대칭
  else if (appState.selectedMemberId === 'MAINTENANCE') {
    statsContainer.className = 'bottom-stats-bar maint-bottom-stats-bar';
    statsContainer.innerHTML = '';

    const wrap = document.createElement('div');
    wrap.className = 'maint-bottom-members-wrap';
    wrap.id = 'maint-bottom-members-container';

    // 5인 슬롯 정보 (설정창 순서 동적 조회: 우건제 -> 조성기 -> 정현식 -> 김천일 -> 이명주)
    const maintMembersList = getMaintSlotMembers();

    // 상단 칩들의 실제 너비를 동적으로 조회하여 1:1 완벽 대칭 매핑
    const topAllChip = document.querySelector('#member-filter-container .filter-chip[data-filter-type="ALL"]');
    const topMemberChips = document.querySelectorAll('#member-filter-container .filter-chip[data-member-id]');
    const allChipWidth = (topAllChip && topAllChip.getBoundingClientRect().width > 0)
      ? topAllChip.getBoundingClientRect().width
      : null;
    const memberWidths = Array.from(topMemberChips).map(c => {
      const w = c.getBoundingClientRect().width;
      return w > 0 ? w : null;
    });

    const activeSlot = (appState.selectedMaintSlot !== undefined) ? appState.selectedMaintSlot : 0;

    maintMembersList.forEach((memberInfo, idx) => {
      const chip = document.createElement('button');
      chip.type = 'button';
      const isActive = (activeSlot === memberInfo.slot);
      chip.className = `filter-chip maint-member-chip ${isActive ? 'active' : ''}`;
      chip.textContent = memberInfo.name;
      chip.dataset.maintSlot = String(memberInfo.slot);
      chip.dataset.maintName = memberInfo.name;
      const weekHours = getMaintenanceWeekHours(targetDateStr, memberInfo.slot);
      chip.title = `${memberInfo.name} (${memberInfo.role}) 개인 달력 (주간 ${weekHours}시간)`;

      // 1번째 우건제: 상단 '송출센터'(4글자)와 크기 및 너비 1:1 완벽 일치
      if (idx === 0) {
        chip.classList.add('chip-match-all');
        if (allChipWidth) {
          chip.style.width = `${allChipWidth}px`;
          chip.style.minWidth = `${allChipWidth}px`;
        }
      } else {
        // 2~5번째 조성기, 정현식, 김천일, 이명주: 상단 이준희, 최혜진, 오승연, 안영주와 1:1 동일 너비
        const matchedW = memberWidths[idx - 1];
        if (matchedW) {
          chip.style.width = `${matchedW}px`;
          chip.style.minWidth = `${matchedW}px`;
        }
      }

      chip.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (!canExecuteAction(200)) return;
        appState.selectedMaintSlot = memberInfo.slot;
        updateMaintBottomChipsActiveState();
        renderCalendar();
        saveLocalOnly();
      });

      wrap.appendChild(chip);
    });

    statsContainer.appendChild(wrap);

    // 렌더링 직후 상단 칩 너비가 측정되지 않았을 경우를 대비한 rAF 후속 동기화
    if (!allChipWidth) {
      requestAnimationFrame(() => {
        syncMaintBottomChipsWidth();
      });
    }
  }
  // C. '특정 1인(송출 멤버)' 선택 모드: 개인 주간 누적 근무시간 + 52시간 잔여 대근 가능 시간 + 프로그레스 바
  else {
    statsContainer.className = 'bottom-stats-bar';
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

// 정비팀 하단 5인 칩 너비를 상단 칩과 1:1 완벽 동기화
function syncMaintBottomChipsWidth() {
  const container = document.getElementById('maint-bottom-members-container');
  if (!container) return;
  const topAllChip = document.querySelector('#member-filter-container .filter-chip[data-filter-type="ALL"]');
  const topMemberChips = document.querySelectorAll('#member-filter-container .filter-chip[data-member-id]');
  const allChipWidth = (topAllChip && topAllChip.getBoundingClientRect().width > 0)
    ? topAllChip.getBoundingClientRect().width
    : null;
  const memberWidths = Array.from(topMemberChips).map(c => {
    const w = c.getBoundingClientRect().width;
    return w > 0 ? w : null;
  });

  const bottomChips = container.querySelectorAll('.maint-member-chip');
  bottomChips.forEach((chip, idx) => {
    if (idx === 0 && allChipWidth) {
      chip.style.width = `${allChipWidth}px`;
      chip.style.minWidth = `${allChipWidth}px`;
    } else if (idx > 0 && memberWidths[idx - 1]) {
      chip.style.width = `${memberWidths[idx - 1]}px`;
      chip.style.minWidth = `${memberWidths[idx - 1]}px`;
    }
  });
}

// 정비팀 하단 5인 칩 활성 상태(선택) 업데이트
function updateMaintBottomChipsActiveState() {
  const container = document.getElementById('maint-bottom-members-container');
  if (!container) return;
  const activeSlot = (appState.selectedMaintSlot !== undefined) ? appState.selectedMaintSlot : 0;
  const chips = container.querySelectorAll('.maint-member-chip');
  chips.forEach(chip => {
    const chipSlot = parseInt(chip.dataset.maintSlot, 10);
    chip.classList.toggle('active', activeSlot === chipSlot);
  });
}

// 윈도우 창 크기 변경 시 정비팀 하단 칩 너비 자동 재동기화
window.addEventListener('resize', () => {
  if (appState.selectedMemberId === 'MAINTENANCE') {
    syncMaintBottomChipsWidth();
  }
});

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
// ==========================================
// 8. 설정 모달 (멤버 이름 및 기본 순번, 비밀번호 잠금 관리)
// ==========================================
let currentContactTarget = null; // { type: 'chief'|'songchul'|'maint', id: number|null }

function setSettingsFieldsDisabled(disabled) {
  const refDateInput = document.getElementById('setting-ref-date');
  if (refDateInput) refDateInput.disabled = disabled;

  const chiefInput = document.getElementById('setting-chief-name');
  if (chiefInput) chiefInput.disabled = disabled;

  document.querySelectorAll('.setup-input-name').forEach(el => {
    el.disabled = disabled;
    el.readOnly = disabled;
  });
  document.querySelectorAll('.setup-maint-name').forEach(el => {
    el.disabled = disabled;
    el.readOnly = disabled;
  });
  for (let i = 0; i < 4; i++) {
    const el = document.getElementById(`setup-maint-name-${i}`);
    if (el) {
      el.disabled = disabled;
      el.readOnly = disabled;
    }
  }
  document.querySelectorAll('.setup-select-shift').forEach(el => el.disabled = disabled);
  document.querySelectorAll('.btn-contact-info').forEach(btn => {
    btn.disabled = disabled;
  });

  const timeIlInput = document.getElementById('setting-time-il');
  const timeYaInput = document.getElementById('setting-time-ya');
  const timeJoInput = document.getElementById('setting-time-jo');
  if (timeIlInput) timeIlInput.disabled = disabled;
  if (timeYaInput) timeYaInput.disabled = disabled;
  if (timeJoInput) timeJoInput.disabled = disabled;

  const ruleIlInput = document.getElementById('setting-rule-il');
  const ruleAmIlInput = document.getElementById('setting-rule-am-il');
  const rulePmIlInput = document.getElementById('setting-rule-pm-il');
  const ruleJoInput = document.getElementById('setting-rule-jo');
  const ruleYaInput = document.getElementById('setting-rule-ya');
  const ruleYajoInput = document.getElementById('setting-rule-yajo');
  if (ruleIlInput) ruleIlInput.disabled = disabled;
  if (ruleAmIlInput) ruleAmIlInput.disabled = disabled;
  if (rulePmIlInput) rulePmIlInput.disabled = disabled;
  if (ruleJoInput) ruleJoInput.disabled = disabled;
  if (ruleYaInput) ruleYaInput.disabled = disabled;
  if (ruleYajoInput) ruleYajoInput.disabled = disabled;

  const settingsCard = document.getElementById('settings-modal');
  if (settingsCard) {
    if (disabled) {
      settingsCard.classList.remove('is-edit-mode');
    } else {
      settingsCard.classList.add('is-edit-mode');
    }
  }
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

  // 관리자 (송출부장) 이름 세팅
  const chiefInput = document.getElementById('setting-chief-name');
  if (chiefInput) chiefInput.value = appState.chiefName || '';

  // 정비팀 (4인) 이름 세팅 (클래스 및 ID 양쪽 완벽 매핑)
  for (let i = 0; i < 4; i++) {
    const item = (appState.maintenanceMembers && appState.maintenanceMembers[i]) || DEFAULT_MAINTENANCE_MEMBERS[i];
    const val = item ? (item.name || '') : '';
    const inputById = document.getElementById(`setup-maint-name-${i}`);
    if (inputById) inputById.value = val;
    const inputByClass = document.querySelectorAll('.setup-maint-name')[i];
    if (inputByClass) inputByClass.value = val;
  }

  const timeIlInput = document.getElementById('setting-time-il');
  const timeYaInput = document.getElementById('setting-time-ya');
  const timeJoInput = document.getElementById('setting-time-jo');
  if (timeIlInput) timeIlInput.value = appState.shiftTimes?.['일'] || '09:00~18:00';
  if (timeYaInput) timeYaInput.value = appState.shiftTimes?.['야'] || '18:00~24:00';
  if (timeJoInput) timeJoInput.value = appState.shiftTimes?.['조'] || '00:00~09:00';

  // 대근 자동 배정 규칙 필드 세팅
  const subRules = appState.subRules || DEFAULT_SUB_RULES;
  const ruleIlInput = document.getElementById('setting-rule-il');
  const ruleAmIlInput = document.getElementById('setting-rule-am-il');
  const rulePmIlInput = document.getElementById('setting-rule-pm-il');
  const ruleJoInput = document.getElementById('setting-rule-jo');
  const ruleYaInput = document.getElementById('setting-rule-ya');
  const ruleYajoInput = document.getElementById('setting-rule-yajo');
  if (ruleIlInput) ruleIlInput.value = subRules['일'] || '비';
  if (ruleAmIlInput) {
    const v = subRules['오전일반'] || '비';
    ruleAmIlInput.value = (v === '수동') ? '미지정' : v;
  }
  if (rulePmIlInput) rulePmIlInput.value = subRules['오후일반'] || '비';
  if (ruleJoInput) ruleJoInput.value = subRules['조'] || '비';
  if (ruleYaInput) ruleYaInput.value = subRules['야'] || '일';
  if (ruleYajoInput) ruleYajoInput.value = subRules['야조'] || '조';

  // 4인 멤버 행 렌더링 (사번/이메일 표 컬럼 대신 조그마한 [연락처] 버튼 배치, 완벽 가운데 센터 정렬)
  const rowsContainer = document.getElementById('members-setup-rows');
  rowsContainer.innerHTML = '';

  appState.members.forEach((m, idx) => {
    const row = document.createElement('div');
    row.className = 'setup-row';
    row.innerHTML = `
      <span class="col-num-text">#${idx + 1}</span>
      <input type="text" class="setup-input-name" data-id="${idx}" value="${m.name}" placeholder="이름" maxlength="6" disabled style="text-align: center;">
      <select class="setup-select-shift" data-id="${idx}" disabled style="text-align: center; text-align-last: center;">
        <option value="일" ${m.baseShift === '일' ? 'selected' : ''}>일근</option>
        <option value="야" ${m.baseShift === '야' ? 'selected' : ''}>야근</option>
        <option value="조" ${m.baseShift === '조' ? 'selected' : ''}>조근</option>
        <option value="비" ${m.baseShift === '비' ? 'selected' : ''}>비번</option>
      </select>
      <button type="button" class="btn-contact-info" data-target="songchul" data-id="${idx}" title="${m.name} 연락처 관리" disabled>연락처</button>
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

// ==========================================
// 8-1. 개인별 연락처 팝업 (사번, 전화번호, 이메일)
// ==========================================
function openContactModal(targetType, targetId) {
  // [사용자 요구] 변경 모드가 아니면 연락처 팝업 절대 열지 않음
  if (!isSettingsEditMode) {
    return;
  }

  let roleText = '';
  let nameText = '';

  if (targetType === 'chief') {
    roleText = '관리자 (송출부장)';
    const chiefNameInput = document.getElementById('setting-chief-name');
    nameText = chiefNameInput?.value?.trim() || appState.chiefName || DEFAULT_CHIEF_NAME;
  } else if (targetType === 'songchul') {
    const idx = Number(targetId);
    const m = (appState.members && appState.members[idx]) || DEFAULT_MEMBERS[idx];
    const nameInput = document.querySelector(`#members-setup-rows .setup-input-name[data-id="${idx}"]`);
    roleText = `송출센터 #${idx + 1}`;
    nameText = nameInput?.value?.trim() || m.name || `멤버${idx + 1}`;
  } else if (targetType === 'maint') {
    const idx = Number(targetId);
    const m = (appState.maintenanceMembers && appState.maintenanceMembers[idx]) || DEFAULT_MAINTENANCE_MEMBERS[idx];
    const nameInput = document.getElementById(`setup-maint-name-${idx}`);
    roleText = `정비팀 (${m.role || `직무 ${idx + 1}`})`;
    nameText = nameInput?.value?.trim() || m.name || `정비 ${idx + 1}`;
  }

  // [사용자 핵심 요구]: 연락처는 특정 자리가 아니라 '사람(이름)'에게 종속된 고유값
  // 현재 입력창에 입력된 이름(nameText)을 기준으로 사람 고유 연락처를 가져옴
  const contact = getContactForPerson(nameText);
  const empNo = contact.empNo;
  const phone = contact.phone;
  const email = contact.email;

  currentContactTarget = {
    type: targetType,
    id: (targetId !== undefined && targetId !== null) ? Number(targetId) : null,
    name: nameText
  };

  const titleEl = document.getElementById('contact-modal-title');
  if (titleEl) titleEl.textContent = `${nameText} 연락처 정보`;

  const roleBadgeEl = document.getElementById('contact-target-role');
  if (roleBadgeEl) roleBadgeEl.textContent = roleText;

  const nameTitleEl = document.getElementById('contact-target-name');
  if (nameTitleEl) nameTitleEl.textContent = nameText;

  const empField = document.getElementById('contact-field-empno');
  if (empField) empField.value = empNo;

  const phoneField = document.getElementById('contact-field-phone');
  if (phoneField) phoneField.value = phone;

  const emailField = document.getElementById('contact-field-email');
  if (emailField) emailField.value = email;

  const modeBadge = document.getElementById('contact-mode-badge');
  const saveBtn = document.getElementById('btn-save-contact');

  if (isSettingsEditMode) {
    if (modeBadge) {
      modeBadge.textContent = '수정 가능';
      modeBadge.classList.add('edit-mode');
    }
    if (empField) empField.disabled = false;
    if (phoneField) phoneField.disabled = false;
    if (emailField) emailField.disabled = false;
    if (saveBtn) saveBtn.style.display = 'inline-block';
    setTimeout(() => {
      if (empField) empField.focus();
    }, 120);
  } else {
    if (modeBadge) {
      modeBadge.textContent = '조회 전용 (수정은 [변경] 클릭)';
      modeBadge.classList.remove('edit-mode');
    }
    if (empField) empField.disabled = true;
    if (phoneField) phoneField.disabled = true;
    if (emailField) emailField.disabled = true;
    if (saveBtn) saveBtn.style.display = 'none';
  }

  const overlay = document.getElementById('contact-modal-overlay');
  if (overlay) overlay.classList.add('active');
}

function closeContactModal(autoSave = true) {
  if (autoSave && isSettingsEditMode && currentContactTarget) {
    // 사용자가 입력 후 닫기나 바깥을 눌러도 입력한 내용이 유실되지 않도록 자동 저장
    saveContactModal(false);
  }
  const overlay = document.getElementById('contact-modal-overlay');
  if (overlay) overlay.classList.remove('active');
  currentContactTarget = null;
}

function saveContactModal(closeAfterSave = true) {
  if (!currentContactTarget) return;

  const empField = document.getElementById('contact-field-empno');
  const phoneField = document.getElementById('contact-field-phone');
  const emailField = document.getElementById('contact-field-email');

  const newEmpNo = empField ? empField.value.trim() : '';
  const newPhone = phoneField ? phoneField.value.trim() : '';
  const newEmail = emailField ? emailField.value.trim() : '';

  const targetName = (currentContactTarget.name || '').trim() || (
    currentContactTarget.type === 'chief' ? (appState.chiefName || '송출부장') :
    (currentContactTarget.type === 'songchul' ? (appState.members[currentContactTarget.id]?.name || '멤버') :
    (appState.maintenanceMembers[currentContactTarget.id]?.name || '정비'))
  );

  // [사용자 핵심 요구]: 사람(이름) 고유값으로 레지스트리에 저장하고 전체 슬롯에 즉시 동기화
  setContactForPerson(targetName, {
    empNo: newEmpNo,
    phone: newPhone,
    email: newEmail
  });

  // 사용자 요구: 연락처 팝업에서 [저장] 시 로컬 및 파이어베이스 즉시 영구 저장!
  saveLocalOnly();
  uploadStateToFirebase();

  showToast(`${targetName}님의 연락처(사번·전화·이메일)가 안전하게 저장되었습니다.`);
  if (closeAfterSave) {
    const overlay = document.getElementById('contact-modal-overlay');
    if (overlay) overlay.classList.remove('active');
    currentContactTarget = null;
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

  // [사용자 핵심 요구]:
  // 송출센터 넘버 1, 2, 3, 4(슬롯 0, 1, 2, 3) 순서대로 입력된 사람 이름과 시프트를 읽고,
  // 연락처는 슬롯 인덱스가 아닌 그 사람 이름(newName)의 고유 연락처를 찾아 자동으로 배정!
  const nameInputs = document.querySelectorAll('#members-setup-rows .setup-input-name');
  const shiftSelects = document.querySelectorAll('#members-setup-rows .setup-select-shift');

  const updatedMembers = [];
  nameInputs.forEach((input, idx) => {
    const newName = input.value.trim() || DEFAULT_MEMBERS[idx]?.name || `멤버${idx + 1}`;
    const newShift = shiftSelects[idx]?.value || DEFAULT_MEMBERS[idx]?.baseShift || '일';
    const contact = getContactForPerson(newName);
    updatedMembers.push({
      id: idx, // 위치값 (0: 넘버1, 1: 넘버2, 2: 넘버3, 3: 넘버4)
      name: newName,
      empNo: contact.empNo || '',
      phone: contact.phone || '',
      email: contact.email || '',
      baseShift: newShift
    });
  });

  appState.members = updatedMembers;

  // 관리자 (송출부장 자리): 다른 사람 이름을 입력하면 그 사람 이름으로 갱신되고, 연락처도 그 사람을 따라감
  const chiefInput = document.getElementById('setting-chief-name');
  if (chiefInput) {
    appState.chiefName = chiefInput.value.trim() || DEFAULT_CHIEF_NAME;
    const chiefContact = getContactForPerson(appState.chiefName);
    appState.chiefEmpNo = chiefContact.empNo || '';
    appState.chiefPhone = chiefContact.phone || '';
    appState.chiefEmail = chiefContact.email || '';
  }

  // 정비팀 (넘버 1, 2, 3, 4 슬롯): 순서가 바뀌거나 다른 사람으로 대체되면 그 사람 이름과 연락처로 생성
  if (!Array.isArray(appState.maintenanceMembers) || appState.maintenanceMembers.length !== 4) {
    appState.maintenanceMembers = JSON.parse(JSON.stringify(DEFAULT_MAINTENANCE_MEMBERS));
  }
  const defaultMaintRoles = ['송신소', '송신소', 'TVR', 'TVR'];
  const defaultMaintNames = ['조성기', '정현식', '김천일', '이명주'];
  const maintInputs = document.querySelectorAll('.setup-maint-name');
  for (let i = 0; i < 4; i++) {
    const inputById = document.getElementById(`setup-maint-name-${i}`);
    const inputByClass = maintInputs[i];
    const val = (inputById ? inputById.value : (inputByClass ? inputByClass.value : '')).trim() || defaultMaintNames[i];
    const maintContact = getContactForPerson(val);
    appState.maintenanceMembers[i] = {
      id: i,
      role: defaultMaintRoles[i] || (i < 2 ? '송신소' : 'TVR'),
      name: val,
      empNo: maintContact.empNo || '',
      phone: maintContact.phone || '',
      email: maintContact.email || ''
    };
  }

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
  const ruleAmIl = document.getElementById('setting-rule-am-il')?.value || '비';
  const rulePmIl = document.getElementById('setting-rule-pm-il')?.value || '비';
  const ruleJo = document.getElementById('setting-rule-jo')?.value || '비';
  const ruleYa = document.getElementById('setting-rule-ya')?.value || '일';
  const ruleYajo = document.getElementById('setting-rule-yajo')?.value || '조';

  appState.subRules = {
    '일': ruleIl,
    '오전일반': ruleAmIl,
    '오후일반': rulePmIl,
    '조': ruleJo,
    '야': ruleYa,
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
    shiftTimes: JSON.parse(JSON.stringify(appState.shiftTimes)),
    chiefName: appState.chiefName,
    chiefEmpNo: appState.chiefEmpNo,
    chiefPhone: appState.chiefPhone,
    chiefEmail: appState.chiefEmail,
    maintenanceMembers: JSON.parse(JSON.stringify(appState.maintenanceMembers))
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
      scheduleHistory: appState.scheduleHistory,
      chiefName: appState.chiefName,
      chiefEmpNo: appState.chiefEmpNo || '',
      chiefPhone: appState.chiefPhone || '',
      chiefEmail: appState.chiefEmail || '',
      maintenanceMembers: appState.maintenanceMembers
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

  // 현재 선택된 멤버 필터가 변경된 4인 멤버 목록에 없으면 '전체 근무(ALL)'로 리셋 (정비 개인 근무표 제외)
  if (appState.selectedMemberId !== 'ALL' && appState.selectedMemberId !== 'MAINTENANCE' && !appState.members.some(m => m.id === appState.selectedMemberId)) {
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
// 9. 캘린더 핀치 줌 & 헤더 스티키 오프셋 제어
// ==========================================
function updateStickyHeaderOffset() {
  const header = document.querySelector('.app-header');
  if (header) {
    const h = header.offsetHeight;
    document.documentElement.style.setProperty('--header-height', `${h}px`);
  }
}

class CalendarZoomController {
  constructor() {
    this.viewport = document.getElementById('calendar-zoom-viewport');
    this.layer = document.getElementById('calendar-zoom-layer');
    this.controls = document.getElementById('calendar-zoom-controls');
    this.btnIn = document.getElementById('btn-zoom-in');
    this.btnOut = document.getElementById('btn-zoom-out');
    this.btnReset = document.getElementById('btn-zoom-reset');
    this.label = document.getElementById('zoom-level-text');

    this.scale = 1.0;
    this.panX = 0;
    this.panY = 0;

    this.minScale = 1.0;
    this.maxScale = 2.2;
    this.step = 0.2;

    // Gesture state
    this.isPinching = false;
    this.isPanning = false;
    this.startDist = 0;
    this.startScale = 1.0;
    this.startPanX = 0;
    this.startPanY = 0;
    this.startCenterX = 0;
    this.startCenterY = 0;

    this.touchStartX = 0;
    this.touchStartY = 0;
    this.touchStartPanX = 0;
    this.touchStartPanY = 0;
    this.hasMoved = false;

    // Mouse drag state
    this.isMouseDown = false;
    this.mouseStartX = 0;
    this.mouseStartY = 0;
    this.mouseStartPanX = 0;
    this.mouseStartPanY = 0;

    this.animTimeout = null;

    this.init();
  }

  init() {
    if (!this.viewport || !this.layer) return;

    // Button controls
    if (this.btnIn) {
      this.btnIn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.zoomBy(this.step);
      });
    }

    if (this.btnOut) {
      this.btnOut.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.zoomBy(-this.step);
      });
    }

    if (this.btnReset) {
      this.btnReset.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.resetZoom(true);
      });
    }

    // Touch events on viewport
    this.viewport.addEventListener('touchstart', (e) => this.onTouchStart(e), { passive: false });
    this.viewport.addEventListener('touchmove', (e) => this.onTouchMove(e), { passive: false });
    this.viewport.addEventListener('touchend', (e) => this.onTouchEnd(e), { passive: false });
    this.viewport.addEventListener('touchcancel', (e) => this.onTouchEnd(e), { passive: false });

    // Mouse wheel (Ctrl + Wheel) on PC
    this.viewport.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });

    // Mouse drag on PC when zoomed
    this.viewport.addEventListener('mousedown', (e) => this.onMouseDown(e));
    window.addEventListener('mousemove', (e) => this.onMouseMove(e));
    window.addEventListener('mouseup', (e) => this.onMouseUp(e));

    // Double tap to toggle zoom
    let lastTap = 0;
    this.viewport.addEventListener('touchend', (e) => {
      if (appState.selectedMemberId !== 'ALL') return;
      if (e.changedTouches && e.changedTouches.length === 1 && !this.hasMoved) {
        const now = Date.now();
        if (now - lastTap < 300) {
          e.preventDefault();
          markTwoFingerInteraction();
          if (this.scale > 1.05) {
            this.resetZoom(true);
          } else {
            const touch = e.changedTouches[0];
            const rect = this.viewport.getBoundingClientRect();
            this.zoomTo(1.4, touch.clientX - rect.left, touch.clientY - rect.top, true);
          }
        }
        lastTap = now;
      }
    });

    // Suppress click if moved/panned
    this.viewport.addEventListener('click', (e) => {
      if (this.hasMoved) {
        e.preventDefault();
        e.stopPropagation();
        this.hasMoved = false;
      }
    }, true);

    window.addEventListener('resize', () => {
      this.clampPan();
      this.updateUI();
    });
  }

  updateUI() {
    const isZoomed = (this.scale > 1.01);
    this.viewport.classList.toggle('is-zoomed', isZoomed);
    if (this.controls) {
      this.controls.classList.toggle('is-zoomed', isZoomed);
      if (this.label) {
        this.label.textContent = `${Math.round(this.scale * 100)}%`;
      }
    }

    if (!isZoomed) {
      this.layer.style.transform = 'none';
      this.viewport.style.overflow = 'visible';
    } else {
      this.viewport.style.overflow = 'hidden';
      this.layer.style.transform = `translate(${Math.round(this.panX)}px, ${Math.round(this.panY)}px) scale(${this.scale})`;
    }
  }

  clampPan() {
    if (this.scale <= 1.01) {
      this.panX = 0;
      this.panY = 0;
      return;
    }

    const vWidth = this.viewport.clientWidth;
    const vHeight = this.viewport.clientHeight;
    const lWidth = this.layer.offsetWidth || vWidth;
    const lHeight = this.layer.offsetHeight || vHeight;

    const scaledWidth = lWidth * this.scale;
    const scaledHeight = lHeight * this.scale;

    const minX = Math.min(0, vWidth - scaledWidth);
    const minY = Math.min(0, vHeight - scaledHeight);

    this.panX = Math.max(minX, Math.min(0, this.panX));
    this.panY = Math.max(minY, Math.min(0, this.panY));
  }

  applyTransform(scale, panX, panY, animate = false) {
    this.scale = Math.min(this.maxScale, Math.max(this.minScale, scale));
    this.panX = panX;
    this.panY = panY;
    this.clampPan();

    if (animate) {
      this.layer.classList.add('is-animating');
      clearTimeout(this.animTimeout);
      this.animTimeout = setTimeout(() => {
        this.layer.classList.remove('is-animating');
      }, 240);
    } else {
      this.layer.classList.remove('is-animating');
    }

    this.updateUI();
  }

  zoomBy(delta, focalX = null, focalY = null) {
    const nextScale = Math.min(this.maxScale, Math.max(this.minScale, Math.round((this.scale + delta) * 100) / 100));
    if (Math.abs(nextScale - this.scale) < 0.01) return;

    if (nextScale <= 1.01) {
      this.resetZoom(true);
      return;
    }

    const vWidth = this.viewport.clientWidth;
    const vHeight = this.viewport.clientHeight;
    const cx = (focalX !== null) ? focalX : (vWidth / 2);
    const cy = (focalY !== null) ? focalY : (vHeight / 2);

    const layerX = (cx - this.panX) / this.scale;
    const layerY = (cy - this.panY) / this.scale;

    const nextPanX = cx - layerX * nextScale;
    const nextPanY = cy - layerY * nextScale;

    this.applyTransform(nextScale, nextPanX, nextPanY, true);
  }

  zoomTo(targetScale, focalX, focalY, animate = false) {
    const nextScale = Math.min(this.maxScale, Math.max(this.minScale, targetScale));
    if (nextScale <= 1.01) {
      this.resetZoom(animate);
      return;
    }

    const cx = focalX;
    const cy = focalY;
    const layerX = (cx - this.panX) / this.scale;
    const layerY = (cy - this.panY) / this.scale;

    const nextPanX = cx - layerX * nextScale;
    const nextPanY = cy - layerY * nextScale;

    this.applyTransform(nextScale, nextPanX, nextPanY, animate);
  }

  resetZoom(animate = true) {
    this.scale = 1.0;
    this.panX = 0;
    this.panY = 0;
    if (animate) {
      this.layer.classList.add('is-animating');
      clearTimeout(this.animTimeout);
      this.animTimeout = setTimeout(() => {
        this.layer.classList.remove('is-animating');
      }, 240);
    } else {
      this.layer.classList.remove('is-animating');
    }
    this.updateUI();
  }

  onTouchStart(e) {
    if (e.touches && e.touches.length >= 2) {
      markTwoFingerInteraction();
    }
    if (appState.selectedMemberId !== 'ALL') return;

    if (e.touches.length === 2) {
      markTwoFingerInteraction();
      this.isPinching = true;
      this.isPanning = false;
      const t1 = e.touches[0];
      const t2 = e.touches[1];
      this.startDist = Math.hypot(t2.clientX - t1.clientX, t2.clientY - t1.clientY);
      this.startScale = this.scale;
      this.startPanX = this.panX;
      this.startPanY = this.panY;

      const rect = this.viewport.getBoundingClientRect();
      this.startCenterX = (t1.clientX + t2.clientX) / 2 - rect.left;
      this.startCenterY = (t1.clientY + t2.clientY) / 2 - rect.top;
      this.hasMoved = true;
      e.preventDefault();
    } else if (e.touches.length === 1 && this.scale > 1.01) {
      this.isPanning = true;
      this.isPinching = false;
      this.touchStartX = e.touches[0].clientX;
      this.touchStartY = e.touches[0].clientY;
      this.touchStartPanX = this.panX;
      this.touchStartPanY = this.panY;
      this.hasMoved = false;
    }
  }

  onTouchMove(e) {
    if (e.touches && e.touches.length >= 2) {
      markTwoFingerInteraction();
    }
    if (appState.selectedMemberId !== 'ALL') return;

    if (e.touches.length === 2 && this.isPinching) {
      markTwoFingerInteraction();
      e.preventDefault();
      const t1 = e.touches[0];
      const t2 = e.touches[1];
      const dist = Math.hypot(t2.clientX - t1.clientX, t2.clientY - t1.clientY);
      if (this.startDist > 0) {
        const scaleRatio = dist / this.startDist;
        const nextScale = Math.min(this.maxScale, Math.max(this.minScale, this.startScale * scaleRatio));

        const rect = this.viewport.getBoundingClientRect();
        const currentCenterX = (t1.clientX + t2.clientX) / 2 - rect.left;
        const currentCenterY = (t1.clientY + t2.clientY) / 2 - rect.top;

        const layerX = (this.startCenterX - this.startPanX) / this.startScale;
        const layerY = (this.startCenterY - this.startPanY) / this.startScale;

        const nextPanX = currentCenterX - layerX * nextScale;
        const nextPanY = currentCenterY - layerY * nextScale;

        this.applyTransform(nextScale, nextPanX, nextPanY, false);
      }
    } else if (e.touches.length === 1 && this.isPanning && this.scale > 1.01) {
      const dx = e.touches[0].clientX - this.touchStartX;
      const dy = e.touches[0].clientY - this.touchStartY;

      if (Math.abs(dx) > 5 || Math.abs(dy) > 5) {
        this.hasMoved = true;
        e.preventDefault();
        this.applyTransform(this.scale, this.touchStartPanX + dx, this.touchStartPanY + dy, false);
      }
    }
  }

  onTouchEnd(e) {
    // 2-touch 조작 후 손을 떼는 순간 1초간 스와이프 차단 타이머 즉시 리셋
    markTwoFingerInteraction();

    if (this.isPinching) {
      if (e.touches.length < 2) {
        this.isPinching = false;
        if (this.scale <= 1.05) {
          this.resetZoom(true);
        } else {
          this.clampPan();
          this.updateUI();
        }
      }
    }
    if (this.isPanning && e.touches.length === 0) {
      this.isPanning = false;
      this.clampPan();
      this.updateUI();
    }
  }

  onWheel(e) {
    if (appState.selectedMemberId !== 'ALL') return;
    if (e.ctrlKey) {
      e.preventDefault();
      const rect = this.viewport.getBoundingClientRect();
      const focalX = e.clientX - rect.left;
      const focalY = e.clientY - rect.top;
      const delta = e.deltaY < 0 ? 0.15 : -0.15;
      this.zoomBy(delta, focalX, focalY);
    }
  }

  onMouseDown(e) {
    if (appState.selectedMemberId !== 'ALL') return;
    if (this.scale > 1.01 && e.button === 0) {
      this.isMouseDown = true;
      this.mouseStartX = e.clientX;
      this.mouseStartY = e.clientY;
      this.mouseStartPanX = this.panX;
      this.mouseStartPanY = this.panY;
      this.hasMoved = false;
      this.viewport.classList.add('is-grabbing');
    }
  }

  onMouseMove(e) {
    if (this.isMouseDown && this.scale > 1.01) {
      const dx = e.clientX - this.mouseStartX;
      const dy = e.clientY - this.mouseStartY;
      if (Math.abs(dx) > 4 || Math.abs(dy) > 4) {
        this.hasMoved = true;
        this.applyTransform(this.scale, this.mouseStartPanX + dx, this.mouseStartPanY + dy, false);
      }
    }
  }

  onMouseUp() {
    if (this.isMouseDown) {
      this.isMouseDown = false;
      this.viewport.classList.remove('is-grabbing');
      this.clampPan();
      this.updateUI();
    }
  }

  setMode(mode) {
    if (mode === 'ALL') {
      if (this.controls) this.controls.classList.remove('is-hidden');
    } else {
      this.resetZoom(false);
      if (this.controls) this.controls.classList.add('is-hidden');
    }
  }
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
  window.calendarZoomCtrl = new CalendarZoomController();
  updateStickyHeaderOffset();
  window.addEventListener('resize', updateStickyHeaderOffset);
  renderMemberFilterChips();
  renderCalendar();

  // 이전달 / 다음달 버튼
  document.getElementById('btn-prev-month').addEventListener('click', () => {
    goToPrevMonth('slide-from-left');
  });

  document.getElementById('btn-next-month').addEventListener('click', () => {
    goToNextMonth('slide-from-right');
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

  // 일근 휴가 유형 선택 팝업 (전일 / 오전 반차 / 오후 반차) 이벤트
  const leaveTypeOverlay = document.getElementById('leave-type-modal-overlay');
  if (leaveTypeOverlay) {
    leaveTypeOverlay.querySelectorAll('.btn-leave-type-opt').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (!canExecuteAction(300)) return;
        const targetBtn = e.target.closest('.btn-leave-type-opt') || btn;
        const type = targetBtn.dataset.type || '전일';
        if (pendingLeaveTarget) {
          const { dateStr, memberId, memberName } = pendingLeaveTarget;
          registerLeaveWithType(dateStr, memberId, memberName, type);
        }
        closeLeaveTypePicker();
      });
    });

    const btnCloseLeaveType = document.getElementById('btn-close-leave-type');
    if (btnCloseLeaveType) {
      btnCloseLeaveType.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        closeLeaveTypePicker();
      });
    }

    leaveTypeOverlay.addEventListener('click', (e) => {
      if (e.target === leaveTypeOverlay) {
        closeLeaveTypePicker();
      }
    });
  }

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

  // 연락처 모달 및 [연락처] 버튼 이벤트 연결 (변경 모드에서만 활성화)
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('.btn-contact-info');
    if (btn) {
      e.preventDefault();
      e.stopPropagation();
      // 변경 모드가 아니거나 비활성화된 상태이면 팝업 열기 차단
      if (!isSettingsEditMode || btn.disabled) {
        return;
      }
      const targetType = btn.getAttribute('data-target') || 'chief';
      const targetId = btn.getAttribute('data-id');
      openContactModal(targetType, targetId);
    }
  });

  const btnCloseContact = document.getElementById('btn-close-contact-modal');
  if (btnCloseContact) {
    btnCloseContact.addEventListener('click', () => closeContactModal(true));
  }
  const btnCancelContact = document.getElementById('btn-cancel-contact');
  if (btnCancelContact) {
    btnCancelContact.addEventListener('click', () => closeContactModal(true));
  }
  const btnSaveContact = document.getElementById('btn-save-contact');
  if (btnSaveContact) {
    btnSaveContact.addEventListener('click', () => saveContactModal(true));
  }
  const contactOverlay = document.getElementById('contact-modal-overlay');
  if (contactOverlay) {
    contactOverlay.addEventListener('click', (e) => {
      if (e.target.id === 'contact-modal-overlay') closeContactModal(true);
    });
  }

  // 연락처 모달 인풋에서 엔터키 입력 시 즉시 안전 저장
  ['contact-field-empno', 'contact-field-phone', 'contact-field-email'].forEach(fieldId => {
    const inputEl = document.getElementById(fieldId);
    if (inputEl) {
      inputEl.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          saveContactModal(true);
        }
      });
    }
  });

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

  // 바텀 시트 손잡이(선) 스와이프 다운 닫기 제스처 활성화
  initBottomSheetSwipe();

  // 달력 좌우 스와이프/드래그로 이전달/다음달 넘기기 제스처 활성화
  initCalendarSwipe();

  // 개인 캘린더 전용 메모 및 알림 설정 리스너 등록
  initMemoListeners();

  // 커스텀 대근 드롭다운 외부 클릭 시 닫기
  window.addEventListener('click', (e) => {
    if (!e.target.closest('.custom-sub-dropdown')) {
      document.querySelectorAll('.custom-sub-dropdown.is-open').forEach(w => {
        w.classList.remove('is-open');
        const m = w.querySelector('.custom-sub-menu');
        if (m) m.style.display = 'none';
      });
    }
  });
});

// ==========================================
// 11. 개인 캘린더 전용 메모 및 알림 헬퍼
// ==========================================
// 메모 입력창 내용 길이에 따른 동적 높이 자동 조절 (업무공유 메모 전용)
function autoResizeMemoTextarea(el, maxLines = 5) {
  if (!el) return;
  el.style.height = 'auto';
  const scrollHeight = el.scrollHeight;
  const lineHeight = 19;
  const maxHeight = maxLines * lineHeight + 4;
  if (scrollHeight > maxHeight && maxLines < 99) {
    el.style.height = `${maxHeight}px`;
    el.style.overflowY = 'auto';
  } else {
    el.style.height = `${Math.max(20, scrollHeight)}px`;
    el.style.overflowY = 'hidden';
  }
}

// ==========================================
// [개인 일정 기기 간 비밀번호(PIN) 동기화 시스템]
// 팀원 간에는 절대 공유되지 않으며, 동일 비밀번호를 등록한 본인 기기(PC, 스마트폰 등)끼리만 실시간 동기화
// ==========================================
const SYNC_PIN_STORAGE_PREFIX = 'SONGCHUL_PERSONAL_SYNC_PIN_';
let personalSyncUnsubscribe = null;
let currentSyncedMemberId = null;
let currentSyncedPin = null;
let personalSyncUploadTimer = null;

function getPersonalSyncPin(memberId) {
  if (memberId === 'ALL' || memberId === null || memberId === undefined) return '';
  try {
    return localStorage.getItem(SYNC_PIN_STORAGE_PREFIX + memberId) || '';
  } catch (e) {
    return '';
  }
}

function setPersonalSyncPin(memberId, pin) {
  if (memberId === 'ALL' || memberId === null || memberId === undefined) return;
  try {
    localStorage.setItem(SYNC_PIN_STORAGE_PREFIX + memberId, pin.trim());
  } catch (e) {}
}

function clearPersonalSyncPin(memberId) {
  if (memberId === 'ALL' || memberId === null || memberId === undefined) return;
  try {
    localStorage.removeItem(SYNC_PIN_STORAGE_PREFIX + memberId);
  } catch (e) {}
}

function isMemberSyncConnected(memberId) {
  return !!getPersonalSyncPin(memberId);
}

function generateRandomSyncPin() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

// Firestore 개인 동기화 실시간 리스너 개시
function setupPersonalSyncListener(memberId) {
  if (!db || memberId === 'ALL') return;

  const memKey = (memberId === 'MAINTENANCE') ? getActiveMemberStorageKey() : memberId;

  if (typeof personalSyncUnsubscribe === 'function') {
    try { personalSyncUnsubscribe(); } catch (e) {}
    personalSyncUnsubscribe = null;
  }

  currentSyncedMemberId = memKey;
  const pin = getPersonalSyncPin(memKey);
  currentSyncedPin = pin;

  if (!pin || memKey === null || memKey === undefined) {
    return;
  }

  const docId = `member_${memKey}_pin_${pin}`;
  const docRef = db.collection('personal_sync').doc(docId);

  personalSyncUnsubscribe = docRef.onSnapshot((doc) => {
    if (!doc.exists) return;
    if (doc.metadata && doc.metadata.hasPendingWrites) return;

    const data = doc.data() || {};
    if (data.lastEditorId === MY_CLIENT_ID) return;

    const remoteMemos = data.personalMemos || {};
    const memberSuffix = `_${memKey}`;
    appState.personalMemos = appState.personalMemos || {};
    let changed = false;

    // 해당 멤버의 로컬 키 중 원격에서 삭제된 항목 제거
    Object.keys(appState.personalMemos).forEach(k => {
      if (k.endsWith(memberSuffix) && !remoteMemos[k]) {
        delete appState.personalMemos[k];
        changed = true;
      }
    });

    // 원격에서 새로 들어온 항목 반영
    Object.keys(remoteMemos).forEach(k => {
      if (k.endsWith(memberSuffix)) {
        if (JSON.stringify(appState.personalMemos[k]) !== JSON.stringify(remoteMemos[k])) {
          appState.personalMemos[k] = remoteMemos[k];
          changed = true;
        }
      }
    });

    if (changed) {
      saveLocalOnly();
      renderCalendar();
      if (appState.activeModalDate) {
        setupPersonalScheduleModalUI(appState.activeModalDate);
      }
      showToast(`🔄 [동기화] 개인 일정이 다른 기기에서 실시간 업데이트되었습니다.`);
    }
  }, (err) => {
    console.warn('개인 일정 실시간 동기화 상태:', err);
  });
}

function schedulePersonalSyncUpload(memberId, pin) {
  if (!db || !pin || memberId === 'ALL') return;
  if (personalSyncUploadTimer) clearTimeout(personalSyncUploadTimer);
  personalSyncUploadTimer = setTimeout(() => {
    uploadPersonalSyncData(memberId, pin);
  }, 400);
}

async function uploadPersonalSyncData(memberId, pin) {
  if (!db || !pin || memberId === 'ALL') return;
  const memKey = (memberId === 'MAINTENANCE') ? getActiveMemberStorageKey() : memberId;
  const docId = `member_${memKey}_pin_${pin}`;
  const memberSuffix = `_${memKey}`;

  const memberMemos = {};
  if (appState.personalMemos) {
    Object.keys(appState.personalMemos).forEach(k => {
      if (k.endsWith(memberSuffix)) {
        memberMemos[k] = appState.personalMemos[k];
      }
    });
  }

  try {
    await db.collection('personal_sync').doc(docId).set({
      memberId: memKey,
      personalMemos: memberMemos,
      lastEditorId: MY_CLIENT_ID,
      updatedAt: Date.now()
    });
  } catch (err) {
    console.warn('개인 일정 클라우드 업로드 오류:', err);
  }
}

// [개인 일정 기기 간 동기화 모달 UI 핸들러]
function openPersonalSyncModal() {
  const memberId = appState.selectedMemberId;
  if (memberId === 'ALL') {
    showToast('개인 캘린더를 선택한 상태에서만 동기화를 설정할 수 있습니다.');
    return;
  }

  const memKey = (memberId === 'MAINTENANCE') ? getActiveMemberStorageKey() : memberId;
  let memberName = '본인';
  if (memberId === 'MAINTENANCE') {
    const slotMembers = getMaintSlotMembers();
    const currentSlot = (appState.selectedMaintSlot !== undefined) ? appState.selectedMaintSlot : 0;
    const currentMaint = slotMembers.find(m => m.slot === currentSlot) || slotMembers[0];
    memberName = currentMaint ? `${currentMaint.name} (${currentMaint.role})` : '정비팀';
  } else {
    const member = (appState.members || []).find(m => m.id === memberId);
    memberName = member ? member.name : '본인';
  }

  const overlay = document.getElementById('personal-sync-modal-overlay');
  const titleEl = document.getElementById('sync-modal-title');
  const pinInput = document.getElementById('sync-pin-input');
  const badgeEl = document.getElementById('sync-status-state-badge');
  const btnConnect = document.getElementById('btn-sync-connect');
  const btnDisconnect = document.getElementById('btn-sync-disconnect');

  if (titleEl) titleEl.textContent = `${memberName} 개인 일정 기기 간 동기화`;

  const currentPin = getPersonalSyncPin(memKey);
  if (currentPin) {
    if (pinInput) pinInput.value = currentPin;
    if (badgeEl) {
      badgeEl.className = 'sync-status-badge online';
      badgeEl.textContent = `연결됨 (비밀번호: ${currentPin})`;
    }
    if (btnDisconnect) btnDisconnect.style.display = 'inline-block';
    if (btnConnect) btnConnect.textContent = '비밀번호 변경 / 재연결';
  } else {
    if (pinInput) pinInput.value = '';
    if (badgeEl) {
      badgeEl.className = 'sync-status-badge offline';
      badgeEl.textContent = '이 기기 단독 저장 (동기화 안 됨)';
    }
    if (btnDisconnect) btnDisconnect.style.display = 'none';
    if (btnConnect) btnConnect.textContent = '동기화 연결하기';
  }

  if (overlay) {
    overlay.style.display = 'flex';
    requestAnimationFrame(() => {
      overlay.classList.add('active');
    });
  }
}

function closePersonalSyncModal() {
  const overlay = document.getElementById('personal-sync-modal-overlay');
  if (overlay) {
    overlay.classList.remove('active');
    setTimeout(() => {
      if (!overlay.classList.contains('active')) {
        overlay.style.display = '';
      }
    }, 250);
  }
}

async function handleConnectPersonalSync() {
  const memberId = appState.selectedMemberId;
  if (memberId === 'ALL') return;

  const memKey = (memberId === 'MAINTENANCE') ? getActiveMemberStorageKey() : memberId;
  const pinInput = document.getElementById('sync-pin-input');
  const pin = pinInput ? pinInput.value.trim() : '';

  if (!pin || pin.length < 4) {
    showToast('⚠️ 동기화 비밀번호를 4자리 이상 입력하세요.');
    if (pinInput) pinInput.focus();
    return;
  }

  setPersonalSyncPin(memKey, pin);

  if (db) {
    try {
      showToast('🔄 클라우드 연결 및 동기화 중...');
      const docId = `member_${memKey}_pin_${pin}`;
      const doc = await db.collection('personal_sync').doc(docId).get();

      if (doc.exists) {
        const data = doc.data() || {};
        const remoteMemos = data.personalMemos || {};
        const memberSuffix = `_${memKey}`;
        appState.personalMemos = appState.personalMemos || {};

        // 서버 데이터를 로컬과 병합
        Object.keys(remoteMemos).forEach(k => {
          if (k.endsWith(memberSuffix)) {
            appState.personalMemos[k] = remoteMemos[k];
          }
        });
        saveLocalOnly();
        renderCalendar();
      }

      // 현재 로컬 데이터 업로드
      await uploadPersonalSyncData(memberId, pin);
      setupPersonalSyncListener(memberId);
      showToast(`🔐 [비밀번호: ${pin}] 기기 간 동기화가 성공적으로 연결되었습니다!`);
    } catch (err) {
      console.warn('동기화 연결 실패:', err);
      showToast('⚠️ 클라우드 연결에 실패했습니다. 네트워크를 확인하세요.');
    }
  }

  closePersonalSyncModal();
  if (appState.activeModalDate) {
    setupPersonalScheduleModalUI(appState.activeModalDate);
  }
}

function handleDisconnectPersonalSync() {
  const memberId = appState.selectedMemberId;
  if (memberId === 'ALL') return;

  const memKey = (memberId === 'MAINTENANCE') ? getActiveMemberStorageKey() : memberId;
  clearPersonalSyncPin(memKey);
  if (typeof personalSyncUnsubscribe === 'function') {
    try { personalSyncUnsubscribe(); } catch (e) {}
    personalSyncUnsubscribe = null;
  }
  showToast('🔓 개인 일정 동기화가 해제되었습니다. (이 기기 단독 저장 모드)');
  closePersonalSyncModal();
  if (appState.activeModalDate) {
    setupPersonalScheduleModalUI(appState.activeModalDate);
  }
}

function initPersonalSyncModalListeners() {
  const btnClose = document.getElementById('btn-close-sync-modal');
  if (btnClose) {
    btnClose.addEventListener('click', closePersonalSyncModal);
  }

  const overlay = document.getElementById('personal-sync-modal-overlay');
  if (overlay) {
    overlay.addEventListener('click', (e) => {
      if (e.target.id === 'personal-sync-modal-overlay') closePersonalSyncModal();
    });
  }

  const btnGen = document.getElementById('btn-sync-pin-gen');
  if (btnGen) {
    btnGen.addEventListener('click', () => {
      const pinInput = document.getElementById('sync-pin-input');
      if (pinInput) {
        pinInput.value = generateRandomSyncPin();
        pinInput.focus();
      }
    });
  }

  const btnConnect = document.getElementById('btn-sync-connect');
  if (btnConnect) {
    btnConnect.addEventListener('click', handleConnectPersonalSync);
  }

  const btnDisconnect = document.getElementById('btn-sync-disconnect');
  if (btnDisconnect) {
    btnDisconnect.addEventListener('click', handleDisconnectPersonalSync);
  }
}

// [개인 일정 메모 모달 UI 세팅]
function setupPersonalScheduleModalUI(dateStr) {
  appState.personalMemos = appState.personalMemos || {};
  const memKey = getActiveMemberStorageKey();
  const pKey = `${dateStr}_${memKey}`;
  const pData = appState.personalMemos[pKey] || {
    items: [],
    text: '',
    alertEnabled: false,
    alertDay: '0',
    alertHour: '9',
    alertMin: '0'
  };

  // 기존 저장 데이터와의 하위 호환성 (items가 없으면 text 파싱)
  let items = pData.items;
  if (!items && pData.text) {
    items = pData.text.split('\n').filter(l => l.trim()).map(line => {
      const m = line.match(/^(\d{1,2}(?::\d{2}|시)?)\s*(.*)$/);
      return m ? { time: m[1], text: m[2].slice(0, 15) } : { time: '', text: line.slice(0, 15) };
    });
  }
  if (!items || items.length === 0) {
    items = [{ time: '', text: '' }];
  }

  // 동적 행 렌더링 (평소 일정이 1개뿐이면 1줄로 표시, 최대 5줄)
  renderPersonalScheduleModalRows(items);

  // 종 모양 알람 토글 버튼 및 알람 설정 팝오버 상태 동기화
  const isAlertOn = (pData.alertEnabled === true);
  const btnToggleAlert = document.getElementById('btn-toggle-personal-alert');
  const alertPopover = document.getElementById('personal-alert-popover');
  if (btnToggleAlert) {
    btnToggleAlert.classList.toggle('active', isAlertOn);
    btnToggleAlert.title = isAlertOn ? '알림 설정 켜짐 (클릭 시 시간 변경/해제)' : '알림 설정 (클릭 시 팝업 열기)';
  }
  if (alertPopover) {
    alertPopover.style.display = 'none';
  }

  // 알람 설정 셀렉트 박스 세팅
  const alertDayEl = document.getElementById('memo-alert-day');
  if (alertDayEl) {
    if (isAlertOn) {
      alertDayEl.value = (pData.alertDay !== undefined && pData.alertDay !== null) ? String(pData.alertDay) : '0';
    } else {
      alertDayEl.value = '0';
    }
  }
  const alertHourEl = document.getElementById('memo-alert-hour');
  if (alertHourEl) alertHourEl.value = (pData.alertHour !== undefined && pData.alertHour !== null) ? String(pData.alertHour) : '9';
  const alertMinEl = document.getElementById('memo-alert-min');
  if (alertMinEl) alertMinEl.value = (pData.alertMin !== undefined && pData.alertMin !== null) ? String(pData.alertMin) : '0';

  // 일정 시간 설정 여부에 따라 '전 알림' vs '알림' 자동 전환
  updatePersonalAlertTextMode();
}

function checkHasPersonalScheduleTime() {
  const container = document.getElementById('personal-schedule-rows-wrap');
  const rows = container ? container.querySelectorAll('.personal-schedule-row') : [];
  return Array.from(rows).some(r => {
    const s = r.querySelector('.personal-time-select');
    return s && s.value && s.value !== '' && s.value !== '시간';
  });
}

function updatePersonalAlertTextMode() {
  const prefixEl = document.getElementById('memo-alert-prefix-text');
  if (prefixEl) {
    prefixEl.style.display = 'none';
  }
}

function renderPersonalScheduleModalRows(items) {
  const container = document.getElementById('personal-schedule-rows-wrap');
  if (!container) return;

  const actionsEl = document.getElementById('personal-top-actions');
  if (actionsEl && actionsEl.parentElement) {
    actionsEl.parentElement.removeChild(actionsEl);
  }

  container.innerHTML = '';

  const list = (items && items.length > 0) ? items : [{ time: '', text: '' }];
  list.slice(0, 5).forEach((item, index) => {
    const row = createPersonalScheduleRowElement(item.time || '', item.text || '', index === 0);
    container.appendChild(row);
  });

  // 첫 번째 행 우측 끝에 알림 토글(🔔)과 + 추가 버튼 부착 (한 줄 완성)
  const firstRow = container.querySelector('.personal-schedule-row');
  if (firstRow && actionsEl) {
    firstRow.appendChild(actionsEl);
  }

  updatePersonalRowDeleteButtons();
  updatePersonalAlertTextMode();
}

function createPersonalScheduleRowElement(timeValue = '', textValue = '', isFirstRow = false) {
  const row = document.createElement('div');
  row.className = `personal-schedule-row ${isFirstRow ? 'is-first-row' : 'is-sub-row'}`;

  // 1. 첫 줄: [개인일정] 단정한 뱃지 라벨, 2번째 줄 이후: 동일 너비(54px)의 스페이서로 들여쓰기 정렬
  if (isFirstRow) {
    const badge = document.createElement('span');
    badge.className = 'memo-badge personal-badge';
    badge.textContent = '개인일정';
    row.appendChild(badge);
  } else {
    const spacer = document.createElement('span');
    spacer.className = 'personal-badge-spacer';
    row.appendChild(spacer);
  }

  // 2. 시간 선택 셀렉트 바 (컴팩트: width 50px, 00시 ~ 23시)
  const select = document.createElement('select');
  select.className = `personal-time-select ${timeValue ? '' : 'is-empty'}`;
  select.title = '일정 시작 시간 선택';

  const defaultOpt = document.createElement('option');
  defaultOpt.value = '';
  defaultOpt.textContent = '시간';
  select.appendChild(defaultOpt);

  for (let h = 0; h < 24; h++) {
    const opt = document.createElement('option');
    const hStr = `${String(h).padStart(2, '0')}시`;
    opt.value = hStr;
    opt.textContent = hStr;
    if (timeValue === hStr || timeValue === `${h}시` || timeValue === `${String(h).padStart(2, '0')}:00`) {
      opt.selected = true;
    }
    select.appendChild(opt);
  }

  select.addEventListener('change', () => {
    if (select.value === '') {
      select.classList.add('is-empty');
    } else {
      select.classList.remove('is-empty');
    }
    updatePersonalAlertTextMode();
    updatePersonalRowDeleteButtons();
    triggerAutoSavePersonalSchedule();
  });

  // 3. 내용 입력창 (15자 최적화, 본인 전용 비공개 보안 안내 플레이스홀더)
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'personal-text-input';
  input.maxLength = 15;
  input.value = textValue;
  input.placeholder = '개인 일정 입력 (본인 전용·비공개)';

  // 실시간 입력 시 디바운스 자동 저장, blur 및 change 시 즉시 저장
  input.addEventListener('input', () => {
    updatePersonalRowDeleteButtons();
    scheduleDebouncedPersonalAutoSave();
  });
  input.addEventListener('change', () => {
    updatePersonalRowDeleteButtons();
    triggerAutoSavePersonalSchedule();
  });
  input.addEventListener('blur', () => {
    triggerAutoSavePersonalSchedule();
  });

  // 4. 줄 삭제 버튼 (너비 22px 고정, 1줄일 때는 내용이 있을 때만 표시하여 모든 줄의 인풋 너비 100% 일치)
  const delBtn = document.createElement('button');
  delBtn.type = 'button';
  delBtn.className = 'personal-row-del-btn';
  delBtn.textContent = '✕';
  delBtn.title = '이 일정 삭제';
  delBtn.addEventListener('click', () => {
    const container = document.getElementById('personal-schedule-rows-wrap');
    const allRows = container ? container.querySelectorAll('.personal-schedule-row') : [];

    // [핵심] 마지막 1줄만 남아있는 경우: 행을 없애지 않고 내용과 시간을 기본값(디폴트)으로 초기화 및 X표 숨김!
    if (allRows.length <= 1) {
      select.value = '';
      select.classList.add('is-empty');
      input.value = '';

      // 알림 설정도 기본값으로 리셋
      const btnToggleAlert = document.getElementById('btn-toggle-personal-alert');
      if (btnToggleAlert) {
        btnToggleAlert.classList.remove('active');
        btnToggleAlert.title = '알림 설정 (클릭 시 팝업 열기)';
      }
      const alertPopover = document.getElementById('personal-alert-popover');
      if (alertPopover) alertPopover.style.display = 'none';
      const dayEl = document.getElementById('memo-alert-day');
      if (dayEl) dayEl.value = '0';
      const hourEl = document.getElementById('memo-alert-hour');
      if (hourEl) hourEl.value = '9';
      const minEl = document.getElementById('memo-alert-min');
      if (minEl) minEl.value = '0';

      input.focus();
      updatePersonalAlertTextMode();
      updatePersonalRowDeleteButtons(); // 디폴트 상태가 되었으므로 X표 즉시 숨김
      triggerAutoSavePersonalSchedule();
      return;
    }

    const actionsEl = document.getElementById('personal-top-actions');

    // 첫 번째 행이 삭제되는 경우 다음 행을 첫 번째 행으로 승격
    if (row.classList.contains('is-first-row')) {
      const nextRow = row.nextElementSibling;
      if (nextRow && nextRow.classList.contains('personal-schedule-row')) {
        nextRow.classList.remove('is-sub-row');
        nextRow.classList.add('is-first-row');
        const spacer = nextRow.querySelector('.personal-badge-spacer');
        if (spacer) {
          const badge = document.createElement('span');
          badge.className = 'memo-badge personal-badge';
          badge.textContent = '개인일정';
          spacer.replaceWith(badge);
        }
        const actionSpacer = nextRow.querySelector('.personal-actions-spacer');
        if (actionSpacer) {
          actionSpacer.remove();
        }
        if (actionsEl) {
          nextRow.appendChild(actionsEl);
        }
      }
    }

    row.remove();
    updatePersonalRowDeleteButtons();
    updatePersonalAlertTextMode();
    triggerAutoSavePersonalSchedule();
  });

  row.appendChild(select);
  row.appendChild(input);
  row.appendChild(delBtn);

  // 5. 첫 번째 행이 아닌 서브 줄에는 actionsEl 너비(76px)만큼 스페이서 추가 (입력창 너비 100% 동일 보장)
  if (!isFirstRow) {
    const actionSpacer = document.createElement('span');
    actionSpacer.className = 'personal-actions-spacer';
    row.appendChild(actionSpacer);
  }

  return row;
}

// [핵심] 줄 삭제 버튼 가시성 제어:
// - 2줄 이상일 때: 각 행마다 X 버튼 항시 표시 (줄 삭제 가능)
// - 1줄일 때: 내용이 입력되어 있을 때만 X 버튼 표시 (클릭 시 내용 지우고 디폴트 초기화 및 X 버튼도 사라짐)
function updatePersonalRowDeleteButtons() {
  const container = document.getElementById('personal-schedule-rows-wrap');
  if (!container) return;
  const rows = container.querySelectorAll('.personal-schedule-row');

  if (rows.length > 1) {
    rows.forEach(r => {
      const delBtn = r.querySelector('.personal-row-del-btn');
      if (delBtn) {
        delBtn.style.visibility = 'visible';
        delBtn.style.pointerEvents = 'auto';
        delBtn.title = '이 일정 삭제';
      }
    });
  } else if (rows.length === 1) {
    const singleRow = rows[0];
    const delBtn = singleRow.querySelector('.personal-row-del-btn');
    const input = singleRow.querySelector('.personal-text-input');
    const select = singleRow.querySelector('.personal-time-select');
    const hasContent = (input && input.value.trim() !== '') || (select && select.value !== '' && select.value !== '시간');

    if (delBtn) {
      if (hasContent) {
        delBtn.style.visibility = 'visible';
        delBtn.style.pointerEvents = 'auto';
        delBtn.title = '내용 지우기 (초기화)';
      } else {
        delBtn.style.visibility = 'hidden';
        delBtn.style.pointerEvents = 'none';
      }
    }
  }
}

// [개인 일정 자동 저장 (Auto-save) 로직]
let personalAutoSaveTimer = null;

function scheduleDebouncedPersonalAutoSave() {
  if (personalAutoSaveTimer) clearTimeout(personalAutoSaveTimer);
  personalAutoSaveTimer = setTimeout(() => {
    triggerAutoSavePersonalSchedule();
  }, 400);
}

function triggerAutoSavePersonalSchedule() {
  if (personalAutoSaveTimer) {
    clearTimeout(personalAutoSaveTimer);
    personalAutoSaveTimer = null;
  }

  const dateStr = appState.activeModalDate;
  if (!dateStr || appState.selectedMemberId === 'ALL') return;

  const container = document.getElementById('personal-schedule-rows-wrap');
  const rows = container ? container.querySelectorAll('.personal-schedule-row') : [];
  const items = [];
  rows.forEach(r => {
    const timeSel = r.querySelector('.personal-time-select');
    const textInp = r.querySelector('.personal-text-input');
    const time = timeSel ? timeSel.value : '';
    const text = textInp ? textInp.value.trim() : '';
    if (text) {
      items.push({ time, text });
    }
  });

  const dayEl = document.getElementById('memo-alert-day');
  const hourEl = document.getElementById('memo-alert-hour');
  const minEl = document.getElementById('memo-alert-min');
  const toggleBtn = document.getElementById('btn-toggle-personal-alert');

  const dayRaw = dayEl ? dayEl.value : '0';
  const isOffSelected = (dayRaw === 'off');
  const isAlertActive = (toggleBtn ? toggleBtn.classList.contains('active') : false) && !isOffSelected;
  const alertDay = isOffSelected ? '0' : dayRaw;
  const alertHour = hourEl ? hourEl.value : '9';
  const alertMin = minEl ? minEl.value : '0';

  const memKey = getActiveMemberStorageKey();
  const pKey = `${dateStr}_${memKey}`;
  appState.personalMemos = appState.personalMemos || {};

  if (items.length > 0) {
    appState.personalMemos[pKey] = {
      items,
      text: items.map(it => (it.time ? it.time + ' ' : '') + it.text).join('\n'),
      alertEnabled: isAlertActive,
      alertDay,
      alertHour,
      alertMin,
      updatedAt: Date.now(),
      fired: false
    };
  } else {
    delete appState.personalMemos[pKey];
  }

  saveLocalOnly();
  renderCalendar();
}

function initMemoListeners() {
  // 업무 공유 메모 리스너
  const workInput = document.getElementById('memo-work-text');
  if (workInput) {
    workInput.addEventListener('input', () => autoResizeMemoTextarea(workInput, 999));
  }

  const btnSaveWork = document.getElementById('btn-save-work-memo');
  if (btnSaveWork) {
    btnSaveWork.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const dateStr = appState.activeModalDate;
      if (!dateStr) return;
      const text = workInput ? workInput.value.trim() : '';
      const urgentCheck = document.getElementById('memo-work-urgent-check');
      const isUrgent = Boolean(urgentCheck && urgentCheck.checked);
      appState.workMemos = appState.workMemos || {};
      if (text) {
        const prevInfo = getWorkMemoInfo(dateStr);
        let confirmedList = [];
        if (prevInfo.text === text) {
          confirmedList = prevInfo.confirmedMembers;
        } else {
          // 새 공지이거나 내용이 변경된 경우: 모든 멤버의 확인 상태 리셋 -> 모두에게 살아 움직임!
          confirmedList = [];
        }

        appState.workMemos[dateStr] = {
          text: text,
          isUrgent: isUrgent,
          confirmedMembers: confirmedList,
          updatedAt: Date.now()
        };

        showToast(isUrgent ? '🚨 긴급 업무 공지가 저장되었습니다.' : '📋 업무 공지가 저장되었습니다.');
      } else {
        delete appState.workMemos[dateStr];
        showToast('업무 공지가 삭제되었습니다.');
      }
      saveState();
      renderCalendar();
    });
  }

  // 개인 일정 줄 추가 버튼 (+ 추가, 최대 5줄)
  const btnAddRow = document.getElementById('btn-add-personal-row');
  if (btnAddRow) {
    btnAddRow.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const container = document.getElementById('personal-schedule-rows-wrap');
      if (!container) return;
      const currentRows = container.querySelectorAll('.personal-schedule-row');
      if (currentRows.length >= 5) {
        showToast('개인 일정은 최대 5개까지 추가할 수 있습니다.');
        return;
      }
      const newRow = createPersonalScheduleRowElement('', '', false);
      container.appendChild(newRow);
      updatePersonalRowDeleteButtons();
      updatePersonalAlertTextMode();
      const input = newRow.querySelector('.personal-text-input');
      if (input) input.focus();
    });
  }

  // 종 모양 알람 버튼 클릭 시 팝오버 열기/닫기 토글
  const btnToggleAlert = document.getElementById('btn-toggle-personal-alert');
  const alertPopover = document.getElementById('personal-alert-popover');
  const btnClosePopover = document.getElementById('btn-close-alert-popover');
  const btnConfirmAlert = document.getElementById('btn-confirm-alert');

  if (btnToggleAlert && alertPopover) {
    btnToggleAlert.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      updatePersonalAlertTextMode();
      const isVisible = (alertPopover.style.display === 'block');
      alertPopover.style.display = isVisible ? 'none' : 'block';
    });
  }

  if (btnClosePopover && alertPopover) {
    btnClosePopover.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      alertPopover.style.display = 'none';
    });
  }

  // 알림 시간 설정 [저장] 버튼: 클릭 시 팝업이 닫히고 알림 설정 저장
  if (btnConfirmAlert && alertPopover && btnToggleAlert) {
    btnConfirmAlert.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const dayVal = document.getElementById('memo-alert-day')?.value || '0';
      const hourVal = document.getElementById('memo-alert-hour')?.value || '9';
      const minVal = document.getElementById('memo-alert-min')?.value || '0';

      if (dayVal === 'off') {
        // 알림 끄기를 선택하고 저장한 경우
        btnToggleAlert.classList.remove('active');
        btnToggleAlert.title = '알림 설정 (클릭 시 팝업 열기)';
        alertPopover.style.display = 'none';
        showToast('🔕 알림 설정이 해제되었습니다.');
      } else {
        // 정상 시간 저장
        btnToggleAlert.classList.add('active');
        btnToggleAlert.title = '알림 설정 켜짐 (클릭 시 시간 변경/해제)';
        alertPopover.style.display = 'none';

        // [핵심] 상단 메인 알람이 꺼져 있어도 개인 일정 알림이 정상 작동할 수 있도록 시스템 알림 권한 및 오디오 세션 즉시 활성화!
        unlockAudioSession();
        requestNotificationPermission(false);

        const dayText = dayVal === '0' ? '당일' : `${dayVal}일 전`;
        showToast(`🔔 [알림 설정] ${dayText} ${hourVal.padStart(2, '0')}:${minVal.padStart(2, '0')} 알림이 설정되었습니다.`);
      }
      triggerAutoSavePersonalSchedule();
    });
  }

  if (alertPopover) {
    alertPopover.addEventListener('click', (e) => {
      e.stopPropagation();
    });
  }

  // 팝오버 외부 클릭 시 닫기
  document.addEventListener('click', (e) => {
    if (alertPopover && alertPopover.style.display === 'block') {
      if (!alertPopover.contains(e.target) && !btnToggleAlert?.contains(e.target)) {
        alertPopover.style.display = 'none';
      }
    }
  });

  // 알람 설정 일/시/분 변경 시 자동 저장
  ['memo-alert-day', 'memo-alert-hour', 'memo-alert-min'].forEach(id => {
    const el = document.getElementById(id);
    if (el) {
      el.addEventListener('change', () => {
        triggerAutoSavePersonalSchedule();
      });
    }
  });

  // 하위 호환용
  const btnSavePersonal = document.getElementById('btn-save-personal-memo');
  if (btnSavePersonal) {
    btnSavePersonal.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      triggerAutoSavePersonalSchedule();
      showToast('💾 개인 일정이 저장되었습니다.');
    });
  }



  // 개인 알림 정기 확인 타이머 (1분 주기 및 화면 복귀/포커스 시 즉시 체크)
  checkDuePersonalAlarms();
  setInterval(checkDuePersonalAlarms, 60000);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      checkDuePersonalAlarms();
    }
  });
  window.addEventListener('focus', () => {
    checkDuePersonalAlarms();
  });
}

function checkDuePersonalAlarms() {
  if (!appState.personalMemos) return;
  const now = new Date();

  Object.entries(appState.personalMemos).forEach(([key, memo]) => {
    if (!memo || memo.fired) return;
    // 알람 비활성화된 경우 알림 발송 생략
    if (memo.alertEnabled === false) return;

    const parts = key.split('_');
    const dateStr = parts[0];
    const memberId = parts[1];

    // [핵심] 상단 메인 알람(isNotificationEnabled) 토글 상태나 현재 선택된 화면 탭과 관계없이,
    // 이 기기에 설정된 개인 일정 알람은 독립적으로 제 시간에 알림(소리/시스템배너/토스트)이 울리도록 보장!
    const alertDay = parseInt(memo.alertDay || '0', 10);
    const alertHour = parseInt(memo.alertHour || '9', 10);
    const alertMin = parseInt(memo.alertMin || '0', 10);

    const targetDate = new Date(dateStr + 'T00:00:00');
    targetDate.setDate(targetDate.getDate() - alertDay);
    targetDate.setHours(alertHour, alertMin, 0, 0);

    const diffMs = now.getTime() - targetDate.getTime();
    // 예정 시각 이후 30분 이내이고 아직 발송 안 되었으면 알림 발송
    if (diffMs >= 0 && diffMs <= 30 * 60 * 1000) {
      memo.fired = true;
      const member = (appState.members || []).find(m => String(m.id) === String(memberId));
      const memberName = member ? member.name : '';
      const summaryText = (memo.items && memo.items.length > 0)
        ? memo.items.map(i => (i.time ? i.time + ' ' : '') + i.text).join(' / ')
        : (memo.text || '개인 일정');

      playNotificationSound();
      sendSystemNotification('📅 개인 일정 알림', `[${memberName ? memberName + ' ' : ''}${dateStr}] ${summaryText}`, `songchul-personal-${key}`);
      showToast(`🔔 [일정 알림] ${summaryText}`);
      saveLocalOnly();
    }
  });
}
