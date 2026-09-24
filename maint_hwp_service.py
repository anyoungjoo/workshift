"""
KBS 송출센터 - 송신 시설 점검 계획 자동 감지 및 AI 연동 서비스
- 한글(.hwp), PDF(.pdf), 이미지/사진(.png, .jpg, .jpeg) 다중 포맷 지원
- 매월 상시 현재 월 변경 감지 및 월말(24일 이후) 다음 달 점검 계획 자동 AI 분석/대체
- 카이로스(FactChat) AI Gateway (Claude Sonnet 5 / Vision) 연동
- 월별 누적 저장 및 웹 브라우저와의 실시간 REST API 연동 (포트 8765)
"""

import os
import sys
import json
import time
import glob
import re
import io
import base64
from datetime import datetime
from http.server import HTTPServer, BaseHTTPRequestHandler
import threading
import urllib.parse
import subprocess

# 윈도우 콘솔 한글 UTF-8 출력 보장
try:
    if hasattr(sys.stdout, 'reconfigure'):
        sys.stdout.reconfigure(encoding='utf-8')
    if hasattr(sys.stderr, 'reconfigure'):
        sys.stderr.reconfigure(encoding='utf-8')
except Exception:
    pass

# .env 파일 로드
try:
    from dotenv import load_dotenv
    load_dotenv(os.path.join(os.path.dirname(__file__), '.env'), override=True)
except Exception:
    pass

from hwp_parser import extract_text_from_hwp, extract_hwp_table_plans

try:
    from openai import OpenAI
except ImportError:
    OpenAI = None

# 환경 설정값
API_GATEWAY_URL = os.environ.get('KAIROS_API_GATEWAY_URL', 'https://factchat.mindlogic-kr-api.com/v1/gateway')
API_KEY = os.environ.get('KAIROS_API_KEY', 'QxqAHcWwvePcBi7SQ5tnLelsTz7xXGVT')
AI_MODEL = os.environ.get('KAIROS_AI_MODEL', 'claude-sonnet-5')
LOCAL_PORT = int(os.environ.get('LOCAL_SERVER_PORT', '8765'))
PLANS_FILE = os.path.join(os.path.dirname(__file__), 'maint_facility_plans.json')
FOLDER_CONFIG_FILE = os.path.join(os.path.dirname(__file__), 'maint_folder_config.json')


def load_saved_watch_folder():
    """저장된 감시 폴더 설정 로드 (한 번 설정되면 재시작 후에도 계속 유지)"""
    if os.path.exists(FOLDER_CONFIG_FILE):
        try:
            with open(FOLDER_CONFIG_FILE, 'r', encoding='utf-8') as f:
                cfg = json.load(f)
                fld = cfg.get('folder')
                if fld and os.path.exists(fld):
                    return os.path.normpath(fld)
        except Exception as e:
            print(f"[Config] 설정 파일 읽기 오류: {e}")
    default_path = os.environ.get('WATCH_FOLDER_PATH', os.path.join(os.path.dirname(__file__), '점검계획_폴더'))
    return os.path.normpath(default_path)


def save_watch_folder(folder_path):
    """지정된 감시 폴더 경로를 영구 설정 파일에 저장"""
    try:
        norm = os.path.normpath(os.path.abspath(folder_path))
        with open(FOLDER_CONFIG_FILE, 'w', encoding='utf-8') as f:
            json.dump({'folder': norm}, f, ensure_ascii=False, indent=2)
        print(f"[Config] 감시 폴더 영구 설정 완료: {norm}")
    except Exception as e:
        print(f"[Config] 설정 파일 저장 오류: {e}")


def choose_native_folder(initial_dir=""):
    """
    Windows 네이티브 폴더 브라우저 창 호출 (내 PC, C:, D: 등 드라이브 및 전체 폴더를 그래픽 탐색)
    """
    helper_script = os.path.join(os.path.dirname(__file__), 'browse_folder.py')
    cmd = [sys.executable, helper_script]
    if initial_dir and os.path.exists(initial_dir):
        cmd.append(initial_dir)
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, encoding='utf-8', errors='replace', timeout=180)
        selected = proc.stdout.strip()
        if selected and os.path.exists(selected):
            return os.path.normpath(selected)
    except Exception as e:
        print(f"[FolderPicker] 폴더 탐색기 호출 실패: {e}")
    return None


WATCH_FOLDER_PATH = load_saved_watch_folder()

# 파일별 마지막 처리 시점(mtime) 캐시
processed_file_mtimes = {}


def ensure_watch_folder():
    """감지 대상 폴더가 없으면 자동 생성"""
    if not os.path.exists(WATCH_FOLDER_PATH):
        try:
            os.makedirs(WATCH_FOLDER_PATH, exist_ok=True)
        except Exception as e:
            print(f"[Facility Sync] 폴더 생성 오류: {e}")


def extract_text_from_pdf(file_or_bytes):
    """PDF 파일 경로 또는 바이트에서 텍스트 추출"""
    try:
        from pypdf import PdfReader
        if isinstance(file_or_bytes, bytes):
            reader = PdfReader(io.BytesIO(file_or_bytes))
        else:
            reader = PdfReader(file_or_bytes)
        text_parts = []
        for idx, page in enumerate(reader.pages):
            t = page.extract_text()
            if t:
                text_parts.append(t)
        return "\n".join(text_parts)
    except Exception as e:
        raise ValueError(f"PDF 텍스트 추출 실패: {e}")


