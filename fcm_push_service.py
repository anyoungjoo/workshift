"""
KBS 송출센터 - Google Firebase Cloud Messaging (FCM) 푸시 발송 서비스
- 예약된 로컬 방송 모니터링 시작 시간에 맞춰 등록된 스마트폰 기기로 FCM 푸시 메시지 발송
- 스마트폰이 잠겨 있거나 다른 앱 사용 중에도 상단 배너/잠금화면 알림 발생
- 알림 터치 시 KBS 온에어 해당 방송 즉시 자동 재생
"""

import os
import sys
import json
import time
import urllib.request
import urllib.error
from datetime import datetime

# UTF-8 출력 보장
try:
    if hasattr(sys.stdout, 'reconfigure'):
        sys.stdout.reconfigure(encoding='utf-8')
    if hasattr(sys.stderr, 'reconfigure'):
        sys.stderr.reconfigure(encoding='utf-8')
except Exception:
    pass

CONFIG_FILE = os.path.join(os.path.dirname(__file__), 'fcm_service_config.json')
TOKENS_FILE = os.path.join(os.path.dirname(__file__), 'fcm_tokens.json')

def load_fcm_config():
    """FCM 발송 설정 로드 (Service Account Key 또는 Legacy Server Key)"""
    if os.path.exists(CONFIG_FILE):
        try:
            with open(CONFIG_FILE, 'r', encoding='utf-8') as f:
                return json.load(f)
        except Exception as e:
            print(f"[FCM Service] 설정 로드 오류: {e}")
    return {
        "server_key": "",
        "service_account_path": ""
    }

def load_registered_tokens():
    """푸시 알림을 수신할 등록된 디바이스 토큰 목록"""
    if os.path.exists(TOKENS_FILE):
        try:
            with open(TOKENS_FILE, 'r', encoding='utf-8') as f:
                return json.load(f)
        except Exception:
            pass
    return []

def save_registered_tokens(tokens):
    """토큰 목록 저장"""
    try:
        with open(TOKENS_FILE, 'w', encoding='utf-8') as f:
            json.dump(tokens, f, ensure_ascii=False, indent=2)
    except Exception as e:
        print(f"[FCM Service] 토큰 저장 오류: {e}")

def send_fcm_push(token, title, body, channel_id="1tv", prog_title=""):
    """
    FCM 푸시 발송 함수
    - FCM Legacy HTTP API 또는 Google OAuth2 기반 v1 API 지원
    """
    config = load_fcm_config()
    server_key = config.get("server_key", "").strip()

    if not server_key:
        print("[FCM Service] 알림: Firebase Server Key가 등록되지 않았습니다. (fcm_service_config.json 참조)")
        return False

    url = "https://fcm.googleapis.com/fcm/send"
    headers = {
        "Authorization": f"key={server_key}",
        "Content-Type": "application/json; UTF-8"
    }

    payload = {
        "to": token,
        "priority": "high",
        "notification": {
            "title": title,
            "body": body,
            "sound": "default",
            "icon": "./icon-192.png",
            "click_action": f"./index.html?openReservation=true&channelId={channel_id}&progTitle={urllib.parse.quote(prog_title)}"
        },
        "data": {
            "channelId": channel_id,
            "progTitle": prog_title,
            "title": title,
            "body": body,
            "timestamp": str(int(time.time()))
        }
    }

    try:
        req = urllib.request.Request(url, data=json.dumps(payload).encode('utf-8'), headers=headers)
        with urllib.request.urlopen(req, timeout=10) as resp:
            resp_data = resp.read().decode('utf-8')
            print(f"[FCM Service] 푸시 발송 성공: {resp_data}")
            return True
    except urllib.error.HTTPError as e:
        err_msg = e.read().decode('utf-8')
        print(f"[FCM Service] HTTP 에러 ({e.code}): {err_msg}")
    except Exception as e:
        print(f"[FCM Service] 푸시 발송 실패: {e}")

    return False

