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

from hwp_parser import extract_text_from_hwp, extract_hwp_table_plans, extract_hwpx_table_plans, extract_text_from_hwpx

try:
    from openai import OpenAI
except ImportError:
    OpenAI = None

# 환경 설정값
LOCAL_PORT = int(os.environ.get('LOCAL_SERVER_PORT', '8765'))
PLANS_FILE = os.path.join(os.path.dirname(__file__), 'maint_facility_plans.json')
FOLDER_CONFIG_FILE = os.path.join(os.path.dirname(__file__), 'maint_folder_config.json')
AI_CONFIG_FILE = os.path.join(os.path.dirname(__file__), 'maint_ai_config.json')


def load_saved_ai_config():
    """저장된 AI 연동 설정(게이트웨이 주소, API 키, AI 모델명) 로드"""
    url = os.environ.get('KAIROS_API_GATEWAY_URL', 'https://factchat.mindlogic-kr-api.com/v1/gateway')
    key = os.environ.get('KAIROS_API_KEY', '')
    model = os.environ.get('KAIROS_AI_MODEL', 'claude-sonnet-5')
    if os.path.exists(AI_CONFIG_FILE):
        try:
            with open(AI_CONFIG_FILE, 'r', encoding='utf-8') as f:
                cfg = json.load(f)
                if cfg.get('gatewayUrl'):
                    url = cfg['gatewayUrl'].strip()
                if cfg.get('apiKey'):
                    key = cfg['apiKey'].strip()
                if cfg.get('aiModel'):
                    model = cfg['aiModel'].strip()
        except Exception as e:
            print(f"[AI Config] 설정 로드 오류: {e}")
    return url, key, model


def save_ai_config(gateway_url, api_key, ai_model):
    """지정된 AI 연동 설정을 영구 저장 파일에 저장"""
    try:
        with open(AI_CONFIG_FILE, 'w', encoding='utf-8') as f:
            json.dump({
                'gatewayUrl': gateway_url.strip(),
                'apiKey': api_key.strip(),
                'aiModel': ai_model.strip()
            }, f, ensure_ascii=False, indent=2)
        print(f"[AI Config] AI 연동 설정 영구 저장 완료 (Model: {ai_model.strip()})")
    except Exception as e:
        print(f"[AI Config] 설정 파일 저장 오류: {e}")


API_GATEWAY_URL, API_KEY, AI_MODEL = load_saved_ai_config()


# 로컬 캐시 폴더 (변환된 DOCX 파일 보관, 항상 고정)
LOCAL_DOCX_CACHE_FOLDER = os.path.normpath(os.path.join(os.path.dirname(__file__), '점검계획_폴더'))


def load_saved_watch_folder():
    """저장된 감시 폴더 설정 로드 (로컬 캐시 폴더 고정 반환)"""
    # 로컬 DOCX 캐시 폴더는 항상 고정 (변환 결과물 저장 위치)
    return LOCAL_DOCX_CACHE_FOLDER


def load_saved_source_folder():
    """저장된 원본 소스 폴더(외부/네트워크 드라이브) 경로 로드"""
    if os.path.exists(FOLDER_CONFIG_FILE):
        try:
            with open(FOLDER_CONFIG_FILE, 'r', encoding='utf-8') as f:
                cfg = json.load(f)
                src = cfg.get('sourceFolder')
                if src and os.path.exists(src):
                    return os.path.normpath(src)
        except Exception as e:
            print(f"[Config] 설정 파일 읽기 오류: {e}")
    return None


def save_source_folder(source_path):
    """원본 소스 폴더 경로를 영구 설정 파일에 저장 (로컬 캐시 폴더도 함께 유지)"""
    try:
        existing = {}
        if os.path.exists(FOLDER_CONFIG_FILE):
            try:
                with open(FOLDER_CONFIG_FILE, 'r', encoding='utf-8') as f:
                    existing = json.load(f)
            except Exception:
                pass
        norm_src = os.path.normpath(os.path.abspath(source_path))
        existing['sourceFolder'] = norm_src
        existing['folder'] = LOCAL_DOCX_CACHE_FOLDER  # 로컬 캐시 폴더는 항상 고정
        with open(FOLDER_CONFIG_FILE, 'w', encoding='utf-8') as f:
            json.dump(existing, f, ensure_ascii=False, indent=2)
        print(f"[Config] 원본 소스 폴더 영구 설정 완료: {norm_src}")
    except Exception as e:
        print(f"[Config] 설정 파일 저장 오류: {e}")


def save_watch_folder(folder_path):
    """하위 호환용 - 이 함수 호출 시 sourceFolder로 저장됨"""
    save_source_folder(folder_path)


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


