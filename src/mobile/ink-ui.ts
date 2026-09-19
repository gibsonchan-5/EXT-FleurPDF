// 移动端手写批注的 UI 层：模式切换 + 笔盒 + 双指滚动。
//
// 设计原则（对齐 fleur-pdf 既有设计语言与 FleurEPUB 的移动端做法）：
//   · 只在 isMobileUI() 为真时创建，桌面端不实例化、不注入样式；
//   · pdf.js 原生的 editToolbar 整块隐藏，UI 全部换成自己的；
//   · 手写模式是一个「模式」，与原有的文本批注编辑模式并列切换，互不干扰。
//
// R9（手写模式独占触摸）是本层必须自建的东西：
//   实测确认手写模式下触摸被 pdf.js 独占，单指滑动 scrollTop 变化恒为 0。
//   因此这里用「双指手势接管」：捕获阶段拦下第二个触点，取消已起手的绘制，
//   然后自己驱动滚动。这比让用户「退出手写再滚」顺手得多。

import { Notice, setIcon } from 'obsidian';
import type FleurPDFPlugin from '../main';
import type { InkEngine, PenSpec } from './ink-engine';
import { eraseAtPoint, toPdfPoint } from './ink-erase';
import { lassoHitEditors, lassoPolyToPdf, moveEditorBy, screenBBoxOfEditors, type ScreenPoint } from './ink-lasso';
import { InkStorage } from './ink-storage';

/** PDF 滚动容器（与 patcher.ts 用的是同一组选择器）。 */
const SCROLL_SELECTOR = '.pdf-container, .pdf-viewer-container, .pdf-container';

/** 首版四笔。钢笔走墨迹通道，荧光笔走自由高亮通道，橡皮是自建行为，套索圈选移动。 */
export const DEFAULT_PENS: PenSpec[] = [
	{ kind: 'pen', color: '#1f1f1f', thickness: 3, opacity: 1 },
	{ kind: 'marker', color: '#ffe066', thickness: 14, opacity: 1 },
	{ kind: 'eraser', color: '', thickness: 16, opacity: 1 },
	{ kind: 'lasso', color: '', thickness: 12, opacity: 1 },
];

/** 钢笔可选色（沿用 fleur-pdf 已有的标注配色基调：深金 / 深蓝 / 深红）。 */
const PEN_COLORS = ['#1f1f1f', '#D4A017', '#2979C4', '#D32F2F', '#2E7D32'];
/** 荧光笔可选色。 */
const MARKER_COLORS = ['#ffe066', '#a5f3b0', '#9fd8ff', '#ffb3c8', '#e0c3ff'];
/** 粗细档位（PDF 用户空间单位）。 */
const PEN_SIZES = [2, 3, 5, 8];
const MARKER_SIZES = [10, 14, 20, 28];

/** 笔的种类 → 图标 / 无障碍名（lucide 图标名，Obsidian setIcon 消费）。 */
const PEN_ICON: Record<PenSpec['kind'], string> = {
	pen: 'pen-tool',
	marker: 'highlighter',
	eraser: 'eraser',
	lasso: 'lasso-select',
};
const PEN_LABEL: Record<PenSpec['kind'], string> = {
	pen: '钢笔',
	marker: '荧光笔',
	eraser: '橡皮',
	lasso: '套索',
};

export class InkUI {
	private toggleBtn: HTMLElement | null = null;
	/** 双态切换器的两段：编辑 / 手写。 */
	private editSeg: HTMLElement | null = null;
	private inkSeg: HTMLElement | null = null;
	private penBar: HTMLElement | null = null;
	private scrollHost: HTMLElement | null = null;
	private detachTwoFinger: (() => void) | null = null;

	/** 是否处于手写模式。 */
	private active = false;
	/** 本次进入手写时是否拿不到 UIManager（笔参数/橡皮/撤销不可用，但书写仍可）。 */
	private umMissing = false;
	/** 当前选中的笔序号（对应 DEFAULT_PENS）。 */
	private penIndex = 0;
	/** 每支笔的当前参数（颜色/粗细按笔独立记忆）。 */
	private readonly pens: PenSpec[] = DEFAULT_PENS.map((p) => ({ ...p }));
	/** 手写模式激活期间是否只允许笔输入（真机笔 vs 手指）。 */
	private readonly storage: InkStorage;

	constructor(
		private plugin: FleurPDFPlugin,
		private engine: InkEngine,
	) {
		this.storage = new InkStorage(plugin.app);
	}

	/* ============================ 挂载 / 卸载 ============================ */

