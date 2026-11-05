// 캡처 위에 표시하기: 펜·네모·화살표·번호(①②③). 고치고 싶은 곳을 라노에게 정확히 알려 주려는 용도.
// 그림 원래 크기 그대로 그리고, [완료]를 누르면 표시가 들어간 PNG(크면 JPG)로 돌려준다.
import { el } from './dom.js';
import { button } from './orgCommon.js';

type Tool = 'pen' | 'rect' | 'arrow' | 'num';
type Shape =
  | { kind: 'pen'; color: string; w: number; pts: [number, number][] }
  | { kind: 'rect' | 'arrow'; color: string; w: number; a: [number, number]; b: [number, number] }
  | { kind: 'num'; color: string; w: number; at: [number, number]; n: number };

const COLORS: [string, string][] = [
  ['#e5383b', '빨강'],
  ['#1f6feb', '파랑'],
  ['#f2b705', '노랑'],
];
const TOOLS: [Tool, string, string][] = [
  ['pen', '✏️ 펜', '자유롭게 그려요'],
  ['rect', '▭ 네모', '고칠 곳을 네모로 감싸요'],
  ['arrow', '➜ 화살표', '고칠 곳을 가리켜요'],
  ['num', '① 번호', '누를 때마다 1, 2, 3… 번호를 찍어요'],
];
const MAX_BYTES = 5 * 1024 * 1024;

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

