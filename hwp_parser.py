"""
KBS 송출센터 - 한글(.hwp) 5.0 텍스트 및 글자 색상(빨강, 파랑, 검정), 표 구조 추출 모듈
OLE Compound File 구조와 zlib 압축 해제를 통해 BodyText, CharShape(색상), 표(Table) 구조를 정밀 파싱합니다.
"""

import sys
import zlib
import struct
import io
import os
import re
import zipfile

try:
    import olefile
except ImportError:
    olefile = None


def get_hwp_char_shape_colors(ole):
    """
    DocInfo 스트림에서 CharShape(Tag 21) 레코드들을 파싱하여
    각 Shape ID별 텍스트 색상 ('red', 'blue', 'black') 맵을 반환합니다.
    """
    cshapes = []
    try:
        if not ole.exists('DocInfo'):
            return cshapes

        docinfo_stream = ole.openstream('DocInfo').read()
        decompressed = None
        for wbits in (-15, 15, zlib.MAX_WBITS | 32):
            try:
                decompressed = zlib.decompress(docinfo_stream, wbits)
                break
            except Exception:
                continue

        if not decompressed:
            decompressed = docinfo_stream

        idx = 0
        length = len(decompressed)
        while idx < length - 4:
            header = struct.unpack_from('<I', decompressed, idx)[0]
            idx += 4
            tag_id = header & 0x3FF
            size = (header >> 20) & 0xFFF
            if size == 0xFFF:
                if idx + 4 > length:
                    break
                size = struct.unpack_from('<I', decompressed, idx)[0]
                idx += 4

            payload = decompressed[idx:idx + size]
            idx += size

            # HWPTAG_CHAR_SHAPE (Tag 21)
            if tag_id == 21 and len(payload) >= 56:
                color = struct.unpack_from('<I', payload, 52)[0]
                r = color & 0xFF
                g = (color >> 8) & 0xFF
                b = (color >> 16) & 0xFF

                if r > 160 and g < 110 and b < 110:
                    cname = 'red'
                elif b > 160 and r < 110 and g < 110:
                    cname = 'blue'
                else:
                    cname = 'black'
                cshapes.append(cname)
    except Exception:
        pass

    return cshapes


