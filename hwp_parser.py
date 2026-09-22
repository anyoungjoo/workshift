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
                            if task_text in ['대체휴일', '한글날', '추석', '설날', '신정', '광복절']:
                                continue
                            if not task_text.strip():
                                continue
                            all_plans.append({
                                'date': date_str,
                                'task': task_text.strip(),
                                'color': color,
                                'category': category
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


if __name__ == '__main__':
    if len(sys.argv) > 1:
        txt = extract_text_from_hwp(sys.argv[1])
        plans = extract_hwp_table_plans(sys.argv[1])
        sys.stdout.reconfigure(encoding='utf-8')
        print(f"--- 표 추출 계획 ({len(plans)} 건) ---")
        for p in plans[:10]:
            print(p)
    else:
        print("사용법: python hwp_parser.py <hwp파일경로>")
