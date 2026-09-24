// ==========================================================================
// KBS 송출센터 - Firebase Cloud Messaging (FCM) 백그라운드 서비스 워커
// - 스마트폰 화면이 꺼져 있거나 앱이 닫혀 있을 때도 구글 푸시 알림 수신
// - 알림 터치 시 앱 화면으로 이동하여 해당 온에어 채널 즉시 자동 재생
// ==========================================================================

importScripts('https://www.gstatic.com/firebasejs/9.23.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/9.23.0/firebase-messaging-compat.js');

// 기본/캐시된 Firebase 설정 (기존 workshift-6ca5d 프로젝트와 100% 매칭)
const DEFAULT_FIREBASE_CONFIG = {
  apiKey: "AIzaSyDLl9O-BYi494GPsqmkPfTPwO_vsAPIeEg",
  authDomain: "workshift-6ca5d.firebaseapp.com",
  projectId: "workshift-6ca5d",
  storageBucket: "workshift-6ca5d.firebasestorage.app",
  messagingSenderId: "722189852354",
  appId: "1:722189852354:web:592e99549a3b97f6e6a55b"
};

let messaging = null;

try {
  if (firebase.apps.length === 0) {
    firebase.initializeApp(DEFAULT_FIREBASE_CONFIG);
  }
  messaging = firebase.messaging();
} catch (e) {
  console.log('[FCM SW] Firebase init waiting for config:', e.message);
}

// 백그라운드 푸시 메시지 수신 핸들러 (화면이 꺼져 있거나 다른 앱 사용 중일 때 호출)
if (messaging) {
  messaging.onBackgroundMessage((payload) => {
    console.log('[FCM SW] 백그라운드 푸시 메시지 수신:', payload);

    const data = payload.data || {};
    const notification = payload.notification || {};

    const title = notification.title || data.title || '🔔 [KBS 송출센터] 예약 방송 알림';
    const body = notification.body || data.body || '예약된 모니터링 방송 시간입니다. 터치하여 바로 시청하세요.';
    const channelId = data.channelId || '1tv';
    const progTitle = data.progTitle || '';
    const clickAction = data.click_action || data.url || `./index.html?openReservation=true&channelId=${channelId}&progTitle=${encodeURIComponent(progTitle)}`;

    const options = {
      body: body,
      icon: './icon-192.png',
      badge: './icon-192.png',
      tag: `onair_reserve_${channelId}_${Date.now()}`,
      renotify: true,
      requireInteraction: true, // 사용자가 터치할 때까지 화면에 유지
      vibrate: [300, 100, 300, 100, 300], // 진동 패턴
      data: {
        url: clickAction,
        channelId: channelId,
        progTitle: progTitle
      },
      actions: [
        { action: 'play', title: '▶ 바로 시청/청취' },
        { action: 'close', title: '닫기' }
      ]
    };

    return self.registration.showNotification(title, options);
  });
}

// 스마트폰 상단바 / 잠금화면 알림 터치(클릭) 이벤트
self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  if (event.action === 'close') {
    return;
  }

  const notificationData = event.notification.data || {};
  const targetUrl = notificationData.url || './index.html?openReservation=true';
  const channelId = notificationData.channelId || '1tv';

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      // 이미 열려있는 창이 있다면 포커스하고 방송 재생 메시지 전송
      for (const client of clientList) {
        if ('focus' in client) {
          client.postMessage({
            type: 'OPEN_RESERVED_CHANNEL',
            channelId: channelId,
            progTitle: notificationData.progTitle
          });
          return client.focus();
        }
      }
      // 열린 창이 없으면 새 창을 띄워 자동 재생 URL로 진입
      if (clients.openWindow) {
        return clients.openWindow(targetUrl);
      }
    })
  );
});

// 서비스 워커 즉시 활성화
self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(clients.claim());
});