	/** M3-A：挂载指引每次插件会话只提示一次（ InkUI 可能因开关切换被多次 mount/unmount）。 */
	private static mountHintShown = false;

	mount(): void {
		if (this.toggleBtn) return;

		// M3-B：显式双态切换器（常驻胶囊，右下角）。替代原先那颗藏起来的 44px 单钮——
		// 用户实测反馈「看不到变化」，根因就是入口可发现性太差。
		// 编辑段 → 退出手写；手写段 → 进入手写。当前态高亮，两种模式下都常驻。
		const sw = document.body.createDiv('fleur-pdf-ink-toggle');

		const editBtn = sw.createDiv('fleur-pdf-ink-switch-btn');
		setIcon(editBtn, 'type');
		editBtn.setAttribute('aria-label', '编辑模式');
		editBtn.addEventListener('click', (e) => {
			e.preventDefault();
			e.stopPropagation();
			if (this.active) void this.exitInk();
		});

		const inkBtn = sw.createDiv('fleur-pdf-ink-switch-btn');
		setIcon(inkBtn, 'pen-tool');
		inkBtn.setAttribute('aria-label', '手写批注');
		inkBtn.addEventListener('click', (e) => {
			e.preventDefault();
			e.stopPropagation();
			if (!this.active) void this.enterInk();
		});

		this.editSeg = editBtn;
		this.inkSeg = inkBtn;
		this.toggleBtn = sw;
		this.syncSwitcher();

		document.body.addEventListener('click', this.onBodyClick, true);

		// M3-A：首次挂载给一条指引入口在哪（只在本会话第一次出现）。
		if (!InkUI.mountHintShown) {
			InkUI.mountHintShown = true;
			new Notice('FleurPDF 手写批注已就绪：点击右下角的“手写”按钮开始批注');
		}
	}

	/** 同步双态切换器的高亮（编辑段 / 手写段互斥）。 */
	private syncSwitcher(): void {
		this.editSeg?.toggleClass('is-active', !this.active);
		this.inkSeg?.toggleClass('is-active', this.active);
	}

	unmount(): void {
		document.body.removeEventListener('click', this.onBodyClick, true);
		if (this.active) this.exitInk();
		this.toggleBtn?.remove();
		this.toggleBtn = null;
		this.editSeg = null;
		this.inkSeg = null;
	}

	/** 点空白处收起「颜色/粗细」展开面板（笔盒本身不收起）。 */
	private readonly onBodyClick = (e: MouseEvent): void => {
		const t = e.target as HTMLElement | null;
		if (!t) return;
		if (t.closest('.fleur-pdf-ink-bar')) return;
		this.penBar?.findAll('.fleur-pdf-ink-pop').forEach((el) => el.removeClass('is-open'));
	};

	/* ============================ 模式切换 ============================ */

	async enterInk(): Promise<void> {
		// 每次进入都重新解析：视图可能刚被重建（切换文件、重新打开）
		const handle = await this.engine.resolve();
		if (!handle) {
			const why = this.engine.resolveError ?? 'unknown';
			new Notice(`手写模式不可用（${why}），详情见控制台`);
			console.warn('[FleurPDF Ink] resolve() 失败:', why, this.engine.resolveDebug);
			return;
		}

		// ⚠️ 顺序不可颠倒：必须**先进入编辑模式**，引擎才可能补齐 UIManager。
		// 因为兜底路径「播种编辑器」依赖当前模式（模式为 0 时 pdf.js 造不出编辑器），
		// 而笔色/粗细又必须在第一笔落墨**之前**下发。
		const pen = this.pens[this.penIndex];
		const res = pen.kind === 'marker' ? this.engine.enterMarker() : this.engine.enterInk();
		if (!res.ok) {
			new Notice(`手写模式不可用：${res.error ?? '未知原因'}`);
			return;
		}

		await this.applyActivePen();

		this.active = true;
		document.body.addClass('fleur-pdf-ink-active');
		this.syncSwitcher();
		this.syncMarkerClass();
		this.buildPenBar();
		this.attachTwoFingerScroll();
		// 按当前笔恢复输入接管（上次退出时可能停在橡皮 / 套索上）
		const activeKind = this.pens[this.penIndex].kind;
		this.setPenInputMode(activeKind === 'eraser' ? 'eraser' : activeKind === 'lasso' ? 'lasso' : 'draw');

		// 拿不到 UIManager 时「写」仍然正常，但笔参数、橡皮、撤销会静默失效。
		// 这是用户最难自行诊断的失败形态（看起来像按钮坏了），必须明说。
		if (!this.engine.getUIManager()) {
			this.umMissing = true;
			new Notice('手写已开启，但当前 PDF 视图的批注接口不可用：可书写，笔色 / 橡皮 / 撤销暂不可用');
		} else {
			this.umMissing = false;
		}
	}

