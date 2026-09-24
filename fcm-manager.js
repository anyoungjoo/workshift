// ==========================================================================
// KBS 송출센터 - 구글 Firebase Cloud Messaging (FCM) 클라이언트 매니저
// - 웹 푸시 알림 권한 요청 및 FCM 디바이스 토큰 발급/관리
// - 서비스 워커 등록 및 포그라운드/백그라운드 푸시 수신 제어
// - 알림 클릭 시 예약 온에어 방송 즉시 자동 재생 연동
// ==========================================================================

const FCM_STORAGE_KEY = 'KBS_FCM_CONFIG';
const FCM_TOKEN_STORAGE_KEY = 'KBS_FCM_DEVICE_TOKEN';
const FCM_ENABLED_STORAGE_KEY = 'KBS_FCM_ENABLED';

let fcmMessaging = null;

// Firebase 설정 불러오기
function getFCMConfig() {
  const defaultConfig = {
    apiKey: "AIzaSyDLl9O-BYi494GPsqmkPfTPwO_vsAPIeEg",
    authDomain: "workshift-6ca5d.firebaseapp.com",
    projectId: "workshift-6ca5d",
    storageBucket: "workshift-6ca5d.firebasestorage.app",
    messagingSenderId: "722189852354",
    appId: "1:722189852354:web:592e99549a3b97f6e6a55b",
    vapidKey: "BP7P9GNMMnEHOY67QP5J-03Ex9r8cm3dMz8K2CF8wvDVr0bPprZBmD00vNB86IYourI7JCELzPBsAP0UPS8bIws"
  };

  try {
    const raw = localStorage.getItem(FCM_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      return {
        ...defaultConfig,
        ...parsed,
        vapidKey: parsed.vapidKey || defaultConfig.vapidKey
      };
    }
  } catch (e) {}
  return defaultConfig;
}

// Firebase 설정 저장
function saveFCMConfig(config) {
  localStorage.setItem(FCM_STORAGE_KEY, JSON.stringify(config));
}

// FCM 초기화 및 서비스 워커 등록
async function initFCMService() {
  if (!('serviceWorker' in navigator) || !('Notification' in window)) {
    console.warn('[FCM] 이 브라우저는 서비스 워커 또는 알림(Notification)을 지원하지 않습니다.');
    return;
  }

  try {
    // 1) 서비스 워커 등록
    const registration = await navigator.serviceWorker.register('./firebase-messaging-sw.js');
    console.log('[FCM] 서비스 워커 등록 성공:', registration.scope);

    // 2) 서비스 워커로부터 메시지 수신 (알림 클릭 시 자동 재생 연동)
    navigator.serviceWorker.addEventListener('message', (event) => {
      if (event.data && event.data.type === 'OPEN_RESERVED_CHANNEL') {
        const { channelId, progTitle } = event.data;
        console.log(`[FCM] 알림 클릭 이벤트 수신 -> 채널 재생: ${channelId} (${progTitle})`);
        playChannelById(channelId, progTitle);
      }
    });

    // 3) Firebase 초기화 (설정값이 있는 경우)
    const config = getFCMConfig();
    if (config.apiKey && config.projectId && typeof firebase !== 'undefined') {
      if (firebase.apps.length === 0) {
        firebase.initializeApp(config);
      }
      fcmMessaging = firebase.messaging();

      // 포그라운드 메시지 수신 (화면을 보고 있을 때)
      fcmMessaging.onMessage((payload) => {
        console.log('[FCM] 포그라운드 메시지 수신:', payload);
        const data = payload.data || {};
        const notification = payload.notification || {};
        const title = notification.title || data.title || '🔔 [KBS 송출센터] 예약 방송 알림';
        const body = notification.body || data.body || '예약된 방송 시간입니다.';
        
        // 인앱 토스트 또는 브라우저 알림 표시
        if (typeof showToast === 'function') {
          showToast(`${title}\n${body}`);
        }
      });
    }
  } catch (err) {
    console.warn('[FCM] 초기화 중 예외 발생:', err);
  }
}

// 푸시 알림 권한 요청 및 FCM 디바이스 토큰 획득
async function requestFCMNotificationPermission() {
  if (!('Notification' in window)) {
    alert('현재 브라우저/스마트폰이 시스템 알림을 지원하지 않습니다.');
    return null;
  }

  const permission = await Notification.requestPermission();
  if (permission !== 'granted') {
    alert('알림 권한이 차단되었거나 허용되지 않았습니다. 브라우저 설정에서 알림을 허용해 주세요.');
    return null;
  }

  const config = getFCMConfig();

  // Firebase 키가 있고 FCM 객체가 준비된 경우 토큰 요청
  if (fcmMessaging && config.vapidKey) {
    try {
      const registration = await navigator.serviceWorker.ready;
      const currentToken = await fcmMessaging.getToken({
        vapidKey: config.vapidKey,
        serviceWorkerRegistration: registration
      });

      if (currentToken) {
        localStorage.setItem(FCM_TOKEN_STORAGE_KEY, currentToken);
        localStorage.setItem(FCM_ENABLED_STORAGE_KEY, 'true');
        console.log('[FCM] 디바이스 토큰 발급 완료:', currentToken);
        return currentToken;
      }
    } catch (e) {
      console.warn('[FCM] 토큰 발급 중 오류:', e);
    }
  }

  // Firebase 키가 아직 미등록된 경우에도 로컬 알림은 활성화
  localStorage.setItem(FCM_ENABLED_STORAGE_KEY, 'true');
  return 'LOCAL_NOTIFICATION_ENABLED';
}