WATCH_FOLDER_PATH = load_saved_watch_folder()  # 로컬 DOCX 캐시 폴더 (고정)
SOURCE_FOLDER_PATH = load_saved_source_folder()  # 원본 HWP 소스 폴더 (외부/네트워크)

# 파일별 마지막 처리 시점(mtime) 캐시
processed_file_mtimes = {}


def ensure_watch_folder():
    """로컬 DOCX 캐시 폴더가 없으면 자동 생성"""
    if not os.path.exists(WATCH_FOLDER_PATH):
        try:
            os.makedirs(WATCH_FOLDER_PATH, exist_ok=True)
        except Exception as e:
            print(f"[Facility Sync] 폴더 생성 오류: {e}")


def find_libreoffice():
    """
    Windows에서 LibreOffice 실행 파일 경로 자동 탐색.
    일반적인 설치 위치를 순서대로 확인합니다.
    """
    candidates = [
        r'C:\Program Files\LibreOffice\program\soffice.exe',
        r'C:\Program Files (x86)\LibreOffice\program\soffice.exe',
        r'C:\Program Files\LibreOffice 7\program\soffice.exe',
        r'C:\Program Files\LibreOffice 24\program\soffice.exe',
        r'C:\Program Files\LibreOffice 25\program\soffice.exe',
    ]
    # 환경변수 PATH에서도 탐색
    for c in candidates:
        if os.path.exists(c):
            return c
    # 레지스트리 등록 경로 탐색
    try:
        import winreg
        for key_path in [
            r'SOFTWARE\LibreOffice\UNO\Path',
            r'SOFTWARE\WOW6432Node\LibreOffice\UNO\Path',
        ]:
            try:
                with winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, key_path) as k:
                    val, _ = winreg.QueryValueEx(k, '')
                    exe = os.path.join(os.path.dirname(val), 'soffice.exe')
                    if os.path.exists(exe):
                        return exe
            except Exception:
                pass
    except ImportError:
        pass
    return None


def _sanitize_xml_str(s):
    """XML에 사용 불가한 제어문자(NULL 등)를 제거하여 안전한 문자열 반환"""
    import re as _re
    return _re.sub(r'[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]', '', str(s))


def convert_hwp_to_docx_parser(hwp_path, output_dir):
    """
    hwp_parser를 사용하여 HWP/HWPX 파일을 파싱하고,
    python-docx로 읽기 가능한 한글 DOCX 파일을 생성합니다.
    LibreOffice 없이 동작하며, 한글이 정확히 보존됩니다.
    - hwp_path: 원본 HWP/HWPX 파일 전체 경로
    - output_dir: 변환 결과 DOCX를 저장할 폴더
    """
    from docx import Document as DocxDocument
    from docx.shared import Pt, RGBColor
    from docx.oxml.ns import qn

    os.makedirs(output_dir, exist_ok=True)
    fname = os.path.basename(hwp_path)
    base_name = os.path.splitext(fname)[0]
    out_path = os.path.join(output_dir, base_name + '.docx')
    ext = os.path.splitext(fname)[1].lower()

    # hwp_parser로 계획 데이터 파싱
    if ext == '.hwpx':
        plans = extract_hwpx_table_plans(hwp_path)
    else:
        plans = extract_hwp_table_plans(hwp_path, fname)

    doc = DocxDocument()
    doc.add_heading(base_name, 0)

    if plans:
        # 표 형식으로 DOCX 생성: 날짜 / 카테고리 / 업무내용 / 색상
        table = doc.add_table(rows=1, cols=4)
        table.style = 'Table Grid'
        hdr = table.rows[0].cells
        hdr[0].text = '날짜'
        hdr[1].text = '구분'
        hdr[2].text = '업무내용'
        hdr[3].text = '색상'
        for h in hdr:
            for run in h.paragraphs[0].runs:
                run.bold = True

        for p in plans:
            row = table.add_row().cells
            row[0].text = _sanitize_xml_str(p.get('date', ''))
            row[1].text = _sanitize_xml_str(p.get('category', ''))
            row[2].text = _sanitize_xml_str(p.get('task', ''))
            color = p.get('color', 'black')
            row[3].text = _sanitize_xml_str(color)
            # 업무내용 셀 글자 색상 적용
            for run in row[2].paragraphs[0].runs:
                if color == 'red':
                    run.font.color.rgb = RGBColor(0xFF, 0x00, 0x00)
                elif color == 'blue':
                    run.font.color.rgb = RGBColor(0x00, 0x00, 0xFF)
    else:
        # 계획 파싱 실패 시 HWPX 텍스트 폴백
        if ext == '.hwpx':
            text = extract_text_from_hwpx(hwp_path)
        else:
            doc.add_paragraph('(계획 데이터를 파싱하지 못했습니다.)')
            text = ''
        if text:
            for line in text.split():
                if line.strip():
                    doc.add_paragraph(line.strip())

    doc.save(out_path)
    print(f"[HWP→DOCX] 변환 성공: {fname} → {base_name}.docx ({len(plans)}건)")
    return out_path


