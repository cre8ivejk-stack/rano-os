---
name: rano-docx
description: 워드(.docx) 문서를 만들거나 고친다. 보고서·안내서·회의록처럼 사람이 읽고 돌려 볼 문서가 필요할 때 쓴다.
---

# 워드 문서 만들기 (rano-docx)

라노 OS 가 데이터 폴더에 설치한 파이썬(`$RANO_PY`)과 python-docx 로 워드 문서를 만든다.

## 순서
1. 문서 뼈대를 먼저 정한다: 제목, 요약(3줄 안), 절 제목, 표, 마무리(다음 할 일).
2. 파이썬 스크립트를 **이 과제의 시안 폴더**에 만들고 `"$RANO_PY" <스크립트>` 로 실행한다(실행은 승인함을 거친다).
3. 결과 문서는 시안 폴더에 먼저 만든다. 작업 폴더에 넣어야 하면 리더가 propose_changes 로 올린다.
4. 만든 뒤 다시 열어(Document(경로)) 절 수·표 수가 맞는지 확인하고 보고에 적는다.

## 스크립트 틀
```python
from docx import Document
from docx.shared import Pt, RGBColor, Cm
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.oxml.ns import qn

FONT = "Apple SD Gothic Neo"   # 맥 기본 한글 글꼴. 회사 PC 용이면 "맑은 고딕"

doc = Document()
# 기본 글꼴: 한글이 깨지지 않게 동아시아 글꼴까지 지정
st = doc.styles["Normal"]
st.font.name = FONT
st.font.size = Pt(10.5)
st.element.rPr.rFonts.set(qn("w:eastAsia"), FONT)
for name in ["Heading 1", "Heading 2", "Title"]:
    s = doc.styles[name]
    s.font.name = FONT
    s.element.rPr.rFonts.set(qn("w:eastAsia"), FONT)

for sec in doc.sections:
    sec.left_margin = sec.right_margin = Cm(2.2)

doc.add_heading("문서 제목", level=0)
p = doc.add_paragraph("한 줄 요약: …")
doc.add_heading("1. 배경", level=1)
doc.add_paragraph("…")
doc.add_paragraph("목록 항목", style="List Bullet")

# 표
rows = [["항목", "내용"], ["예시", "설명"]]
t = doc.add_table(rows=len(rows), cols=len(rows[0]))
t.style = "Table Grid"
for i, r in enumerate(rows):
    for j, v in enumerate(r):
        cell = t.cell(i, j)
        cell.text = str(v)
        if i == 0:
            for run in cell.paragraphs[0].runs:
                run.font.bold = True

doc.save("결과.docx")  # 실제로는 시안 폴더 절대 경로로 저장
```

## 지킬 것
- 쉬운 한국어로 쓰고, 사실은 작업 폴더·참고 폴더에서 확인한 것만 쓴다. 모르는 것은 "확인 필요"로 남긴다.
- 제목 단계(Heading 1, 2)를 지켜 워드의 탐색 창에서 목차가 보이게 한다.
- 비밀 값(.env, 토큰, 비밀번호)은 넣지 않는다.
- `$RANO_PY` 가 없다고 나오면 직접 설치하지 말고 보고에 "라노 OS 설정에서 문서 도구 설치 필요"라고 적는다.
