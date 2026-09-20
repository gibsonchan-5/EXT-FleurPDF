// 内置 pdf.js 墨迹引擎的接入层（移动端手写批注的「落墨 + 落盘」通道）。
//
// 依据：v0.3 方案文档的 R1 实测（离线复现法，17 项断言全绿）确认 ——
//   · Obsidian 内置的 pdf.js 5.3.34 携带完整墨迹引擎，可用一行 annotationEditorMode 零侵入激活；
//   · 不激活时编辑层为 `disabled`、0×0、pointer-events:none，对桌面端完全惰性；
//   · 落盘产出的是业界通用的 /Subtype /Ink 注释，Adobe / PDF Expert / 系统预览都能看到。
//
// 本模块把那条链路封装成幂等、可降级的 API，并收口实测踩出来的四个「会让人误判功能不存在」的陷阱：
//   1. um.getEditors() 必须传 pageIndex，不传恒返回 []（内部是 `editor.pageIndex === pageIndex`）；
//   2. AnnotationStorage.serializable.map 是 Map，不是普通对象（Object.keys 恒为 []）；
//   3. updateParams / delete 只作用于「选择集」，改单个编辑器要 um.setSelected(e)（e.select() 不够）；
//   4. supportMultipleDrawings=true 时 pointerup 不生成编辑器，必须显式 commitOrRemove() 或切模式。
//
// 另有一个参数分流的坑（本轮实测新发现）：
//   荧光笔的「新笔默认色」参数是 HIGHLIGHT_DEFAULT_COLOR(32)，不是 HIGHLIGHT_COLOR(31)。
//   31 只作用于「已选中」的编辑器，且 HighlightEditor.updateDefaultParams 里没有 31 的分支，
//   经 um.updateParams 下发会被静默吞掉 —— 表现为「设了颜色却没生效」。厚度 33 两处通用。
//
// ⚠️ 第 5 个坑（本版集成实测发现，最危险的一个）：**UIManager 极难拿到**。
//
//    pdf.js 只在 `PDFViewer.setDocument()` 期间派发一次 `annotationeditoruimanager` 事件；
//    而插件是在用户点「手写」按钮时才 resolve() 的 —— 事件早已过去，监听接不到。
//    更糟的是，AnnotationEditorLayer 与 PDFViewer 上的 uiManager 都是构建期「唯一化改名」的
//    真私有字段（实测 `'_uiManager' in layer === false`，且 Object.getOwnPropertyNames 里也没有），
//    反射完全不可达。我原本写的「从编辑层内部回退」是**永远不可能命中的死代码**。
//
//    唯一可用的公开铰链是 **AnnotationEditor 实例上的 `_uiManager`**（上游 editor.js 里是
//    `_uiManager = null;` 类字段 + `this._uiManager = parameters.uiManager`，是真属性而非 #private，
//    构建产物也保留了 `._uiManager.` 的点号访问形态）。
//
//    因此按三条路径依次获取（见 ensureUIManager）：
//      ① 事件 —— 仅当视图刚创建、我们抢到了监听时才有效；
//      ② 存储 —— `annotationStorage.getRawValue(key)` 返回原始值（即编辑器实例），取其 _uiManager；
//      ③ 播种 —— 已进入编辑模式但存储为空时，用 `layer.createAndAddNewEditor()` 造一个空编辑器
//         换取 UIManager，随即 `remove()`。实测存储条数与编辑器数都复原，无残留；
//         全程在同一宏任务内完成，浏览器不会绘制中间态，用户看不到闪动。
//
//    拿不到 UIManager 的后果是**静默失效**：笔色/粗细不下发、橡皮与撤销全部无效，
//    但「画」仍然正常 —— 用户会以为是按钮坏了。所以这是本模块必须收口的第一风险。

import { App, TFile, loadPdfJs } from 'obsidian';
import { stripInkIdentity, type InkEntry } from './ink-store';

/* ---------------------------------------------------------------------------
 * 类型
 * ------------------------------------------------------------------------- */

/** 内置 pdfjsLib 的最小可用面。只声明用到的成员，避免引入 pdfjs-dist 类型包依赖。 */
export interface InkPdfJsLib {
	AnnotationEditorType: {
		DISABLE: number;
		NONE: number;
		INK: number;
		HIGHLIGHT: number;
	};
	AnnotationEditorParamsType: {
		INK_COLOR: number;
		INK_THICKNESS: number;
		INK_OPACITY: number;
		HIGHLIGHT_COLOR: number;
		HIGHLIGHT_DEFAULT_COLOR: number;
		HIGHLIGHT_THICKNESS: number;
		HIGHLIGHT_FREE: number;
	};
}

/** 引擎所需的全部引用。任一环缺失都视为引擎不可用（调用方应静默降级）。 */
export interface InkHandle {
	/** 真 pdf.js PDFViewer（不是 Obsidian 的包装对象）。 */
	viewer: any;
	/** pdf.js 的 PDFDocumentProxy。 */
	pdfDocument: any;
	/** viewer 的事件总线。UIManager / 参数下发都经它。 */
	eventBus: any;
	/** 内置 pdfjsLib（提供 AnnotationEditorType / AnnotationEditorParamsType）。 */
	lib: InkPdfJsLib;
	/** Obsidian 的 PDFView（仅用于取文件路径）。 */
	view: any;
	/** 当前打开 PDF 的 vault 路径（可能为空）。 */
	filePath: string;
}

/** 笔的种类。钢笔 / 荧光笔 / 橡皮 / 套索。 */
export type PenKind = 'pen' | 'marker' | 'eraser' | 'lasso';

export interface PenSpec {
	kind: PenKind;
	/** 十六进制颜色，如 '#d32f2f'。橡皮忽略此字段。 */
	color: string;
	/** 线宽（PDF 用户空间单位）。 */
	thickness: number;
	/** 不透明度 0~1。 */
	opacity: number;
}

/** 落盘/切换等操作的结果。engine 全程不抛异常，一律以结果对象返回。 */
export interface InkOpResult {
	ok: boolean;
	error?: string;
	detail?: unknown;
}

/* ---------------------------------------------------------------------------
 * 引用解析
 * ------------------------------------------------------------------------- */

/**
 * 从 Obsidian 的 PDF 视图上解析出真 pdf.js PDFViewer。
 *
 * 现行 Obsidian（2026-03 app.js 实挖，ground truth）是**三层懒加载包装**：
 *   view.viewer              懒加载壳（只有 .child / .then()）
 *   view.viewer.child        控制器，加载完成后才存在
 *   view.viewer.child.pdfViewer          createObsidianPDFViewer 的 App 对象
 *   view.viewer.child.pdfViewer.pdfViewer  真 pdf.js PDFViewer ← 要拿的
 *
 * 旧版结构（.viewer.pdfViewer 两层）保留为次级候选 —— Obsidian 内部结构随版本
 * 演进过多次，单点取值会在某个版本上静默失败。
 */
function pickPdfViewer(view: any): any {
	return (
		view?.viewer?.child?.pdfViewer?.pdfViewer ??
		view?.viewer?.pdfViewer?.pdfViewer ??
		view?.viewer?.pdfViewer ??
		view?.pdfViewer ??
		view?._pdfViewer ??
		null
	);
}

/** 取 PDFDocumentProxy（多候选回退）。真 PDFViewer 的 setDocument 也持有 pdfDocument。 */
function pickPdfDocument(view: any, viewer: any): any {
	return (
		view?.viewer?.child?.pdfViewer?.pdfDocument ??
		viewer?.pdfDocument ??
		view?.viewer?.pdfViewer?.pdfDocument ??
		view?.viewer?.pdfDocument ??
		view?.pdfViewer?.pdfDocument ??
		view?._pdfViewer?.pdfDocument ??
		view?._pdf ??
		viewer?._pdfDocument ??
		null
	);
}

/**
 * 从 loadPdfJs() 的返回值里取常量表，并对缺失的常量组做硬编码兜底。
 *
 * Obsidian 的内置 pdf.js 不保证把编辑器模块的枚举暴露在 pdfjsLib 上（真机待验项之一），
 * 而这些值是 pdf.js 规范化的枚举（与上游 editor.js / annotation_editor_params.js 一致），
 * 缺失时直接兜底，不引入任何行为差异。
 */
function pickConstants(lib: any): InkPdfJsLib | null {
	const src = lib?.AnnotationEditorType ? lib : (lib?.default ?? null);
	const base = src ?? lib ?? null;
	if (!base || typeof base !== 'object') return null;
	return {
		AnnotationEditorType: base.AnnotationEditorType ?? FALLBACK_EDITOR_TYPE,
		AnnotationEditorParamsType: base.AnnotationEditorParamsType ?? FALLBACK_PARAMS_TYPE,
	};
}