def extract_hwp_table_plans(file_or_bytes, filename=""):
    """
    KBS 송신 시설 점검 계획 표 구조를 직접 분석하여
    정확한 날짜(YYYY-MM-DD), 작업내용, 글자색(red/blue/black) 목록을 추출합니다.
    """
    if isinstance(file_or_bytes, (str, os.PathLike)):
        if not os.path.exists(file_or_bytes):
            return []
        f = open(file_or_bytes, 'rb')
        if not filename:
            filename = os.path.basename(file_or_bytes)
    elif isinstance(file_or_bytes, bytes):
        f = io.BytesIO(file_or_bytes)
    else:
        f = file_or_bytes

    try:
        if olefile is None:
            return []

        ole = olefile.OleFileIO(f)
        cshapes = get_hwp_char_shape_colors(ole)

        # 파일명 또는 내용에서 연도/월 추출 (예: 202610, 2026년 10월 등)
        year = 2026
        month = 10
        m_match = re.search(r'(\d{4})[^\d]*(\d{1,2})', filename)
        if m_match:
            year = int(m_match.group(1))
            month = int(m_match.group(2))

        # Section 파싱
        dirs = ole.listdir()
        section_paths = [p for p in dirs if len(p) >= 2 and p[0] == 'BodyText' and p[1].startswith('Section')]
        section_paths.sort(key=lambda x: int(x[1].replace('Section', '')) if x[1].replace('Section', '').isdigit() else x[1])

        all_plans = []

        for sp in section_paths:
            stream_data = ole.openstream(sp).read()
            if not stream_data:
                continue

            decompressed = None
            for wbits in (-15, 15, zlib.MAX_WBITS | 32):
                try:
                    decompressed = zlib.decompress(stream_data, wbits)
                    break
                except Exception:
                    continue
            if not decompressed:
                decompressed = stream_data

            idx = 0
            length = len(decompressed)
            cur_cell = None
            cells = {}
            cur_para_text = ''

            while idx < length - 4:
                header = struct.unpack_from('<I', decompressed, idx)[0]
                idx += 4
                tag_id = header & 0x3FF
                size = (header >> 20) & 0xFFF
                if size == 0xFFF:
                    if idx + 4 > length:
                        break
                    size = struct.unpack_from('<I', decompressed, idx)[0]
                    idx += 4
                payload = decompressed[idx:idx + size]
                idx += size

                if tag_id == 72 and len(payload) >= 16:  # HWPTAG_LIST_HEADER (Table Cell)
                    col, row, colspan, rowspan = struct.unpack_from('<HHHH', payload, 8)
                    cur_cell = (row, col)
                    if cur_cell not in cells:
                        cells[cur_cell] = []
                elif tag_id == 67:  # HWPTAG_PARA_TEXT
                    cur_para_text = payload.decode('utf-16le', errors='ignore')
                elif tag_id == 68:  # HWPTAG_PARA_CHAR_SHAPE
                    if cur_cell and cur_para_text:
                        pos_shapes = []
                        for p_idx in range(0, len(payload), 8):
                            if p_idx + 8 <= len(payload):
                                c_pos, s_id = struct.unpack_from('<II', payload, p_idx)
                                pos_shapes.append((c_pos, s_id))
                        for i in range(len(pos_shapes)):
                            st = pos_shapes[i][0]
                            ed = pos_shapes[i + 1][0] if i + 1 < len(pos_shapes) else len(cur_para_text)
                            sid = pos_shapes[i][1]
                            cname = cshapes[sid] if sid < len(cshapes) else 'black'
                            part = cur_para_text[st:ed].strip()
                            if part:
                                cells[cur_cell].append((cname, part))
                        cur_para_text = ''

            # 날짜 행 탐색 (cols 1..7 에 일자 숫자가 4개 이상 있는 행)
            date_rows = []
            for r in sorted(set(k[0] for k in cells.keys())):
                col_nums = []
                for c in range(1, 8):
                    items = cells.get((r, c), [])
                    txt = ' '.join([t[1] for t in items]).strip()
                    if txt.isdigit() and 1 <= int(txt) <= 31:
                        col_nums.append((c, int(txt)))
                if len(col_nums) >= 4:
                    date_rows.append((r, dict(col_nums)))

            max_row = max([k[0] for k in cells.keys()]) if cells else 0
            for i, (dr, day_map) in enumerate(date_rows):
                next_dr = date_rows[i + 1][0] if i + 1 < len(date_rows) else max_row + 1
                for task_row in range(dr + 1, next_dr):
                    cat_items = cells.get((task_row, 0), [])
                    category = ' '.join([t[1] for t in cat_items]).strip()
                    if not category or '참고' in category or '구분' in category:
                        continue
                    for col, day_num in day_map.items():
                        cell_items = cells.get((task_row, col), [])
                        if not cell_items:
                            continue

                        cur_m = month
                        cur_y = year
                        if i == 0 and day_num > 20:
                            cur_m = month - 1 if month > 1 else 12
                            cur_y = year if month > 1 else year - 1
                        elif i >= len(date_rows) - 1 and day_num < 10:
                            cur_m = month + 1 if month < 12 else 1
                            cur_y = year if month < 12 else year + 1

                        date_str = f"{cur_y:04d}-{cur_m:02d}-{day_num:02d}"
                        for color, task_text in cell_items:
                            clean_task = task_text.strip()
                            # 옥천 TVR 표준화 (도덕봉 등 제거 및 정기점검 black 확정)
                            if clean_task.startswith('옥천') and not ('계획' in clean_task or '정파' in clean_task):
                                clean_task = '옥천TVR'
                                color = 'black'

                            # 작업이 아닌 기념일/공휴일 제외
                            if any(h in clean_task for h in ['방송의날', '방송의 날', '대체휴일', '한글날', '추석', '설날', '신정', '광복절', '개천절', '어린이날', '현충일', '삼일절', '크리스마스']):
                                continue
                            if not clean_task:
                                continue

                            all_plans.append({
                                'date': date_str,
                                'task': clean_task,
                                'color': color,
                                'category': category,
                                'order': task_row
                            })

        ole.close()
        return all_plans
    finally:
        if isinstance(file_or_bytes, (str, os.PathLike)) and f:
            f.close()