def parse_json_plans_from_ai_response(content):
    """AI 응답 텍스트에서 JSON 배열을 안전하게 파싱하고 color 필드를 정규화"""
    clean_content = content.strip()
    if clean_content.startswith("```"):
        clean_content = re.sub(r"^```[a-zA-Z]*\n?", "", clean_content)
        clean_content = re.sub(r"\n?```$", "", clean_content).strip()

    raw_plans = []
    try:
        data = json.loads(clean_content)
        if isinstance(data, dict) and "plans" in data:
            data = data["plans"]
        if isinstance(data, list):
            raw_plans = data
    except Exception:
        match = re.search(r"\[\s*\{.*\}\s*\]", clean_content, re.DOTALL)
        if match:
            raw_plans = json.loads(match.group(0))

    if not raw_plans:
        raise ValueError(f"AI 응답에서 유효한 JSON 배열을 파싱하지 못했습니다.\n응답 내용:\n{content}")

    normalized = []
    for item in raw_plans:
        if not isinstance(item, dict):
            continue
        date_val = str(item.get('date', '')).strip()
        task_val = str(item.get('task', '')).strip()
        color_val = str(item.get('color', '')).lower().strip()

        # [RED:...] 또는 [BLUE:...] 태그가 task에 포함된 경우 색상 감지 및 텍스트 정제
        if '[red:' in task_val.lower():
            color_val = 'red'
            task_val = re.sub(r'\[red:\s*(.*?)\s*\]', r'\1', task_val, flags=re.IGNORECASE).strip()
        elif '[blue:' in task_val.lower():
            color_val = 'blue'
            task_val = re.sub(r'\[blue:\s*(.*?)\s*\]', r'\1', task_val, flags=re.IGNORECASE).strip()

        if color_val not in ['red', 'blue', 'black']:
            if any(k in color_val for k in ['red', '빨강', '빨간']):
                color_val = 'red'
            elif any(k in color_val for k in ['blue', '파랑', '파란']):
                color_val = 'blue'
            else:
                color_val = 'black'

        if date_val and task_val:
            normalized.append({
                'date': date_val,
                'task': task_val,
                'color': color_val
            })

    return normalized


def analyze_text_with_ai(doc_text, source_filename=""):
    """
    텍스트 문서(HWP/PDF) 내용을 카이로스 AI Gateway에 전달하여
    글자 색상(빨강, 파랑, 검정) 및 날짜 1:1 일치 검증된 송신 시설 점검 계획 추출
    """
    if not API_KEY or API_KEY == 'YOUR_API_KEY':
        raise ValueError(".env 파일의 KAIROS_API_KEY에 올바른 카이로스 API 키를 입력해 주세요.")
    if not OpenAI:
        raise RuntimeError("openai 라이브러리가 필요합니다. (pip install openai)")

    client = OpenAI(api_key=API_KEY, base_url=API_GATEWAY_URL)
    system_prompt = (
        "당신은 방송국 송출/송신 시설 관리 데이터 분석 전문가입니다.\n"
        "제공되는 문서 원문에서 오직 **'송신 시설 점검 및 계획정파(점파)'**에 해당하는 내용만 정확하게 추출해야 합니다.\n\n"
        "[🎯 핵심 규칙 1: 글자 색상 판별 (Color Matching - 필수)]\n"
        "문서 원문의 글자 색상(또는 [RED:...], [BLUE:...] 태그)을 반드시 판독하여 'color' 필드에 지정해야 합니다:\n"
        "  * 'red' (빨간색 글씨): 실제로 진행하는 계획점파(가장 중요)입니다.\n"
        "  * 'blue' (파란색 글씨): 자체 송신/송출센터 점검을 위한 계획점파/작업입니다.\n"
        "  * 'black' (검은색 글씨): 일반 정기점검 및 통상 점검입니다.\n\n"
        "[🎯 핵심 규칙 2: 날짜와 작업 내용의 완벽한 1:1 일치 (Date Accuracy - 필수)]\n"
        "- 각 날짜(일자) 칸 안에 기재된 작업 내용만이 해당 날짜의 계획입니다.\n"
        "- 원본 문서의 일자와 작업 내용이 절대 달라지거나 다른 날짜의 내용이 섞여 들어오지 않도록 엄격히 대조하세요.\n"
        "- 표 밖의 참고사항/공지사항이나 교대근무자 명단, 일반 휴가 등은 절대 포함하지 마세요.\n\n"
        "[🎯 핵심 규칙 3: JSON 출력 형식]\n"
        "- date는 반드시 'YYYY-MM-DD' 형식 (예: 2026-10-06)으로 작성하세요.\n"
        "- task는 원문의 시설명과 점검/정파 내용을 명확하게 유지하세요.\n"
        "- 출력은 아래와 같은 순수 JSON 배열만 출력해야 합니다. 마크다운 코드블록이나 부가 설명 문구는 절대 붙이지 마세요.\n\n"
        "[\n"
        '  {"date": "2026-10-06", "task": "우암(1TV/음악FM)", "color": "blue"},\n'
        '  {"date": "2026-10-13", "task": "식장(음악FM)", "color": "red"},\n'
        '  {"date": "2026-10-14", "task": "우암산송신소 정기점검", "color": "black"}\n'
        "]"
    )

    user_prompt = f"파일명: {source_filename}\n\n[문서 원문 텍스트 (글자색 태그 포함)]:\n{doc_text[:16000]}"

    response = client.chat.completions.create(
        model=AI_MODEL,
        messages=[
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt}
        ],
        temperature=0.1
    )
    return parse_json_plans_from_ai_response(response.choices[0].message.content)