/** pdf.js 编辑器枚举（规范化值）。仅在 loadPdfJs() 未暴露同名常量时兜底。 */
const FALLBACK_EDITOR_TYPE = {
	DISABLE: -1, NONE: 0, FREETEXT: 3, HIGHLIGHT: 9, STAMP: 13, INK: 15, SIGNATURE: 101,
};
/** pdf.js 编辑器参数枚举（规范化值）。仅在 loadPdfJs() 未暴露同名常量时兜底。 */
const FALLBACK_PARAMS_TYPE = {
	INK_COLOR: 21, INK_THICKNESS: 22, INK_OPACITY: 23,
	HIGHLIGHT_COLOR: 31, HIGHLIGHT_DEFAULT_COLOR: 32, HIGHLIGHT_THICKNESS: 33, HIGHLIGHT_FREE: 34,
};

/* ---------------------------------------------------------------------------
 * 笔迹几何读取（橡皮 / 套索共用的唯一数据源）
 * ------------------------------------------------------------------------- */

/**
 * 读出编辑器的笔画几何（lines / points / rect）。
 *
 * ⚠️ **这是「历史笔迹擦不掉、套索圈不中」的根治点，改动前务必读完本注释。**
 *
 * 旧写法是 `editor.serialize()`，然后取 `serial?.paths?.lines ?? []`。
 * 在「本次会话新画的笔」上没问题，但在**文件固有笔迹**上是恒空的。
 * 依据 Obsidian 内置 pdf.js 的构建产物（.qa/obs-pdfjs/pdf.min.mjs，已逐字核对）：
 *
 *   serialize() {
 *     ...
 *     const o = { annotationType, color, opacity, thickness,
 *                 paths: { lines, points }, pageIndex, rect, rotation, ... };
 *     if (t) { o.isCopy = true; return o; }          // ← t 为真时直接返回，绕过下面那一关
 *     if (this.annotationElementId && !hasElementChanged(o)) return null;   // ★ 元凶
 *     o.id = this.annotationElementId;
 *     return o;
 *   }
 *   function hasElementChanged(o) {
 *     return this._hasBeenMoved || this._hasBeenResized ||
 *            o.color.some((v, i) => v !== initial.color[i]) ||   // 只比颜色
 *            o.thickness !== initial.thickness ||                // 只比粗细
 *            o.opacity !== initial.opacity ||                    // 只比不透明度
 *            o.pageIndex !== initial.pageIndex;
 *   }
 *
 * 两个要点：
 *   ① 重开文件后，pdf.js 会把文件里的 /Ink 注释转成编辑器，这类编辑器带
 *      `annotationElementId`；而 hasElementChanged **根本不比对笔画本身**（lines 不在
 *      比对列表里），所以只要用户没改过颜色/粗细/位置，serialize() 就返回 null。
 *   ② 返回 null 于是被下游的 `?? []` 吞成空数组 → `continue` 静默跳过 →
 *      用户看到的就是「橡皮擦不掉历史笔迹」「套索圈不中」。
 *
 * 解法：改用 **`serialize(true)`**。它在 `serializeDraw` 之后立刻 `return`，
 * 完全绕过 `annotationElementId` 那一关，而且 paths.lines / points 一应俱全 ——
 * 是新笔还是固有笔都拿到数据。唯一副作用是对象上多一个 `isCopy: true`，
 * 重建前必须删掉（见 stripCopyFlags），否则 DrawingEditor.render 会走
 * `_moveAfterPaste` 分支把重建出来的笔迹挪位。
 *
 * 兜底链：serialize(true) 抛错 → serialize()（至少覆盖新笔）→ 返回 null。
 */
export interface InkGeometry {
	lines: ArrayLike<number>[];
	points: ArrayLike<number>[];
	rect: number[] | null;
	/** 完整的序列化对象（已含 color / thickness / opacity / pageIndex / rotation），供重建复用。 */
	data: any;
}

export function readInkGeometry(editor: any): InkGeometry | null {
	if (!editor) return null;

	let data: any = null;
	try {
		// true = mustBeCommitted：pdf.js 会分配新的点数组（不返回内部引用），
		// 且提前 return，绕过 annotationElementId 的 null 短路。
		data = editor.serialize(true);
	} catch {
		data = null;
	}
	if (!data) {
		try {
			data = editor.serialize();
		} catch {
			data = null;
		}
	}
	if (!data) return null;

	const lines = data?.paths?.lines;
	if (!Array.isArray(lines) || lines.length === 0) return null;

	return {
		lines,
		points: Array.isArray(data?.paths?.points) ? data.paths.points : [],
		rect: Array.isArray(data?.rect) && data.rect.length === 4 ? data.rect : null,
		data,
	};
}

/**
 * 抹掉「重建数据」里的身份与副本标记。
 *
 * 实现已上移到数据层（`ink-store.ts`）—— 因为「写进 JSON 的笔迹快照」与
 * 「擦除 / 套索重建时的数据」必须走**同一套**清理规则：两边各维护一份迟早漂移，
 * 而这里漏掉任何一个字段，症状都是「擦完这一笔之后再也擦不动」。
 * 此处只做 re-export，保持 ink-erase / ink-lasso 既有的 import 路径不变。
 */
export { stripInkIdentity };

/**
 * 编辑器是否墨迹编辑器。
 *
 * pdf.js 用类的静态属性 `_type` 标识类型（旧版本是 `type`）；别处的写法是
 * `e?.constructor?._type ?? e?.constructor?.type`，这里收口成一个函数，
 * 免得每处各写一遍、漏了回退分支就把墨迹当成别的编辑器跳过。
 */
export function isInkEditor(editor: any): boolean {
	try {
		const t = editor?.constructor?._type ?? editor?.constructor?.type;
		return t === 'ink';
	} catch {
		return false;
	}
}

/** 我们给笔迹分配的编辑器 id 前缀。加前缀是为了永不与 pdf.js 自己的 id 撞车。 */
const STROKE_ID_PREFIX = 'fleur-ink-';

/**
 * 生成一条笔迹的编辑器 id（**必须是批内唯一且可复现的**）。
 *
 * ⚠️ **这不是装饰，漏掉它会导致静默丢笔迹，改动前务必读完。**
 *
 * 依据 Obsidian 内置 pdf.js 的构建产物（.qa/obs-pdfjs/pdf.min.mjs，已逐字核对）：
 *
 *   // AnnotationEditor 构造函数
 *   this.id = t.id;                                  // ★ 没有 uid 兜底，缺就真是 undefined
 *   // AnnotationEditorLayer
 *   attach(t){ this.#editors.set(t.id, t) }           // 以 id 为 Map 键
 *   // AnnotationEditorUIManager
 *   addEditor(t){ this.#editors.set(t.id, t) }
 *   getEditors(page){ for(const e of this.#editors.values()) e.pageIndex===page && push(e) }
 *
 * 而 `serialize(true)` 在 pdf.js 里是**提前 return** 的：
 *
 *   serialize(){ ... if(t){ o.isCopy=!0; return o }   // ← 这里返回的 o 里没有 id
 *                o.id = this.annotationElementId; return o }
 *
 * 于是从 sidecar 重建时 `data.id` 是 undefined ⇒ 所有重建出来的编辑器在
 * UIManager 的 Map 里**共用一个 `undefined` 键**，只剩最后一条能被 getEditors 取到 ⇒
 * 下一次导出只导出 1 条 ⇒ 再存盘就把其余笔迹全删了。
 *
 * 所以：导出时按「页 + 页内序号」派生一个可复现的 id 写进 JSON，
 * 恢复时再据此赋给编辑器（见 restoreStrokeEntries）。
 * 用序号而不是随机值 —— 内容没变时导出结果必须逐字节相同，否则
 * 「内容指纹比对」会失效，每次空闲都白写一次盘。
 */
function strokeId(page: number, index: number): string {
	return `${STROKE_ID_PREFIX}${page}-${index}`;
}

/** 会话内递增序号，供「删旧重建」路径取一次性 id（擦除 / 套索）。 */
let rebuildSeq = 0;

/**
 * 取一个本次会话内唯一的编辑器 id（擦除 / 套索重建用）。
 *
 * 前缀里的 `r` 段与 `strokeId()` 的 `<页>-<序>` 格式不同，两套命名永不碰撞：
 * 恢复出来的笔迹用前者，重建出来的用后者，用户新画的用 pdf.js 自己的数字 id。
 *
 * @returns 新的 id 字符串
 */