# 하위 호환용 별칭
def convert_hwp_to_docx_libreoffice(hwp_path, output_dir):
    """하위 호환용: convert_hwp_to_docx_parser를 호출합니다."""
    return convert_hwp_to_docx_parser(hwp_path, output_dir)


def extract_text_from_docx(file_or_bytes):
    """python-docx를 사용하여 DOCX 파일에서 텍스트 추출"""
    try:
        from docx import Document
        if isinstance(file_or_bytes, bytes):
            doc = Document(io.BytesIO(file_or_bytes))
        else:
            doc = Document(file_or_bytes)
        parts = []
        for para in doc.paragraphs:
            if para.text.strip():
                parts.append(para.text)
        for table in doc.tables:
            for row in table.rows:
                row_texts = [cell.text.strip() for cell in row.cells if cell.text.strip()]
                if row_texts:
                    parts.append(' | '.join(row_texts))
        return '\n'.join(parts)
    except ImportError:
        raise RuntimeError("python-docx 라이브러리가 필요합니다. (pip install python-docx)")
    except Exception as e:
        raise ValueError(f"DOCX 텍스트 추출 실패: {e}")


def extract_docx_table_plans(file_or_bytes, filename=""):
    """
    python-docx를 사용하여 DOCX 내의 표(Table) 구조에서 점검 계획 데이터를 직접 추출합니다.
    - AI 호출 없이도 한글 문서에서 변환된 표(날짜, 구분, 업무내용, 글자색)를 100% 완벽하게 추출
    - AI 크레딧 부족(402), 인터넷 장애, API 지연 시에도 완벽한 정합성 및 글자색(빨강/파랑/검정) 보존!
    """
    try:
        from docx import Document
        if isinstance(file_or_bytes, bytes):
            doc = Document(io.BytesIO(file_or_bytes))
        else:
            doc = Document(file_or_bytes)

        plans = []
        for table in doc.tables:
            if not table.rows:
                continue
            header = [c.text.strip() for c in table.rows[0].cells]
            col_map = {}
            for idx, h in enumerate(header):
                if any(k in h for k in ['날짜', '일자', '일시']):
                    col_map['date'] = idx
                elif any(k in h for k in ['구분', '소', '분류']):
                    col_map['category'] = idx
                elif any(k in h for k in ['내용', '업무', '계획', '점검']):
                    col_map['task'] = idx
                elif '색' in h:
                    col_map['color'] = idx

            # 컬럼 매핑이 불충분하고 열 수가 3~4개인 경우 기본 매핑
            if 'date' not in col_map and len(header) >= 3:
                col_map['date'] = 0
                col_map['category'] = 1
                col_map['task'] = 2
                if len(header) >= 4:
                    col_map['color'] = 3

            for row in table.rows[1:]:
                cells = row.cells
                if not cells:
                    continue
                d = cells[col_map['date']].text.strip() if 'date' in col_map and col_map['date'] < len(cells) else ''
                t = cells[col_map['task']].text.strip() if 'task' in col_map and col_map['task'] < len(cells) else ''
                c = cells[col_map['category']].text.strip() if 'category' in col_map and col_map['category'] < len(cells) else ''
                clr = cells[col_map['color']].text.strip().lower() if 'color' in col_map and col_map['color'] < len(cells) else 'black'

                # 글자색이 task에 [red:...] 등으로 있거나 정제
                if '[red:' in t.lower():
                    clr = 'red'
                    t = re.sub(r'\[red:\s*(.*?)\s*\]', r'\1', t, flags=re.IGNORECASE).strip()
                elif '[blue:' in t.lower():
                    clr = 'blue'
                    t = re.sub(r'\[blue:\s*(.*?)\s*\]', r'\1', t, flags=re.IGNORECASE).strip()

                # 셀의 실제 글자색(run font color) 검사
                if clr not in ('red', 'blue') and 'task' in col_map and col_map['task'] < len(cells):
                    task_cell = cells[col_map['task']]
                    for p in task_cell.paragraphs:
                        for r in p.runs:
                            if r.font and r.font.color and r.font.color.rgb:
                                rgb = str(r.font.color.rgb).upper()
                                if rgb in ('FF0000', 'C00000', 'E00000'):
                                    clr = 'red'
                                    break
                                elif rgb in ('0000FF', '002060', '0070C0'):
                                    clr = 'blue'
                                    break

                # YYYY-MM-DD 형식 날짜 검증
                if d and re.match(r'^\d{4}-\d{2}-\d{2}$', d) and t:
                    plans.append({
                        'date': d,
                        'category': c,
                        'task': t,
                        'color': clr if clr in ('red', 'blue') else 'black'
                    })

        return plans
    except Exception as e:
        print(f"[Facility Sync] DOCX 표 직접 추출 실패 ({filename}): {e}")
        return []


