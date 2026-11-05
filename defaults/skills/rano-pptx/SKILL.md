---
name: rano-pptx
description: 파워포인트(.pptx) 발표 자료를 만든다. 보고·공유용 장표, 요약 슬라이드가 필요할 때 쓴다.
---

# 파워포인트 만들기 (rano-pptx)

라노 OS 가 데이터 폴더에 설치한 파이썬(`$RANO_PY`)과 python-pptx 로 발표 자료를 만든다.

## 순서
1. 장표 흐름을 먼저 정한다: 표지 → 한 장 요약 → 본문 3~8장 → 다음 할 일. 한 장에 메시지 하나.
2. 파이썬 스크립트를 **이 과제의 시안 폴더**에 만들고 `"$RANO_PY" <스크립트>` 로 실행한다(실행은 승인함을 거친다).
3. 결과 파일은 시안 폴더에 먼저 만든다. 작업 폴더에 넣어야 하면 리더가 propose_changes 로 올린다.
4. 만든 뒤 다시 열어(Presentation(경로)) 장 수와 장마다 제목을 확인하고 보고에 적는다.

## 스크립트 틀
```python
from pptx import Presentation
from pptx.util import Inches, Pt
from pptx.dml.color import RGBColor

FONT = "Apple SD Gothic Neo"   # 회사 PC 용이면 "맑은 고딕"
prs = Presentation()
prs.slide_width, prs.slide_height = Inches(13.333), Inches(7.5)   # 16:9

def title_only(title):
    s = prs.slides.add_slide(prs.slide_layouts[5])   # 제목만 있는 틀
    s.shapes.title.text = title
    for p in s.shapes.title.text_frame.paragraphs:
        for r in p.runs:
            r.font.name = FONT; r.font.size = Pt(30); r.font.bold = True
    return s

def bullets(slide, items, top=1.6):
    box = slide.shapes.add_textbox(Inches(0.8), Inches(top), Inches(11.7), Inches(5))
    tf = box.text_frame; tf.word_wrap = True
    for i, t in enumerate(items):
        p = tf.paragraphs[0] if i == 0 else tf.add_paragraph()
        p.text = f"• {t}"
        for r in p.runs:
            r.font.name = FONT; r.font.size = Pt(20)
        p.space_after = Pt(10)

# 표지
s = prs.slides.add_slide(prs.slide_layouts[0])
s.shapes.title.text = "발표 제목"
s.placeholders[1].text = "부제 · 날짜"

# 본문
s = title_only("한 장 요약")
bullets(s, ["핵심 1", "핵심 2", "핵심 3"])

# 표
s = title_only("숫자로 보기")
rows = [["항목", "값"], ["예시", "1,234"]]
tbl = s.shapes.add_table(len(rows), len(rows[0]), Inches(0.8), Inches(1.6), Inches(11.7), Inches(0.5 * len(rows))).table
for i, r in enumerate(rows):
    for j, v in enumerate(r):
        c = tbl.cell(i, j); c.text = str(v)
        for p in c.text_frame.paragraphs:
            for run in p.runs:
                run.font.name = FONT; run.font.size = Pt(16); run.font.bold = (i == 0)

prs.save("결과.pptx")  # 실제로는 시안 폴더 절대 경로로 저장
```

## 지킬 것
- 한 장에 글은 6줄 안, 한 줄은 짧게. 자세한 내용은 발표자 노트(`slide.notes_slide.notes_text_frame.text`)에 둔다.
- 숫자는 작업 폴더·참고 폴더에서 확인한 것만 쓰고, 출처를 마지막 장이나 노트에 적는다.
- 비밀 값은 넣지 않는다.
- `$RANO_PY` 가 없다고 나오면 직접 설치하지 말고 보고에 "라노 OS 설정에서 문서 도구 설치 필요"라고 적는다.