export function mintStrokeId(): string {
	rebuildSeq += 1;
	return `${STROKE_ID_PREFIX}r${rebuildSeq}`;
}

/* ---------------------------------------------------------------------------
 * 引擎
 * ------------------------------------------------------------------------- */

export class InkEngine {
	private handle: InkHandle | null = null;
	private uiManager: any = null;
	private readonly disposers: Array<() => void> = [];
	/** 当前已下发的笔（用于切换 PDF 后重新套用）。 */
	private currentPen: PenSpec | null = null;
	/** 上一次 resolve() 失败的原因码（成功后清空）。 */
	private lastResolveError: string | null = null;
	/** 上一次 resolve() 的结构探测结果（诊断用）。 */
	private lastResolveDebug: Record<string, unknown> = {};

	constructor(private app: App) {}

	/** 上一次 resolve() 失败的原因码；null 表示上次解析成功（或尚未解析）。 */
	get resolveError(): string | null {
		return this.lastResolveError;
	}

	/** 上一次 resolve() 的结构探测结果（视图类型 / 各引用是否找到等）。 */
	get resolveDebug(): Record<string, unknown> {
		return this.lastResolveDebug;
	}

	/* ------------------------------ 生命周期 ------------------------------ */

	/**
	 * 解析引擎引用。每次打开/切换 PDF 后都要调用（可反复调用，内部幂等）。
	 *
	 * 返回 null 表示当前环境不支持 —— 调用方应静默降级，不要弹错。
	 * 这是 R5（Obsidian 升级改内部结构）的缓解措施：把版本耦合收在这一个函数里。
	 */
	async resolve(): Promise<InkHandle | null> {
		// 每次解析都重置诊断信息；失败原因码经 resolveError 供 UI 与控制台使用，
		// 避免静默返回 null 后只能靠猜（真机第一轮排障的真实教训）。
		const dbg: Record<string, unknown> = {};
		this.lastResolveDebug = dbg;
		this.lastResolveError = null;

		// 活动视图只有在「真的能解析出完整 PDF 引用」时才直接采用。
		// 不能用 getActiveViewOfType(Object) 的返回值兜底判定：它对任何类型的视图都返回
		// （所有视图都 instanceof Object），焦点在批注侧边栏 / 大纲等非 PDF 面板上时，
		// 会拿一个解析不出 pdfViewer 的视图然后在这里失败 —— 而此时 PDF 明明开着。
		const active: any = this.app.workspace.getActiveViewOfType?.(Object as any) ?? null;
		const activeViewer = active ? pickPdfViewer(active) : null;
		const activeDoc = activeViewer ? pickPdfDocument(active, activeViewer) : null;
		const view: any = activeViewer && activeDoc ? active : this.findPdfView();
		dbg.activeViewType = active?.getViewType?.() ?? active?.constructor?.name ?? null;
		dbg.usedActiveView = !!activeViewer && !!activeDoc;
		dbg.viewType = view?.getViewType?.() ?? view?.constructor?.name ?? null;
		if (!view) {
			this.lastResolveError = 'no-pdf-view';
			return null;
		}

		const viewer = pickPdfViewer(view);
		dbg.viewerFound = !!viewer;
		if (!viewer || typeof viewer !== 'object') {
			this.lastResolveError = 'pdfviewer-not-found';
			return null;
		}

		const pdfDocument = pickPdfDocument(view, viewer);
		dbg.docFound = !!pdfDocument;
		if (!pdfDocument || typeof pdfDocument.getPage !== 'function') {
			this.lastResolveError = 'pdfdocument-not-found';
			return null;
		}

		const eventBus = viewer.eventBus;
		dbg.eventBusFound = !!eventBus;
		if (!eventBus || typeof eventBus.on !== 'function') {
			this.lastResolveError = 'eventbus-not-found';
			return null;
		}

		let raw: any = null;
		try {
			raw = await loadPdfJs();
		} catch (e) {
			dbg.loadPdfJsError = String(e);
		}
		dbg.libNativeConstants = !!raw?.AnnotationEditorType;
		const lib = pickConstants(raw);
		if (!lib) {
			this.lastResolveError = 'pdfjs-lib-not-found';
			return null;
		}

		const filePath = String(view?.file?.path ?? '');
		dbg.filePath = filePath;

		this.detachHandle();
		this.handle = { viewer, pdfDocument, eventBus, lib, view, filePath };

		// 抓 UIManager —— pdf.js 唯一的公开途径是这个事件。
		const onUIManager = (payload: any) => {
			if (payload?.uiManager) this.uiManager = payload.uiManager;
		};
		eventBus.on('annotationeditoruimanager', onUIManager);
		this.disposers.push(() => {
			try {
				eventBus.off?.('annotationeditoruimanager', onUIManager);
			} catch {
				/* 视图已销毁时忽略 */
			}
		});

		// 事件早于本次监听就已派发过是常态（见文件头第 5 个坑），先从存储里捞一次。
		this.uiManager = this.uiManager ?? this.acquireFromStorage();

		return this.handle;
	}

	/** 在当前工作区里找 PDF 视图（活动文件匹配优先，其次主工作区里可见的叶子）。 */
	private findPdfView(): any {
		const leaves = this.app.workspace.getLeavesOfType('pdf');
		if (!leaves.length) return null;
		const active = this.app.workspace.getActiveFile();
		// 排序键：活动文件匹配（0）> 在主工作区可见（rootSplit，0）> 其余。
		// 焦点常落在侧边栏（批注列表 / 搜索），此时 getActiveFile() 为空，
		// 「主工作区优先」能避免选中折叠在后台的另一个 PDF。
		const rank = (leaf: any): number => {
			const fileMatch = leaf?.view?.file?.path === active?.path ? 0 : 1;
			let inMain = 1;
			try {
				inMain = leaf?.getRoot?.() === 'rootSplit' ? 0 : 1;
			} catch {
				/* 老版本 API 缺 getRoot 时按原样处理 */
			}
			return fileMatch * 2 + inMain;
		};
		const sorted = [...leaves].sort((a: any, b: any) => rank(a) - rank(b));
		return sorted[0]?.view ?? null;
	}

	/** 释放对上一个 PDF 视图的持有（不改变其状态）。 */
	private detachHandle(): void {
		while (this.disposers.length) {
			const fn = this.disposers.pop();
			try {
				fn?.();
			} catch {
				/* 忽略 */
			}
		}
		this.handle = null;
		this.uiManager = null;
	}

	dispose(): void {
		this.detachHandle();
		this.currentPen = null;
	}

	/* ------------------------------ 查询 ------------------------------ */

	get isReady(): boolean {
		return !!this.handle;
	}

	get pdfFilePath(): string {
		return this.handle?.filePath ?? '';
	}

	get constants(): InkPdfJsLib | null {
		return this.handle?.lib ?? null;
	}

	/**
	 * UIManager。编辑器相关的 API（getEditors / updateParams / setSelected / delete / undo / redo）
	 * 全在它身上，layer 与 viewer 都没有 —— 所以它是本模块的命门。
	 *
	 * 内部走 ensureUIManager()，会依次尝试「事件 → 存储 → 播种」三条路径。
	 */
	getUIManager(): any {
		return this.ensureUIManager();
	}

	/**
	 * 主动补齐 UIManager（幂等）。需要 UIManager 的操作都应先经此。
	 *
	 * 返回 null 表示当前环境拿不到 —— 调用方必须静默降级，不要当异常抛。
	 */
	ensureUIManager(): any {
		if (this.uiManager?.getEditors) return this.uiManager;

		// 路径 ①（事件）：resolve() 时已注册监听，命中过就已经在 this.uiManager 里。
		// 路径 ②（存储）：从已存在的编辑器实例上取。
		this.uiManager = this.acquireFromStorage() ?? null;
		if (this.uiManager) return this.uiManager;

		// 路径 ③（播种）：仅当已处于某种编辑模式时可行（createAndAddNewEditor 依赖当前模式）。
		this.uiManager = this.acquireBySeeding() ?? null;
		return this.uiManager;
	}

	/**
	 * 取编辑器实例上的 UIManager —— pdf.js 唯一的公开铰链。
	 *
	 * 之所以能这么取：上游 editor.js 里 uiManager 是 `_uiManager`（真属性、非 #private），
	 * 与 AnnotationEditorLayer 上的私有字段不同，构建产物也保留了 `._uiManager.` 访问形态。
	 */
	private umFromEditor(editor: any): any {
		try {
			const um = editor?._uiManager ?? null;
			return typeof um?.getEditors === 'function' ? um : null;
		} catch {
			return null;
		}
	}