def analyze_image_with_ai(image_bytes, source_filename="", mime_type="image/jpeg"):
    """
    이미지 또는 사진(촬영본/문서 캡처)을 카이로스 Vision AI에 전달하여
    글자 색상(빨강, 파랑, 검정) 및 날짜 1:1 일치 송신 시설 점검 계획 추출
    """
    if not API_KEY or API_KEY == 'YOUR_API_KEY':
        raise ValueError(".env 파일의 KAIROS_API_KEY에 올바른 카이로스 API 키를 입력해 주세요.")
    if not OpenAI:
        raise RuntimeError("openai 라이브러리가 필요합니다. (pip install openai)")

    b64_str = base64.b64encode(image_bytes).decode('utf-8')
    client = OpenAI(api_key=API_KEY, base_url=API_GATEWAY_URL)
    system_prompt = (
        "당신은 방송국 송출/송신 시설 관리 데이터 분석 전문가입니다.\n"
        "제공되는 이미지 속의 송신시설 점검계획 일정표에서 오직 **'송신 시설 점검 및 계획정파(점파)'** 일정만 정확하게 추출해야 합니다.\n\n"
        "[🎯 핵심 규칙 1: 글자 색상 판별 (Color Matching - 필수)]\n"
        "각 날짜 칸 안의 텍스트 글자 색상을 반드시 판독하여 'color' 필드에 정확히 지정해야 합니다:\n"
        "  * 'red' (빨간색 글씨): 실제로 진행하는 계획점파(최우선 중요 계획)입니다.\n"
        "  * 'blue' (파란색 글씨): 자체 송출/송신센터 점검을 위한 계획점파/작업입니다.\n"
        "  * 'black' (검은색 글씨): 일반 정기점검 및 통상 작업입니다.\n\n"
        "[🎯 핵심 규칙 2: 날짜와 작업 내용의 완벽한 1:1 일치 (Date Accuracy - 필수)]\n"
        "- 각 날짜(일자) 칸 안에 기재된 작업 내용만이 해당 날짜의 계획입니다.\n"
        "- 달력 표의 날짜와 작업 내용이 절대 달라지거나 하루라도 밀려서는 안 됩니다. 다른 날짜의 내용이 섞여 들어오지 않도록 철저히 대조하세요.\n"
        "- 표 밖의 참고사항/공지사항이나 교대근무자 명단, 일반 휴가 등은 절대 포함하지 마세요.\n\n"
        "[🎯 핵심 규칙 3: JSON 출력 형식]\n"
        "- date는 반드시 'YYYY-MM-DD' 형식 (예: 2026-09-02)으로 작성하세요.\n"
        "- task는 원문의 시설명과 점검/정파 내용을 명확하게 기재하세요.\n"
        "- 출력은 아래와 같은 순수 JSON 배열만 출력해야 합니다. 마크다운 코드블록이나 불필요한 설명은 절대 붙이지 마세요.\n\n"
        "[\n"
        '  {"date": "2026-09-02", "task": "식장(음악FM)", "color": "red"},\n'
        '  {"date": "2026-09-02", "task": "우암(1TV/음악FM)", "color": "blue"},\n'
        '  {"date": "2026-09-04", "task": "우암산송신소 정기점검", "color": "black"}\n'
        "]"
    )

    response = client.chat.completions.create(
        model=AI_MODEL,
        messages=[
            {"role": "system", "content": system_prompt},
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": f"파일명: {source_filename}\n이 이미지 속의 송신 시설 점검 계획 일정표를 판독하여, 글자 색상(red/blue/black)과 해당 일자별 작업 내용을 정확히 일치시켜 순수 JSON 배열로 반환하세요."},
                    {"type": "image_url", "image_url": {"url": f"data:{mime_type};base64,{b64_str}"}}
                ]
            }
        ],
        temperature=0.1
    )
    return parse_json_plans_from_ai_response(response.choices[0].message.content)


def get_current_plans():
    """저장된 최신 점검 계획 반환"""
    if os.path.exists(PLANS_FILE):
        try:
            with open(PLANS_FILE, 'r', encoding='utf-8') as f:
                return json.load(f)
        except Exception:
            pass
    return {
        "lastSync": None,
        "sourceFile": None,
        "folder": os.path.abspath(WATCH_FOLDER_PATH),
        "totalCount": 0,
        "plans": []
    }


def detect_primary_month(filename, plans):
    """
    파일명 및 계획 날짜들을 기반으로 이 파일의 주 대상 월(YYYY-MM)을 결정.
    1. 파일명에서 YYYYMM (예: 202609, 202610), YYYY-MM, YYYY.MM, YYYY_MM 추출
    2. 파일명에서 'N월' 추출
    3. 계획 항목 날짜 빈도수 중 최빈 월
    """
    # 1. YYYYMM 또는 YYYY-MM 등 추출
    m = re.search(r'(20\d{2})[-_.]?(0[1-9]|1[0-2])', filename or '')
    if m:
        return f"{m.group(1)}-{m.group(2)}"

    # 2. '9월', '10월' 등 추출
    m_month = re.search(r'([1-9]|1[0-2])월', filename or '')
    if m_month:
        month_num = int(m_month.group(1))
        # 연도는 현재 연도 또는 plans에서 추출
        now_year = datetime.now().year
        return f"{now_year}-{month_num:02d}"

    # 3. plans 날짜 최빈값
    month_counts = {}
    for p in (plans or []):
        d = p.get('date', '')
        if len(d) >= 7:
            ym = d[:7]
            month_counts[ym] = month_counts.get(ym, 0) + 1

    if month_counts:
        return max(month_counts.items(), key=lambda x: x[1])[0]

    return datetime.now().strftime('%Y-%m')