	async exitInk(): Promise<void> {
		// 先提交：supportMultipleDrawings=true 时 pointerup 不会生成编辑器，
		// 必须显式提交（或切模式，这里两者都做），否则最后一笔会丢。
		this.engine.commit();
		this.engine.exit();

		this.clearLasso();

		this.active = false;
		document.body.removeClass('fleur-pdf-ink-active');
		document.body.removeClass('fleur-pdf-ink-marker');
		this.syncSwitcher();
		this.detachTwoFingerScroll();
		this.penBar?.remove();
		this.penBar = null;
	}

	/** 把手写层的待保存批注写回 PDF。 */
	private async save(): Promise<void> {
		// 提交当前会话，否则最后一笔不在存储里
		this.engine.commit();
		await new Promise((r) => window.setTimeout(r, 80));

		if (!this.engine.hasUnsaved) {
			new Notice('没有需要保存的手写批注');
			return;
		}
		const file = this.engine.getFile();
		if (!file) {
			new Notice('找不到对应的 PDF 文件');
			return;
		}

		const out = await this.storage.saveAnnotated(this.engine, file);
		if (out.ok) {
			new Notice(`已写入手写批注（${Math.round((out.bytes ?? 0) / 1024)} KB）`);
			// 文件已被改写，重开视图才能拿到干净的状态
			await this.exitInk();
		} else {
			new Notice(`写入失败：${out.error ?? '未知原因'}`);
		}
	}

	/* ============================ 笔盒 ============================ */

	private buildPenBar(): void {
		this.penBar?.remove();
		const bar = document.body.createDiv('fleur-pdf-ink-bar');
		this.penBar = bar;

		// ── 笔 ──
		const penGroup = bar.createDiv('fleur-pdf-ink-group');
		this.pens.forEach((pen, i) => {
			const btn = penGroup.createDiv('fleur-pdf-ink-btn');
			setIcon(btn, PEN_ICON[pen.kind]);
			btn.setAttribute('aria-label', PEN_LABEL[pen.kind]);
			if (i === this.penIndex) btn.addClass('is-active');
			btn.addEventListener('click', (e) => {
				e.stopPropagation();
				void this.selectPen(i);
			});
		});

		// ── 颜色 ──
		const colorBtn = bar.createDiv('fleur-pdf-ink-btn');
		setIcon(colorBtn, 'palette');
		colorBtn.setAttribute('aria-label', '颜色');
		colorBtn.createDiv('fleur-pdf-ink-swatch').setCssStyles({
			background:
				this.pens[this.penIndex].kind === 'eraser' || this.pens[this.penIndex].kind === 'lasso'
					? 'transparent'
					: this.pens[this.penIndex].color,
		});
		const colorPop = this.buildColorPop();
		bar.appendChild(colorPop);
		colorBtn.addEventListener('click', (e) => {
			e.stopPropagation();
			this.closePops(colorPop);
			colorPop.toggleClass('is-open', !colorPop.hasClass('is-open'));
		});

		// ── 粗细 ──
		const sizeBtn = bar.createDiv('fleur-pdf-ink-btn');
		setIcon(sizeBtn, 'circle-dot');
		sizeBtn.setAttribute('aria-label', '粗细');
		const sizePop = this.buildSizePop();
		bar.appendChild(sizePop);
		sizeBtn.addEventListener('click', (e) => {
			e.stopPropagation();
			this.closePops(sizePop);
			sizePop.toggleClass('is-open', !sizePop.hasClass('is-open'));
		});

		bar.createDiv('fleur-pdf-ink-sep');

		// ── 撤销 / 重做 ──
		const undoBtn = bar.createDiv('fleur-pdf-ink-btn');
		setIcon(undoBtn, 'undo-2');
		undoBtn.setAttribute('aria-label', '撤销');
		undoBtn.addEventListener('click', (e) => {
			e.stopPropagation();
			this.engine.undo();
		});

		const redoBtn = bar.createDiv('fleur-pdf-ink-btn');
		setIcon(redoBtn, 'redo-2');
		redoBtn.setAttribute('aria-label', '重做');
		redoBtn.addEventListener('click', (e) => {
			e.stopPropagation();
			this.engine.redo();
		});

		// ── 删除选中（仅套索激活时出现：删除的是套索圈中的选择集）──
		if (this.pens[this.penIndex].kind === 'lasso') {
			const delBtn = bar.createDiv('fleur-pdf-ink-btn');
			setIcon(delBtn, 'trash-2');
			delBtn.setAttribute('aria-label', '删除选中');
			delBtn.addEventListener('click', (e) => {
				e.stopPropagation();
				this.deleteLassoSelection();
			});
		}

		bar.createDiv('fleur-pdf-ink-sep');

		// ── 保存 / 完成 ──
		const saveBtn = bar.createDiv('fleur-pdf-ink-btn is-primary');
		setIcon(saveBtn, 'save');
		saveBtn.setAttribute('aria-label', '写回 PDF');
		saveBtn.addEventListener('click', (e) => {
			e.stopPropagation();
			void this.save();
		});

		const doneBtn = bar.createDiv('fleur-pdf-ink-btn');
		setIcon(doneBtn, 'check');
		doneBtn.setAttribute('aria-label', '退出手写模式');
		doneBtn.addEventListener('click', (e) => {
			e.stopPropagation();
			void this.exitInk();
		});
	}

