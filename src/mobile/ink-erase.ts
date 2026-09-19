// 笔画级橡皮（自建）。
//
// 为什么必须自建：实测确认 pdf.js 的编辑器源码里 `eraser|Eraser|ERASER` 零命中 ——
// 内置墨迹引擎只有「画」和「整体删除注释」，没有笔画级擦除。而橡皮是刚需。
//
// 实现路径（关键设计决策）：全程只走公开契约，不碰任何 #private 字段。
//   1. editor.serialize() 给出的 paths.lines 本身就是「一条笔画一项」的数组；
//   2. 命中检测在裁剪后的点集上自算（pdf.js 没有 isHit，实测 editor.js / draw.js 均零命中）；
//   3. 裁掉目标笔画后，用 InkEditor.deserialize() 重建编辑器。
//
// 之所以强调「不碰 private」：InkEditor 的笔画集合是真正的 ES private field
// （`#drawOutlines`，不出现在 Object.getOwnPropertyNames 里），拿不到也改不了。
// 而 serialize/deserialize 是稳定契约 —— 这让本模块对 Obsidian 升级（风险 R5）更鲁棒。
//
// 0.2.0 三种擦除模式（对齐 GoodNotes）：
//   · stroke 笔画擦除 —— 触到哪笔删哪笔（整笔消失）。
//     0.1.0 只擦「最近的一笔」是灵敏度差的主因之一：快速拖过多笔时
//     每个采样点只带走一笔。现在一次命中半径内的**全部**笔画。
//   · pixel  像素擦除 —— 橡皮圆盘扫过处把折线切开，保留盘外线段。
//     切割点取线段与圆盘边界的交点（解析解，非采样），切口干净。
//   · select 选区擦除 —— 拖一个矩形，与矩形相交的笔画整笔删除。
//
// 三种模式共用同一套「删旧 → deserialize 重建 → layer.add」的契约重建流程。

import type { InkEngine } from './ink-engine';

/** PDF 用户空间坐标（原点左下，与 serialize() 的 lines 同一坐标系）。 */
export interface PdfPoint {
	pageIndex: number;
	x: number;
	y: number;
}

/** 擦除模式。 */
export type EraseMode = 'pixel' | 'stroke' | 'select';

export interface EraseOutcome {
	/** 是否真的改变了什么（没有命中时为 false）。 */
	changed: boolean;
	/** 擦掉的笔画数。 */
	removedStrokes: number;
	/** 被整体删除的注释数（该注释的所有笔画都被擦掉时）。 */
	removedEditors: number;
	/** 重建后的编辑器数。 */
	rebuiltEditors: number;
	error?: string;
}