def get_plan_sort_priority(item):
    """
    KBS 송출센터 시설 점검 계획 원본 및 업무 비중 기준 정렬 우선순위
    1. 특수/법정 검사: 전기설비 법정검사 등 최상단 (rank 1)
    2. 송신소 정기점검: 우암 > 청원 (우암 rank 10, 청원 rank 11)
    3. 전기대행 등 부대 작업: 청원전기대행 등 (rank 20)
    4. 계획정파: 우암 > 가엽 > 식장 > 기타 (우암 rank 30, 가엽 rank 31, 식장 rank 32, 기타 rank 35)
    5. TVR / 중계소 (옥천, 영동, 보은, 청천, 청산, 학산, 상촌, 소수 등): 무조건 최하단 바닥 (rank 90)
    """
    task = str(item.get('task', '')).strip()
    color = str(item.get('color', '')).lower().strip()
    cat = str(item.get('category', '')).strip()

    # 1. 특수/법정 검사
    if any(k in task for k in ['법정검사', '전기설비']):
        return 1

    # 2. 송신소 정기점검 (우암산/우암 > 청원)
    is_regular = (cat in ['정기점검', '시설점검', '일반점검'] or color == 'black')
    if is_regular:
        if task in ['우암', '우암산', '우암산송신소'] or (task.startswith('우암') and not ('(' in task or '계획' in task)):
            return 10
        # 무선국수검 등 우암 관련 수검 항목은 우암 바로 밑
        if '수검' in task or '무선국' in task:
            return 10.5
        if task in ['청원', '청원송신소', '청원 AM', '청원AM'] or (task.startswith('청원') and '전기대행' not in task and not ('(' in task or '계획' in task)):
            return 11
        if '전기대행' in task:
            return 20

    # 3. 계획정파 (우암 > 가엽 > 식장 > 기타)
    is_jeongpa = (color in ['red', 'blue'] or '계획' in task or '정파' in task or '(' in task or cat in ['계획정파', '계획점파'])
    if is_jeongpa:
        tvr_names = ['옥천', '영동', '보은', '청천', '청산', '학산', '상촌', '소수', 'TVR']
        if not any(k in task for k in tvr_names):
            if '우암' in task:
                return 30
            elif '가엽' in task:
                return 31
            elif '식장' in task:
                return 32
            else:
                return 35

    # 4. TVR / 중계소 (옥천, 영동, 보은 등): 무조건 최하단 바닥!
    tvr_locations = ['옥천', '영동', '보은', '청천', '청산', '학산', '상촌', '소수', 'TVR', '중계소']
    if any(loc in task for loc in tvr_locations) or 'TVR' in cat or 'T  V  R' in cat:
        return 90

    if '수검' in task or '무선국' in task:
        return 10.5

    return 50


def get_monitoring_target_months(now=None):
    """
    🎯 [사용자 핵심 규칙: 감시 대상 월]
    - 1일 ~ 24일: 당월(cur_ym)만 감시
    - 25일 ~ 말일: 당월(cur_ym) + 익월(next_ym) 동시 감시
    - 과거 달(지난달, 전전달 등): 파일을 스캔하여 덮어쓰지 않고 기존 저장 데이터를 영구 보존!
    """
    if now is None:
        now = datetime.now()
    cur_year = now.year
    cur_month = now.month
    cur_day = now.day

    cur_ym = f"{cur_year}-{cur_month:02d}"

    if cur_month == 12:
        next_ym = f"{cur_year + 1}-01"
    else:
        next_ym = f"{cur_year}-{cur_month + 1:02d}"

    if cur_day >= 25:
        return [cur_ym, next_ym]
    else:
        return [cur_ym]


def merge_and_save_plans(new_plans, source_filename=""):
    """
    새로 추출된 계획을 기존 데이터와 병합 저장:
    - 이번 파일의 주 대상 월(primary_month)의 계획만 최신본으로 갱신
    - 🎯 [사용자 핵심 규칙] 과거 달(지난달, 전전달 등) 및 다른 월의 기존 계획은 절대 삭제하지 않고 영구 보존!
    """
    current_data = get_current_plans()
    existing_plans = current_data.get("plans", [])

    if not new_plans:
        return current_data

    primary_month = detect_primary_month(source_filename, new_plans)

    # 1. 🎯 [영구 보존] 기존 계획 중 이번 파일의 주 대상 월(primary_month)이 아닌 모든 계획(과거 달, 미래 달 등)은 온전히 보존
    preserved_existing = [p for p in existing_plans if not p.get('date', '').startswith(primary_month)]

    # 2. 이번 새 계획 중 주 대상 월 항목
    primary_new = [p for p in new_plans if p.get('date', '').startswith(primary_month)]

    # 3. 이번 새 계획 중 다른 월에 부수적으로 걸친 항목 (중복 방지 병합)
    other_new = [p for p in new_plans if not p.get('date', '').startswith(primary_month)]
    existing_keys = {(p.get('date', ''), p.get('task', '').strip(), p.get('color', '').lower()) for p in preserved_existing}
    added_others = []
    for p in other_new:
        key = (p.get('date', ''), p.get('task', '').strip(), p.get('color', '').lower())
        if key not in existing_keys:
            added_others.append(p)
            existing_keys.add(key)

    merged_plans = preserved_existing + primary_new + added_others

    # 4. 공휴일/기념일 필터링 (불필요한 문구 제외)
    cleaned = []
    for p in merged_plans:
        t = p.get('task', '').strip()
        if any(h in t for h in ['방송의날', '방송의 날', '대체휴일', '한글날', '추석', '설날', '신정', '광복절', '개천절', '어린이날', '현충일', '삼일절', '크리스마스']):
            continue
        cleaned.append(p)
    merged_plans = cleaned

    # 6. 사용자 업무 비중 및 원본 표 순서 기준 정렬
    def get_sort_tuple(x):
        date_str = x.get('date', '')
        if 'sortIndex' in x and x['sortIndex'] is not None:
            return (date_str, 0, x['sortIndex'])
        order_val = x.get('order')
        if order_val is not None:
            return (date_str, 1, order_val, get_plan_sort_priority(x))
        return (date_str, 2, get_plan_sort_priority(x))

    merged_plans.sort(key=get_sort_tuple)

    # 소스 파일 이름 목록 관리
    cur_sources = [s.strip() for s in (current_data.get("sourceFile") or "").split(",") if s.strip()]
    if source_filename and source_filename not in cur_sources:
        cur_sources.append(source_filename)
    combined_source_file = ", ".join(cur_sources) if cur_sources else (source_filename or "송신 시설 점검 계획")

    result_payload = {
        "lastSync": datetime.now().isoformat(),
        "sourceFile": combined_source_file,
        "folder": os.path.abspath(WATCH_FOLDER_PATH),
        "totalCount": len(merged_plans),
        "plans": merged_plans
    }

    with open(PLANS_FILE, 'w', encoding='utf-8') as f:
        json.dump(result_payload, f, ensure_ascii=False, indent=2)

    return result_payload