def broadcast_reservation_push(title, body, channel_id="1tv", prog_title=""):
    """등록된 모든 스마트폰 기기에 동시 푸시 발송"""
    tokens = load_registered_tokens()
    if not tokens:
        print("[FCM Service] 등록된 스마트폰 토큰이 없습니다.")
        return 0

    success_count = 0
    for t in tokens:
        if send_fcm_push(t, title, body, channel_id, prog_title):
            success_count += 1
    print(f"[FCM Service] 총 {len(tokens)}대 중 {success_count}대 발송 완료")
    return success_count

# 주요 온에어 모니터링 방송 편성 목록
DEFAULT_PROGRAM_SCHEDULE = [
    {"channel_id": "1tv", "channel_name": "KBS 1TV", "title": "KBS 뉴스광장", "start": "06:00"},
    {"channel_id": "1tv", "channel_name": "KBS 1TV", "title": "KBS 930 뉴스", "start": "09:30"},
    {"channel_id": "1tv", "channel_name": "KBS 1TV", "title": "KBS 뉴스 7", "start": "19:00"},
    {"channel_id": "1tv", "channel_name": "KBS 1TV", "title": "KBS 뉴스 9", "start": "21:00"},
    {"channel_id": "1radio", "channel_name": "1라디오", "title": "9시 로컬뉴스", "start": "09:00"},
    {"channel_id": "1radio", "channel_name": "1라디오", "title": "정오종합뉴스", "start": "12:00"},
    {"channel_id": "1radio", "channel_name": "1라디오", "title": "5시 로컬뉴스", "start": "17:00"},
    {"channel_id": "fm", "channel_name": "음악FM", "title": "음악이 있는 곳에", "start": "11:00"},
]

def run_schedule_monitor():
    """
    🎯 [사용자 핵심 요구] 방송 시작 1초 전 푸시 알림 발송 스케줄러 루프
    - 스마트폰이 꺼져 있거나 앱/웹이 종료된 상태에서도 백그라운드 푸시 알림 전송
    - 1초 전 알림을 클릭하면 시작 시각 정각에 바로 라이브 방송 시청
    """
    print("[FCM Service] 실시간 예약 감시 스케줄러 가동 중 (방송 시작 1초 전 발송 모드)...")
    notified_today = set()
    last_date_str = ""

    while True:
        now = datetime.now()
        cur_date_str = now.strftime("%Y-%m-%d")
        if cur_date_str != last_date_str:
            notified_today.clear()
            last_date_str = cur_date_str

        cur_sec = now.hour * 3600 + now.minute * 60 + now.second

        for item in DEFAULT_PROGRAM_SCHEDULE:
            parts = item["start"].split(":")
            start_sec = int(parts[0]) * 3600 + int(parts[1]) * 60
            key = f"{cur_date_str}_{item['channel_id']}_{item['start']}"

            # 방송 시작 딱 1초 전 (start_sec - 1)
            if cur_sec == (start_sec - 1) and key not in notified_today:
                notified_today.add(key)
                title = f"🔔 [{item['channel_name']}] {item['title']}"
                body = f"1초 후 방송이 시작됩니다! 터치하여 바로 시청하세요. ({item['start']})"
                print(f"[FCM Service] [T-1초] 방송 시작 1초 전 푸시 발송: {title}")
                broadcast_reservation_push(title, body, item["channel_id"], item["title"])

        time.sleep(0.5)

if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "--test":
        print("[FCM Service] 테스트 푸시 발송 시작...")
        test_token = sys.argv[2] if len(sys.argv) > 2 else ""
        if test_token:
            send_fcm_push(test_token, "🔔 [테스트] KBS 송출센터 예약 알림", "스마트폰 잠금화면 알림 연동 테스트입니다.", "1tv", "KBS 뉴스광장")
        else:
            broadcast_reservation_push("🔔 [테스트] KBS 송출센터 예약 알림", "스마트폰 잠금화면 알림 연동 테스트입니다.", "1tv", "KBS 뉴스광장")
    elif len(sys.argv) > 1 and sys.argv[1] == "--schedule":
        run_schedule_monitor()
    else:
        print("[FCM Service] KBS 송출센터 FCM 푸시 서비스 모듈이 준비되었습니다.")
        print("  - 테스트 발송: python fcm_push_service.py --test")
        print("  - 실시간 스케줄러: python fcm_push_service.py --schedule")