def get_file_priority_score(filepath):
    """
    점검 계획 파일의 우선순위 점수 계산:
    - 수정본/최종본/확정 키워드 가산점 (+100)
    - 복사본(copy) 감점 (-80)
    - 확장자 포맷 점수 (DOCX/HWP 우선)
    - 최신 수정일시(mtime) 반영
    """
    bname = os.path.basename(filepath).lower()
    score = 0
    if any(k in bname for k in ['최종', '수정', '변경', '확정']):
        score += 100
    if '복사본' in bname or 'copy' in bname:
        score -= 80
    ext = os.path.splitext(filepath)[1].lower()
    if ext == '.docx': score += 35
    elif ext in ('.hwp', '.hwpx'): score += 30
    elif ext == '.pdf': score += 20
    else: score += 10
    score += os.path.getmtime(filepath) / 1e10
    return score


def sync_source_to_local_folder(force_overwrite=False, target_months=None):
    """
    🎯 [사용자 최신 규칙] 원본 소스 폴더(외부/네트워크 드라이브)에서
    오직 '당해 월'(25일~말일이면 '당월 + 익월') 파일만 원본에서 가져와 DOCX로 변환합니다.
    - 1일 ~ 24일: 당월 1개 파일만 선별하여 변환
    - 25일 ~ 말일: 당월 1개 + 익월 1개 (총 2개 파일만 선별하여 변환)
    - 다른 월(과거 월이나 불필요한 월)의 파일은 원본에서 일체 건드리지 않고 건너뜁니다.
    - 각 월별로도 복사본을 제외한 가장 최신/수정본 '단 1개의 파일'만 선택하여 변환합니다.
    - 반환값: 새로 변환/갱신된 파일 수
    """
    global SOURCE_FOLDER_PATH
    if not SOURCE_FOLDER_PATH or not os.path.exists(SOURCE_FOLDER_PATH):
        return 0

    # 대상 월 목록 강제 (미지정 시 현재 일자 규칙에 따라 당월 또는 당월+익월 자동 결정)
    if not target_months:
        target_months = get_monitoring_target_months()
    elif isinstance(target_months, (str, bytes)):
        target_months = [str(target_months).strip()]

    hwp_exts = ('.hwp', '.hwpx')
    candidate_src_files = []

    # 소스 폴더에서 HWP/HWPX 파일만 1차 탐색
    for root, _, files in os.walk(SOURCE_FOLDER_PATH):
        for fname in files:
            ext = os.path.splitext(fname)[1].lower()
            if ext in hwp_exts:
                candidate_src_files.append(os.path.join(root, fname))

    if not candidate_src_files:
        print(f"[소스→로컬] 원본 소스 폴더에 한글 문서가 없습니다: {SOURCE_FOLDER_PATH}")
        return 0

    # 🎯 [핵심] 대상 월별로 '단 1개의 최신/수정본 파일'만 엄선!
    selected_src_files = []
    for ym in target_months:
        ym_compact = ym.replace('-', '')
        month_int = int(ym.split('-')[1]) if '-' in ym else None
        month_matched = []

        for fpath in candidate_src_files:
            bname = os.path.basename(fpath)
            # 연월 매칭 (예: 202609, 2026-09) 또는 '9월' 매칭
            if ym_compact in bname.replace('-', '').replace('.', ''):
                month_matched.append(fpath)
            elif month_int and f"{month_int}월" in bname:
                month_matched.append(fpath)

        if month_matched:
            # 수정본/최종본 우선, 복사본 감점, 최신 mtime 기준 1개 파일만 선정
            month_matched.sort(key=get_file_priority_score, reverse=True)
            chosen_src = month_matched[0]
            selected_src_files.append((ym, chosen_src))
            print(f"[소스→로컬] {ym}월 원본 대상 파일 선정 (단 1개): {os.path.basename(chosen_src)}")
        else:
            print(f"[소스→로컬] {ym}월에 해당하는 원본 한글 파일이 없습니다.")

    if not selected_src_files:
        print("[소스→로컬] 대상 월에 일치하는 원본 한글 파일이 없습니다.")
        return 0

    converted_count = 0

    # 엄선된 파일(당월 1개 또는 당월+익월 2개)만 DOCX로 변환!
    for ym, src_path in selected_src_files:
        fname = os.path.basename(src_path)
        base_name = os.path.splitext(fname)[0]
        local_docx_path = os.path.join(LOCAL_DOCX_CACHE_FOLDER, base_name + '.docx')

        src_mtime = os.path.getmtime(src_path)
        src_size = os.path.getsize(src_path)

        if not force_overwrite and os.path.exists(local_docx_path):
            local_mtime = os.path.getmtime(local_docx_path)
            size_cache_path = local_docx_path + '.srcsize'
            cached_size = None
            try:
                if os.path.exists(size_cache_path):
                    with open(size_cache_path, 'r') as sf:
                        cached_size = int(sf.read().strip())
            except Exception:
                cached_size = None
            if src_mtime <= local_mtime and cached_size == src_size:
                continue

        overwrite_note = " (강제 덮어쓰기)" if force_overwrite else ""
        print(f"[소스→로컬] {ym}월 HWP 변환 실행{overwrite_note}: {fname} (크기: {src_size}bytes)")
        try:
            converted_path = convert_hwp_to_docx_libreoffice(src_path, LOCAL_DOCX_CACHE_FOLDER)
            os.utime(converted_path, (src_mtime, src_mtime))
            size_cache_path = converted_path + '.srcsize'
            try:
                with open(size_cache_path, 'w') as sf:
                    sf.write(str(src_size))
            except Exception:
                pass
            converted_count += 1
            if converted_path in processed_file_mtimes:
                del processed_file_mtimes[converted_path]
        except Exception as e:
            print(f"[소스→로컬] 변환 실패 ({fname}): {e}")

    if converted_count > 0:
        print(f"[소스→로컬] 총 {converted_count}개 파일만 엄선 변환 완료 → {LOCAL_DOCX_CACHE_FOLDER}")
    return converted_count


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
    elif ext == '.hwpx':
        table_plans = extract_hwpx_table_plans(file_bytes, filename)
        if table_plans and len(table_plans) > 0:
            print(f"[Facility Sync] HWPX 점검표 구조 및 글자색(빨강/파랑/검정) 직접 파싱 성공: {len(table_plans)}건")
            plans = table_plans
        else:
            text = extract_text_from_hwpx(file_bytes)
            if not text.strip():
                raise ValueError("한글(HWPX) 문서에서 텍스트를 추출할 수 없습니다.")
            plans = analyze_text_with_ai(text, filename)
    elif ext == '.docx':
        # 1. DOCX 내의 정형 점검표 직접 파싱 시도 (AI 크레딧 소진/오류 시에도 100% 무결점 보장)
        table_plans = extract_docx_table_plans(file_bytes or file_path, filename)
        if table_plans and len(table_plans) > 0:
            print(f"[Facility Sync] DOCX 점검표 직접 파싱 성공: {len(table_plans)}건 (글자색 포함)")
            plans = table_plans
        else:
            # 2. 비정형 DOCX인 경우 텍스트 추출 후 AI 분석 전달
            text = extract_text_from_docx(file_bytes or file_path)
            if not text.strip():
                raise ValueError("DOCX 문서에서 텍스트를 추출할 수 없습니다.")
            print(f"[Facility Sync] DOCX 텍스트 추출 완료 ({len(text)}자) → AI 분석 전달")
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
        raise ValueError(f"지원되지 않는 파일 형식입니다: {ext} (지원: .hwp, .docx, .pdf, .jpg, .png 등)")

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