def process_general_file(file_path=None, file_bytes=None, filename=""):
    """
    HWP, PDF, 이미지 파일 자동 분기 처리 -> AI/직접 분석 -> 월별 누적 병합 저장
    """
    if file_path:
        filename = os.path.basename(file_path)
        with open(file_path, 'rb') as f:
            file_bytes = f.read()

    if not file_bytes:
        raise ValueError("파일 내용이 비어있습니다.")

    ext = os.path.splitext(filename)[1].lower()
    print(f"[Facility Sync] 파일 분석 시작: {filename} (확장자: {ext}, 크기: {len(file_bytes)} bytes)")

    if ext == '.hwp':
        table_plans = extract_hwp_table_plans(file_bytes, filename)
        if table_plans and len(table_plans) > 0:
            print(f"[Facility Sync] HWP 점검표 구조 및 글자색(빨강/파랑/검정) 직접 파싱 성공: {len(table_plans)}건")
            plans = table_plans
        else:
            text = extract_text_from_hwp(file_bytes)
            if not text.strip():
                raise ValueError("한글 문서에서 텍스트를 추출할 수 없습니다.")
            plans = analyze_text_with_ai(text, filename)
    elif ext == '.pdf':
        text = extract_text_from_pdf(file_bytes)
        if not text.strip():
            raise ValueError("PDF 문서에서 텍스트를 추출할 수 없습니다.")
        plans = analyze_text_with_ai(text, filename)
    elif ext in ('.png', '.jpg', '.jpeg', '.webp', '.bmp'):
        mime_map = {
            '.png': 'image/png',
            '.jpg': 'image/jpeg',
            '.jpeg': 'image/jpeg',
            '.webp': 'image/webp',
            '.bmp': 'image/bmp'
        }
        plans = analyze_image_with_ai(file_bytes, filename, mime_map.get(ext, 'image/jpeg'))
    else:
        raise ValueError(f"지원되지 않는 파일 형식입니다: {ext} (지원: .hwp, .pdf, .jpg, .png 등)")

    print(f"[Facility Sync] 분석 완료: 총 {len(plans)}건의 송신 시설 점검 계획 추출 성공!")
    res = merge_and_save_plans(plans, source_filename=filename)
    return res


def clear_current_plans():
    """정비일정 데이터 초기화 (plans를 빈 목록으로 리셋)"""
    ensure_watch_folder()
    with open(PLANS_FILE, 'w', encoding='utf-8') as f:
        json.dump({
            "lastSync": None,
            "sourceFile": None,
            "folder": os.path.abspath(WATCH_FOLDER_PATH),
            "totalCount": 0,
            "plans": []
        }, f, ensure_ascii=False, indent=2)
    processed_file_mtimes.clear()
    print("[Facility Sync] 정비일정 계획 데이터 초기화 완료.")