def extract_text_from_hwp(file_or_bytes):
    """
    한글 (.hwp) 파일 경로 또는 파일 바이트에서 BodyText 섹션의 텍스트를 추출하며,
    빨간 글씨, 파란 글씨가 있을 경우 [RED], [BLUE] 태그를 달아 전달합니다.
    """
    if isinstance(file_or_bytes, (str, os.PathLike)):
        if not os.path.exists(file_or_bytes):
            raise FileNotFoundError(f"파일을 찾을 수 없습니다: {file_or_bytes}")
        f = open(file_or_bytes, 'rb')
    elif isinstance(file_or_bytes, bytes):
        f = io.BytesIO(file_or_bytes)
    else:
        f = file_or_bytes

    try:
        if olefile is None:
            raise RuntimeError("olefile 모듈이 필요합니다. (pip install olefile)")

        ole = olefile.OleFileIO(f)
        cshapes = get_hwp_char_shape_colors(ole)

        dirs = ole.listdir()
        section_paths = [p for p in dirs if len(p) >= 2 and p[0] == 'BodyText' and p[1].startswith('Section')]
        section_paths.sort(key=lambda x: int(x[1].replace('Section', '')) if x[1].replace('Section', '').isdigit() else x[1])

        extracted_lines = []

        for sp in section_paths:
            stream_data = ole.openstream(sp).read()
            if not stream_data:
                continue

            decompressed = None
            for wbits in (-15, 15, zlib.MAX_WBITS | 32):
                try:
                    decompressed = zlib.decompress(stream_data, wbits)
                    break
                except Exception:
                    continue

            if not decompressed:
                decompressed = stream_data

            idx = 0
            length = len(decompressed)
            cur_para_text = ''

            while idx < length - 4:
                header = struct.unpack_from('<I', decompressed, idx)[0]
                idx += 4
                tag_id = header & 0x3FF
                size = (header >> 20) & 0xFFF
                if size == 0xFFF:
                    if idx + 4 > length:
                        break
                    size = struct.unpack_from('<I', decompressed, idx)[0]
                    idx += 4

                payload = decompressed[idx:idx + size]
                idx += size

                if tag_id == 67:  # HWPTAG_PARA_TEXT
                    cur_para_text = payload.decode('utf-16le', errors='ignore')
                elif tag_id == 68:  # HWPTAG_PARA_CHAR_SHAPE
                    if cur_para_text:
                        pos_shapes = []
                        for p_idx in range(0, len(payload), 8):
                            if p_idx + 8 <= len(payload):
                                c_pos, s_id = struct.unpack_from('<II', payload, p_idx)
                                pos_shapes.append((c_pos, s_id))

                        line_parts = []
                        for i in range(len(pos_shapes)):
                            st = pos_shapes[i][0]
                            ed = pos_shapes[i + 1][0] if i + 1 < len(pos_shapes) else len(cur_para_text)
                            sid = pos_shapes[i][1]
                            cname = cshapes[sid] if sid < len(cshapes) else 'black'
                            raw_part = cur_para_text[st:ed]
                            # 특수문자 정리
                            clean_chars = [ch if ord(ch) >= 32 or ch in '\n\t' else ' ' for ch in raw_part]
                            part_text = ''.join(clean_chars).strip()
                            if part_text:
                                if cname == 'red':
                                    line_parts.append(f"[RED:{part_text}]")
                                elif cname == 'blue':
                                    line_parts.append(f"[BLUE:{part_text}]")
                                else:
                                    line_parts.append(part_text)

                        full_line = ' '.join(line_parts).strip()
                        if full_line:
                            extracted_lines.append(full_line)
                        cur_para_text = ''

        ole.close()
        return '\n'.join(extracted_lines)

    finally:
        if isinstance(file_or_bytes, (str, os.PathLike)) and f:
            f.close()