	/**
	 * 路径 ②：扫描 AnnotationStorage 里的编辑器实例。
	 *
	 * 为什么可行：AnnotationStorage 存的就是 AnnotationEditor 实例（serializable 里
	 * `value instanceof AnnotationEditor ? value.serialize() : value` 即证据），
	 * 而 `getRawValue(key)` 返回的是**原始值**（不经序列化），正好是编辑器本身。
	 * serializable.map 的键也就是 #storage 的原始键（构建产物里是 `t.set(i, n)`）。
	 */
	private acquireFromStorage(): any {
		const store = this.handle?.pdfDocument?.annotationStorage;
		let keys: Iterable<string> | null = null;
		try {
			const map = store?.serializable?.map;
			if (!map || !map.size) return null;
			keys = map.keys();
		} catch {
			return null;
		}
		if (!keys) return null;

		for (const key of keys) {
			let raw: any = null;
			try {
				raw = store.getRawValue?.(key);
			} catch {
				continue;
			}
			const um = this.umFromEditor(raw);
			if (um) return um;
		}
		return null;
	}

	/**
	 * 路径 ③：在已进入编辑模式、但存储里还没有编辑器时，造一个空编辑器换取 UIManager。
	 *
	 * 这是「首次进入手写模式」的必经之路（那时存储必然是空的，而笔色必须在第一笔落墨前下发）。
	 * 安全性：实测 `remove()` 之后 AnnotationStorage 的 size 与 UIManager 的编辑器数都回到原值；
	 * 创建与移除发生在同一个宏任务内，浏览器不会绘制中间态。
	 */
	private acquireBySeeding(): any {
		// createAndAddNewEditor 内部按「当前模式」决定造哪种编辑器 —— 模式为 0 时造不出来。
		if (!this.getMode()) return null;

		const layer = this.getLayer(0);
		if (typeof layer?.createAndAddNewEditor !== 'function') return null;

		let seeded: any = null;
		try {
			seeded = layer.createAndAddNewEditor({ offsetX: 0, offsetY: 0 }, true, {});
		} catch {
			return null;
		}

		const um = this.umFromEditor(seeded);
		try {
			seeded?.remove?.();
		} catch {
			/* 移除失败也接受：它是个空编辑器，不进批注存储 */
		}
		return um;
	}

	/**
	 * 取指定页的 AnnotationEditorLayer。
	 *
	 * ⚠️ 必须优先走「页面视图 → builder → layer」这条不依赖 UIManager 的直连路径。
	 * 若先问 UIManager，就会与 ensureUIManager() 的「播种」路径形成
	 * acquireBySeeding → getLayer → getUIManager → acquireBySeeding 的无限递归。
	 */
	getLayer(pageIndex = 0): any {
		const pv = (this.handle?.viewer?._pages ?? [])[pageIndex];
		const direct = pv?.annotationEditorLayer?.annotationEditorLayer ?? null;
		if (direct) return direct;
		try {
			return this.uiManager?.getLayer?.(pageIndex) ?? null;
		} catch {
			return null;
		}
	}

	/** 文档总页数（无 handle 时 0）。 */
	get pageCount(): number {
		return (this.handle?.viewer?._pages ?? []).length;
	}

	/**
	 * 指定页的 AnnotationLayer 实例（「注释层」，注意不是编辑器层）。
	 *
	 * 编辑器层（AnnotationEditorLayer）与注释层（AnnotationLayer）是两个东西：
	 * 编辑器层负责「画 / 改」，注释层负责「渲染文件里固有的注释」。
	 * 固有手写笔迹要转成可编辑对象，数据源头就在注释层的
	 * getEditableAnnotations() —— 与 pdf.js 自身 enable() 里用的同一入口。
	 */
	getAnnotationLayer(pageIndex = 0): any {
		const pv = (this.handle?.viewer?._pages ?? [])[pageIndex];
		return pv?.annotationLayer?.annotationLayer ?? null;
	}

	/**
	 * 该页的编辑器列表。
	 *
	 * ⚠️ 陷阱 1：必须传 pageIndex。pdf.js 内部是 `editor.pageIndex === pageIndex`，
	 * 不传参时 `0 === undefined` 恒为假 → 恒返回空数组，会让人误判「没有编辑器」。
	 */
	getEditors(pageIndex = 0): any[] {
		const um = this.getUIManager();
		if (!um?.getEditors) return [];
		try {
			return um.getEditors(pageIndex) ?? [];
		} catch {
			return [];
		}
	}

	/** 当前模式。未激活时返回 DISABLE(-1) 或 NONE(0)。 */
	getMode(): number {
		try {
			return this.handle?.viewer?.annotationEditorMode ?? -1;
		} catch {
			return -1;
		}
	}

	/** 手写模式是否处于激活状态。 */
	get isInkActive(): boolean {
		return this.getMode() === (this.constants?.AnnotationEditorType.INK ?? 15);
	}

	/* ------------------------------ 模式切换 ------------------------------ */

	/**
	 * 切换编辑器模式。这是引擎唯一的激活入口 —— 一行赋值、不重建 viewer、不改 baseConfig。
	 *
	 * 参数 mode 取 AnnotationEditorType：NONE(0) / INK(15) / HIGHLIGHT(9)。
	 * 传 NONE 等价于「提交并退出手写」，pdf.js 会把当前绘制会话落成编辑器。
	 *
	 * ⚠️ setMode 是**同步触发 + 异步落盘**。调用 `viewer.annotationEditorMode = { mode }` 时，
	 * pdf.js 内部只是排了个 updater（NONE → 非 NONE 还要等所有页渲染完），存储值在 updater
	 * 跑完前不会变。所以本方法返回的 `after` 可能是旧值；需要等真生效请用 setModeAsync。
	 */
	setMode(mode: number): InkOpResult & { before: number; after: number } {
		const viewer = this.handle?.viewer;
		if (!viewer) return { ok: false, error: '引擎未就绪', before: -1, after: -1 };
		const before = this.getMode();
		try {
			viewer.annotationEditorMode = { mode };
			const after = this.getMode();
			// ⚠️ 这里的 ok:false **不代表失败**，只代表「pdf.js 还没落盘」。
			// setter 内部是异步 updater（见 setModeAsync 注释），赋值后立刻读回必然是旧值。
			// 调用方必须用 setModeAsync —— 那里以「等到的结果」为成功依据。
			return { ok: after === mode, before, after };
		} catch (err) {
			// 门闩未开（viewer 尚未 setDocument）时会抛 "The AnnotationEditor is not enabled."
			// 这条才是真失败：error 非空即「连排期都没排上」。
			return {
				ok: false,
				before,
				after: before,
				error: err instanceof Error ? err.message : String(err),
			};
		}
	}

	/**
	 * 异步版 setMode —— 等到模式真的落盘（或超时）才返回。
	 *
	 * 真机反复踩到的坑：NONE → INK 时 pdf.js 走重路径，要先 toggleEditingMode 再等所有页
	 * pagerendered，再 setTimeout(updater, 0)。updater 里才设置存储值。在这之前 getMode()
	 * 永远返回旧值 NONE，applyPen / ensureUIManager（依赖 `getMode() !== 0` 的播种路径）
	 * 全部静默失败 —— 用户感受是「第一次切模式没反应，再点一次才好」。
	 *
	 * 解决：监听 pdf.js 在 updater 末尾 dispatch 的 `annotationeditormodechanged` 事件。
	 */
	async setModeAsync(mode: number, timeoutMs = 8000): Promise<InkOpResult & { before: number; after: number }> {
		const r = this.setMode(mode);
		// error 非空 = 赋值当场抛了（门闩未开），这才是真失败，不必等。
		if (r.error) return r;
		// 已经是目标模式 → setter 会直接 return 且**不派发事件**，只能靠读回值判定。
		if (this.getMode() === mode) return { ...r, ok: true };

		// ⚠️ 曾经的写法是 `ok: waited && r.ok`，这是本轮真机问题的元凶：
		// r.ok 来自「赋值后立刻读回」，而 pdf.js 的 setter 是异步落盘
		// （NONE → INK 要先 toggleEditingMode、等所有页 pagerendered，再 setTimeout(updater, 0)），
		// 所以首次进入手写时 r.ok 恒为 false。于是即便事件明确告诉我们已经切好了，
		// 返回值仍被判成失败 —— 调用方弹「手写模式不可用」并**提前 return**，
		// 笔盒、手势盾、触摸路由、自动落盘、固有笔迹播种全都不会挂上。
		// 成功与否只能以「等到的结果」为准，不能与同步读回相与。
		const ok = await this.waitForMode(mode, timeoutMs);
		return { ...r, ok, after: this.getMode() };
	}

