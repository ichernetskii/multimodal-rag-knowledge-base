import sys
from pathlib import Path
import pypdfium2 as pdfium

source, target, maximum, side = sys.argv[1:]
pdf = pdfium.PdfDocument(source)
if len(pdf) > int(maximum):
    raise ValueError('PAGE_LIMIT')
for i in range(len(pdf)):
    page = pdf[i]
    width, height = page.get_size()
    image = page.render(scale=min(float(side) / max(width, height), 2)).to_pil()
    image.convert('RGB').save(Path(target) / ('page-%d.jpg' % i), quality=85)
    page.close()
pdf.close()