def scan_and_sync_all_relevant_files(force=False, is_initial=False, target_month=None):
    """
    지정 폴더에서 점검 및 업무 계획 파일을 탐색하여 AI로 분석하고 저장합니다.
    - target_month: 특정 근무월(예: '2026-09') 지정 시 해당 월 파일 우선 분석
    - force=True: 수동 동기화 요청 시 캐시와 무관하게 해당 월 대상 파일을 재분석하여 동기화
    - 🎯 [사용자 핵심 규칙]:
      1. 과거 달(지난달 등) 데이터는 일체 건드리지 않고 영구 보존
      2. 25일~말일: 당월 + 익월(다음 달) 파일 감시
      3. 1일~24일: 당월 파일 감시 (수정본 파일 생성/수정 시에만 업데이트, 없으면 웹 수동 수정 유지)
    """
    ensure_watch_folder()
    supported_exts = ('.hwp', '.pdf', '.png', '.jpg', '.jpeg', '.webp', '.bmp')
    all_files = []
    for root, _, files in os.walk(WATCH_FOLDER_PATH):
        for f in files:
            ext = os.path.splitext(f)[1].lower()
            if ext in supported_exts:
                all_files.append(os.path.join(root, f))

    # 관련 파일 필터링: 연월 패턴이 있거나 관련 키워드가 포함된 파일
    target_keywords = ['점검', '시설', '송신', '정비', '계획', '업무', '근무', '일정']
    candidate_files = []
    for f in all_files:
        bname = os.path.basename(f)
        has_date_pattern = bool(re.search(r'20\d{2}[-_.]?(0[1-9]|1[0-2])|([1-9]|1[0-2])월', bname))
        has_keyword = any(k in bname for k in target_keywords)
        if has_date_pattern or has_keyword:
            candidate_files.append(f)

    if not candidate_files:
        print("[Watcher] 지정 폴더 내에 처리할 점검계획 파일이 없습니다.")
        return False

    def get_file_priority_score(filepath):
        bname = os.path.basename(filepath).lower()
        score = 0
        # 수정본 / 최종본 가산점 (수정, 최종, 확정 키워드)
        if any(k in bname for k in ['최종', '수정', '변경', '확정']):
            score += 100
        # 포맷 점수
        ext = os.path.splitext(filepath)[1].lower()
        if ext == '.hwp': score += 30
        elif ext == '.pdf': score += 20
        else: score += 10
        # 파일 수정 시간(mtime) 추가
        score += os.path.getmtime(filepath) / 1e10
        return score

    # 감시 대상 월 목록 결정
    if target_month:
        target_months = [target_month]
    else:
        target_months = get_monitoring_target_months()

    files_to_process = []

    for ym in target_months:
        month_part = ym.split('-')[-1] if '-' in ym else ''
        month_int = int(month_part) if month_part.isdigit() else None
        target_ym_compact = ym.replace('-', '')
        month_matched = []

        for f in candidate_files:
            bname = os.path.basename(f)
            # 202609, 2026-09, 2026.09 매칭 또는 9월 매칭
            if target_ym_compact in bname.replace('-', '').replace('.', ''):
                month_matched.append(f)
            elif month_int and f"{month_int}월" in bname:
                month_matched.append(f)

        if month_matched:
            # 점수 및 최신 수정 일시 기준 가장 최적의 파일 1개 선정
            month_matched.sort(key=get_file_priority_score, reverse=True)
            chosen_file = month_matched[0]
            files_to_process.append((ym, chosen_file))
            print(f"[Watcher] 근무월({ym}) 최신/수정본 점검 계획 파일 선정: {os.path.basename(chosen_file)}")

    # 만약 대상 월에 맞는 파일이 없으나 전체 후보가 있는 경우 (단일 파일인 경우)
    if not files_to_process and candidate_files:
        candidate_files.sort(key=get_file_priority_score, reverse=True)
        files_to_process.append((None, candidate_files[0]))
        print(f"[Watcher] 최신 점검 계획 파일 선정: {os.path.basename(candidate_files[0])}")

    updated_any = False

    for ym, f in files_to_process:
        bname = os.path.basename(f)
        mtime = os.path.getmtime(f)
        last_mtime = processed_file_mtimes.get(f)

        # 수동 동기화(force=True)이거나 신규 파일/수정본 파일(mtime 변경) 감지 시
        if force or last_mtime != mtime:
            print(f"[Watcher] 점검 계획 파일 AI 분석 실행 ({bname}, 신규/수정 감지)")
            try:
                process_general_file(file_path=f)
                processed_file_mtimes[f] = mtime
                updated_any = True
            except Exception as err:
                print(f"[Watcher] 파일 처리 실패 ({bname}): {err}")
        else:
            print(f"[Watcher] 파일 변경 없음 (웹 수기 수정 및 기존 내용 보존): {bname}")

    return updated_any