	/**
	 * 等到模式变成目标值（或超时返回 false）。
	 *
	 * 事件与轮询**同时**用：pdf.js 在 updater 末尾派发 `annotationeditormodechanged`，
	 * 但那条事件只在「模式确实变了」时派发 —— 若我们注册监听比 updater 晚、
	 * 或事件在视图重建途中丢失，只等事件就会白等到超时。轮询是最后的安全网。
	 *
	 * 超时给到 8s：NONE → INK 时 pdf.js 要等**所有已渲染页** pagerendered 才跑 updater，
	 * 移动端渲染慢，取 1.5s（旧值）会让首屏较大的 PDF 必然判超时。
	 */
	private waitForMode(targetMode: number, timeoutMs = 8000): Promise<boolean> {
		if (this.getMode() === targetMode) return Promise.resolve(true);
		return new Promise((resolve) => {
			let done = false;
			const bus = this.handle?.eventBus;
			const onChanged = (payload: any) => {
				if (payload?.mode === targetMode) finish(true);
			};
			const poll = window.setInterval(() => {
				if (this.getMode() === targetMode) finish(true);
			}, 100);
			const timer = window.setTimeout(() => finish(this.getMode() === targetMode), timeoutMs);
			const cleanup = () => {
				window.clearInterval(poll);
				window.clearTimeout(timer);
				try { bus?.off?.('annotationeditormodechanged', onChanged); } catch { /* 视图已销毁 */ }
			};
			const finish = (ok: boolean) => {
				if (done) return;
				done = true;
				cleanup();
				resolve(ok);
			};
			try {
				bus?.on?.('annotationeditormodechanged', onChanged);
			} catch {
				/* 没有 eventBus 也能靠轮询兜住 */
			}
		});
	}

	/**
	 * 进入手写模式（黑/墨迹）—— 异步版本，等模式真落盘。
	 *
	 * ⚠️ 返回值必须带上 before/after：`ok:false` 有两种截然不同的含义
	 * （赋值当场被拒 vs 只是没等到落盘），调用方要靠 error 与 after 区分。
	 * 早先这里只回 `{ok, error}`，调用方既判断不了、日志也看不出发生了什么。
	 */
	enterInk(): Promise<InkOpResult & { before: number; after: number }> {
		return this.setModeAsync(this.constants?.AnnotationEditorType.INK ?? 15);
	}

	/**
	 * 进入荧光笔模式。
	 *
	 * ⚠️ 0.2.0 起荧光笔**不再**走 pdf.js 的 HIGHLIGHT(9) 自由高亮通道。
	 * 原因：自由高亮的渲染是「Outline 多边形填充」——它把粗描边转成闭合多边形
	 * 再半透明填充，渲染层自带一圈同色描边（真机用户实测「像选区图层、有边框」）。
	 * 这条描边长在 pdf.js 的绘制逻辑与导出的外观流里，CSS 去不掉。
	 *
	 * 现在与 GoodNotes 同语义：荧光笔 = 钢笔调大笔触（INK 通道 + 半透明），
	 * 渲染是一条真正的粗笔画，没有任何边框。
	 */
	enterMarker(): Promise<InkOpResult & { before: number; after: number }> {
		return this.setModeAsync(this.constants?.AnnotationEditorType.INK ?? 15);
	}

	/** 退出编辑（提交当前会话）。NONE 让正在绘制的笔画被落成编辑器。 */
	exit(): Promise<InkOpResult> {
		return this.setModeAsync(0).then((r) => ({ ok: r.ok, error: r.error }));
	}

	/**
	 * 显式提交当前绘制会话。
	 *
	 * ⚠️ 陷阱 4：InkEditor.supportMultipleDrawings === true 时 pointerup 会主动 return，
	 * 笔迹此刻只是预览路径、编辑器尚未诞生。必须提交才会生成编辑器并进入 AnnotationStorage。
	 */
	commit(): InkOpResult {
		for (const pv of this.handle?.viewer?._pages ?? []) {
			const layer = pv?.annotationEditorLayer?.annotationEditorLayer;
			try {
				layer?.commitOrRemove?.();
			} catch {
				/* 单页失败不影响其它页 */
			}
		}
		return { ok: true };
	}

	/* ------------------------------ 笔参数 ------------------------------ */

	/**
	 * 下发笔参数。
	 *
	 * 参数分流（0.2.0 起统一走墨迹通道）：
	 *   · 钢笔   —— INK_COLOR(21) / INK_THICKNESS(22) / INK_OPACITY(23)，
	 *              DrawingEditor.updateDefaultParams 会同时改「默认值」与「当前正在画的笔」；
	 *   · 荧光笔 —— 同样走 INK_* 参数：粗笔触 + 半透明（pen.opacity，默认 0.4）。
	 *              旧版走 HIGHLIGHT_*（32/33/34）因自由高亮自带描边已弃用；
	 *   · 橡皮   —— 不参与参数下发（它是自建行为，见 ink-erase.ts）。
	 *
	 * ⚠️ 顺序敏感：下发前必须先「提交当前会话 + 硬清空选择集」。
	 *
	 * 真机实测（0.2.1 小米平板反馈）：「切钢笔↔荧光笔」「换颜色」都会把**历史笔迹
	 * 一起改掉」。两个独立成因叠加：
	 *
	 *   ① 绘制会话未提交 —— supportMultipleDrawings=true 时 pointerup 不生成编辑器，
	 *      同一会话里的多条笔画共用一组 color/thickness。不先 commit，改参数会把
	 *      这一整组笔画一起改（表现为「历史笔迹跟着变粗/变透明」）。
	 *
	 *   ② `um.unselectAll()` 在编辑模式下**不会真的清空选择集** —— 见 tools.js：
	 *      只要 `#activeEditor` 存在，它 commitOrRemove 后因 `mode !== NONE` 直接
	 *      `return`；若还有 `#currentDrawingSession` 同样提前 return。于是刚画完的
	 *      编辑器仍留在 `#selectedEditors` 里，`updateParams` 遍历选择集把它们
	 *      全部改色（表现为「历史笔迹跟着变色」）。
	 *
	 * 所以必须先 commit()（消掉 ①），再用 clearSelection() 反复 unselectAll 直到
	 * hasSelection 为假（消掉 ②）。两步都做完，updateParams 才只落「默认参数」，
	 * 只影响之后的新笔迹。
	 */
	applyPen(pen: PenSpec): Promise<InkOpResult> {
		const lib = this.constants;
		const um = this.getUIManager();
		if (!lib || !um?.updateParams) return Promise.resolve({ ok: false, error: '引擎未就绪' });

		const P = lib.AnnotationEditorParamsType;
		try {
			if (pen.kind === 'pen' || pen.kind === 'marker') {
				// ① 固化当前绘制会话：让已有笔画成为独立编辑器、锁住自己的参数
				this.commit();
				// ② 硬清空选择集：否则 updateParams 会顺着选择集改到历史笔迹
				this.clearSelection(um);
			}
			if (pen.kind === 'pen' || pen.kind === 'marker') {
				um.updateParams(P.INK_COLOR, pen.color);
				um.updateParams(P.INK_THICKNESS, pen.thickness);
				um.updateParams(P.INK_OPACITY, pen.opacity);
			}
			this.currentPen = pen;
			return Promise.resolve({ ok: true });
		} catch (err) {
			return Promise.resolve({ ok: false, error: err instanceof Error ? err.message : String(err) });
		}
	}

	/**
	 * 异步版 applyPen：先等 UIManager 就绪（初次切模式可能尚未就绪，详见 waitForMode）。
	 *
	 * 真机 0.4.0 反馈：首次 applyPen 拿到 null 的 um → 静默失败 → 再点一次才好。
	 * 根因：setMode 的异步 updater 还没跑完，layer 还没建好，「播种」路径拿不到 um。
	 * 此处用短间隔轮询（最多 1.5s）等到 um 可用或超时。UIManager 落到 this 后就不再变。
	 */
	async applyPenAsync(pen: PenSpec, timeoutMs = 1500): Promise<InkOpResult> {
		const lib = this.constants;
		if (!lib) return { ok: false, error: '引擎未就绪' };
		const um = await this.ensureUIManagerAsync(timeoutMs);
		if (!um?.updateParams) return { ok: false, error: 'UIManager 不可用' };

		const P = lib.AnnotationEditorParamsType;
		try {
			if (pen.kind === 'pen' || pen.kind === 'marker') {
				this.commit();
				this.clearSelection(um);
			}
			if (pen.kind === 'pen' || pen.kind === 'marker') {
				um.updateParams(P.INK_COLOR, pen.color);
				um.updateParams(P.INK_THICKNESS, pen.thickness);
				um.updateParams(P.INK_OPACITY, pen.opacity);
			}
			this.currentPen = pen;
			return { ok: true };
		} catch (err) {
			return { ok: false, error: err instanceof Error ? err.message : String(err) };
		}
	}

