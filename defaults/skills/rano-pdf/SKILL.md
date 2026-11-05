---
name: rano-pdf
description: PDF 를 읽고(글자·표 뽑기, 쪽 나누기·합치기) 간단한 PDF 문서를 만든다. 받은 PDF 를 정리하거나 배포용 PDF 가 필요할 때 쓴다.
---

# PDF 다루기 (rano-pdf)

라노 OS 가 데이터 폴더에 설치한 파이썬(`$RANO_PY`)과 pypdf(읽기·합치기·나누기), reportlab(만들기)을 쓴다.

## 순서
1. 스크립트를 **이 과제의 시안 폴더**에 만들고 `"$RANO_PY" <스크립트>` 로 실행한다(실행은 승인함을 거친다).
2. 결과 파일은 시안 폴더에 먼저 만든다. 작업 폴더에 넣어야 하면 리더가 propose_changes 로 올린다.
3. 만든 뒤 쪽 수를 다시 세어 보고에 적는다.

## 읽기·합치기·나누기
```python
from pypdf import PdfReader, PdfWriter

r = PdfReader("받은.pdf")
print(len(r.pages))
text = "\n".join(p.extract_text() or "" for p in r.pages)   # 스캔본(그림)이면 글자가 안 나온다 → 보고에 적는다

w = PdfWriter()
for p in r.pages[0:3]:          # 1~3쪽만
    w.add_page(p)
w.write("앞3쪽.pdf")

m = PdfWriter()
for f in ["a.pdf", "b.pdf"]:
    for p in PdfReader(f).pages:
        m.add_page(p)
m.write("합침.pdf")
```

## 만들기 (한글 글꼴 필수)
```python
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib import colors
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont

pdfmetrics.registerFont(TTFont("KR", "/System/Library/Fonts/Supplemental/AppleGothic.ttf"))  # 맥 기본 한글 글꼴
base = getSampleStyleSheet()
body = ParagraphStyle("body", parent=base["Normal"], fontName="KR", fontSize=10.5, leading=16)
h1 = ParagraphStyle("h1", parent=body, fontSize=18, leading=24, spaceAfter=10)

doc = SimpleDocTemplate("결과.pdf", pagesize=A4, leftMargin=50, rightMargin=50)
rows = [["항목", "값"], ["예시", "1,234"]]
t = Table(rows)
t.setStyle(TableStyle([("FONT", (0, 0), (-1, -1), "KR", 10), ("GRID", (0, 0), (-1, -1), 0.5, colors.grey),
                       ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#DDEBE1"))]))
doc.build([Paragraph("문서 제목", h1), Paragraph("본문 …", body), Spacer(1, 12), t])
```

## 지킬 것
- 한글이 네모로 나오면 글꼴 등록이 빠진 것이다. 모든 글과 표에 "KR" 글꼴을 쓴다.
- 받은 PDF 의 내용을 옮길 때는 쪽 번호를 함께 적어 근거를 남긴다.
- 비밀 값은 넣지 않는다.
- `$RANO_PY` 가 없다고 나오면 직접 설치하지 말고 보고에 "라노 OS 설정에서 문서 도구 설치 필요"라고 적는다.