def extract_hwpx_table_plans(file_or_bytes, filename=""):
    """
    최신 한글 포맷(.hwpx: OWPML ZIP/XML 구조)에서 점검표 구조 및
    글자색(빨강, 파랑, 검정), 날짜별 점검 계획을 직접 추출합니다.
    """
    if isinstance(file_or_bytes, (str, os.PathLike)):
        z = zipfile.ZipFile(file_or_bytes)
        if not filename:
            filename = os.path.basename(file_or_bytes)
    else:
        z = zipfile.ZipFile(io.BytesIO(file_or_bytes))

    # 연/월 추출
    year = 2026
    month = 9
    ym_match = re.search(r'(20\d{2})[-_.]?(0[1-9]|1[0-2])', filename)
    if ym_match:
        year = int(ym_match.group(1))
        month = int(ym_match.group(2))
    else:
        m_match = re.search(r'([1-9]|1[0-2])월', filename)
        if m_match:
            month = int(m_match.group(1))

    # 1. 색상 매핑 (Contents/header.xml)
    char_colors = {}
    if 'Contents/header.xml' in z.namelist():
        head_xml = z.read('Contents/header.xml').decode('utf-8', errors='replace')
        for m in re.finditer(r'<hh:charPr\s+id="(\d+)"[^>]*textColor="(#[0-9A-Fa-f]{6})"', head_xml):
            cid, col = m.group(1), m.group(2).upper()
            r = int(col[1:3], 16)
            g = int(col[3:5], 16)
            b = int(col[5:7], 16)
            if r > 150 and g < 100 and b < 100:
                char_colors[cid] = 'red'
            elif b > 150 and r < 100:
                char_colors[cid] = 'blue'
            else:
                char_colors[cid] = 'black'

    # 2. 셀 파싱 (Contents/section0.xml)
    cells = {}  # (row, col) -> [(color, text)]
    if 'Contents/section0.xml' in z.namelist():
        sec_xml = z.read('Contents/section0.xml').decode('utf-8', errors='replace')
        tc_pattern = re.compile(r'<hp:tc\b[^>]*>(.*?)</hp:tc>', re.DOTALL)
        for tc_match in tc_pattern.finditer(sec_xml):
            tc_content = tc_match.group(1)
            addr_m = re.search(r'<hp:cellAddr\s+colAddr="(\d+)"\s+rowAddr="(\d+)"', tc_content)
            if not addr_m:
                continue
            col = int(addr_m.group(1))
            row = int(addr_m.group(2))
            cur_cell = (row, col)
            if cur_cell not in cells:
                cells[cur_cell] = []

            run_pattern = re.compile(r'<hp:run\s+charPrIDRef="(\d+)"[^>]*>(.*?)</hp:run>', re.DOTALL)
            for r_match in run_pattern.finditer(tc_content):
                cid = r_match.group(1)
                r_body = r_match.group(2)
                t_matches = re.findall(r'<hp:t>(.*?)</hp:t>', r_body, re.DOTALL)
                if not t_matches:
                    continue
                txt = "".join(t_matches).strip()
                if txt:
                    color = char_colors.get(cid, 'black')
                    cells[cur_cell].append((color, txt))

    # 3. 날짜 행 탐색 (cols 1..7 에 일자 숫자가 4개 이상 있는 행)
    date_rows = []
    for r in sorted(set(k[0] for k in cells.keys())):
        col_nums = []
        for c in range(1, 8):
            items = cells.get((r, c), [])
            txt = ' '.join([t[1] for t in items]).strip()
            if txt.isdigit() and 1 <= int(txt) <= 31:
                col_nums.append((c, int(txt)))
        if len(col_nums) >= 4:
            date_rows.append((r, dict(col_nums)))

    all_plans = []
    max_row = max([k[0] for k in cells.keys()]) if cells else 0
    for i, (dr, day_map) in enumerate(date_rows):
        next_dr = date_rows[i + 1][0] if i + 1 < len(date_rows) else max_row + 1
        for task_row in range(dr + 1, next_dr):
            cat_items = cells.get((task_row, 0), [])
            category = ' '.join([t[1] for t in cat_items]).strip()
            if not category or '참고' in category or '구분' in category:
                continue
            for col, day_num in day_map.items():
                cell_items = cells.get((task_row, col), [])
                if not cell_items:
                    continue

                cur_m = month
                cur_y = year
                if i == 0 and day_num > 20:
                    cur_m = month - 1 if month > 1 else 12
                    cur_y = year if month > 1 else year - 1
                elif i >= len(date_rows) - 1 and day_num < 10:
                    cur_m = month + 1 if month < 12 else 1
                    cur_y = year if month < 12 else year + 1

                date_str = f"{cur_y:04d}-{cur_m:02d}-{day_num:02d}"
                for color, task_text in cell_items:
                    clean_task = task_text.strip()
                    if clean_task.startswith('옥천') and not ('계획' in clean_task or '정파' in clean_task):
                        clean_task = '옥천TVR'
                        color = 'black'

                    # 공휴일 및 기념일 제외
                    if any(h in clean_task for h in ['방송의날', '방송의 날', '대체휴일', '한글날', '추석', '설날', '신정', '광복절', '개천절', '어린이날', '현충일', '삼일절', '크리스마스']):
                        continue
                    if not clean_task:
                        continue

                    all_plans.append({
                        'date': date_str,
                        'task': clean_task,
                        'color': color,
                        'category': category,
                        'order': task_row
                    })

    z.close()
    return all_plans