	/**
	 * 异步拿 UIManager：短间隔轮询，等到 um 可用或超时（默认 1.5s）。
	 * 同步版 `ensureUIManager` 在异步 updater 跑完前会立即返回 null，调用方只能拿到失败结果。
	 */
	ensureUIManagerAsync(timeoutMs = 1500): Promise<any> {
		if (this.uiManager?.getEditors) return Promise.resolve(this.uiManager);
		return new Promise((resolve) => {
			const deadline = Date.now() + timeoutMs;
			const tick = () => {
				const um = this.ensureUIManager();
				if (um?.getEditors) return resolve(um);
				if (Date.now() > deadline) return resolve(this.uiManager ?? null);
				window.setTimeout(tick, 40);
			};
			tick();
		});
	}

	/**
	 * 硬清空选择集。
	 *
	 * pdf.js 的 `unselectAll()` 名字骗人：在编辑模式下它**不清选择集**。
	 * tools.js 的实现是「有 #activeEditor → commitOrRemove 后因 mode !== NONE 直接 return；
	 * 有 #currentDrawingSession → 同样 return」，只有这两个都消掉之后才走到
	 * `#selectedEditors.clear()`。因此单次调用几乎必然提前返回。
	 *
	 * 这里按 `hasSelection` 循环调用，最多 6 轮兜底（正常情况下 2~3 轮即清空），
	 * 避免依赖 pdf.js 内部轮数假设。
	 */
	private clearSelection(um: any): void {
		for (let i = 0; i < 6; i++) {
			let has = false;
			try {
				has = !!um?.hasSelection;
			} catch {
				return;
			}
			if (!has) return;
			try {
				um.unselectAll?.();
			} catch {
				return;
			}
		}
	}

	/** 重新套用最近一次的笔（切换 PDF、离开再回来时用）。 */
	reapplyPen(): void {
		if (this.currentPen) this.applyPen(this.currentPen);
	}

	/** 最近一次下发的笔（笔盒据此回填当前选中态）。 */
	get penSpec(): PenSpec | null {
		return this.currentPen;
	}

	/* ------------------------------ 选择与删除 ------------------------------ */

	/**
	 * 选中一个编辑器。
	 *
	 * ⚠️ 陷阱 3：updateParams / delete 都只遍历 UIManager 的 #selectedEditors。
	 * e.select() 只加 `selectedEditor` class，不进选择集 —— 必须让 UIManager 知道。
	 *
	 * 用 toggleSelected 而不是 setSelected：前者是 UIManager 的公开逐项选择方法
	 * （内部完成 `#selectedEditors.add` + `editor.select()` + 广播 propertiesToUpdate）；
	 * 后者用于「整体替换选择集」，且传 null 会抛 "Cannot read properties of null"（实测）。
	 * 先 unselectAll 再 toggle，避免目标已在选择集里时被反选掉。
	 */
	select(editor: any): InkOpResult {
		if (!editor) return { ok: false, error: '编辑器为空' };
		const um = this.getUIManager();
		try {
			um?.unselectAll?.();
			if (typeof um?.toggleSelected === 'function') um.toggleSelected(editor);
			else editor.select?.();
			return { ok: true };
		} catch (err) {
			return { ok: false, error: err instanceof Error ? err.message : String(err) };
		}
	}

	unselectAll(): void {
		try {
			this.getUIManager()?.unselectAll?.();
		} catch {
			/* 忽略 */
		}
	}

	/**
	 * 落笔结束后主动「提交 + 释放选择集」。
	 *
	 * 为什么需要：pdf.js 在 INK 模式下每画一笔都会把新编辑器放进 `#selectedEditors`，
	 * 而 `unselectAll()` 在 mode !== NONE 时**不清选择集**（见 clearSelection 注释）。
	 * 结果就是「刚画的笔一直处于选中态」：
	 *   · 视觉上每一笔带一圈高亮描边，相邻几笔像被一个选区框串起来（真机反馈）；
	 *   · 行为上后续任何 `updateParams` 都可能顺着选择集改到历史笔迹。
	 *
	 * 每次 pointerup 后调用它，让「笔迹始终未选中」成为常态。
	 * 需要真正选择时走套索模式（ink-lasso 自己维护选择集，不经 pdf.js 选择）。
	 */
	releaseSelection(): void {
		const um = this.getUIManager();
		if (!um) return;
		this.commit();
		this.clearSelection(um);
	}

	/**
	 * 多选：套索圈中若干编辑器后整组入选。
	 *
	 * toggleSelected 是「追加/反选」语义，不触碰选择集里的其他成员，
	 * 所以先 unselectAll 清场，再逐个 toggle 追加 —— 得到精确的选择集。
	 * 任一项失败不中断（部分成功远好于全部回滚），但会把失败计数带回去。
	 */
	selectMany(editors: any[]): { ok: boolean; selected: number; failed: number } {
		const um = this.getUIManager();
		if (!um) return { ok: false, selected: 0, failed: editors.length };
		try {
			um.unselectAll?.();
		} catch {
			/* 忽略 */
		}
		let selected = 0;
		let failed = 0;
		for (const editor of editors) {
			if (!editor) continue;
			try {
				if (typeof um.toggleSelected === 'function') um.toggleSelected(editor);
				else editor.select?.();
				selected++;
			} catch {
				failed++;
			}
		}
		return { ok: failed === 0 && selected > 0, selected, failed };
	}

	/** 删除当前选择集内的编辑器（连同其在 AnnotationStorage 中的记录）。 */
	deleteSelected(): InkOpResult {
		const um = this.getUIManager();
		if (!um?.delete) return { ok: false, error: 'UIManager 缺少 delete' };
		try {
			um.delete();
			return { ok: true };
		} catch (err) {
			return { ok: false, error: err instanceof Error ? err.message : String(err) };
		}
	}

	undo(): InkOpResult {
		const um = this.getUIManager();
		if (!um?.undo) return { ok: false, error: 'UIManager 缺少 undo' };
		try {
			um.undo();
			return { ok: true };
		} catch (err) {
			return { ok: false, error: err instanceof Error ? err.message : String(err) };
		}
	}

	redo(): InkOpResult {
		const um = this.getUIManager();
		if (!um?.redo) return { ok: false, error: 'UIManager 缺少 redo' };
		try {
			um.redo();
			return { ok: true };
		} catch (err) {
			return { ok: false, error: err instanceof Error ? err.message : String(err) };
		}
	}

	/* ------------------------------ 序列化与落盘 ------------------------------ */

	/**
	 * AnnotationStorage 中待保存的条目。
	 *
	 * ⚠️ 陷阱 2：serializable.map 是 Map 不是普通对象。
	 * Object.keys(map) 恒为 []，必须 [...map.keys()]。
	 */
	listStored(): Array<{ id: string; data: any }> {
		const storage = this.handle?.pdfDocument?.annotationStorage;
		if (!storage?.serializable?.map) return [];
		try {
			return [...storage.serializable.map.entries()].map(([id, data]) => ({
				id: String(id),
				data,
			}));
		} catch {
			return [];
		}
	}

	/** 待保存的批注条数。 */
	get pendingCount(): number {
		return this.handle?.pdfDocument?.annotationStorage?.size ?? 0;
	}