# ================================================================
# 로컬 REST API 서버 (웹 프론트엔드 연동)
# ================================================================
class ApiHandler(BaseHTTPRequestHandler):
    def _send_cors(self):
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type, Access-Control-Request-Private-Network')
        self.send_header('Access-Control-Allow-Private-Network', 'true')

    def _send_json(self, status_code, obj):
        try:
            body = json.dumps(obj, ensure_ascii=False).encode('utf-8')
            self.send_response(status_code)
            self._send_cors()
            self.send_header('Content-Type', 'application/json; charset=utf-8')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        except (ConnectionResetError, ConnectionAbortedError, BrokenPipeError):
            pass

    def do_OPTIONS(self):
        self.send_response(200)
        self._send_cors()
        self.end_headers()

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)

        if parsed.path == '/api/status':
            plans_data = get_current_plans()
            status = {
                "watchFolder": os.path.abspath(WATCH_FOLDER_PATH),
                "folderExists": os.path.exists(WATCH_FOLDER_PATH),
                "apiKeyConfigured": bool(API_KEY and API_KEY != 'YOUR_API_KEY'),
                "aiModel": AI_MODEL,
                "gatewayUrl": API_GATEWAY_URL,
                "lastSync": plans_data.get("lastSync"),
                "sourceFile": plans_data.get("sourceFile"),
                "totalCount": plans_data.get("totalCount", 0)
            }
            self._send_json(200, status)

        elif parsed.path == '/api/folder':
            self._send_json(200, {
                "success": True,
                "folder": os.path.abspath(WATCH_FOLDER_PATH),
                "exists": os.path.exists(WATCH_FOLDER_PATH)
            })

        elif parsed.path == '/api/plans':
            data = get_current_plans()
            self._send_json(200, data)

        elif parsed.path == '/api/clear-plans':
            try:
                clear_current_plans()
                self._send_json(200, {
                    "success": True,
                    "message": "정비일정 데이터가 완전히 초기화되었습니다.",
                    "data": get_current_plans()
                })
            except Exception as e:
                self._send_json(500, {"success": False, "message": str(e)})

        elif parsed.path == '/api/sync':
            query_params = urllib.parse.parse_qs(parsed.query)
            target_month = query_params.get('targetMonth', [None])[0] or query_params.get('month', [None])[0]
            try:
                updated = scan_and_sync_all_relevant_files(force=True, is_initial=False, target_month=target_month)
                current_data = get_current_plans()
                notice = f"PC 최신 파일 AI 동기화 완료 (총 {current_data.get('totalCount', 0)}건)"
                self._send_json(200, {"success": True, "data": current_data, "notice": notice})
            except Exception as e:
                self._send_json(500, {"success": False, "message": str(e)})

        else:
            self.send_response(404)
            self._send_cors()
            self.end_headers()

    def do_POST(self):
        global WATCH_FOLDER_PATH
        parsed = urllib.parse.urlparse(self.path)

        # 🎯 [사용자 요청] 내 PC / C: / D: 드라이브를 브라우징하는 Windows 네이티브 폴더 브라우저 창 호출
        # (폴더 지정 시 동기화는 일체 진행하지 않고 오직 폴더 경로만 영구 지정/보존)
        if parsed.path == '/api/browse-folder':
            try:
                selected_folder = choose_native_folder(WATCH_FOLDER_PATH)
                if selected_folder:
                    WATCH_FOLDER_PATH = selected_folder
                    save_watch_folder(selected_folder)
                    # 🎯 [사용자 요청] 최초 폴더 지정 즉시 해당 폴더의 최신 계획 파일 AI 분석 실행
                    scan_and_sync_all_relevant_files(force=True, is_initial=True)
                    current_data = get_current_plans()
                    self._send_json(200, {
                        "success": True,
                        "folder": os.path.abspath(WATCH_FOLDER_PATH),
                        "data": current_data,
                        "notice": f"📁 점검 계획 폴더가 지정되었습니다.\n{os.path.abspath(WATCH_FOLDER_PATH)}\n(총 {current_data.get('totalCount', 0)}건 동기화 완료)"
                    })
                else:
                    self._send_json(200, {
                        "success": False,
                        "cancelled": True,
                        "folder": os.path.abspath(WATCH_FOLDER_PATH),
                        "notice": "폴더 선택이 취소되었습니다."
                    })
            except Exception as e:
                self._send_json(500, {"success": False, "message": str(e)})

        elif parsed.path == '/api/set-folder':
            content_length = int(self.headers.get('Content-Length', 0))
            post_body = self.rfile.read(content_length)
            try:
                payload = json.loads(post_body.decode('utf-8'))
                new_folder = payload.get('folder', '').strip()
                if not new_folder:
                    raise ValueError('폴더 경로가 비어 있습니다.')
                if not os.path.exists(new_folder):
                    raise ValueError(f'지정한 폴더가 존재하지 않습니다: {new_folder}')

                WATCH_FOLDER_PATH = new_folder
                save_watch_folder(new_folder)
                # 🎯 [사용자 요청] 경로 입력 즉시 해당 폴더의 최신 계획 파일 AI 분석 실행
                scan_and_sync_all_relevant_files(force=True, is_initial=True)
                current_data = get_current_plans()
                self._send_json(200, {
                    "success": True,
                    "folder": os.path.abspath(WATCH_FOLDER_PATH),
                    "data": current_data,
                    "notice": f"감시 폴더가 지정되었습니다.\n경로: {os.path.abspath(WATCH_FOLDER_PATH)}\n(총 {current_data.get('totalCount', 0)}건 동기화 완료)"
                })
            except Exception as e:
                self._send_json(500, {"success": False, "message": str(e)})

        elif parsed.path == '/api/clear-plans':
            try:
                clear_current_plans()
                self._send_json(200, {
                    "success": True,
                    "message": "정비일정 데이터가 완전히 초기화되었습니다.",
                    "data": get_current_plans()
                })
            except Exception as e:
                self._send_json(500, {"success": False, "message": str(e)})

        elif parsed.path == '/api/sync':
            target_month = None
            try:
                content_length = int(self.headers.get('Content-Length', 0))
                if content_length > 0:
                    post_body = self.rfile.read(content_length)
                    payload = json.loads(post_body.decode('utf-8'))
                    target_month = payload.get('targetMonth') or payload.get('month')
            except Exception:
                pass
            try:
                # 🎯 [사용자 요청] 지정된 폴더 안에서 해당 근무월 계획표 파일을 AI로 처리하여 반환
                updated = scan_and_sync_all_relevant_files(force=True, is_initial=False, target_month=target_month)
                current_data = get_current_plans()
                if not updated and current_data.get('totalCount', 0) == 0:
                    notice = "지정된 폴더에 처리 가능한 점검 계획 파일(.hwp, .pdf, 이미지)이 없습니다."
                else:
                    file_name = current_data.get('sourceFile', '')
                    file_msg = f"[{file_name}] " if file_name else ""
                    notice = f"{file_msg}AI 분석 완료 (총 {current_data.get('totalCount', 0)}건)"
                self._send_json(200, {"success": True, "data": current_data, "notice": notice})
            except Exception as e:
                self._send_json(500, {"success": False, "message": str(e)})

        elif parsed.path == '/api/upload':
            content_length = int(self.headers.get('Content-Length', 0))
            post_body = self.rfile.read(content_length)
            try:
                payload = json.loads(post_body.decode('utf-8'))
                file_bytes = base64.b64decode(payload['base64'])
                filename = payload.get('filename', 'uploaded_file')

                ensure_watch_folder()
                save_path = os.path.join(WATCH_FOLDER_PATH, filename)
                with open(save_path, 'wb') as sf:
                    sf.write(file_bytes)

                processed_file_mtimes[save_path] = os.path.getmtime(save_path)
                res = process_general_file(file_bytes=file_bytes, filename=filename)
                self._send_json(200, {"success": True, "data": res})
            except Exception as e:
                self._send_json(500, {"success": False, "message": str(e)})

        elif parsed.path == '/api/plans/save':
            content_length = int(self.headers.get('Content-Length', 0))
            post_body = self.rfile.read(content_length)
            try:
                payload = json.loads(post_body.decode('utf-8'))
                plans = payload.get('plans', [])
                current_data = get_current_plans()

                # 🎯 [사용자 규칙] 저장 시에도 지난달(과거 월) 데이터는 완전히 배제/제거
                allowed_months = get_allowed_target_months()
                filtered_plans = [p for p in plans if any(p.get('date', '').startswith(m) for m in allowed_months)]

                current_data['plans'] = filtered_plans
                current_data['totalCount'] = len(filtered_plans)
                current_data['lastSync'] = datetime.now().isoformat()
                if payload.get('sourceFile'):
                    current_data['sourceFile'] = payload['sourceFile']

                with open(PLANS_FILE, 'w', encoding='utf-8') as f:
                    json.dump(current_data, f, ensure_ascii=False, indent=2)

                self._send_json(200, {"success": True, "data": current_data})
            except Exception as e:
                self._send_json(500, {"success": False, "message": str(e)})
        else:
            self.send_response(404)
            self._send_cors()
            self.end_headers()

    def log_message(self, format, *args):
        pass