	private closePops(except: HTMLElement): void {
		this.penBar?.findAll('.fleur-pdf-ink-pop').forEach((el) => {
			if (el !== except) el.removeClass('is-open');
		});
	}

	private buildColorPop(): HTMLElement {
		const pop = createDiv('fleur-pdf-ink-pop fleur-pdf-ink-colors');
		const isMarker = this.pens[this.penIndex].kind === 'marker';
		const colors = isMarker ? MARKER_COLORS : PEN_COLORS;
		for (const c of colors) {
			const dot = pop.createDiv('fleur-pdf-ink-color');
			dot.setCssStyles({ background: c });
			if (c === this.pens[this.penIndex].color) dot.addClass('is-active');
			dot.addEventListener('click', (e) => {
				e.stopPropagation();
				void this.setColor(c);
			});
		}
		return pop;
	}

	private buildSizePop(): HTMLElement {
		const pop = createDiv('fleur-pdf-ink-pop fleur-pdf-ink-sizes');
		const isMarker = this.pens[this.penIndex].kind === 'marker';
		const sizes = isMarker ? MARKER_SIZES : PEN_SIZES;
		for (const s of sizes) {
			const item = pop.createDiv('fleur-pdf-ink-size');
			item.createDiv('fleur-pdf-ink-size-dot').setCssStyles({
				width: `${Math.min(4 + s, 18)}px`,
				height: `${Math.min(4 + s, 18)}px`,
			});
			if (s === this.pens[this.penIndex].thickness) item.addClass('is-active');
			item.addEventListener('click', (e) => {
				e.stopPropagation();
				void this.setSize(s);
			});
		}
		return pop;
	}

	/* ============================ 笔操作 ============================ */

	private async selectPen(i: number): Promise<void> {
		this.penIndex = i;
		const pen = this.pens[i];
		// 离开套索时清掉选择集 —— 带着选择去画/擦，行为会互相纠缠
		if (pen.kind !== 'lasso') this.clearLasso();
		await this.applyActivePen();
		if (pen.kind === 'eraser') {
			this.setPenInputMode('eraser');
		} else if (pen.kind === 'lasso') {
			// 套索不改 annotationEditorMode（与橡皮同理：输入层接管）。
			// 但若当前不在任何编辑模式（首笔就是套索），先进墨迹模式让编辑器存在。
			if (!this.engine.getMode()) this.engine.enterInk();
			this.setPenInputMode('lasso');
		} else if (pen.kind === 'marker') {
			this.engine.enterMarker();
			this.setPenInputMode('draw');
		} else {
			this.engine.enterInk();
			this.setPenInputMode('draw');
		}
		this.syncMarkerClass();
		this.refreshPenBar();
	}

	/**
	 * 荧光笔选中态同步到 body class。
	 * 对应 ink-css.ts 里的规则：关掉 textLayer span 的指针事件，
	 * 让荧光笔的拖拽永远走 pdf.js 的自由高亮闸门（而不是选字 marquee）。
	 */
	private syncMarkerClass(): void {
		const on = this.active && this.pens[this.penIndex].kind === 'marker';
		document.body.toggleClass('fleur-pdf-ink-marker', on);
	}

	private async setColor(color: string): Promise<void> {
		this.pens[this.penIndex].color = color;
		await this.applyActivePen();
		this.refreshPenBar();
	}

	private async setSize(size: number): Promise<void> {
		this.pens[this.penIndex].thickness = size;
		await this.applyActivePen();
		this.refreshPenBar();
	}

