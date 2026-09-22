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
WATCH_FOLDER_PATH = os.environ.get('WATCH_FOLDER_PATH', os.path.join(os.path.dirname(__file__), '점검계획_폴더'))
LOCAL_PORT = int(os.environ.get('LOCAL_SERVER_PORT', '8765'))
PLANS_FILE = os.path.join(os.path.dirname(__file__), 'maint_facility_plans.json')

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


def merge_and_save_plans(new_plans, source_filename=""):
    """
    새로 추출된 계획의 주 대상 월(Primary Month)을 파악하여,
    해당 월의 기존 계획만 새로 추출된 계획으로 최신화하고,
    다른 월(예: 9월, 10월 등)의 기존 계획은 안전하게 100% 보존합니다.
    """
    current_data = get_current_plans()
    existing_plans = current_data.get("plans", [])

    if not new_plans:
        return current_data

    primary_month = detect_primary_month(source_filename, new_plans)

    # 1. 기존 계획 중 이번 파일의 주 대상 월(primary_month)이 아닌 계획들은 보존
    remaining_existing = [p for p in existing_plans if not p.get('date', '').startswith(primary_month)]

    # 2. 이번 새 계획 중 주 대상 월 항목
    primary_new = [p for p in new_plans if p.get('date', '').startswith(primary_month)]

    # 3. 이번 새 계획 중 다른 월에 부수적으로 걸친 항목 (예: 10월 계획표의 첫 주에 포함된 9월 말일 3건 등)
    other_new = [p for p in new_plans if not p.get('date', '').startswith(primary_month)]

    # 기존에 이미 있는 항목 (날짜, 태스크, 색상) 식별 키셋
    existing_keys = {(p.get('date', ''), p.get('task', '').strip(), p.get('color', '').lower()) for p in remaining_existing}
    added_others = []
    for p in other_new:
        key = (p.get('date', ''), p.get('task', '').strip(), p.get('color', '').lower())
        if key not in existing_keys:
            added_others.append(p)
            existing_keys.add(key)

    merged_plans = remaining_existing + primary_new + added_others

    # 4. 공휴일/기념일(방송의날 등) 필터링
    cleaned = []
    for p in merged_plans:
        t = p.get('task', '').strip()
        if any(h in t for h in ['방송의날', '방송의 날', '대체휴일', '한글날', '추석', '설날', '신정', '광복절', '개천절', '어린이날', '현충일', '삼일절', '크리스마스']):
            continue
        cleaned.append(p)
    merged_plans = cleaned

    # 5. 사용자 업무 비중 및 원본 표 순서 기준 정렬 (수동 지정 sortIndex 우선, 그 다음 원본 표 order, 동일 행 내 우선순위)
    def get_sort_tuple(x):
        date_str = x.get('date', '')
        if 'sortIndex' in x and x['sortIndex'] is not None:
            return (date_str, 0, x['sortIndex'])
        order_val = x.get('order')
        if order_val is not None:
            return (date_str, 1, order_val, get_plan_sort_priority(x))
        return (date_str, 2, get_plan_sort_priority(x))

    merged_plans.sort(key=get_sort_tuple)

    # 소스 파일 이름 목록 관리 (다중 파일 누적)
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


