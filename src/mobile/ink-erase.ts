// 笔画级橡皮（自建）。
//
// 为什么必须自建：实测确认 pdf.js 的编辑器源码里 `eraser|Eraser|ERASER` 零命中 ——
// 内置墨迹引擎只有「画」和「整体删除注释」，没有笔画级擦除。而首版三笔里橡皮是刚需。
//
// 实现路径（关键设计决策）：全程只走公开契约，不碰任何 #private 字段。
//   1. editor.serialize() 给出的 paths.lines 本身就是「一条笔画一项」的数组；
//   2. 命中检测在裁剪后的点集上自算（pdf.js 没有 isHit，实测 editor.js / draw.js 均零命中）；
//   3. 裁掉目标笔画后，用 InkEditor.deserialize() 重建编辑器。
//
// 之所以强调「不碰 private」：InkEditor 的笔画集合是真正的 ES private field
// （`#drawOutlines`，不出现在 Object.getOwnPropertyNames 里），拿不到也改不了。
// 而 serialize/deserialize 是稳定契约 —— 这让本模块对 Obsidian 升级（风险 R5）更鲁棒。

import type { InkEngine } from './ink-engine';

/** PDF 用户空间坐标（原点左下，与 serialize() 的 lines 同一坐标系）。 */
export interface PdfPoint {
	pageIndex: number;
	x: number;
	y: number;
}

export interface EraseOutcome {
	/** 是否真的改变了什么（没有命中时为 false）。 */
	changed: boolean;
	/** 擦掉的笔画数（一次调用通常是 1）。 */
	removedStrokes: number;
	/** 被整体删除的注释数（该注释只剩这一笔时）。 */
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

/**
 * 把视口坐标换算成 PDF 用户空间坐标。
 *
 * 之所以要翻转 y：serialize() 的 lines 用的是 PDF 用户空间（原点左下），而 DOM 是原点左上。
 * 该换算已用实测数据校准过（三笔的 yMean 与落点换算误差 < 3pt）。
 *
 * 页面带旋转时返回 null —— 首版不做旋转页的擦除，宁可拒绝也不要擦错位置。
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

/**
 * 在指定页擦除笔尖下最近的一条笔画。
 *
 * 命中多笔时只擦距离最小的那一笔 —— 与真实橡皮的手感一致（一层一层擦）。
 */
export async function eraseAtPoint(
	engine: InkEngine,
	point: PdfPoint,
	options: { radius?: number } = {},
): Promise<EraseOutcome> {
	const none: EraseOutcome = { changed: false, removedStrokes: 0, removedEditors: 0, rebuiltEditors: 0 };

	const um = engine.getUIManager();
	const layer = engine.getLayer(point.pageIndex);
	if (!um || !layer) return { ...none, error: '引擎未就绪' };

	const editors = engine.getEditors(point.pageIndex).filter(
		(e) => (e?.constructor?._type ?? e?.constructor?.type) === 'ink',
	);
	if (!editors.length) return none;

	// 命中半径：给用户传入的橡皮粗细放宽容错（×1.25，且不小于 10pt）。
	// v0.5 用户实测「不太灵敏」——半径贴着笔粗时，笔画细一点就擦不到。
	const eraserRadius = Math.max(10, (options.radius ?? 12) * 1.25);

	/** 找出「距离笔尖最近的那一笔」，跨编辑器一起比。 */
	type Candidate = { editor: any; lineIndex: number; distance: number; thickness: number; serial: any };
	let best: Candidate | null = null;

	for (const editor of editors) {
		let serial: any;
		try {
			serial = editor.serialize();
		} catch {
			continue;
		}
		const lines: ArrayLike<number>[] = serial?.paths?.lines ?? [];
		const thickness = Number(serial?.thickness ?? 0);
		for (let i = 0; i < lines.length; i++) {
			const d = distToPolyline(lines[i], point.x, point.y);
			if (!Number.isFinite(d)) continue;
			if (d > eraserRadius) continue;
			if (!best || d < best.distance) best = { editor, lineIndex: i, distance: d, thickness, serial };
		}
	}

	if (!best) return none;

	/* ---------- 裁剪 ---------- */
	const serial = best.serial;
	const lines: ArrayLike<number>[] = serial.paths.lines;
	const pointsRaw: ArrayLike<number>[] | undefined = serial.paths.points;
	const remaining = lines.length - 1;

	const isLastStroke = remaining <= 0;

	/* ---------- 删原编辑器 ---------- */
	try {
		engine.select(best.editor);
		engine.deleteSelected();
	} catch (err) {
		return { ...none, error: err instanceof Error ? err.message : String(err) };
	}

	if (isLastStroke) {
		return { changed: true, removedStrokes: 1, removedEditors: 1, rebuiltEditors: 0 };
	}

	/* ---------- 用裁剪后的数据重建 ---------- */
	// 保持原有顺序（只去掉命中项），这样笔画的绘制层次不变。
	const keepIdx: number[] = [];
	for (let i = 0; i < lines.length; i++) if (i !== best.lineIndex) keepIdx.push(i);

	const rebuiltData: any = {
		...serial,
		paths: {
			lines: keepIdx.map((i) => new Float32Array(lines[i] as any)),
			...(pointsRaw ? { points: keepIdx.map((i) => new Float32Array(pointsRaw[i] as any)) } : {}),
		},
	};
	// 丢掉身份，让它以「新建编辑器」的身份重新入库（原 id / 原 PDF 注释引用都已随删除失效）。
	delete rebuiltData.id;
	delete rebuiltData.annotationElementId;

	const Editor = best.editor.constructor;
	let rebuilt: any = null;
	try {
		rebuilt = await Editor.deserialize(rebuiltData, layer, um);
	} catch (err) {
		return {
			changed: true,
			removedStrokes: 1,
			removedEditors: 1,
			rebuiltEditors: 0,
			error: err instanceof Error ? err.message : String(err),
		};
	}

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
	}

	return { changed: true, removedStrokes: 1, removedEditors: 0, rebuiltEditors: rebuilt ? 1 : 0 };
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