def extract_text_from_hwpx(file_or_bytes):
    """HWPX 파일에서 [RED:...], [BLUE:...] 태그가 포함된 텍스트 추출"""
    if isinstance(file_or_bytes, (str, os.PathLike)):
        z = zipfile.ZipFile(file_or_bytes)
    else:
        z = zipfile.ZipFile(io.BytesIO(file_or_bytes))

    char_colors = {}
    if 'Contents/header.xml' in z.namelist():
        head_xml = z.read('Contents/header.xml').decode('utf-8', errors='replace')
        for m in re.finditer(r'<hh:charPr\s+id="(\d+)"[^>]*textColor="(#[0-9A-Fa-f]{6})"', head_xml):
            cid, col = m.group(1), m.group(2).upper()
            r = int(col[1:3], 16)
            g = int(col[3:5], 16)
            b = int(col[5:7], 16)
            if r > 150 and g < 100 and b < 100:
                char_colors[cid] = 'red'
            elif b > 150 and r < 100:
                char_colors[cid] = 'blue'
            else:
                char_colors[cid] = 'black'

    text_chunks = []
    if 'Contents/section0.xml' in z.namelist():
        sec_xml = z.read('Contents/section0.xml').decode('utf-8', errors='replace')
        run_pattern = re.compile(r'<hp:run\s+charPrIDRef="(\d+)"[^>]*>(.*?)</hp:run>', re.DOTALL)
        for m in run_pattern.finditer(sec_xml):
            cid = m.group(1)
            txts = re.findall(r'<hp:t>(.*?)</hp:t>', m.group(2), re.DOTALL)
            if not txts:
                continue
            run_txt = "".join(txts).strip()
            if not run_txt:
                continue
            color = char_colors.get(cid, 'black')
            if color == 'red':
                text_chunks.append(f"[RED:{run_txt}]")
            elif color == 'blue':
                text_chunks.append(f"[BLUE:{run_txt}]")
            else:
                text_chunks.append(run_txt)

    z.close()
    return " ".join(text_chunks)


if __name__ == '__main__':
    if len(sys.argv) > 1:
        fp = sys.argv[1]
        ext = os.path.splitext(fp)[1].lower()
        if ext == '.hwpx':
            plans = extract_hwpx_table_plans(fp)
        else:
            plans = extract_hwp_table_plans(fp)
        sys.stdout.reconfigure(encoding='utf-8')
        print(f"--- 표 추출 계획 ({len(plans)} 건) ---")
        for p in plans[:10]:
            print(p)
    else:
        print("사용법: python hwp_parser.py <hwp/hwpx파일경로>")
