const functions = require('firebase-functions');
const admin = require('firebase-admin');

admin.initializeApp();

/**
 * 🎯 [KBS 송출센터 온에어 방송 모니터링 클라우드 예약 스케줄러]
 * - 구글 클라우드(Google Cloud / Firebase Functions)에서 매 1분마다 자동 실행
 * - PC가 꺼져 있거나 스마트폰이 잠겨 있어도 100% 구글 서버에서 자동 푸시 발송
 * - 한국 표준시(KST, Asia/Seoul) 기준 요일 및 시각(HH:mm) 일치 기기만 개별 1:1 발송
 */
exports.checkAndSendReservedPushes = functions.region('asia-northeast3') // 서울 리전
  .pubsub.schedule('* * * * *')
  .timeZone('Asia/Seoul')
  .onRun(async (context) => {
    const now = new Date();
    // KST 계산 (UTC + 9시간)
    const utc = now.getTime() + (now.getTimezoneOffset() * 60000);
    const kst = new Date(utc + (9 * 3600000));

    const curHour = String(kst.getHours()).padStart(2, '0');
    const curMinute = String(kst.getMinutes()).padStart(2, '0');
    const curTimeStr = `${curHour}:${curMinute}`;
    const curDay = kst.getDay(); // 0: 일요일, 1: 월요일, ... 6: 토요일

    console.log(`[Google Cloud Scheduler] KST ${curTimeStr} (요일: ${curDay}) 예약 푸시 검사 시작`);

    const db = admin.firestore();
    const snapshot = await db.collection('fcm_subscriptions')
      .where('enabled', '==', true)
      .get();

    if (snapshot.empty) {
      console.log('[Google Cloud Scheduler] 활성화된 기기 예약 없음');
      return null;
    }

    const messagesToSend = [];

    snapshot.forEach(doc => {
      const data = doc.data();
      const token = data.token || doc.id;
      if (!token) return;

      const cycle = data.cycle || 'always';
      const programs = Array.isArray(data.programs) ? data.programs : [];

      programs.forEach(prog => {
        // 요일 검사 (repeat 모드일 때만 적용)
        if (cycle === 'repeat' && Array.isArray(prog.days)) {
          if (!prog.days.includes(curDay)) return;
        }

        // 방송 시작 시간(start, 예: "09:30")이 현재 분(curTimeStr)과 일치하는 경우
        if (prog.start === curTimeStr) {
          const chName = prog.channelName || prog.channelId || 'KBS 온에어';
          const progTitle = prog.title || '예약 방송';
          const channelId = prog.channelId || '1tv';
          const clickUrl = `./index.html?openReservation=true&channelId=${channelId}&progTitle=${encodeURIComponent(progTitle)}`;

          messagesToSend.push({
            token: token,
            notification: {
              title: `🔔 [${chName}] ${progTitle}`,
              body: `방송이 지금 시작됩니다! 터치하여 바로 시청하세요. (${prog.start})`
            },
            data: {
              channelId: channelId,
              progTitle: progTitle,
              url: clickUrl
            },
            android: {
              priority: 'high',
              notification: {
                sound: 'default',
                clickAction: clickUrl
              }
            },
            apns: {
              payload: {
                aps: {
                  sound: 'default',
                  badge: 1
                }
              }
            },
            webpush: {
              headers: {
                Urgency: 'high'
              },
              notification: {
                title: `🔔 [${chName}] ${progTitle}`,
                body: `방송이 지금 시작됩니다! 터치하여 바로 시청하세요. (${prog.start})`,
                icon: './icon-192.png',
                badge: './icon-192.png',
                requireInteraction: true
              },
              fcmOptions: {
                link: clickUrl
              }
            }
          });
        }
      });
    });

    if (messagesToSend.length === 0) {
      console.log(`[Google Cloud Scheduler] ${curTimeStr} 발송 대상 예약 없음`);
      return null;
    }

    console.log(`[Google Cloud Scheduler] 총 ${messagesToSend.length}건 개별 푸시 발송 시작...`);
    const response = await admin.messaging().sendEach(messagesToSend);
    console.log(`[Google Cloud Scheduler] 발송 완료 - 성공: ${response.successCount}, 실패: ${response.failureCount}`);

    // 만료된 토큰 자동 정리
    const expiredTokens = [];
    response.responses.forEach((resp, idx) => {
      if (!resp.success && resp.error) {
        const errCode = resp.error.code;
        if (errCode === 'messaging/invalid-registration-token' ||
            errCode === 'messaging/registration-token-not-registered') {
          expiredTokens.push(messagesToSend[idx].token);
        }
      }
    });

    if (expiredTokens.length > 0) {
      const batch = db.batch();
      expiredTokens.forEach(t => {
        batch.delete(db.collection('fcm_subscriptions').doc(t));
      });
      await batch.commit();
      console.log(`[Google Cloud Scheduler] 만료 토큰 ${expiredTokens.length}개 자동 삭제 정리 완료`);
    }

    return null;
  });

/**
 * 🎯 [테스트 즉시 푸시 발송용 HTTP / Callable 함수]
 * - 기기 알림 수신 테스트 버튼 클릭 시 구글 클라우드에서 직접 발송
 */
exports.sendTestPushToDevice = functions.region('asia-northeast3')
  .https.onCall(async (data, context) => {
    const token = data.token;
    if (!token) {
      throw new functions.https.HttpsError('invalid-argument', '디바이스 토큰이 필요합니다.');
    }

    const title = data.title || '🔔 [구글 클라우드 테스트] KBS 송출센터 모니터링 알림';
    const body = data.body || '구글 Firebase 클라우드에서 정상 발송되었습니다. 터치 시 방송이 자동 실행됩니다.';
    const clickUrl = './index.html?openReservation=true&channelId=1tv&progTitle=' + encodeURIComponent('테스트 방송');

    try {
      const message = {
        token: token,
        notification: { title, body },
        data: { channelId: '1tv', progTitle: '테스트 방송', url: clickUrl },
        android: { priority: 'high', notification: { sound: 'default' } },
        apns: { payload: { aps: { sound: 'default', badge: 1 } } },
        webpush: {
          headers: { Urgency: 'high' },
          notification: { title, body, icon: './icon-192.png', badge: './icon-192.png', requireInteraction: true },
          fcmOptions: { link: clickUrl }
        }
      };

      const result = await admin.messaging().send(message);
      return { success: true, messageId: result };
    } catch (err) {
      console.error('[Google Cloud] 테스트 푸시 실패:', err);
      throw new functions.https.HttpsError('internal', err.message);
    }
  });