/** 点到线段的距离。 */
function distToSegment(px: number, py: number, x1: number, y1: number, x2: number, y2: number): number {
	const dx = x2 - x1;
	const dy = y2 - y1;
	const lenSq = dx * dx + dy * dy;
	if (lenSq === 0) return Math.hypot(px - x1, py - y1);
	let t = ((px - x1) * dx + (py - y1) * dy) / lenSq;
	t = Math.max(0, Math.min(1, t));
	return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

/**
 * 点到折线的最短距离。
 *
 * 点集格式为 [x1,y1,x2,y2,...]，且实测前若干个点可能是 NaN（pdf.js 内部 padding），
 * 因此逐段判有限性、遇到非法点直接跳过。
 */
export function distToPolyline(pts: ArrayLike<number>, px: number, py: number): number {
	let best = Infinity;
	for (let i = 0; i + 3 < pts.length; i += 2) {
		const x1 = pts[i];
		const y1 = pts[i + 1];
		const x2 = pts[i + 2];
		const y2 = pts[i + 3];
		if (!Number.isFinite(x1) || !Number.isFinite(y1) || !Number.isFinite(x2) || !Number.isFinite(y2)) continue;
		const d = distToSegment(px, py, x1, y1, x2, y2);
		if (d < best) best = d;
	}
	return best;
}

/* ============================ 像素切割 ============================ */

/** 把折线里的非法点（NaN padding）滤掉，返回连续点对列表。 */
function finitePoints(pts: ArrayLike<number>): Array<[number, number]> {
	const out: Array<[number, number]> = [];
	for (let i = 0; i + 1 < pts.length; i += 2) {
		const x = pts[i];
		const y = pts[i + 1];
		if (Number.isFinite(x) && Number.isFinite(y)) out.push([x, y]);
	}
	return out;
}

/**
 * 用橡皮圆盘切割折线，返回落在盘外的线段（若干子折线）。
 *
 * 几何：对每条线段解 |A + t·d − C| = r 的二次方程取 [0,1] 内的根，
 * 得到进/出圆盘的精确参数 t，在交点处断开。切口是解析解，不是采样近似。
 *
 * 返回空数组表示整笔都在盘内（应整笔删除）。
 */
export function cutPolylineByDisk(
	pts: ArrayLike<number>,
	cx: number,
	cy: number,
	r: number,
): Float32Array[] {
	const points = finitePoints(pts);
	if (points.length < 2) return [];

	const pieces: Float32Array[] = [];
	let cur: number[] = [];

	const inside = (x: number, y: number): boolean => Math.hypot(x - cx, y - cy) < r;
	const pushPiece = (): void => {
		if (cur.length >= 4) pieces.push(Float32Array.from(cur));
		cur = [];
	};

	// 线段与圆的交点参数（[0,1] 内，升序）。无交点返回 []。
	const crossings = (ax: number, ay: number, bx: number, by: number): number[] => {
		const dx = bx - ax;
		const dy = by - ay;
		const fx = ax - cx;
		const fy = ay - cy;
		const a = dx * dx + dy * dy;
		if (a === 0) return [];
		const b = 2 * (fx * dx + fy * dy);
		const c = fx * fx + fy * fy - r * r;
		const disc = b * b - 4 * a * c;
		if (disc < 0) return [];
		const sq = Math.sqrt(disc);
		const roots = [(-b - sq) / (2 * a), (-b + sq) / (2 * a)].filter((t) => t >= 0 && t <= 1);
		return roots.sort((m, n) => m - n);
	};

	for (let i = 0; i + 1 < points.length; i++) {
		const [ax, ay] = points[i];
		const [bx, by] = points[i + 1];
		const aIn = inside(ax, ay);
		const bIn = inside(bx, by);
		const at = (t: number): [number, number] => [ax + (bx - ax) * t, ay + (by - ay) * t];

		if (aIn && bIn) {
			// 整段在盘内：当前子折线到此为止
			pushPiece();
			continue;
		}

		if (!aIn && !bIn) {
			const roots = crossings(ax, ay, bx, by);
			if (roots.length >= 2) {
				// 线段穿过圆盘：外 → 内 → 外
				if (cur.length === 0) cur.push(ax, ay);
				const [x1, y1] = at(roots[0]);
				cur.push(x1, y1);
				pushPiece();
				const [x2, y2] = at(roots[roots.length - 1]);
				cur.push(x2, y2, bx, by);
			} else {
				// 整段在盘外
				if (cur.length === 0) cur.push(ax, ay);
				cur.push(bx, by);
			}
			continue;
		}

		if (aIn && !bIn) {
			// 从盘内穿出：在出点断开
			const roots = crossings(ax, ay, bx, by);
			const tExit = roots.length ? roots[roots.length - 1] : 1;
			const [x, y] = at(tExit);
			cur.push(x, y);
			pushPiece();
			continue;
		}

		// !aIn && bIn：从盘外穿入：从入点起一段新的子折线
		const roots = crossings(ax, ay, bx, by);
		const tEnter = roots.length ? roots[0] : 0;
		const [x, y] = at(tEnter);
		cur.push(x, y, bx, by);
	}
	pushPiece();

	return pieces;
}

/* ============================ 矩形相交 ============================ */

function segmentsCross(
	p1x: number, p1y: number, p2x: number, p2y: number,
	q1x: number, q1y: number, q2x: number, q2y: number,
): boolean {
	const d1 = (q2x - q1x) * (p1y - q1y) - (q2y - q1y) * (p1x - q1x);
	const d2 = (q2x - q1x) * (p2y - q1y) - (q2y - q1y) * (p2x - q1x);
	const d3 = (p2x - p1x) * (q1y - p1y) - (p2y - p1y) * (q1x - p1x);
	const d4 = (p2x - p1x) * (q2y - p1y) - (p2y - p1y) * (q2x - p1x);
	return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

/** 点是否落在线段上（含端点；共线 + 区间判定）。 */
function pointOnSegment(px: number, py: number, x1: number, y1: number, x2: number, y2: number): boolean {
	const cross = (x2 - x1) * (py - y1) - (y2 - y1) * (px - x1);
	if (Math.abs(cross) > 1e-9) return false;
	const dot = (px - x1) * (px - x2) + (py - y1) * (py - y2);
	return dot <= 1e-9;
}

/** 线段是否与矩形相交（端点落在矩形内，或与任一条边相交，或穿过顶点）。 */
export function segmentIntersectsRect(
	x1: number, y1: number, x2: number, y2: number,
	rect: { minX: number; minY: number; maxX: number; maxY: number },
): boolean {
	if (x1 >= rect.minX && x1 <= rect.maxX && y1 >= rect.minY && y1 <= rect.maxY) return true;
	if (x2 >= rect.minX && x2 <= rect.maxX && y2 >= rect.minY && y2 <= rect.maxY) return true;
	if (
		segmentsCross(x1, y1, x2, y2, rect.minX, rect.minY, rect.maxX, rect.minY) ||
		segmentsCross(x1, y1, x2, y2, rect.maxX, rect.minY, rect.maxX, rect.maxY) ||
		segmentsCross(x1, y1, x2, y2, rect.maxX, rect.maxY, rect.minX, rect.maxY) ||
		segmentsCross(x1, y1, x2, y2, rect.minX, rect.maxY, rect.minX, rect.minY)
	) {
		return true;
	}
	// 线段恰好穿过矩形顶点（如对角线）时严格相交判定会漏，补顶点在线检查
	return (
		pointOnSegment(rect.minX, rect.minY, x1, y1, x2, y2) ||
		pointOnSegment(rect.maxX, rect.maxY, x1, y1, x2, y2) ||
		pointOnSegment(rect.maxX, rect.minY, x1, y1, x2, y2) ||
		pointOnSegment(rect.minX, rect.maxY, x1, y1, x2, y2)
	);
}

/* ============================ 坐标换算 ============================ */

/**
 * 把视口坐标换算成 PDF 用户空间坐标。
 *
 * 之所以要翻转 y：serialize() 的 lines 用的是 PDF 用户空间（原点左下），而 DOM 是原点左上。
 * 该换算已用实测数据校准过（三笔的 yMean 与落点换算误差 < 3pt）。
 *
 * 页面带旋转时返回 null —— 不做旋转页的擦除，宁可拒绝也不要擦错位置。
 */
export function toPdfPoint(
	engine: InkEngine,
	clientX: number,
	clientY: number,
	pageNumber: number,
): PdfPoint | null {
	const pageEl = engine.getPageElement(pageNumber);
	if (!pageEl) return null;

	// 旋转页的坐标映射与下面这套线性换算不同，直接放弃（调用方会静默跳过）。
	const rotation = Number(pageEl.dataset.rotate ?? '0');
	if (Number.isFinite(rotation) && rotation % 360 !== 0) return null;

	const rect = pageEl.getBoundingClientRect();
	if (rect.width <= 0 || rect.height <= 0) return null;

	const scale = engine.getScaleFactor();
	const x = (clientX - rect.left) / scale;
	const y = rect.height / scale - (clientY - rect.top) / scale;

	return { pageIndex: pageNumber - 1, x, y };
}

/* ============================ 擦除实现 ============================ */

/** 命中半径：给用户传入的橡皮粗细放宽容错（×1.25，且不小于 10pt）。 */
function hitRadius(radius: number | undefined): number {
	return Math.max(10, (radius ?? 12) * 1.25);
}

/** 单个编辑器的「擦后数据」：剩余笔画列表 + 是否有改动。 */
interface EditorCut {
	editor: any;
	serial: any;
	remainingLines: Float32Array[];
	removed: number;
}

/**
 * 在指定页、按给定模式做一次点状擦除。
 *
 * 一次调用处理**所有**命中半径内的笔画（0.1.0 只擦最近一笔是灵敏度差的主因）：
 * 每个受影响的编辑器只做一次「删旧 → 重建」，拖动过程中的多次调用天然合并。
 */
export async function eraseAtPoint(
	engine: InkEngine,
	point: PdfPoint,
	options: { radius?: number; mode?: 'pixel' | 'stroke' } = {},
): Promise<EraseOutcome> {
	const none: EraseOutcome = { changed: false, removedStrokes: 0, removedEditors: 0, rebuiltEditors: 0 };

	const um = engine.getUIManager();
	const layer = engine.getLayer(point.pageIndex);
	if (!um || !layer) return { ...none, error: '引擎未就绪' };

	const mode = options.mode ?? 'stroke';
	const eraserRadius = hitRadius(options.radius);

	const editors = engine.getEditors(point.pageIndex).filter(
		(e) => (e?.constructor?._type ?? e?.constructor?.type) === 'ink',
	);
	if (!editors.length) return none;

	/* ---------- 计算每个编辑器的擦后数据 ---------- */
	const cuts: EditorCut[] = [];
	for (const editor of editors) {
		let serial: any;
		try {
			serial = editor.serialize();
		} catch {
			continue;
		}
		const lines: ArrayLike<number>[] = serial?.paths?.lines ?? [];
		if (!lines.length) continue;

		const remainingLines: Float32Array[] = [];
		let removed = 0;

		for (const line of lines) {
			if (mode === 'pixel') {
				const pieces = cutPolylineByDisk(line, point.x, point.y, eraserRadius);
				if (pieces.length === 0) {
					removed++; // 整笔都在盘内
					continue;
				}
				// 圆盘没真正切到时，切割结果与原笔逐点相同（长度等于有限点数）
				const finiteLen = finitePoints(line).length * 2;
				const total = pieces.reduce((s, p) => s + p.length, 0);
				if (pieces.length === 1 && total >= finiteLen) {
					remainingLines.push(pieces[0]); // 未切到，原样保留，避免无效重建
				} else {
					removed++;
					remainingLines.push(...pieces);
				}
			} else {
				const d = distToPolyline(line, point.x, point.y);
				if (Number.isFinite(d) && d <= eraserRadius) {
					removed++; // 笔画擦除：触到即整笔消失
				} else {
					remainingLines.push(new Float32Array(line as any));
				}
			}
		}

		if (removed > 0) cuts.push({ editor, serial, remainingLines, removed });
	}

	if (!cuts.length) return none;

	/* ---------- 逐编辑器执行「删旧 → 重建」 ---------- */
	let removedStrokes = 0;
	let removedEditors = 0;
	let rebuiltEditors = 0;
	let firstError: string | undefined;

	for (const cut of cuts) {
		removedStrokes += cut.removed;
		try {
			engine.select(cut.editor);
			engine.deleteSelected();
		} catch (err) {
			firstError ??= err instanceof Error ? err.message : String(err);
			continue;
		}

		if (!cut.remainingLines.length) {
			removedEditors++; // 所有笔画都擦掉了，注释整体消失
			continue;
		}

		const rebuiltData: any = {
			...cut.serial,
			paths: { lines: cut.remainingLines },
		};
		// 丢掉身份，让它以「新建编辑器」的身份重新入库。
		// 注意：points 数组同步省略 —— 0.1.0 的笔画擦除已验证 deserialize 不依赖它，
		// 且像素切割后的子折线与原 points 无法逐点对应。
		delete rebuiltData.id;
		delete rebuiltData.annotationElementId;

		const Editor = cut.editor.constructor;
		try {
			const rebuilt = await Editor.deserialize(rebuiltData, layer, um);
			if (rebuilt) {
				try {
					// 必须走 layer.add()：AnnotationStorage 的写入在它内部完成
					// （um.addEditor() 只把编辑器登记进 #allEditors，不落存储 —— 实测踩过）。
					layer.add(rebuilt);
				} catch {
					try {
						um.addEditor(rebuilt);
					} catch {
						/* 两种都失败时，笔画已被删除，至少是安全的一侧 */
					}
				}
				rebuiltEditors++;
			}
		} catch (err) {
			firstError ??= err instanceof Error ? err.message : String(err);
		}
	}

	return {
		changed: removedStrokes > 0,
		removedStrokes,
		removedEditors,
		rebuiltEditors,
		...(firstError ? { error: firstError } : {}),
	};
}

/**
 * 选区擦除：删除与矩形相交的所有笔画（整笔消失，GoodNotes 的「选区擦除」语义）。
 *
 * rect 为该页 PDF 用户空间坐标（调用方负责把屏幕拖选矩形换算过来）。
 */
export async function eraseInRect(
	engine: InkEngine,
	pageIndex: number,
	rect: { minX: number; minY: number; maxX: number; maxY: number },
): Promise<EraseOutcome> {
	const none: EraseOutcome = { changed: false, removedStrokes: 0, removedEditors: 0, rebuiltEditors: 0 };

	const um = engine.getUIManager();
	const layer = engine.getLayer(pageIndex);
	if (!um || !layer) return { ...none, error: '引擎未就绪' };

	const editors = engine.getEditors(pageIndex).filter(
		(e) => (e?.constructor?._type ?? e?.constructor?.type) === 'ink',
	);

	const cuts: EditorCut[] = [];
	for (const editor of editors) {
		let serial: any;
		try {
			serial = editor.serialize();
		} catch {
			continue;
		}
		const lines: ArrayLike<number>[] = serial?.paths?.lines ?? [];
		if (!lines.length) continue;

		const remainingLines: Float32Array[] = [];
		let removed = 0;
		for (const line of lines) {
			let hit = false;
			for (let i = 0; i + 3 < line.length && !hit; i += 2) {
				const x1 = line[i];
				const y1 = line[i + 1];
				const x2 = line[i + 2];
				const y2 = line[i + 3];
				if (!Number.isFinite(x1) || !Number.isFinite(y1) || !Number.isFinite(x2) || !Number.isFinite(y2)) continue;
				if (segmentIntersectsRect(x1, y1, x2, y2, rect)) hit = true;
			}
			if (hit) removed++;
			else remainingLines.push(new Float32Array(line as any));
		}
		if (removed > 0) cuts.push({ editor, serial, remainingLines, removed });
	}

	if (!cuts.length) return none;

	let removedStrokes = 0;
	let removedEditors = 0;
	let rebuiltEditors = 0;
	let firstError: string | undefined;

	for (const cut of cuts) {
		removedStrokes += cut.removed;
		try {
			engine.select(cut.editor);
			engine.deleteSelected();
		} catch (err) {
			firstError ??= err instanceof Error ? err.message : String(err);
			continue;
		}
		if (!cut.remainingLines.length) {
			removedEditors++;
			continue;
		}
		const rebuiltData: any = { ...cut.serial, paths: { lines: cut.remainingLines } };
		delete rebuiltData.id;
		delete rebuiltData.annotationElementId;
		const Editor = cut.editor.constructor;
		try {
			const rebuilt = await Editor.deserialize(rebuiltData, layer, um);
			if (rebuilt) {
				try {
					layer.add(rebuilt);
				} catch {
					try {
						um.addEditor(rebuilt);
					} catch {
						/* 同上兜底 */
					}
				}
				rebuiltEditors++;
			}
		} catch (err) {
			firstError ??= err instanceof Error ? err.message : String(err);
		}
	}

	return {
		changed: removedStrokes > 0,
		removedStrokes,
		removedEditors,
		rebuiltEditors,
		...(firstError ? { error: firstError } : {}),
	};
}

/**
 * 擦除一整条注释（该页所有墨迹注释，或指定的那一条）。
 * 用于「清空本页手写」以及橡皮的兜底行为。
 */
export function eraseEntireEditors(engine: InkEngine, pageIndex: number): EraseOutcome {
	const editors = engine.getEditors(pageIndex).filter(
		(e) => (e?.constructor?._type ?? e?.constructor?.type) === 'ink',
	);
	if (!editors.length) return { changed: false, removedStrokes: 0, removedEditors: 0, rebuiltEditors: 0 };
	let removed = 0;
	for (const editor of editors) {
		engine.select(editor);
		const r = engine.deleteSelected();
		if (r.ok) removed++;
	}
	return { changed: removed > 0, removedStrokes: 0, removedEditors: removed, rebuiltEditors: 0 };
}