def scan_and_sync_all_relevant_files(force=False):
    """
    지정 폴더에서 모든 월별(9월, 10월 등) 점검 및 업무 계획 파일을 탐색하여,
    각 월별 최신 파일을 파싱하고 9월, 10월 등 다중 월 일정을 온전하게 통합 저장합니다.
    - force=True: 수동 동기화 요청 시 캐시와 무관하게 폴더 내의 모든 대상 파일을 전수 동기화
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
        return False

    # 월별 그룹화 (동일 월에 여러 파일이 있을 경우 포맷 우선순위: .hwp > .pdf > 이미지)
    def get_format_score(filepath):
        ext = os.path.splitext(filepath)[1].lower()
        if ext == '.hwp': return 3
        if ext == '.pdf': return 2
        return 1

    month_file_map = {}
    for f in candidate_files:
        bname = os.path.basename(f)
        # 월 감지
        m_ym = re.search(r'(20\d{2})[-_.]?(0[1-9]|1[0-2])', bname)
        if m_ym:
            ym = f"{m_ym.group(1)}-{m_ym.group(2)}"
        else:
            m_m = re.search(r'([1-9]|1[0-2])월', bname)
            if m_m:
                ym = f"{datetime.now().year}-{int(m_m.group(1)):02d}"
            else:
                ym = 'general'

        score = (get_format_score(f), os.path.getmtime(f))
        if ym not in month_file_map or score > month_file_map[ym][0]:
            month_file_map[ym] = (score, f)

    # 월 순서(과거 월 -> 최신 월)로 정렬하여 순차 처리
    sorted_months = sorted(month_file_map.keys())
    selected_files = [month_file_map[m][1] for m in sorted_months]

    if force:
        # 수동 동기화 요청 시: 깨끗한 통합을 위해 초기화 후 모든 파일 순차 병합
        print(f"[Watcher] 수동 전수 동기화 실행: 대상 파일 {len(selected_files)}개")
        temp_plans_file = PLANS_FILE
        # 빈 데이터셋에서 시작
        with open(temp_plans_file, 'w', encoding='utf-8') as pf:
            json.dump({
                "lastSync": datetime.now().isoformat(),
                "sourceFile": "",
                "folder": os.path.abspath(WATCH_FOLDER_PATH),
                "totalCount": 0,
                "plans": []
            }, pf, ensure_ascii=False, indent=2)

        for f in selected_files:
            bname = os.path.basename(f)
            try:
                process_general_file(file_path=f)
                processed_file_mtimes[f] = os.path.getmtime(f)
            except Exception as err:
                print(f"[Watcher] 파일 처리 실패 ({bname}): {err}")
        return True

    updated_any = False
    for f in selected_files:
        bname = os.path.basename(f)
        mtime = os.path.getmtime(f)
        if processed_file_mtimes.get(f) != mtime:
            print(f"[Watcher] 신규 또는 변경된 점검 계획 파일 감지: {bname}")
            try:
                process_general_file(file_path=f)
                processed_file_mtimes[f] = mtime
                updated_any = True
            except Exception as err:
                print(f"[Watcher] 파일 처리 실패 ({bname}): {err}")

    return updated_any


# ================================================================
# 로컬 REST API 서버 (웹 프론트엔드 연동)
# ================================================================
class ApiHandler(BaseHTTPRequestHandler):
    def _send_cors(self):
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')

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

        elif parsed.path == '/api/plans':
            data = get_current_plans()
            self._send_json(200, data)

        elif parsed.path == '/api/sync':
            try:
                updated = scan_and_sync_all_relevant_files(force=True)
                current_data = get_current_plans()
                notice = f"폴더 내 점검 계획 파일이 모두 동기화되었습니다. (총 {current_data.get('totalCount', 0)}건)"
                self._send_json(200, {"success": True, "data": current_data, "notice": notice})
            except Exception as e:
                self._send_json(500, {"success": False, "message": str(e)})

        else:
            self.send_response(404)
            self._send_cors()
            self.end_headers()

    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)

        if parsed.path == '/api/sync':
            try:
                updated = scan_and_sync_all_relevant_files(force=True)
                current_data = get_current_plans()
                notice = f"폴더 내 점검 계획 파일이 모두 동기화되었습니다. (총 {current_data.get('totalCount', 0)}건)"
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
                current_data['plans'] = plans
                current_data['totalCount'] = len(plans)
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
    백그라운드 스레드: 매 10분마다 폴더를 검사하여 현재 월 및 월말 다음 달 파일 자동 감지 및 동기화
    """
    def watcher_loop():
        while True:
            try:
                scan_and_sync_all_relevant_files()
            except Exception as e:
                print(f"[Watcher] 감시 루프 오류: {e}")
            time.sleep(600)  # 10분 간격

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
        return

    if '--sync' in sys.argv:
        print("[*] 즉시 동기화 실행 중...")
        updated = scan_and_sync_all_relevant_files(force=True)
        plans = get_current_plans()
        print(f"[✓] 완료: 총 {plans.get('totalCount', 0)}건 유지/저장됨.")
        return

    # 시작 시 최초 1회 폴더 스캔
    try:
        scan_and_sync_all_relevant_files()
    except Exception as e:
        print(f"[*] 초기 폴더 스캔: {e}")

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