	private async applyActivePen(): Promise<void> {
		const pen = this.pens[this.penIndex];
		// 橡皮 / 套索没有「笔参数」可下发（橡皮是输入层接管，套索不落墨）
		if (pen.kind === 'eraser' || pen.kind === 'lasso') return;
		this.engine.applyPen(pen);
	}

	/** 重绘笔盒（选中态、颜色方块、粗细圆点都要跟着变）。 */
	private refreshPenBar(): void {
		const wasActive = this.active;
		this.buildPenBar();
		if (!wasActive) this.penBar?.remove();
	}

	/* ============================ 输入接管 ============================ */

	private eraserDetach: (() => void) | null = null;
	private lassoDetach: (() => void) | null = null;

	/**
	 * 切换输入行为。
	 *   draw    —— 交给 pdf.js（它已经接好了 pointer 监听）
	 *   eraser  —— 由我们接管：拦截 pointer 事件，做笔画级擦除
	 *   lasso   —— 由我们接管：圈选 / 移动 / 删除已写的笔画
	 */
	private setPenInputMode(mode: 'draw' | 'eraser' | 'lasso'): void {
		this.eraserDetach?.();
		this.eraserDetach = null;
		this.lassoDetach?.();
		this.lassoDetach = null;
		if (mode === 'eraser') this.attachEraser();
		else if (mode === 'lasso') this.attachLasso();
	}

	private attachEraser(): void {
		const host = this.scrollHost ?? document.body;

		const onDown = (e: PointerEvent) => {
			// 双指手势优先给滚动逻辑（它在捕获阶段，正常会先于这里被处理）
			if (e.isPrimary === false) return;
			this.eraserDown = true;
			this.lastErasePt = null;
			void this.eraseAt(e.clientX, e.clientY);
			e.preventDefault();
			e.stopPropagation();
		};
		const onMove = (e: PointerEvent) => {
			if (!this.eraserDown) return;
			e.preventDefault();
			e.stopPropagation();
			void this.eraseAt(e.clientX, e.clientY);
		};
		const onUp = () => {
			this.eraserDown = false;
			this.lastErasePt = null;
		};

		host.addEventListener('pointerdown', onDown, { capture: true });
		host.addEventListener('pointermove', onMove, { capture: true });
		host.addEventListener('pointerup', onUp, { capture: true });
		host.addEventListener('pointercancel', onUp, { capture: true });

		this.eraserDetach = () => {
			host.removeEventListener('pointerdown', onDown, { capture: true });
			host.removeEventListener('pointermove', onMove, { capture: true });
			host.removeEventListener('pointerup', onUp, { capture: true });
			host.removeEventListener('pointercancel', onUp, { capture: true });
		};
	}

	/* ---------------- 橡皮擦除调度 ----------------
	 * 灵敏度的三个来源（v0.5 用户实测「不太灵敏」后修正）：
	 *  1. 快速拖动时 pointermove 事件之间有间距 —— 旧实现只在事件点擦，
	 *     中间的笔画整段漏掉。现在沿「上一点 → 当前点」线段按步长插值补点；
	 *  2. 每次命中都涉及 serialize/deserialize 重建，异步 —— 旧实现用 45ms
	 *     时间节流硬拦，反而放大了间距问题。现在改为忙队列：进行中只记
	 *     最新坐标，结束后立刻补擦；
	 *  3. 命中半径过小 —— 放宽到 max(10, 笔粗 × 1.25)。
	 */
	private eraserDown = false;
	private eraserBusy = false;
	private pendingErase: { x: number; y: number } | null = null;
	private lastErasePt: { x: number; y: number } | null = null;

	private async eraseAt(clientX: number, clientY: number): Promise<void> {
		if (this.eraserBusy) {
			this.pendingErase = { x: clientX, y: clientY };
			return;
		}
		this.eraserBusy = true;
		try {
			const last = this.lastErasePt ?? { x: clientX, y: clientY };
			const dist = Math.hypot(clientX - last.x, clientY - last.y);
			const step = Math.max(4, (this.pens[this.penIndex].thickness || 8) * 0.5);
			const n = Math.max(1, Math.ceil(dist / step));
			for (let i = 1; i <= n; i++) {
				const px = last.x + ((clientX - last.x) * i) / n;
				const py = last.y + ((clientY - last.y) * i) / n;
				await this.eraseSingle(px, py);
				// 用户已松手就不再沿旧轨迹补擦
				if (!this.eraserDown) return;
			}
			this.lastErasePt = { x: clientX, y: clientY };
		} finally {
			this.eraserBusy = false;
			const p = this.pendingErase;
			this.pendingErase = null;
			if (p && this.eraserDown) void this.eraseAt(p.x, p.y);
		}
	}