	/**
	 * 把内存中的批注合成为新的 PDF 字节流。
	 *
	 * 产出是标准 PDF（钢笔与荧光笔同为 /Subtype /Ink + /InkList），
	 * 因此批注不是插件私有产物 —— 换任何阅读器都看得见。
	 *
	 * ⚠️ 0.5 起**主流程已不再调用本方法**：笔迹的落盘改由 `ink-store.ts` 以 sidecar
	 * JSON 承担（理由见该文件开头的架构说明 —— 写回 PDF 会触发视图重载、且固有编辑器
	 * 擦不掉）。本方法保留下来，作为「导出到 PDF」（把笔迹烧进副本、不覆盖原文件）
	 * 这一后续能力的基础 —— 那是唯一还需要真正改写 PDF 字节的场景。
	 *
	 * 本方法只负责「生成字节」，不写盘。
	 *
	 * ⚠️ **落盘前必须先确认「真的有东西可写」** —— 这是 0.4.4 补的第二道闸门，
	 * 针对的是 pdf.js 一个极隐蔽的静默失败。依据 Obsidian 内置 pdf.js 构建产物
	 * （.qa/obs-pdfjs/pdf.min.mjs，逐字核对）：
	 *
	 *   get serializable() {
	 *     if (0 === #storage.size) return EMPTY_STORAGE;
	 *     const map = new Map(); let hasBitmap = false;
	 *     for (const [k, v] of #storage) {
	 *       const n = v instanceof AnnotationEditor ? v.serialize(false, opts) : v;
	 *       if (n) { map.set(k, n); ... }          // ★ null 项在这里被静默丢弃
	 *     }
	 *     return map.size > 0 ? { map, hash, transfer } : EMPTY_STORAGE;   // ★ 全 null → 空存储
	 *   }
	 *
	 *   saveDocument() {
	 *     const { map, transfer } = this.annotationStorage.serializable;    // ← 拿到的可能是空 map
	 *     return sendWithPromise('SaveDocument', {..., annotationStorage: map}, transfer)
	 *            .finally(() => this.annotationStorage.resetModified());   // ★ 无论写没写都清 dirty
	 *   }
	 *
	 * 而 worker 侧收到空 changes 时是 `return originalBytes`（直接回吐原文件字节，不报错）。
	 *
	 * 三条合起来的后果非常危险：
	 *   ① 产出字节**长度非 0**，落盘方按 `bytes.length === 0` 做的空判抓不住；
	 *   ② 写回去的是原文件的完整副本 —— 文件看起来「被保存过了」；
	 *   ③ resetModified() 把 dirty 清掉，于是后续自动落盘直接跳过「没有未保存内容」。
	 *   ⇒ 用户的笔迹**一次都不会真正进文件**，且插件全程不报错。
	 *
	 * 所以这里先自己算一遍 `serializable.map.size`：为 0 就返回 null，
	 * 让调用方以「无内容」收场（不写盘、不清 dirty）。下次落盘会重试。
	 */
	async exportAnnotatedBytes(): Promise<Uint8Array | null> {
		const doc = this.handle?.pdfDocument;
		if (!doc?.saveDocument) return null;
		const storage = doc.annotationStorage;
		if (!storage || !storage.size) return null;
		if (!this.hasSerializableContent(storage)) {
			console.warn(
				'[FleurPDF Ink] 存储里有条目但全部序列化为 null，pdf.js 会静默回吐原文件字节；本次跳过落盘。',
			);
			return null;
		}
		try {
			// 注意：pdf.js 的 saveDocument() **不接受参数** —— 它内部自己读
			// `this.annotationStorage.serializable`。传进去的 storage 会被忽略，
			// 旧代码 `doc.saveDocument(storage)` 只是恰好无害，这里去掉以免误导。
			const bytes: Uint8Array = await doc.saveDocument();
			return bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
		} catch {
			return null;
		}
	}

	/* -------------------- 笔迹快照（方案 C 的存取口） -------------------- */

	/**
	 * 导出所有页的笔迹快照 —— 写进 sidecar 的数据源。
	 *
	 * 与 `exportAnnotatedBytes` 的根本区别：
	 *   · 后者产出**整份 PDF 字节**，写盘要改写用户的 PDF 文件 ⇒ Obsidian 销毁重建
	 *     视图 ⇒ 内存里尚未写回的笔迹随之全丢（真机反馈的「只存开头几笔」）；
	 *   · 这里只产出**笔迹数据**，写进插件自己的 JSON，完全不触碰 PDF ⇒
	 *     可以高频、静默地存，不会引发任何重载。
	 *
	 * 用 `serialize(true)` 而非 `serialize()`：固有编辑器在后者下恒返回 null，
	 * 详见 readInkGeometry 的长注释。
	 */
	exportStrokeEntries(): InkEntry[] {
		const out: InkEntry[] = [];
		for (let page = 0; page < this.pageCount; page++) {
			let editors: any[] = [];
			try {
				editors = this.getEditors(page);
			} catch {
				continue; // 该页还没渲染出编辑层 —— 跳过，不影响其余页
			}
			let idx = 0;
			for (const editor of editors) {
				if (!isInkEditor(editor)) continue;
				const geom = readInkGeometry(editor);
				if (!geom) continue;
				const data = stripInkIdentity(geom.data);
				// ★ 必须补一个 id，原因见 strokeId 的长注释。
				data.id = strokeId(page, idx++);
				out.push({ page, data });
			}
		}
		return out;
	}

	/**
	 * 从快照恢复编辑器。
	 *
	 * 恢复出来的编辑器**不带 `annotationElementId`**（快照里已剔除），所以 pdf.js
	 * 把它当作「本次会话新画的」—— `serialize()` 永远正常返回，擦除 / 套索 / 移动
	 * 在任何时候都拿得到几何数据。
	 *
	 * 这是「不论关闭笔记重新打开，历史笔迹都要能擦」的实现根基：我们不再依赖
	 * pdf.js 那套「把文件固有注释转成可编辑对象」的机制 —— 它要求注释层先渲染完，
	 * 时机不可控（0.4.4 的播种只跑一次、450ms 就放弃，注释没渲染出来就永久失败）。
	 *
	 * @returns 成功重建出来的那些 entry 的 `sourceId` 集合，供调用方决定「哪些
	 *          固有注释可以安全隐藏」。只 hide 重建成功的那些：万一某条数据坏了
	 *          建不出来，把原件也一并藏掉就等于笔迹凭空消失。
	 */
	async restoreStrokeEntries(entries: InkEntry[]): Promise<Set<string>> {
		const restoredSourceIds = new Set<string>();
		if (!entries.length) return restoredSourceIds;
		// 按页分组：deserialize 必须用该页自己的编辑器层
		const byPage = new Map<number, InkEntry[]>();
		for (const entry of entries) {
			const list = byPage.get(entry.page);
			if (list) list.push(entry);
			else byPage.set(entry.page, [entry]);
		}

		for (const [page, list] of byPage) {
			const layer = this.getLayer(page);
			if (!layer?.deserialize) continue;
			let idx = 0;
			for (const entry of list) {
				const id = strokeId(page, idx++);
				try {
					// pageIndex 以快照记录为准：跨页搬运过的笔迹可能与 data 里的旧值不一致。
					// ⚠️ 这里**故意不传 `id`**：InkEditor.deserialize 末尾会执行
					// `s.annotationElementId = t.id || null`，传进去就等于把我们自己
					// 编的 id 冒充成 PDF 注释 id，serialize() 会重新开始返回 null
					// （就是这次要根治的那个坑）。id 必须在 deserialize 之后、add 之前
					// 直接赋给编辑器 —— add() 内部用 editor.id 作 Map 键。
					const editor = await layer.deserialize({ ...entry.data, id: undefined, pageIndex: page });
					if (!editor) continue;
					editor.id = id;
					try {
						layer.add?.(editor); // deserialize 不保证入层；已入层时 add 自带守卫，是空操作
					} catch {
						/* 已在层里 */
					}
					// 二次确认：万一 deserialize 从别处拿到了 id，这里也不能让它留着
					if (editor.annotationElementId) editor.annotationElementId = null;
					try {
						editor.enableEditing?.();
					} catch {
						/* 非致命：不能编辑但至少看得见 */
					}
					if (entry.sourceId) restoredSourceIds.add(entry.sourceId);
				} catch {
					/* 单条失败不影响其余笔迹 */
				}
			}
		}
		return restoredSourceIds;
	}

