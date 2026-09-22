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


def merge_and_save_plans(new_plans, source_filename=""):
    """
    새로 추출된 계획의 대상 월(YYYY-MM)들을 파악하여,
    해당 월의 기존 계획만 새로 추출된 계획으로 완벽 대체하고,
    다른 월의 계획은 그대로 유지하며 영구 저장합니다.
    """
    current_data = get_current_plans()
    existing_plans = current_data.get("plans", [])

    if not new_plans:
        return current_data

    # 새로 들어온 계획들의 년-월 목록 (예: {'2026-10'})
    target_months = set()
    for p in new_plans:
        d = p.get('date', '')
        if len(d) >= 7:
            target_months.add(d[:7])

    # 기존 계획 중 target_months에 속하지 않는 계획들만 유지
    merged_plans = [p for p in existing_plans if p.get('date', '')[:7] not in target_months]
    merged_plans.extend(new_plans)

    # 날짜 오름차순 정렬
    merged_plans.sort(key=lambda x: x.get('date', ''))

    result_payload = {
        "lastSync": datetime.now().isoformat(),
        "sourceFile": source_filename or current_data.get("sourceFile", "송신 시설 점검 계획"),
        "folder": os.path.abspath(WATCH_FOLDER_PATH),
        "totalCount": len(merged_plans),
        "plans": merged_plans
    }

    with open(PLANS_FILE, 'w', encoding='utf-8') as f:
        json.dump(result_payload, f, ensure_ascii=False, indent=2)

    return result_payload


def process_general_file(file_path=None, file_bytes=None, filename=""):
    """
    HWP, PDF, 이미지 파일 자동 분기 처리 -> AI 분석 -> 월별 누적 병합 저장
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

    print(f"[Facility Sync] AI 분석 완료: 총 {len(plans)}건의 송신 시설 점검 계획 추출 성공!")
    res = merge_and_save_plans(plans, source_filename=filename)
    return res


def scan_and_sync_all_relevant_files():
    """
    지정 폴더에서 현재 월 및 (월말인 경우) 다음 달 점검 계획 파일을 모두 탐색하여,
    신규 파일이거나 수정된(mtime 변경) 파일이 있으면 AI 분석 후 일정을 자동 갱신합니다.
    """
    ensure_watch_folder()
    supported_exts = ('.hwp', '.pdf', '.png', '.jpg', '.jpeg', '.webp')
    all_files = []
    for ext in supported_exts:
        all_files.extend(glob.glob(os.path.join(WATCH_FOLDER_PATH, f'*{ext}')))
        all_files.extend(glob.glob(os.path.join(WATCH_FOLDER_PATH, '**', f'*{ext}'), recursive=True))

    now = datetime.now()
    cur_month = now.month
    next_month = (now.month % 12) + 1

    cur_patterns = [f"{cur_month}월", f"{now.year}.{cur_month:02d}", f"{now.year}-{cur_month:02d}"]
    next_patterns = [f"{next_month}월", f"{now.year}.{next_month:02d}", f"{now.year}-{next_month:02d}"]

    updated_any = False
    for f in all_files:
        bname = os.path.basename(f)
        is_cur_match = any(p in bname for p in cur_patterns)
        is_next_match = any(p in bname for p in next_patterns)

        # 현재 월 파일이거나, 월말(24일 이후) 또는 다음달 계획 파일인 경우
        should_process = False
        if is_cur_match:
            should_process = True
        elif is_next_match and (now.day >= 24 or any(k in bname for k in ['점검', '시설', '계획', '정비'])):
            should_process = True
        elif not is_cur_match and not is_next_match and any(k in bname for k in ['점검', '시설', '송신', '정비']):
            should_process = True

        if should_process:
            mtime = os.path.getmtime(f)
            # 아직 처리 안 됐거나 파일이 수정된 경우
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
                updated = scan_and_sync_all_relevant_files()
                current_data = get_current_plans()
                notice = "신규/수정된 점검 계획 파일이 반영되었습니다." if updated else f"점검계획_폴더를 확인하였으며, 현재 등록된 {current_data.get('totalCount', 0)}건의 계획을 유지합니다."
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
                updated = scan_and_sync_all_relevant_files()
                current_data = get_current_plans()
                notice = "신규/수정된 점검 계획 파일이 반영되었습니다." if updated else f"점검계획_폴더를 확인하였으며, 현재 등록된 {current_data.get('totalCount', 0)}건의 계획을 유지합니다."
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
        updated = scan_and_sync_all_relevant_files()
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
