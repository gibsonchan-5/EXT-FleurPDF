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
			return { ok: after === mode, before, after };
		} catch (err) {
			// 门闩未开（viewer 尚未 setDocument）时会抛 "The AnnotationEditor is not enabled."
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
	async setModeAsync(mode: number, timeoutMs = 1500): Promise<InkOpResult & { before: number; after: number }> {
		const r = this.setMode(mode);
		if (r.ok && this.getMode() === mode) return r; // 同步路径已经搞定
		const ok = await this.waitForMode(mode, timeoutMs);
		const after = this.getMode();
		return { ...r, ok: ok && r.ok, after };
	}

	/**
	 * 等到模式变成目标值（或超时返回 false）。优先用 `annotationeditormodechanged` 事件，
	 * 没 eventBus 时退化为短间隔轮询。
	 */
	private waitForMode(targetMode: number, timeoutMs = 1500): Promise<boolean> {
		if (this.getMode() === targetMode) return Promise.resolve(true);
		const bus = this.handle?.eventBus;
		if (!bus?.on) {
			return new Promise((resolve) => {
				const deadline = Date.now() + timeoutMs;
				const tick = () => {
					if (this.getMode() === targetMode) return resolve(true);
					if (Date.now() > deadline) return resolve(false);
					window.setTimeout(tick, 30);
				};
				tick();
			});
		}
		return new Promise((resolve) => {
			let done = false;
			const finish = (ok: boolean) => {
				if (done) return;
				done = true;
				resolve(ok);
			};
			const timer = window.setTimeout(() => {
				try { bus.off?.('annotationeditormodechanged', onChanged); } catch { /* ignore */ }
				finish(this.getMode() === targetMode);
			}, timeoutMs);
			const onChanged = (payload: any) => {
				if (payload?.mode === targetMode) {
					window.clearTimeout(timer);
					try { bus.off?.('annotationeditormodechanged', onChanged); } catch { /* ignore */ }
					finish(true);
				}
			};
			try {
				bus.on('annotationeditormodechanged', onChanged);
			} catch {
				finish(this.getMode() === targetMode);
			}
		});
	}

	/** 进入手写模式（黑/墨迹）—— 异步版本，等模式真落盘。 */
	enterInk(): Promise<InkOpResult> {
		return this.setModeAsync(this.constants?.AnnotationEditorType.INK ?? 15).then((r) => ({ ok: r.ok, error: r.error }));
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
	enterMarker(): Promise<InkOpResult> {
		return this.setModeAsync(this.constants?.AnnotationEditorType.INK ?? 15).then((r) => ({ ok: r.ok, error: r.error }));
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
	 * 本方法只负责「生成字节」，不写盘。写盘与备份由 ink-storage.ts 承担。
	 */
	async exportAnnotatedBytes(): Promise<Uint8Array | null> {
		const doc = this.handle?.pdfDocument;
		if (!doc?.saveDocument) return null;
		const storage = doc.annotationStorage;
		if (!storage || !storage.size) return null;
		try {
			const bytes: Uint8Array = await doc.saveDocument(storage);
			return bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
		} catch {
			return null;
		}
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