	/**
	 * 接管 PDF 里既有的固有手写注释（0.4.x → 0.5 的迁移，且是**增量、可重入**的）。
	 *
	 * 0.4.x 是把笔迹写回 PDF 的，所以老用户的文件里躺着 `/Subtype /Ink` 注释。
	 * 新版不再写回，必须把这些笔迹接管进我们自己的数据 —— 否则它们既不属于我们的
	 * 数据（擦不掉），又会在 PDF 里继续显示（与接管后的重建体重影）。
	 *
	 * ⚠️ 刻意**不建临时编辑器**。早先的实现走的是 `layer.deserialize(el)` 再
	 * `editor.remove()`：deserialize 会把编辑器登记进层的私有 Map 与 UIManager，
	 * 而 `editor.remove()` 只摘除 DOM、不动那两张表，于是留下一批「父级为 null
	 * 但仍在册」的幽灵编辑器 —— 它们会被下一次 exportStrokeEntries 当作真实笔迹
	 * 导出，笔迹凭空翻倍，且擦掉一份还剩一份（正是用户报的「擦不掉」）。
	 *
	 * 现在改为**纯数据转换**：注释元素上本来就带着画这条笔迹所需的全部字段，
	 * 按 pdf.js `InkEditor.deserialize` 的同一映射照搬即可，全程不碰编辑层。
	 *
	 * @param skipIds 已经认领过的注释 id（含已被擦除的）—— 必须跳过，否则
	 *                用户擦掉的笔迹会在下次进入时从 PDF 原件里「复活」。
	 */
	async claimInherentInk(skipIds: Set<string> = new Set()): Promise<InkEntry[]> {
		const entries: InkEntry[] = [];
		if (!this.pageCount) return entries;

		for (let page = 0; page < this.pageCount; page++) {
			const annLayer = this.getAnnotationLayer(page);
			if (!annLayer?.getEditableAnnotations) continue;

			let elements: any[] = [];
			try {
				elements = annLayer.getEditableAnnotations() ?? [];
			} catch {
				continue; // 该页注释层还没渲染出来 —— 下一页
			}

			let idx = 0;
			for (const el of elements) {
				const d = el?.data;
				if (!d || d.subtype !== 'Ink' || !d.id) continue;
				if (skipIds.has(d.id)) continue;
				if (!Array.isArray(d.inkLists) || !d.inkLists.length) continue;

				// 颜色必须是**非空数组**：pdf.js 会把它直接塞进 SVG 的 stroke
				// （stroke: [0,0,0] 这种写法无效，笔画会整条看不见）。
				const color = Array.from((d.color ?? []) as ArrayLike<number>);
				if (color.length < 3) color.push(0, 0, 0);

				const data: Record<string, unknown> = {
					annotationType: this.constants?.AnnotationEditorType?.INK ?? 15,
					color,
					thickness: d.borderStyle?.rawWidth ?? 1,
					opacity: typeof d.opacity === 'number' ? d.opacity : 1,
					paths: { points: d.inkLists }, // 缺 lines 无妨：InkDrawOutline.deserialize 会从 points 反推
					boxes: null,
					pageIndex: page,
					rect: Array.isArray(d.rect) ? d.rect.slice(0) : d.rect,
					rotation: typeof d.rotation === 'number' ? d.rotation : 0,
					id: strokeId(page, idx),
				};
				idx++;
				entries.push({ page, data, sourceId: d.id });
			}
		}
		return entries;
	}

	/**
	 * 隐藏已被我们接管的固有注释（消除「PDF 原件 + 重建体」双影）。
	 *
	 * 只对 `ids` 里的注释动手，不碰用户用别的工具新加进来的笔迹。
	 * `hide()` 是 pdf.js 注释元素的公开方法（官方把固有注释转成编辑器时用的就是它），
	 * 只在当前会话生效，不修改文件。
	 */
	hideInherentInk(ids: Set<string>): number {
		if (!ids.size) return 0;
		let hidden = 0;
		for (let page = 0; page < this.pageCount; page++) {
			const annLayer = this.getAnnotationLayer(page);
			if (!annLayer?.getEditableAnnotations) continue;
			let elements: any[] = [];
			try {
				elements = annLayer.getEditableAnnotations() ?? [];
			} catch {
				continue;
			}
			for (const el of elements) {
				const id = el?.data?.id;
				if (!id || !ids.has(id)) continue;
				try {
					el.hide?.();
					hidden++;
				} catch {
					/* 单条失败不影响其余 */
				}
			}
		}
		return hidden;
	}

	/**
	 * AnnotationStorage 里是否存在「能真正序列化出来」的条目。
	 *
	 * 不能用 `storage.size > 0` 代替：size 是**原始条目数**，而 pdf.js 真正交给
	 * worker 的是 `serializable.map`（已过滤掉 serialize() 返回 null 的项）。
	 * 两者会分叉 —— 详见 exportAnnotatedBytes 的长注释。
	 */
	private hasSerializableContent(storage: any): boolean {
		try {
			const map = storage.serializable?.map;
			return !!map && typeof map.size === 'number' && map.size > 0;
		} catch {
			// 探测本身失败时选择「按有内容处理」：宁可多写一次（幂等），也不要漏存。
			return true;
		}
	}

	/**
	 * 清掉当前所有墨迹编辑器（只针对墨迹，不碰自由文本 / 高亮等其它编辑器）。
	 *
	 * 用途：重进手写模式前先归零。pdf.js 退出编辑模式并**不销毁**已建好的编辑器，
	 * 它们仍留在层与 UIManager 的表里；如果直接再恢复一遍，同一份数据会被建成
	 * 两套对象、共用同一组 id，后一套把前一套从表里挤掉 —— 前一套就成了看不见
	 * 又删不掉的幽灵，而导出只会拿到后一套。
	 *
	 * 走 `layer.remove()` 而不是 `editor.remove()`：前者会同步清理层与 UIManager
	 * 的两张表，后者只摘 DOM。
	 */
	clearInkEditors(): number {
		let removed = 0;
		for (let page = 0; page < this.pageCount; page++) {
			const layer = this.getLayer(page);
			if (!layer?.remove) continue;
			let editors: any[] = [];
			try {
				editors = this.getEditors(page);
			} catch {
				continue;
			}
			for (const editor of editors) {
				if (!isInkEditor(editor)) continue;
				try {
					layer.remove(editor);
					removed++;
				} catch {
					try {
						editor.remove?.();
					} catch {
						/* 单个失败不影响其余 */
					}
				}
			}
		}
		return removed;
	}

	/** 把落盘结果标记为「已保存」，清掉 pdf.js 的 dirty 状态（避免重复写盘）。 */
	markSaved(): void {
		const storage = this.handle?.pdfDocument?.annotationStorage;
		try {
			storage?.resetModified?.();
		} catch {
			/* 忽略 */
		}
	}

	/**
	 * 当前 PDF 是否已有未保存的手写批注。
	 *
	 * 必须同时看 size 与 modified —— 单独用任一个都会被一种情况带偏：
	 *   · 只看 size：size 是批注条数且**永不重置**，落盘后仍 > 0，
	 *     于是「存过一次、视图未重载」会被误报成「还有东西没存」；
	 *   · 只看 modified：ensureUIManager() 的「播种」会短暂写入一个空编辑器再移除，
	 *     期间 #setModified 已把 modified 置真。
	 */
	get hasUnsaved(): boolean {
		const storage = this.handle?.pdfDocument?.annotationStorage;
		if (!storage) return false;
		try {
			if (!(storage.size > 0)) return false;
			return typeof storage.modified === 'boolean' ? storage.modified : true;
		} catch {
			return false;
		}
	}

	/**
	 * handle 指向的 PDF 视图是否仍挂在文档上（未被销毁）。
	 *
	 * 这是「关闭文件 / 切换标签页」时的关键判断。Obsidian 销毁 PDF 视图后，
	 * `this.handle` 仍指向那个旧对象：它的 annotationStorage 里可能还留着条目
	 * （于是 hasUnsaved 依然为真），但 `saveDocument` 已随视图一同失效 ——
	 * 此时继续导出只会拿到空字节。
	 *
	 * 真机 0.4.1 的误报「手写批注保存失败：没有可写回的手写批注」就出在这里：
	 * 关闭文件触发的兜底落盘，拿着一个已经销毁的 handle 去导出。
	 */
	get isHandleAlive(): boolean {
		const root = this.handle?.viewer?.viewer as HTMLElement | undefined;
		if (!root) return false;
		try {
			return root.isConnected;
		} catch {
			return false;
		}
	}

	/* ------------------------------ 辅助 ------------------------------ */

	/** 页面 DOM 元素（坐标换算用）。 */
	getPageElement(pageNumber: number): HTMLElement | null {
		const root: HTMLElement | undefined = this.handle?.viewer?.viewer;
		if (!root) return null;
		return root.querySelector<HTMLElement>(`.page[data-page-number="${pageNumber}"]`);
	}

	/** 当前缩放比（从 .pdfViewer 的 --scale-factor 读，与 pdf.js 内部一致）。 */
	getScaleFactor(): number {
		const root: HTMLElement | undefined = this.handle?.viewer?.viewer;
		if (!root) return 1;
		const raw = getComputedStyle(root).getPropertyValue('--scale-factor');
		const n = Number.parseFloat(raw);
		return Number.isFinite(n) && n > 0 ? n : 1;
	}

	/** 该 PDF 对应的 vault 文件。 */
	getFile(): TFile | null {
		const p = this.handle?.filePath;
		if (!p) return null;
		const f = this.app.vault.getAbstractFileByPath(p);
		return f instanceof TFile ? f : null;
	}
}