// 테스트 알림 발송 (기기에서 잘 울리는지 1초 만에 확인)
async function sendTestNotification(customTitle = null, customBody = null) {
  if (!('Notification' in window)) {
    alert('알림을 지원하지 않는 브라우저입니다.');
    return;
  }

  if (Notification.permission !== 'granted') {
    const granted = await Notification.requestPermission();
    if (granted !== 'granted') {
      alert('알림 권한을 먼저 허용해 주세요.');
      return;
    }
  }

  const title = customTitle || '🔔 [테스트] KBS 송출센터 모니터링 알림';
  const body = customBody || '스마트폰 잠금화면과 상단바에 알림이 정상적으로 수신됩니다. 터치 시 방송이 바로 재생됩니다.';

  try {
    const registration = await navigator.serviceWorker.ready;
    if (registration && registration.showNotification) {
      await registration.showNotification(title, {
        body: body,
        icon: './icon-192.png',
        badge: './icon-192.png',
        vibrate: [200, 100, 200],
        tag: 'kbs_test_notification',
        renotify: true,
        data: {
          url: './index.html?openReservation=true&channelId=1tv&progTitle=' + encodeURIComponent('테스트 방송')
        }
      });
      return;
    }
  } catch (e) {
    console.warn('[FCM] 서비스 워커 알림 실패, 기본 Notification 폴백:', e);
  }

  // 기본 Notification 폴백
  new Notification(title, {
    body: body,
    icon: './icon-192.png'
  });
}

// 🎯 [사용자 핵심 요구] 방송 시작 1초 전 푸시 알림 발송 (스마트폰 잠금화면 / PC 배너)
// - 1초 전에 알림이 발생하여 터치 시 방송 시작 시각에 정각 매칭
async function sendReservedProgramNotification(prog) {
  if (!prog) return;
  if (!('Notification' in window) || Notification.permission !== 'granted') return;

  const chNameMap = {
    '1tv': 'KBS 1TV',
    '2tv': 'KBS 2TV',
    '1radio': '1라디오',
    '2radio': '2라디오',
    'fm': '음악FM',
    '1fm': '음악FM'
  };
  const chName = prog.channelName || chNameMap[prog.channelId] || prog.channelId;
  const progTitle = prog.title || '예약 방송';
  const channelId = prog.channelId || '1tv';
  const title = `🔔 [${chName}] ${progTitle}`;
  const body = `1초 후 방송이 시작됩니다! 터치하여 바로 시청하세요. (${prog.start || ''})`;

  const clickUrl = `./index.html?openReservation=true&channelId=${channelId}&progTitle=${encodeURIComponent(progTitle)}`;

  try {
    if ('serviceWorker' in navigator) {
      const registration = await navigator.serviceWorker.ready;
      if (registration && registration.showNotification) {
        await registration.showNotification(title, {
          body: body,
          icon: './icon-192.png',
          badge: './icon-192.png',
          vibrate: [300, 100, 300, 100, 300],
          tag: `onair_reserve_${prog.id || 'res'}_${Date.now()}`,
          renotify: true,
          requireInteraction: true,
          data: {
            url: clickUrl,
            channelId: channelId,
            progTitle: progTitle
          },
          actions: [
            { action: 'play', title: '▶ 바로 시청/청취' },
            { action: 'close', title: '닫기' }
          ]
        });
        console.log(`[FCM] 방송 시작 1초 전 푸시 알림 전송: ${title}`);
        return;
      }
    }
  } catch (e) {
    console.warn('[FCM] 서비스 워커 푸시 알림 실패, 기본 Notification 폴백:', e);
  }

  // 데스크톱 / 브라우저 일반 Notification 폴백
  try {
    const notif = new Notification(title, {
      body: body,
      icon: './icon-192.png'
    });
    notif.onclick = () => {
      window.focus();
      playChannelById(channelId, progTitle);
    };
  } catch (e) {}
}

// 채널 ID로 즉시 플로팅 플레이어 실행
function playChannelById(channelId, progTitle = '') {
  if (typeof ONAIR_CHANNELS === 'undefined' || typeof openFloatingPlayer !== 'function') {
    console.warn('[FCM] 플레이어 함수가 아직 로드되지 않음');
    return;
  }

  const channelObj = ONAIR_CHANNELS.find(c => c.id === channelId) || ONAIR_CHANNELS[0];
  openFloatingPlayer(channelObj, {
    startMuted: false,
    isReserved: true,
    reservedProgram: {
      channelId: channelId,
      channelName: channelObj.name,
      title: progTitle || `${channelObj.name} 예약 방송`
    }
  });
}

// 페이지 로드 시 URL 파라미터(?openReservation=true) 감지하여 자동 재생
function checkUrlReservationParam() {
  const params = new URLSearchParams(window.location.search);
  if (params.get('openReservation') === 'true') {
    const channelId = params.get('channelId') || '1tv';
    const progTitle = params.get('progTitle') || '';
    console.log(`[FCM] URL 파라미터 감지 -> 즉시 자동 재생: ${channelId} (${progTitle})`);
    
    // UI가 모두 마운트된 후 안전하게 실행
    setTimeout(() => {
      playChannelById(channelId, progTitle);
    }, 800);

    // URL 히스토리 깔끔하게 정리 (파라미터 제거)
    const cleanUrl = window.location.pathname;
    window.history.replaceState({}, document.title, cleanUrl);
  }
}

// 초기화 실행
window.addEventListener('DOMContentLoaded', () => {
  initFCMService();
  checkUrlReservationParam();
});