	/** 在单个视口坐标点擦一次（旧 eraseAt 去掉时间节流后的本体）。 */
	private async eraseSingle(clientX: number, clientY: number): Promise<void> {
		const pageEl = (document.elementFromPoint(clientX, clientY) as HTMLElement | null)?.closest<HTMLElement>('.page');
		const pageNumber = Number(pageEl?.dataset.pageNumber ?? '1');
		if (!Number.isFinite(pageNumber) || pageNumber < 1) return;

		const point = toPdfPoint(this.engine, clientX, clientY, pageNumber);
		if (!point) return;

		await eraseAtPoint(this.engine, point, { radius: this.pens[this.penIndex].thickness });
	}

	/* ============================ 套索 ============================ */

	/**
	 * 套索状态机（参考 GoodNotes）：
	 *   · 在空白处拖一圈 → 圈中的墨迹注释整组入选（pdf.js 原生多选蓝框）；
	 *   · 在选择集包围盒内起手拖动 → 群组移动（拖动中 CSS transform 跟手，松手契约重建）；
	 *   · 在选择外轻点 → 取消选择。
	 * 与橡皮同理：捕获阶段接管 pointer，pdf.js 完全看不到这些事件。
	 */
	private lassoDown = false;
	private lassoGesture: 'idle' | 'select' | 'move' = 'idle';
	private lassoStart: ScreenPoint = { x: 0, y: 0 };
	private lassoPts: ScreenPoint[] = [];
	/** 当前选择集（编辑器实例）与其所在页码。 */
	private lassoSelection: any[] = [];
	private lassoPageNumber = 0;
	/** 移动中的实时位移（屏幕 px），松手时换算成 PDF 坐标重建。 */
	private lassoOverlay: SVGSVGElement | null = null;
	private lassoPathEl: SVGPathElement | null = null;

	private attachLasso(): void {
		const host = this.scrollHost ?? document.body;

		const onDown = (e: PointerEvent) => {
			if (e.isPrimary === false) return;
			this.lassoDown = true;
			this.lassoGesture = 'idle';
			this.lassoStart = { x: e.clientX, y: e.clientY };
			this.lassoPts = [this.lassoStart];
			e.preventDefault();
			e.stopPropagation();
		};

		const onMove = (e: PointerEvent) => {
			if (!this.lassoDown) return;
			e.preventDefault();
			e.stopPropagation();
			const pt = { x: e.clientX, y: e.clientY };

			// 首次移动时决定手势：选择集内起手 → 移动；否则 → 圈选
			if (this.lassoGesture === 'idle') {
				const box = this.lassoSelection.length ? screenBBoxOfEditors(this.lassoSelection) : null;
				const inside =
					!!box &&
					this.lassoStart.x >= box.minX - 4 &&
					this.lassoStart.x <= box.maxX + 4 &&
					this.lassoStart.y >= box.minY - 4 &&
					this.lassoStart.y <= box.maxY + 4;
				this.lassoGesture = inside ? 'move' : 'select';
				if (this.lassoGesture === 'select') this.clearLassoSelectionOnly();
			}

			if (this.lassoGesture === 'move') {
				const dx = pt.x - this.lassoStart.x;
				const dy = pt.y - this.lassoStart.y;
				for (const editor of this.lassoSelection) {
					const div: HTMLElement | null = editor?.div ?? null;
					if (div?.isConnected) div.style.transform = `translate(${dx}px, ${dy}px)`;
				}
			} else if (this.lassoGesture === 'select') {
				const last = this.lassoPts[this.lassoPts.length - 1];
				if (Math.hypot(pt.x - last.x, pt.y - last.y) >= 3) this.lassoPts.push(pt);
				this.drawLassoPath();
			}
		};

		const onUp = (e: PointerEvent) => {
			if (!this.lassoDown) return;
			this.lassoDown = false;
			const pt = { x: e.clientX, y: e.clientY };
			const gesture = this.lassoGesture;
			this.lassoGesture = 'idle';

			if (gesture === 'move') {
				this.finishLassoMove(pt);
			} else if (gesture === 'select') {
				this.finishLassoSelect(pt);
			} else {
				// 原地轻点：在选择外 → 取消选择
				this.clearLassoSelectionOnly();
				this.clearLassoPath();
			}
		};

		host.addEventListener('pointerdown', onDown, { capture: true });
		host.addEventListener('pointermove', onMove, { capture: true });
		host.addEventListener('pointerup', onUp, { capture: true });
		host.addEventListener('pointercancel', onUp, { capture: true });

		this.lassoDetach = () => {
			host.removeEventListener('pointerdown', onDown, { capture: true });
			host.removeEventListener('pointermove', onMove, { capture: true });
			host.removeEventListener('pointerup', onUp, { capture: true });
			host.removeEventListener('pointercancel', onUp, { capture: true });
		};
	}

