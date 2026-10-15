"""Local bounded PDF extraction; OCR only pages without useful text. No network."""
import csv
import io
import json
import os
import subprocess
import sys
import tempfile
import resource
import re
from collections import defaultdict
import pdfplumber
import pypdfium2

path, language, max_pages, timeout, max_chars = sys.argv[1:]
text_characters = 0
resource.setrlimit(resource.RLIMIT_CPU, (int(max_pages) * int(timeout) + 60,) * 2)
if sys.platform.startswith('linux'):
    limit = int(os.environ.get('OCR_MEMORY_MB', '1024')) * 1024 * 1024
    resource.setrlimit(resource.RLIMIT_AS, (limit, limit))
pages = []
with pdfplumber.open(path) as pdf:
    if len(pdf.pages) > int(max_pages):
        print(json.dumps({'error': 'PAGE_LIMIT'}), flush=True)
        sys.exit(2)
    renderer = None
    for number, page in enumerate(pdf.pages, 1):
        text = page.extract_text(layout=False) or ''
        warnings = []
        method = 'text'
        image_area = sum(max(0, float(image['x1']) - float(image['x0'])) * max(0, float(image['bottom']) - float(image['top'])) for image in page.images)
        if not text.strip() or '\ufffd' in text or re.search(r'\(cid:\d+\)', text) or (image_area > page.width * page.height * 0.55 and len(text) < 300):
            method = 'ocr'
            print(json.dumps({'progress': 'ocr', 'page': number}), flush=True)
            try:
                if renderer is None:
                    renderer = pypdfium2.PdfDocument(path)
                with tempfile.TemporaryDirectory(prefix='ocr-', dir=os.path.dirname(path)) as directory:
                    image = os.path.join(directory, 'page.png')
                    rendered_page = renderer[number - 1]
                    bitmap = rendered_page.render(scale=min(2, 2800 / max(page.width, page.height)))
                    picture = bitmap.to_pil()
                    try:
                        picture.save(image)
                    finally:
                        picture.close()
                        bitmap.close()
                        rendered_page.close()
                    vision = os.environ.get('OCR_VISION_BIN', '')
                    if vision:
                        result = subprocess.run([vision, image, language], capture_output=True, timeout=int(timeout), check=True)
                        observations = json.loads(result.stdout)
                        rows = []
                        line_id = 0
                        previous_y = -1
                        for observation in observations:
                            if abs(observation['y'] - previous_y) > 0.008:
                                line_id += 1
                            previous_y = observation['y']
                            rows.append({'text': observation['text'], 'conf': 100 * observation['confidence'], 'block_num': 0, 'par_num': 0, 'line_num': line_id})
                    else:
                        result = subprocess.run(['tesseract', image, 'stdout', '-l', language, '--psm', '3', 'tsv'], capture_output=True, timeout=int(timeout), check=True, env={**os.environ, 'OMP_THREAD_LIMIT': '1'})
                        rows = list(csv.DictReader(io.StringIO(result.stdout.decode()), delimiter='\t'))
                    lines = {}
                    scores = []
                    for row in rows:
                        word = row.get('text', '').strip()
                        if not word:
                            continue
                        key = (row['block_num'], row['par_num'], row['line_num'])
                        lines.setdefault(key, []).append(word)
                        scores.append(float(row['conf']))
                    text = '\n'.join(' '.join(words) for words in lines.values())
                    if not scores or sum(scores) / len(scores) < 75:
                        warnings.append('OCR_LOW_CONFIDENCE')
                    warnings.append('OCR_REVIEW_REQUIRED')
            except (FileNotFoundError, subprocess.SubprocessError):
                warnings.append('OCR_UNAVAILABLE_OR_FAILED')
        tables = page.extract_tables()
        for table in tables:
            if not table:
                continue
            header = [str(cell or '').replace('\n', ' ') for cell in table[0]]
            for row in table[1:]:
                text += '\n' + '; '.join(f'{header[i] if i < len(header) else i}: {cell or ""}' for i, cell in enumerate(row))
        text_characters += len(text)
        if text_characters > int(max_chars):
            print(json.dumps({'error': 'EXTRACTED_TEXT_LIMIT'}), flush=True)
            sys.exit(2)
        if not text.strip():
            warnings.append('NO_TEXT')
        # Preserve separate heading lines instead of flattening all headings into one page title.
        word_lines = defaultdict(list)
        for word in page.extract_words(extra_attrs=['size', 'fontname']):
            word_lines[round(float(word['top']) / 3)].append(word)
        headings = []
        if method == 'ocr':
            meaningful = [line.strip() for line in text.splitlines() if line.strip()]
            if meaningful:
                headings.append(meaningful[0])
            headings.extend(line for line in meaningful[1:] if re.match(r'^\d+(?:\.\d+)*[.)]?\s+[^\W\d_]', line))
        for words in word_lines.values():
            title = ' '.join(word['text'] for word in words)
            if max(float(word['size']) for word in words) >= 14 or (re.match(r'^\d+(?:\.\d+)*\s', title) and any('bold' in word['fontname'].lower() for word in words)):
                headings.append(title)
        sections = []
        title = headings[0] if headings else f'Page {number}'
        lines = []
        for line in text.splitlines():
            if line in headings and line != title:
                if lines:
                    sections.append({'title': title[:200], 'text': '\n'.join(lines)})
                title = line
                lines = []
            lines.append(line)
        if lines:
            sections.append({'title': title[:200], 'text': '\n'.join(lines)})
        pages.append({'number': number, 'text': text, 'method': method, 'warnings': warnings, 'sections': sections})
        page.close()
    if renderer:
        renderer.close()
print(json.dumps({'pages': pages}, ensure_ascii=False), flush=True)