/** 표시 창을 연다. 완료하면 새 data URL, 취소하면 null */
export async function annotateImage(src: string, name: string): Promise<string | null> {
  let img: HTMLImageElement;
  try {
    img = await loadImage(src);
  } catch {
    return null;
  }
  const W = img.naturalWidth;
  const H = img.naturalHeight;
  const lineW = Math.max(3, Math.round(Math.max(W, H) / 300)); // 그림 크기에 맞춘 굵기

  return new Promise((resolve) => {
    const overlay = el('div', 'anno-overlay');
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', '캡처에 표시하기');
    const box = el('div', 'anno-box');
    const bar = el('div', 'anno-bar');
    const stageWrap = el('div', 'anno-stage');
    const canvas = el('canvas', 'anno-canvas');
    canvas.width = W;
    canvas.height = H;
    stageWrap.appendChild(canvas);
    const ctx = canvas.getContext('2d')!;

    let tool: Tool = 'rect';
    let color = COLORS[0][0];
    const shapes: Shape[] = [];
    let drawing: Shape | null = null;

    const toolBtns = new Map<Tool, HTMLButtonElement>();
    for (const [t, label, tip] of TOOLS) {
      const b = button(label, 'btn btn-small anno-tool');
      b.title = tip;
      b.addEventListener('click', () => {
        tool = t;
        for (const [k, x] of toolBtns) x.classList.toggle('on', k === t);
      });
      toolBtns.set(t, b);
      bar.appendChild(b);
    }
    toolBtns.get(tool)!.classList.add('on');
    bar.appendChild(el('span', 'anno-sep'));
    const colorBtns: HTMLButtonElement[] = [];
    for (const [c, label] of COLORS) {
      const b = el('button', 'anno-color');
      b.type = 'button';
      b.style.background = c;
      b.title = label;
      b.setAttribute('aria-label', `${label} 색`);
      b.addEventListener('click', () => {
        color = c;
        colorBtns.forEach((x) => x.classList.toggle('on', x === b));
      });
      colorBtns.push(b);
      bar.appendChild(b);
    }
    colorBtns[0].classList.add('on');
    bar.appendChild(el('span', 'anno-sep'));
    const undo = button('되돌리기', 'btn btn-small btn-plain');
    const wipe = button('모두 지우기', 'btn btn-small btn-plain');
    bar.append(undo, wipe);
    const right = el('span', 'anno-right');
    const cancel = button('취소', 'btn btn-small');
    const done = button('완료', 'btn btn-small btn-confirm');
    right.append(cancel, done);
    bar.appendChild(right);

    const hint = el('p', 'anno-hint', `${name} · 고치고 싶은 곳을 네모·화살표·번호로 표시하고, 글로 "1번은 …"처럼 설명하면 라노가 정확히 알아들어요.`);
    box.append(bar, stageWrap, hint);
    overlay.appendChild(box);

    // ---- 그리기 ----
    const drawArrow = (a: [number, number], b: [number, number], w: number) => {
      const ang = Math.atan2(b[1] - a[1], b[0] - a[0]);
      const head = w * 5;
      ctx.beginPath();
      ctx.moveTo(a[0], a[1]);
      ctx.lineTo(b[0], b[1]);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(b[0], b[1]);
      ctx.lineTo(b[0] - head * Math.cos(ang - Math.PI / 7), b[1] - head * Math.sin(ang - Math.PI / 7));
      ctx.lineTo(b[0] - head * Math.cos(ang + Math.PI / 7), b[1] - head * Math.sin(ang + Math.PI / 7));
      ctx.closePath();
      ctx.fill();
    };
    const paint = () => {
      ctx.clearRect(0, 0, W, H);
      ctx.drawImage(img, 0, 0);
      for (const s of drawing ? [...shapes, drawing] : shapes) {
        ctx.strokeStyle = s.color;
        ctx.fillStyle = s.color;
        ctx.lineWidth = s.w;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        if (s.kind === 'pen') {
          ctx.beginPath();
          s.pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
          ctx.stroke();
        } else if (s.kind === 'rect') {
          ctx.strokeRect(Math.min(s.a[0], s.b[0]), Math.min(s.a[1], s.b[1]), Math.abs(s.b[0] - s.a[0]), Math.abs(s.b[1] - s.a[1]));
        } else if (s.kind === 'arrow') {
          drawArrow(s.a, s.b, s.w);
        } else if (s.kind === 'num') {
          const r = s.w * 5;
          ctx.beginPath();
          ctx.arc(s.at[0], s.at[1], r, 0, Math.PI * 2);
          ctx.fill();
          ctx.lineWidth = Math.max(2, s.w / 2);
          ctx.strokeStyle = '#ffffff';
          ctx.stroke();
          ctx.fillStyle = '#ffffff';
          ctx.font = `bold ${Math.round(r * 1.2)}px -apple-system, sans-serif`;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(String(s.n), s.at[0], s.at[1] + r * 0.06);
        }
      }
      undo.disabled = wipe.disabled = !shapes.length;
    };
    const pos = (e: PointerEvent): [number, number] => {
      const r = canvas.getBoundingClientRect();
      return [((e.clientX - r.left) / r.width) * W, ((e.clientY - r.top) / r.height) * H];
    };
    canvas.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      canvas.setPointerCapture(e.pointerId);
      const p = pos(e);
      if (tool === 'num') {
        shapes.push({ kind: 'num', color, w: lineW, at: p, n: shapes.filter((s) => s.kind === 'num').length + 1 });
        paint();
        return;
      }
      drawing = tool === 'pen' ? { kind: 'pen', color, w: lineW, pts: [p] } : { kind: tool, color, w: lineW, a: p, b: p };
    });
    canvas.addEventListener('pointermove', (e) => {
      if (!drawing) return;
      const p = pos(e);
      if (drawing.kind === 'pen') drawing.pts.push(p);
      else if (drawing.kind === 'rect' || drawing.kind === 'arrow') drawing.b = p;
      paint();
    });
    const finish = () => {
      if (!drawing) return;
      const d = drawing;
      drawing = null;
      // 너무 작은 표시(실수로 누른 것)는 버린다
      const tiny = d.kind === 'pen' ? d.pts.length < 2 : d.kind !== 'num' && Math.hypot(d.b[0] - d.a[0], d.b[1] - d.a[1]) < lineW * 2;
      if (!tiny) shapes.push(d);
      paint();
    };
    canvas.addEventListener('pointerup', finish);
    canvas.addEventListener('pointercancel', finish);
    undo.addEventListener('click', () => {
      shapes.pop();
      paint();
    });
    wipe.addEventListener('click', () => {
      shapes.length = 0;
      paint();
    });

    const close = (result: string | null) => {
      overlay.remove();
      document.removeEventListener('keydown', onKey, true);
      resolve(result);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close(null);
      else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        shapes.pop();
        paint();
      }
    };
    cancel.addEventListener('click', () => close(null));
    done.addEventListener('click', () => {
      if (!shapes.length) return close(null);
      let url = canvas.toDataURL('image/png');
      // 5MB 를 넘으면 JPG 로 줄인다
      if ((url.length * 3) / 4 > MAX_BYTES) url = canvas.toDataURL('image/jpeg', 0.88);
      close(url);
    });
    document.addEventListener('keydown', onKey, true);
    document.body.appendChild(overlay);
    paint();
    done.focus();
  });
}
