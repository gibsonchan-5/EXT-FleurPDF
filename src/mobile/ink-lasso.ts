// 套索：圈选墨迹笔画并移动（参考 GoodNotes / Notability 的套索笔）。
//
// 与 ink-erase.ts 同一设计原则：全程只走公开契约（serialize(true) / deserialize /
// layer.add / um.toggleSelected），不碰任何 #private 字段 —— 对 Obsidian 升级鲁棒。
//
// ⚠️ 0.4.4 修正：数据源统一换成 readInkGeometry()（内部 `serialize(true)`）。
// 旧的 `editor.serialize()` 对「文件固有且用户没改过」的编辑器恒返回 null，
// 于是历史笔迹的包围盒算不出来、多边形命中测试也拿不到笔画 ——
// 真机表现是「套索圈不中之前的笔迹、也拖不动」。根因详见 ink-engine.ts。
//
// 三个能力：
//   1. lassoHitEditors  —— 多边形命中测试（包围盒粗筛 + 点在多边形内 / 线段相交细判）；
//   2. moveEditorBy     —— 把一个编辑器的全部笔画平移 (dx, dy)（删旧建新，契约重建）；
//   3. screenBBoxOfEditors —— 选择集的屏幕包围盒（判断「拖动起点是否在选择内」）。
//
// 坐标系备忘：serialize() 的 lines 用 PDF 用户空间（原点左下，y 向上），
// DOM 是原点左上。屏幕向右下拖动 (dxPx, dyPx) ⇒ PDF 位移 (+dxPx/scale, -dyPx/scale)。

import { mintStrokeId, readInkGeometry, stripInkIdentity, type InkEngine } from './ink-engine';
import { toPdfPoint, type PdfPoint } from './ink-erase';

/** 视口坐标点。 */
export interface ScreenPoint {
	x: number;
	y: number;
}

/* ============================ 几何基元 ============================ */

/** 射线法：点是否在多边形内（poly 为闭合环，无需重复首点）。 */
export function pointInPolygon(px: number, py: number, poly: ScreenPoint[]): boolean {
	let inside = false;
	for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
		const xi = poly[i].x;
		const yi = poly[i].y;
		const xj = poly[j].x;
		const yj = poly[j].y;
		const crosses = yi > py !== yj > py;
		if (!crosses) continue;
		const xAt = xi + ((py - yi) * (xj - xi)) / (yj - yi);
		if (px < xAt) inside = !inside;
	}
	return inside;
}