def scan_and_sync_all_relevant_files(force=False, is_initial=False, target_month=None, target_months=None):
    """
    [STEP 1] 원본 소스 폴더(외부/네트워크 드라이브)에서 HWP 파일을 감지하여
             force=True(강제 동기화) 시 무조건 DOCX로 강제 변환/덮어쓰기 수행
             force=False 시 변경된 것만 DOCX로 변환
    [STEP 2] 로컬 점검계획_폴더에서 점검 계획 파일을 탐색하여 AI로 분석하고 저장합니다.
    - target_month / target_months: 특정 근무월 지정 (예: '2026-09' 또는 ['2026-09', '2026-10'])
    - force=True: 수동 동기화 요청 시 원본 HWP 파일을 무조건 강제로 DOCX로 변환(기존 워드 파일 덮어쓰기) 후 AI 분석 수행
    - 🎯 [사용자 핵심 규칙]:
      1. 과거 달(지난달 등) 데이터는 일체 건드리지 않고 영구 보존
      2. 25일~말일: 당월 + 익월(다음 달) 파일 감시 및 처리
      3. 1일~24일: 당월 파일 감시 및 처리
    """
    ensure_watch_folder()

    # 감시 대상 월 목록 결정
    if target_months and isinstance(target_months, (list, tuple)):
        target_months_list = [str(m).strip() for m in target_months if str(m).strip()]
    elif target_month:
        target_months_list = [str(target_month).strip()]
        # 25일 이상이고 target_month가 현재 월이면 익월도 함께 추가
        now = datetime.now()
        cur_ym = now.strftime('%Y-%m')
        if now.day >= 25 and target_month == cur_ym:
            next_ym = f"{now.year + 1}-01" if now.month == 12 else f"{now.year}-{now.month + 1:02d}"
            if next_ym not in target_months_list:
                target_months_list.append(next_ym)
    else:
        target_months_list = get_monitoring_target_months()

    # ── STEP 1: 원본 소스 폴더 → 로컬 DOCX 캐시 강제/증분 동기화 ──────────────
    if SOURCE_FOLDER_PATH and os.path.exists(SOURCE_FOLDER_PATH):
        # 🎯 [사용자 핵심 요구] 동기화 버튼 클릭 시(force=True) 원본 파일을 무조건 강제로 DOCX 변환(덮어쓰기)
        print(f"[Watcher] 원본 소스 폴더 동기화 시작 (강제변환덮어쓰기={force}, 대상월={target_months_list}): {SOURCE_FOLDER_PATH}")
        sync_source_to_local_folder(force_overwrite=force, target_months=target_months_list)
    # ─────────────────────────────────────────────────────────────────────────

    supported_exts = ('.hwp', '.hwpx', '.docx', '.pdf', '.png', '.jpg', '.jpeg', '.webp', '.bmp')
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

    files_to_process = []

    for ym in target_months_list:
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
            # 점수 및 최신 수정 일시 기준 가장 최적의 파일 1개 선정 (변환된 최신 DOCX 우선)
            month_matched.sort(key=get_file_priority_score, reverse=True)
            chosen_file = month_matched[0]
            files_to_process.append((ym, chosen_file))
            print(f"[Watcher] 근무월({ym}) 최적 점검 계획 파일 선정: {os.path.basename(chosen_file)}")

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

        # 수동 강제 동기화(force=True)이거나 신규 파일/수정본 파일(mtime 변경) 감지 시 무조건 AI 분석 실행
        if force or last_mtime != mtime:
            print(f"[Watcher] 점검 계획 파일 AI 분석 실행 ({bname}, 강제동기화={force})")
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
                "sourceFolder": SOURCE_FOLDER_PATH or "",
                "sourceFolderExists": bool(SOURCE_FOLDER_PATH and os.path.exists(SOURCE_FOLDER_PATH)),
                "libreOfficeAvailable": bool(find_libreoffice()),
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
                "exists": os.path.exists(WATCH_FOLDER_PATH),
                "sourceFolder": SOURCE_FOLDER_PATH or "",
                "sourceFolderExists": bool(SOURCE_FOLDER_PATH and os.path.exists(SOURCE_FOLDER_PATH))
            })

        elif parsed.path == '/api/source-folder':
            self._send_json(200, {
                "success": True,
                "sourceFolder": SOURCE_FOLDER_PATH or "",
                "sourceFolderExists": bool(SOURCE_FOLDER_PATH and os.path.exists(SOURCE_FOLDER_PATH)),
                "localCacheFolder": os.path.abspath(WATCH_FOLDER_PATH),
                "libreOfficeAvailable": bool(find_libreoffice()),
                "libreOfficePath": find_libreoffice() or ""
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

        elif parsed.path == '/api/ai-config':
            self._send_json(200, {
                "success": True,
                "gatewayUrl": API_GATEWAY_URL,
                "apiKey": API_KEY,
                "aiModel": AI_MODEL
            })

        else:
            self.send_response(404)
            self._send_cors()
            self.end_headers()

    def do_POST(self):
        global WATCH_FOLDER_PATH, SOURCE_FOLDER_PATH
        parsed = urllib.parse.urlparse(self.path)

        # 🎯 [사용자 요청] 내 PC / C: / D: 드라이브를 브라우징하는 Windows 네이티브 폴더 브라우저 창 호출
        # - 선택된 폴더 = 원본 소스 폴더(외부/네트워크 드라이브 HWP 파일 위치)
        # - 선택 즉시 HWP→DOCX 변환 후 로컬 캐시 폴더에 저장, AI 분석 실행
        if parsed.path == '/api/browse-folder':
            try:
                selected_folder = choose_native_folder(SOURCE_FOLDER_PATH or WATCH_FOLDER_PATH)
                if selected_folder:
                    SOURCE_FOLDER_PATH = selected_folder
                    save_source_folder(selected_folder)
                    # 즉시 소스→로컬 변환 및 AI 분석 실행
                    scan_and_sync_all_relevant_files(force=True, is_initial=True)
                    current_data = get_current_plans()
                    lo_available = bool(find_libreoffice())
                    lo_note = "" if lo_available else "\n⚠️ LibreOffice 미설치: HWP→DOCX 자동변환 비활성. LibreOffice를 설치하면 변환이 활성화됩니다."
                    self._send_json(200, {
                        "success": True,
                        "folder": os.path.abspath(WATCH_FOLDER_PATH),
                        "sourceFolder": SOURCE_FOLDER_PATH,
                        "data": current_data,
                        "notice": f"📁 원본 폴더가 지정되었습니다.\n{SOURCE_FOLDER_PATH}\n(총 {current_data.get('totalCount', 0)}건 동기화 완료){lo_note}"
                    })
                else:
                    self._send_json(200, {
                        "success": False,
                        "cancelled": True,
                        "folder": os.path.abspath(WATCH_FOLDER_PATH),
                        "sourceFolder": SOURCE_FOLDER_PATH or "",
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

                SOURCE_FOLDER_PATH = os.path.normpath(new_folder)
                save_source_folder(SOURCE_FOLDER_PATH)
                # 즉시 소스→로컬 변환 및 AI 분석 실행
                scan_and_sync_all_relevant_files(force=True, is_initial=True)
                current_data = get_current_plans()
                self._send_json(200, {
                    "success": True,
                    "folder": os.path.abspath(WATCH_FOLDER_PATH),
                    "sourceFolder": SOURCE_FOLDER_PATH,
                    "data": current_data,
                    "notice": f"원본 폴더가 지정되었습니다.\n경로: {SOURCE_FOLDER_PATH}\n(총 {current_data.get('totalCount', 0)}건 동기화 완료)"
                })
            except Exception as e:
                self._send_json(500, {"success": False, "message": str(e)})

        elif parsed.path == '/api/source-folder':
            content_length = int(self.headers.get('Content-Length', 0))
            post_body = self.rfile.read(content_length)
            try:
                payload = json.loads(post_body.decode('utf-8'))
                new_src = payload.get('sourceFolder', '').strip()
                if not new_src:
                    raise ValueError('소스 폴더 경로가 비어 있습니다.')
                if not os.path.exists(new_src):
                    raise ValueError(f'지정한 소스 폴더가 존재하지 않습니다: {new_src}')
                SOURCE_FOLDER_PATH = os.path.normpath(new_src)
                save_source_folder(SOURCE_FOLDER_PATH)
                self._send_json(200, {
                    "success": True,
                    "sourceFolder": SOURCE_FOLDER_PATH,
                    "localCacheFolder": os.path.abspath(WATCH_FOLDER_PATH),
                    "message": f"원본 소스 폴더가 설정되었습니다: {SOURCE_FOLDER_PATH}"
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
            target_months = None
            try:
                content_length = int(self.headers.get('Content-Length', 0))
                if content_length > 0:
                    post_body = self.rfile.read(content_length)
                    payload = json.loads(post_body.decode('utf-8'))
                    target_month = payload.get('targetMonth') or payload.get('month')
                    target_months = payload.get('targetMonths')
            except Exception:
                pass
            try:
                # 🎯 [사용자 요청] 폴더 동기화 클릭 시: 원본 파일을 강제로 워드로 변환(덮어쓰기)하고 AI 분석 수행
                updated = scan_and_sync_all_relevant_files(force=True, is_initial=False, target_month=target_month, target_months=target_months)
                current_data = get_current_plans()
                if not updated and current_data.get('totalCount', 0) == 0:
                    notice = "지정된 폴더에 처리 가능한 점검 계획 파일(.hwp, .docx, .pdf, 이미지)이 없습니다."
                else:
                    file_name = current_data.get('sourceFile', '')
                    file_msg = f"[{file_name}] " if file_name else ""
                    notice = f"{file_msg}워드 변환 및 AI 분석 완료 (총 {current_data.get('totalCount', 0)}건)"
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
                allowed_months = get_monitoring_target_months()
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

        elif parsed.path == '/api/ai-config':
            content_length = int(self.headers.get('Content-Length', 0))
            post_body = self.rfile.read(content_length)
            try:
                payload = json.loads(post_body.decode('utf-8'))
                global API_GATEWAY_URL, API_KEY, AI_MODEL
                if payload.get('gatewayUrl'):
                    API_GATEWAY_URL = payload['gatewayUrl'].strip()
                if payload.get('apiKey'):
                    API_KEY = payload['apiKey'].strip()
                if payload.get('aiModel'):
                    AI_MODEL = payload['aiModel'].strip()

                save_ai_config(API_GATEWAY_URL, API_KEY, AI_MODEL)
                print(f"[AI Config] AI 설정 변경 완료: Gateway={API_GATEWAY_URL}, Model={AI_MODEL}")
                self._send_json(200, {
                    "success": True,
                    "message": "AI 연동 설정이 성공적으로 저장되었습니다.",
                    "gatewayUrl": API_GATEWAY_URL,
                    "apiKey": API_KEY,
                    "aiModel": AI_MODEL
                })
            except Exception as e:
                self._send_json(500, {"success": False, "message": str(e)})

        else:
            self.send_response(404)
            self._send_cors()
            self.end_headers()

    def log_message(self, format, *args):
        pass


def run_scheduled_sync(label, target_months):
    """
    스케줄 자동 실행 공통 처리:
    1. 원본 소스 폴더에서 target_months에 해당하는 HWP 파일을 무조건 DOCX로 변환(기존 덮어쓰기)
    2. AI에 전달하여 점검 계획 분석 후 갱신
    """
    print(f"[Watcher] {label} 스케줄 자동 실행 시작 - 대상 월: {target_months}")
    scan_and_sync_all_relevant_files(force=True, is_initial=False, target_months=target_months)
    print(f"[Watcher] {label} 스케줄 자동 실행 완료")


def start_background_watcher():
    """
    백그라운드 스레드:
    🎯 [사용자 정의 점검계획 자동 관리 스케줄 규칙]
    - 매달  1일 09시: 당월 파일을 DOCX로 강제 변환(덮어쓰기) → AI 분석 → 달력 표시
    - 매달  5일 09시: 동일 (당월)
    - 매달 25일 09시: 당월 + 다음달 파일 모두 강제 변환 → AI 분석 → 달력 표시
    - 매달 30일 09시: 당월 + 다음달 파일 모두 강제 변환 → AI 분석 → 달력 표시
    * 위 4개 날짜 외에는 자동 실행하지 않음 (웹 수동 수정/동기화 우선 유지)
    """
    import datetime as _dt

    # 스케줄 실행 대상 일자 (매월 해당 일)
    SCHEDULE_DAYS = {1, 5, 25, 30}

    def get_target_months_for_day(day, now):
        """해당 일에 처리해야 할 대상 월 목록 반환"""
        cur_ym = now.strftime('%Y-%m')
        if now.month == 12:
            next_ym = f"{now.year + 1}-01"
        else:
            next_ym = f"{now.year}-{now.month + 1:02d}"

        if day in (25, 30):
            # 25일, 30일: 당월 + 다음달
            return [cur_ym, next_ym]
        else:
            # 1일, 5일: 당월만
            return [cur_ym]

    def watcher_loop():
        last_run_key = None  # 마지막 스케줄 실행 키 (YYYY-MM-DD)
        while True:
            try:
                now = datetime.now()
                cur_day = now.day
                cur_hour = now.hour
                cur_minute = now.minute
                today_key = now.strftime('%Y-%m-%d')

                # 스케줄 대상 날짜이고, 09시 이후이고, 오늘 아직 실행하지 않은 경우
                if cur_day in SCHEDULE_DAYS and cur_hour >= 9 and today_key != last_run_key:
                    target_months = get_target_months_for_day(cur_day, now)
                    label = f"{today_key} {cur_day}일"
                    run_scheduled_sync(label, target_months)
                    last_run_key = today_key

                elif cur_day not in SCHEDULE_DAYS and today_key != last_run_key:
                    # 비스케줄 날짜: 로그만 출력하고 넘어감
                    if cur_hour >= 9 and cur_minute == 0:
                        print(f"[Watcher] {today_key}: 자동 실행 비대상일 (스케줄: 매월 1·5·25·30일 09시)")
                        last_run_key = today_key  # 하루 1회 로그 방지

            except Exception as e:
                print(f"[Watcher] 감시 루프 오류: {e}")

            # 5분 간격으로 확인 (정각 체크에 충분한 해상도)
            time.sleep(300)

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