def start_background_watcher():
    """
    백그라운드 스레드:
    🎯 [사용자 정의 점검계획 자동 관리 라이프사이클 규칙]
    1. 매달 1일 ~ 5일:
       - 새로운 달 시작 시, 매일 1회 당월 최신본/확정본을 조사하여 변경사항 자동 갱신
    2. 매달 6일 ~ 24일:
       - 기본적으로 웹 앱에서 직접 수정한 내용이 우선순위
       - 단, 매일 1회 폴더를 체크하여 '수정본 파일(...수정.hwp 등)'이 새로 생성되었거나 파일 수정일시가 달라진 경우에만 재분석하여 웹에 업데이트
       - 파일에 변화가 없으면 웹 수동 수정 내용을 그대로 안전하게 유지
    3. 매달 25일 ~ 말일:
       - 매일 1회 다음 달(익월) 점검계획 파일이 폴더에 올라왔는지 조사
       - 다음 달 파일이 감지되면 분석하여 다음 달 달력에 미리 표시
    4. 지난달(과거 달) 데이터:
       - 월이 넘어가면 더 이상 파일을 스캔하거나 덮어쓰지 않고, 저장된 값 그대로 영구 유지!
    """
    def watcher_loop():
        last_checked_day_key = None
        while True:
            try:
                now = datetime.now()
                cur_day = now.day
                today_key = now.strftime('%Y-%m-%d')

                # 오늘 아직 자동 조사를 안 한 경우에만 실행
                plans_now = get_current_plans()
                # 사용자가 초기화하여 계획이 0건인 경우에는 [폴더 동기화]를 직접 누르기 전까지 자동 덮어쓰기 방지
                if plans_now.get('totalCount', 0) == 0:
                    time.sleep(300)
                    continue

                if today_key != last_checked_day_key:
                    # 1. 매월 1일 ~ 5일: 당월 확정본 및 변경사항 매일 1회 체크
                    if 1 <= cur_day <= 5:
                        print(f"[Watcher] {now.strftime('%Y-%m-%d')}: 매월 1~5일 당월 최신 확정본 파일 자동 탐색 중...")
                        scan_and_sync_all_relevant_files(force=False)
                        last_checked_day_key = today_key
                    # 2. 매월 25일 ~ 말일: 익월(다음 달) 계획 파일 조사 및 미리 반영
                    elif cur_day >= 25:
                        print(f"[Watcher] {now.strftime('%Y-%m-%d')}: 매월 25~말일 익월(다음 달) 점검계획 파일 자동 탐색 중...")
                        scan_and_sync_all_relevant_files(force=False)
                        last_checked_day_key = today_key
                    # 3. 매월 6일 ~ 24일: 수정본 파일 감시 (웹 수정 우선 유지, 새 수정본 파일 생성 시에만 갱신)
                    else:
                        print(f"[Watcher] {now.strftime('%Y-%m-%d')}: 매월 6~24일 수정본 파일 감시 체크 (웹 수기 수정 우선)...")
                        scan_and_sync_all_relevant_files(force=False)
                        last_checked_day_key = today_key
            except Exception as e:
                print(f"[Watcher] 감시 루프 오류: {e}")
            time.sleep(1800)  # 30분 간격 체크

    t = threading.Thread(target=watcher_loop, daemon=True)
    t.start()


def main():
    ensure_watch_folder()
    print("=" * 60)
    print("  KBS 송출센터 - 송신 시설 점검 계획 (HWP/PDF/사진) AI 연동 서비스")
    print("=" * 60)
    print(f" * 감지 폴더: {os.path.abspath(WATCH_FOLDER_PATH)}")
    print(f" * 카이로스 Gateway: {API_GATEWAY_URL}")
    print(f" * AI 모델: {AI_MODEL}")
    print(f" * 로컬 API 포트: http://localhost:{LOCAL_PORT}")
    print("=" * 60)

    if '--help' in sys.argv or '-h' in sys.argv:
        print("사용법:")
        print("  python maint_hwp_service.py         : 로컬 API 서버(포트 8765) 구동 및 백그라운드 폴더 감시")
        print("  python maint_hwp_service.py --sync  : 감지 폴더의 최신 파일 1회 즉시 AI 분석 및 동기화")
        print("  python maint_hwp_service.py --clear : 정비일정 데이터 즉시 초기화")
        return

    if '--clear' in sys.argv:
        clear_current_plans()
        print("[✓] 정비일정 데이터가 초기화되었습니다.")
        return

    if '--sync' in sys.argv:
        print("[*] 즉시 동기화 실행 중...")
        updated = scan_and_sync_all_relevant_files(force=True)
        plans = get_current_plans()
        print(f"[✓] 완료: 총 {plans.get('totalCount', 0)}건 유지/저장됨.")
        return

    # 백그라운드 감시 스레드 시작
    start_background_watcher()

    # 로컬 API 서버 시작
    server = HTTPServer(('127.0.0.1', LOCAL_PORT), ApiHandler)
    print(f"[✓] 로컬 연동 서버가 정상 대기 중입니다. (포트 {LOCAL_PORT})")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n[!] 서버를 종료합니다.")
        server.server_close()


if __name__ == '__main__':
    main()