/** 线段 p1p2 与 q1q2 是否相交（严格相交，不含共线重叠的边界情形 —— 足够套索用）。 */
export function segmentsIntersect(
	p1x: number, p1y: number, p2x: number, p2y: number,
	q1x: number, q1y: number, q2x: number, q2y: number,
): boolean {
	const d1 = cross(q1x, q1y, q2x, q2y, p1x, p1y);
	const d2 = cross(q1x, q1y, q2x, q2y, p2x, p2y);
	const d3 = cross(p1x, p1y, p2x, p2y, q1x, q1y);
	const d4 = cross(p1x, p1y, p2x, p2y, q2x, q2y);
	return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

function cross(ax: number, ay: number, bx: number, by: number, cx: number, cy: number): number {
	return (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
}

/** 笔画（一条折线）是否被多边形选中：任一点落在内部，或任一线段与多边形边相交。 */
export function strokeInPolygon(pts: ArrayLike<number>, poly: ScreenPoint[]): boolean {
	if (poly.length < 3) return false;
	let hasFinite = false;
	for (let i = 0; i + 1 < pts.length; i += 2) {
		const x = pts[i];
		const y = pts[i + 1];
		if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
		hasFinite = true;
		if (pointInPolygon(x, y, poly)) return true;
	}
	if (!hasFinite) return false;
	for (let i = 0; i + 3 < pts.length; i += 2) {
		const x1 = pts[i];
		const y1 = pts[i + 1];
		const x2 = pts[i + 2];
		const y2 = pts[i + 3];
		if (!Number.isFinite(x1) || !Number.isFinite(y1) || !Number.isFinite(x2) || !Number.isFinite(y2)) continue;
		for (let j = 0, k = poly.length - 1; j < poly.length; k = j++) {
			if (segmentsIntersect(x1, y1, x2, y2, poly[k].x, poly[k].y, poly[j].x, poly[j].y)) return true;
		}
	}
	return false;
}

/* ============================ 命中测试 ============================ */

/** 编辑器序列化后的包围盒（PDF 坐标），用于粗筛与屏幕换算。 */
export function editorBBox(editor: any): { minX: number; minY: number; maxX: number; maxY: number } | null {
	// readInkGeometry 内部走 serialize(true)，对固有笔迹同样有效
	const geom = readInkGeometry(editor);
	if (!geom) return null;

	let minX = Infinity;
	let minY = Infinity;
	let maxX = -Infinity;
	let maxY = -Infinity;
	for (const line of geom.lines) {
		for (let i = 0; i + 1 < line.length; i += 2) {
			const x = line[i];
			const y = line[i + 1];
			if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
			if (x < minX) minX = x;
			if (y < minY) minY = y;
			if (x > maxX) maxX = x;
			if (y > maxY) maxY = y;
		}
	}
	if (!Number.isFinite(minX)) return null;
	return { minX, minY, maxX, maxY };
}

/**
 * 圈选命中：返回多边形框住的墨迹编辑器（整条注释为粒度 —— 与橡皮的
 * 「笔画级」不同，套索移动的最小单位是注释）。
 *
 * 判定规则：注释的任一笔画被多边形选中（点在内或线段相交），该注释即入选。
 */
export function lassoHitEditors(engine: InkEngine, pageIndex: number, poly: ScreenPoint[]): any[] {
	const editors = engine.getEditors(pageIndex).filter(
		(e) => (e?.constructor?._type ?? e?.constructor?.type) === 'ink',
	);
	const hits: any[] = [];
	for (const editor of editors) {
		// 粗筛：注释包围盒与多边形包围盒无交集直接跳过
		const box = editorBBox(editor);
		if (!box) continue;
		const polyMinX = Math.min(...poly.map((p) => p.x));
		const polyMaxX = Math.max(...poly.map((p) => p.x));
		const polyMinY = Math.min(...poly.map((p) => p.y));
		const polyMaxY = Math.max(...poly.map((p) => p.y));
		if (box.maxX < polyMinX || box.minX > polyMaxX || box.maxY < polyMinY || box.minY > polyMaxY) continue;

		// 细判：逐笔画做点在多边形内 / 线段相交测试
		const geom = readInkGeometry(editor);
		if (!geom) continue;
		if (geom.lines.some((line) => strokeInPolygon(line, poly))) hits.push(editor);
	}
	return hits;
}

/* ============================ 平移重建 ============================ */

/**
 * 把一个编辑器的全部笔画平移 (dx, dy)（PDF 坐标）。
 *
 * 路径与橡皮的重建一致：serialize → 修改点集 → 删旧（select + deleteSelected）→
 * deserialize 重建 → layer.add() 入库。删旧建新而非原地改 —— InkEditor 的
 * 笔画集合是 ES private field，改不动；契约重建是被实测验证过的路。
 */
export async function moveEditorBy(
	engine: InkEngine,
	editor: any,
	dx: number,
	dy: number,
): Promise<{ ok: boolean; rebuilt: any | null; error?: string }> {
	const um = engine.getUIManager();
	const pageIndex = Number(editor?.pageIndex ?? 0);
	const layer = engine.getLayer(pageIndex);
	if (!um || !layer) return { ok: false, rebuilt: null, error: '引擎未就绪' };

	let geom;
	try {
		// serialize(true)：固有笔迹也拿得到（serialize() 对它们恒为 null）
		geom = readInkGeometry(editor);
	} catch (err) {
		return { ok: false, rebuilt: null, error: err instanceof Error ? err.message : String(err) };
	}
	if (!geom) return { ok: false, rebuilt: null, error: '编辑器没有笔画' };
	const lines = geom.lines;

	const shiftLine = (line: ArrayLike<number>): Float32Array => {
		const out = new Float32Array(line.length);
		for (let i = 0; i + 1 < line.length; i += 2) {
			out[i] = Number(line[i]) + dx;
			out[i + 1] = Number(line[i + 1]) + dy;
		}
		// 尾部奇数长度兜底（理论不会出现，防御性拷贝）
		for (let i = line.length - (line.length % 2); i < line.length; i++) out[i] = Number(line[i]);
		return out;
	};

	const pointsRaw: ArrayLike<number>[] | undefined = geom.points.length ? geom.points : undefined;
	const rebuiltData: any = stripInkIdentity({
		...geom.data,
		paths: {
			lines: lines.map(shiftLine),
			...(pointsRaw ? { points: pointsRaw.map(shiftLine) } : {}),
		},
	});
	// rect 若存在则同步平移（保持注释框一致）
	if (geom.rect) {
		rebuiltData.rect = [geom.rect[0] + dx, geom.rect[1] + dy, geom.rect[2] + dx, geom.rect[3] + dy];
	}

	// 删旧：select() 内部会先 unselectAll 再 toggle，逐个处理即可
	try {
		engine.select(editor);
		engine.deleteSelected();
	} catch (err) {
		return { ok: false, rebuilt: null, error: err instanceof Error ? err.message : String(err) };
	}

	const Editor = editor.constructor;
	try {
		const rebuilt = await Editor.deserialize(rebuiltData, layer, um);
		if (rebuilt) {
			// ★ 必须补 id：见 ink-engine 的 strokeId 长注释。缺了它，多次重建会把彼此
			// 从 UIManager 的编辑器表里挤掉（共用 undefined 键），结局是「擦一笔，别的笔迹跟着消失」。
			rebuilt.id = mintStrokeId();
			try {
				layer.add(rebuilt);
			} catch {
				try {
					um.addEditor(rebuilt);
				} catch {
					/* 与橡皮同款兜底：至少旧笔画已删 */
				}
			}
		}
		return { ok: true, rebuilt };
	} catch (err) {
		return { ok: false, rebuilt: null, error: err instanceof Error ? err.message : String(err) };
	}
}

/* ============================ 屏幕坐标辅助 ============================ */

/**
 * 编辑器选择集的屏幕包围盒（用于「拖动起点是否在选择内」的判定）。
 * editor.div 是 pdf.js 编辑器的真实 DOM 节点（普通属性，minify 不改名）。
 */
export function screenBBoxOfEditors(editors: any[]): {
	minX: number;
	minY: number;
	maxX: number;
	maxY: number;
} | null {
	let minX = Infinity;
	let minY = Infinity;
	let maxX = -Infinity;
	let maxY = -Infinity;
	for (const editor of editors) {
		const div: HTMLElement | null = editor?.div ?? null;
		if (!div?.isConnected) continue;
		const r = div.getBoundingClientRect();
		if (r.width === 0 && r.height === 0) continue;
		if (r.left < minX) minX = r.left;
		if (r.top < minY) minY = r.top;
		if (r.right > maxX) maxX = r.right;
		if (r.bottom > maxY) maxY = r.bottom;
	}
	if (!Number.isFinite(minX)) return null;
	return { minX, minY, maxX, maxY };
}

/** 把一圈屏幕坐标点整体换算到某一页的 PDF 坐标。任一点换算失败返回 null。 */
export function lassoPolyToPdf(
	engine: InkEngine,
	poly: ScreenPoint[],
	pageNumber: number,
): PdfPoint[] | null {
	const out: PdfPoint[] = [];
	for (const p of poly) {
		const pt = toPdfPoint(engine, p.x, p.y, pageNumber);
		if (!pt) return null;
		out.push(pt);
	}
	return out;
}