	/** 圈选收尾：闭合多边形 → 命中测试 → 整组入选。 */
	private finishLassoSelect(endPt: ScreenPoint): void {
		const pts = [...this.lassoPts, endPt];
		this.clearLassoPath();

		// 轻点（拖动距离过小）：在选择外点一下 = 取消选择
		const minX = Math.min(...pts.map((p) => p.x));
		const maxX = Math.max(...pts.map((p) => p.x));
		const minY = Math.min(...pts.map((p) => p.y));
		const maxY = Math.max(...pts.map((p) => p.y));
		if (Math.max(maxX - minX, maxY - minY) < 12) {
			this.clearLassoSelectionOnly();
			return;
		}

		// 圈选起点落在哪一页，就只在那一页找（v1 约束：跨页套索不做）
		const pageEl = (document.elementFromPoint(pts[0].x, pts[0].y) as HTMLElement | null)?.closest<HTMLElement>(
			'.page',
		);
		const pageNumber = Number(pageEl?.dataset.pageNumber ?? '1');
		if (!Number.isFinite(pageNumber) || pageNumber < 1) return;

		const poly = lassoPolyToPdf(this.engine, pts, pageNumber);
		if (!poly) return;

		const hits = lassoHitEditors(this.engine, pageNumber - 1, poly);
		if (!hits.length) {
			this.clearLassoSelectionOnly();
			return;
		}
		const r = this.engine.selectMany(hits);
		this.lassoSelection = hits;
		this.lassoPageNumber = pageNumber;
		if (!r.ok) new Notice(`圈选完成，但部分笔画未能入选（${r.failed} 个）`);
	}

	/** 移动收尾：撤掉 transform，按最终位移做契约重建（删旧建新）。 */
	private finishLassoMove(endPt: ScreenPoint): void {
		const dxPx = endPt.x - this.lassoStart.x;
		const dyPx = endPt.y - this.lassoStart.y;
		const selection = this.lassoSelection;
		this.lassoSelection = [];
		this.clearLassoPath();

		// 位移太小当作误触：还原 transform 即可
		const scale = this.engine.getScaleFactor() || 1;
		if (Math.hypot(dxPx, dyPx) < 4) {
			for (const editor of selection) {
				const div: HTMLElement | null = editor?.div ?? null;
				if (div) div.style.transform = '';
			}
			return;
		}

		const dx = dxPx / scale;
		const dy = -dyPx / scale; // PDF y 轴向上

		void (async () => {
			const rebuiltEditors: any[] = [];
			for (const editor of selection) {
				const div: HTMLElement | null = editor?.div ?? null;
				if (div) div.style.transform = '';
				const r = await moveEditorBy(this.engine, editor, dx, dy);
				if (r.ok && r.rebuilt) rebuiltEditors.push(r.rebuilt);
				else if (r.error) console.warn('[FleurPDF Ink] 套索移动失败:', r.error);
			}
			this.engine.unselectAll();
			if (rebuiltEditors.length) {
				// 重建后的编辑器保持入选，方便连续拖动
				this.engine.selectMany(rebuiltEditors);
				this.lassoSelection = rebuiltEditors;
				this.lassoPageNumber = Number(rebuiltEditors[0]?.pageIndex ?? 0) + 1;
			}
			this.engine.commit();
		})();
	}

	/** 删除当前选择集（笔盒上的垃圾桶）。 */
	private deleteLassoSelection(): void {
		if (!this.lassoSelection.length) {
			new Notice('先用套索圈选要删除的笔画');
			return;
		}
		const n = this.lassoSelection.length;
		const r = this.engine.deleteSelected();
		if (r.ok) {
			new Notice(`已删除 ${n} 条手写批注`);
			this.clearLassoSelectionOnly();
			this.engine.commit();
			this.refreshPenBar();
		} else {
			new Notice(`删除失败：${r.error ?? '未知原因'}`);
		}
	}

	private clearLassoSelectionOnly(): void {
		this.lassoSelection = [];
		try {
			this.engine.unselectAll();
		} catch {
			/* 忽略 */
		}
	}

