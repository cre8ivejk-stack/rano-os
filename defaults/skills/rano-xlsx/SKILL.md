---
name: rano-xlsx
description: 엑셀(.xlsx) 파일을 만들거나 고친다. 표·숫자 정리, 집계, 보고용 시트가 필요할 때 쓴다.
---

# 엑셀 파일 만들기 (rano-xlsx)

라노 OS 가 데이터 폴더에 설치한 파이썬(`$RANO_PY`)과 openpyxl 로 엑셀 파일을 만든다.

## 순서
1. 무엇을 담을지 먼저 정한다: 시트 이름, 열 제목, 행 데이터, 합계·평균 같은 계산.
2. 파이썬 스크립트를 **이 과제의 시안 폴더**에 `make_xlsx.py` 같은 이름으로 만든다(시안 폴더 쓰기는 승인이 필요 없다).
3. `"$RANO_PY" <시안 폴더>/make_xlsx.py` 로 실행한다. 실행은 승인함을 거친다. 승인 요청의 "왜"에 무엇을 만드는지 한 줄로 적는다.
4. 결과 파일도 먼저 시안 폴더에 만든다. 작업 폴더에 넣어야 하면 리더가 propose_changes(묶음 승인)로 올린다. 파일 하나면 그 엑셀을 시안 폴더에 두고 보고에 위치를 적는다.
5. 만든 뒤 다시 열어(openpyxl.load_workbook) 시트·행 수·합계가 맞는지 확인하고, 확인한 내용을 보고에 적는다.

## 스크립트 틀
```python
from openpyxl import Workbook
from openpyxl.styles import Font, PatternFill, Alignment, Border, Side
from openpyxl.utils import get_column_letter

wb = Workbook()
ws = wb.active
ws.title = "요약"                      # 시트 이름은 31자 이하, / \ ? * [ ] 금지

headers = ["항목", "값", "비고"]
rows = [["예시", 1234, ""]]

ws.append(headers)
for r in rows:
    ws.append(r)

# 머리줄 꾸미기
head_fill = PatternFill("solid", fgColor="DDEBE1")
thin = Side(style="thin", color="C8C8C0")
for c in ws[1]:
    c.font = Font(bold=True)
    c.fill = head_fill
    c.alignment = Alignment(horizontal="center", vertical="center")
for row in ws.iter_rows(min_row=1, max_row=ws.max_row, max_col=len(headers)):
    for c in row:
        c.border = Border(top=thin, bottom=thin, left=thin, right=thin)

# 합계는 값이 아니라 수식으로 넣는다 (엑셀에서 다시 계산되게)
last = ws.max_row
ws.append(["합계", f"=SUM(B2:B{last})", ""])
ws.cell(row=ws.max_row, column=1).font = Font(bold=True)

# 숫자 서식, 열 너비, 머리줄 고정
for c in ws["B"][1:]:
    c.number_format = "#,##0"
for i, h in enumerate(headers, start=1):
    width = max(len(str(h)), *(len(str(ws.cell(row=r, column=i).value or "")) for r in range(2, ws.max_row + 1)))
    ws.column_dimensions[get_column_letter(i)].width = min(60, width * 2 + 4)  # 한글은 폭이 넓다
ws.freeze_panes = "A2"

wb.save("결과.xlsx")  # 실제로는 시안 폴더 절대 경로로 저장
```

## 지킬 것
- 계산 값은 가능하면 엑셀 수식(`=SUM(...)`, `=AVERAGE(...)`)으로 넣어 사용자가 고쳐도 다시 계산되게 한다.
- 날짜는 `datetime.date` 로 넣고 `number_format = "yyyy-mm-dd"` 를 준다. 글자 "2026-11-05" 로 넣지 않는다.
- 원본 숫자를 지어내지 않는다. 작업 폴더·참고 폴더에서 확인한 값만 쓰고, 출처를 "비고"나 별도 시트에 적는다.
- 비밀 값(.env, 토큰, 비밀번호)은 넣지 않는다.
- 기존 엑셀을 고칠 때는 `load_workbook(경로)` 로 열고, 수식을 지우지 않게 `data_only=True` 로 열지 않는다.
- `$RANO_PY` 가 없다고 나오면 직접 설치하지 말고 보고에 "라노 OS 설정에서 문서 도구 설치 필요"라고 적는다.
