// ==========================================================================
// KBS 송출센터 - PWA (Progressive Web App) + Firebase Messaging (FCM) 통합 서비스 워커
// - PWA 모바일/PC 홈 화면 설치 및 오프라인 구동 지원
// - Network-First(온라인 우선) 전략: 온라인 시 항상 서버 최신 코드를 즉시 반영
// - 오프라인 시: 캐시된 화면 및 리소스로 앱 즉시 실행
// - FCM 백그라운드 푸시 알림 및 알림 터치 시 방송 자동 재생 연동
// ==========================================================================

importScripts('https://www.gstatic.com/firebasejs/9.23.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/9.23.0/firebase-messaging-compat.js');

const CACHE_NAME = 'kbs-workshift-cache-v2';

// 오프라인 구동용 사전 캐싱 자원
const PRECACHE_ASSETS = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './baseline-data.js',
  './hwp-template-data.js',
  './pako.min.js',
  './fcm-manager.js',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-192.png',
  './icons/icon-maskable-512.png'
];

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

// --------------------------------------------------------------------------
// 1. 서비스 워커 생명주기 (Install & Activate)
// --------------------------------------------------------------------------
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(PRECACHE_ASSETS).catch((err) => {
        console.warn('[PWA SW] 사전 캐시 실패 항목이 있으나 설치를 계속합니다:', err);
      });
    })
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames
          .filter((name) => name !== CACHE_NAME)
          .map((name) => caches.delete(name))
      );
    }).then(() => clients.claim())
  );
});

// --------------------------------------------------------------------------
// 2. 캐싱 전략: Network-First (온라인 우선 전략)
// - 온라인 상태: 서버에서 최신 코드를 즉시 받아오고 캐시를 자동 업데이트
// - 오프라인 상태: 이전에 저장된 캐시로 접속 보장
// --------------------------------------------------------------------------
self.addEventListener('fetch', (event) => {
  const request = event.request;

  // GET 요청만 캐싱
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // http/https 스킴만 처리
  if (!url.protocol.startsWith('http')) return;

  // 파이어베이스 통신, 스트리밍, 외부 실시간 소스는 캐시 대상에서 제외
  if (
    url.hostname.includes('firestore.googleapis.com') ||
    url.hostname.includes('firebaseinstallations.googleapis.com') ||
    url.hostname.includes('fcmregistrations.googleapis.com') ||
    url.hostname.includes('identitytoolkit.googleapis.com') ||
    url.hostname.includes('firebasestorage.googleapis.com') ||
    url.pathname.endsWith('.m3u8') ||
    url.pathname.endsWith('.ts') ||
    url.hostname.includes('kbs.co.kr')
  ) {
    return;
  }

  event.respondWith(
    fetch(request)
      .then((networkResponse) => {
        // 성공 응답 시 백그라운드 캐시 갱신
        if (networkResponse && networkResponse.status === 200) {
          const responseClone = networkResponse.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(request, responseClone);
          });
        }
        return networkResponse;
      })
      .catch(async () => {
        // 오프라인 또는 네트워크 단절 시 캐시에서 제공
        const cachedResponse = await caches.match(request);
        if (cachedResponse) {
          return cachedResponse;
        }

        // 페이지 네비게이션 요청인 경우 메인 index.html 반환
        if (request.mode === 'navigate') {
          const fallbackIndex = await caches.match('./index.html');
          if (fallbackIndex) return fallbackIndex;
        }

        return new Response('오프라인 상태입니다.', {
          status: 503,
          statusText: 'Service Unavailable',
          headers: new Headers({ 'Content-Type': 'text/plain; charset=utf-8' })
        });
      })
  );
});

// --------------------------------------------------------------------------
// 3. 백그라운드 푸시 메시지 수신 (FCM)
// --------------------------------------------------------------------------
if (messaging) {
  messaging.onBackgroundMessage(async (payload) => {
    console.log('[FCM SW] 푸시 메시지 수신:', payload);

    try {
      const clientList = await clients.matchAll({ type: 'window', includeUncontrolled: true });
      const isAppVisible = clientList.some(client => client.visibilityState === 'visible');
      if (isAppVisible) {
        console.log('[FCM SW] 앱 화면이 켜져 있으므로 외부 알림 배너 표시를 생략합니다.');
        return;
      }
    } catch (e) {
      console.warn('[FCM SW] 클라이언트 가시성 검사 예외:', e);
    }

    const data = payload.data || {};
    const notification = payload.notification || {};

    const title = notification.title || data.title || '🔔 [KBS 송출센터] 예약 방송 알림';
    const body = notification.body || data.body || '예약된 모니터링 방송 시간입니다. 터치하여 바로 시청하세요.';
    const channelId = data.channelId || '1tv';
    const progTitle = data.progTitle || '';
    const clickAction = data.click_action || data.url || `./index.html?openReservation=true&channelId=${channelId}&progTitle=${encodeURIComponent(progTitle)}`;

    const options = {
      body: body,
      icon: './icons/icon-192.png',
      badge: './icons/icon-192.png',
      tag: `onair_reserve_${channelId}_${Date.now()}`,
      renotify: true,
      requireInteraction: true,
      vibrate: [300, 100, 300, 100, 300],
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

// --------------------------------------------------------------------------
// 4. 알림 클릭 시 방송 자동 재생 연동
// --------------------------------------------------------------------------
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
      if (clients.openWindow) {
        return clients.openWindow(targetUrl);
      }
    })
  );
});