	private clearLasso(): void {
		this.lassoDown = false;
		this.lassoGesture = 'idle';
		this.lassoSelection = [];
		this.lassoPageNumber = 0;
		this.clearLassoPath();
	}

	/* ---- 圈选虚线的实时预览（fixed 全屏 SVG，pointer-events:none）---- */

	private ensureLassoOverlay(): void {
		if (this.lassoOverlay?.isConnected) return;
		const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
		svg.setAttribute('class', 'fleur-pdf-lasso-overlay');
		const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
		svg.appendChild(path);
		document.body.appendChild(svg);
		this.lassoOverlay = svg;
		this.lassoPathEl = path;
	}

	private drawLassoPath(): void {
		this.ensureLassoOverlay();
		if (!this.lassoPathEl || !this.lassoPts.length) return;
		const d = this.lassoPts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' ');
		this.lassoPathEl.setAttribute('d', d);
	}

	private clearLassoPath(): void {
		this.lassoPathEl?.setAttribute('d', '');
		this.lassoOverlay?.remove();
		this.lassoOverlay = null;
		this.lassoPathEl = null;
	}

	/* ============================ 双指滚动（R9） ============================ */

	/**
	 * 手写模式下 pdf.js 独占触摸（实测 scrollTop Δ 恒为 0）。
	 * 这里在捕获阶段接管第二个触点：取消已起手的绘制，然后自己驱动滚动。
	 *
	 * 为什么必须「取消已起手的绘制」：第一个手指的 pointerdown 一定先于第二个到达
	 * pdf.js（pointerdown 早于 touchstart），此时它已经开始画了。第二个触点出现后
	 * 向编辑层补发一个 pointercancel，是 pdf.js 自己的「放弃本笔」语义。
	 */
	private attachTwoFingerScroll(): void {
		if (this.detachTwoFinger) return;

		const host =
			(document.querySelector(SCROLL_SELECTOR) as HTMLElement | null) ??
			(this.engine.getPageElement(1)?.parentElement ?? null);
		if (!host) return;
		this.scrollHost = host;

		const pointers = new Map<number, { x: number; y: number }>();
		let scrolling = false;
		let startY = 0;
		let startScrollTop = 0;

		const centerY = () => {
			let sum = 0;
			for (const p of pointers.values()) sum += p.y;
			return pointers.size ? sum / pointers.size : 0;
		};

		const beginScroll = (): void => {
			scrolling = true;
			startY = centerY();
			startScrollTop = host.scrollTop;
			// 让 pdf.js 放弃已经开始的那一笔
			const layerDiv = host.querySelector('.annotationEditorLayer');
			for (const id of pointers.keys()) {
				try {
					layerDiv?.dispatchEvent(
						new PointerEvent('pointercancel', { pointerId: id, bubbles: true, cancelable: true }),
					);
				} catch {
					/* 老 WebView 不支持 PointerEvent 构造时忽略 */
				}
			}
		};

		const onDown = (e: PointerEvent) => {
			if (e.pointerType !== 'touch') return;
			pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
			if (pointers.size === 2) {
				beginScroll();
				e.stopPropagation();
				e.preventDefault();
			}
		};

		const onMove = (e: PointerEvent) => {
			if (!pointers.has(e.pointerId)) return;
			pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
			if (!scrolling) return;
			e.stopPropagation();
			e.preventDefault();
			host.scrollTop = startScrollTop - (centerY() - startY);
		};

		const onUp = (e: PointerEvent) => {
			if (!pointers.has(e.pointerId)) return;
			pointers.delete(e.pointerId);
			if (pointers.size < 2) scrolling = false;
		};

		host.addEventListener('pointerdown', onDown, { capture: true });
		window.addEventListener('pointermove', onMove, { capture: true, passive: false });
		window.addEventListener('pointerup', onUp, { capture: true });
		window.addEventListener('pointercancel', onUp, { capture: true });

		this.detachTwoFinger = () => {
			host.removeEventListener('pointerdown', onDown, { capture: true });
			window.removeEventListener('pointermove', onMove, { capture: true });
			window.removeEventListener('pointerup', onUp, { capture: true });
			window.removeEventListener('pointercancel', onUp, { capture: true });
			this.scrollHost = null;
		};
	}

	private detachTwoFingerScroll(): void {
		this.eraserDetach?.();
		this.eraserDetach = null;
		this.lassoDetach?.();
		this.lassoDetach = null;
		this.detachTwoFinger?.();
		this.detachTwoFinger = null;
	}
}
