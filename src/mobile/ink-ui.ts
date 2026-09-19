// 移动端手写批注的 UI 层：模式切换 + 笔盒 + 手指滚动（触摸路由）。
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
import { eraseAtPoint, eraseInRect, toPdfPoint, type EraseMode } from './ink-erase';
import { lassoHitEditors, lassoPolyToPdf, moveEditorBy, screenBBoxOfEditors, type ScreenPoint } from './ink-lasso';
import { InkStorage } from './ink-storage';

/**
 * PDF 视图的类名候选（仅作最后兜底）。
 *
 * ⚠️ 不要拿这个列表去 `querySelector` 取滚动容器 —— 真机实测（0.2.1 小米平板）：
 * Obsidian 的 `.pdf-container` 是**外层**（app.css 里 overflow: hidden），
 * `.pdf-viewer-container` 才是 overflow: auto 的滚动容器。querySelector 返回的是
 * DOM 里**靠前**的 `.pdf-container`，在它身上写 scrollTop 完全无效，
 * 用户感受就是「开启手写后整个界面定住、划不动」。滚动容器一律用
 * resolveScrollHost() 按可滚动能力向上探测。
 */
const SCROLL_SELECTOR = '.pdf-viewer-container, .pdfViewer';

/**
 * 首版四笔。钢笔与荧光笔同走墨迹通道（0.2.0 起，荧光笔 = 大笔触 + 半透明，
 * 不再走 pdf.js 自由高亮 —— 那条通道的 Outline 多边形渲染自带一圈描边）。
 * 荧光笔的半透明感来自 opacity 0.45（0.3.0 从 0.4 上调：真机反馈颜色太淡）。
 */
export const DEFAULT_PENS: PenSpec[] = [
	{ kind: 'pen', color: '#1f1f1f', thickness: 3, opacity: 1 },
	{ kind: 'marker', color: '#f2c200', thickness: 14, opacity: 0.45 },
	{ kind: 'eraser', color: '', thickness: 16, opacity: 1 },
	{ kind: 'lasso', color: '', thickness: 12, opacity: 1 },
];

/** 钢笔可选色（沿用 fleur-pdf 已有的标注配色基调：深金 / 深蓝 / 深红）。 */
const PEN_COLORS = ['#1f1f1f', '#D4A017', '#2979C4', '#D32F2F', '#2E7D32'];
/**
 * 荧光笔可选色。
 *
 * 0.3.0 小米平板反馈：上一组（#ffe066 / #a5f3b0 / #9fd8ff / #ffb3c8 / #e0c3ff）
 * 配 opacity 0.4 在浅色正文上几乎看不出颜色。这里整体加深一档 ——
 * 仍然保持「能透出下面文字」的荧光笔语义，但颜色要真正立得住。
 */
const MARKER_COLORS = ['#f2c200', '#5fc93f', '#2f9fe0', '#ee5f86', '#a06edb'];

/**
 * 笔触大小滑块的取值范围 [min, max, step]（PDF 用户空间单位）。
 *
 * 0.3.0 起由固定档位（原 PEN_SIZES / MARKER_SIZES / ERASER_SIZES）改为连续滑块：
 * 真机反馈「档位跨度太粗，想要的值调不出来」。滑块步长对钢笔取 0.5，其余取 1。
 */
const SIZE_RANGE: Record<PenSpec['kind'], [number, number, number]> = {
	pen: [1, 12, 0.5],
	marker: [6, 40, 1],
	eraser: [6, 48, 1],
	lasso: [1, 1, 1],
};

/**
 * 空闲自动落盘的防抖时长（ms）。
 *
 * 写回 PDF 是重操作（重新序列化整份 PDF + 先备份原文件 + 原地改写），
 * 对几十 MB 的 PDF 是百毫秒级的活；太短会反复重写，太长则「关掉 App 时」
 * 丢的内容多。12 秒是「一笔一停手就看得到结果」与「不折腾磁盘」的折中。
 */
/**
 * 停笔后多久静默落盘一次。
 *
 * 从 12s 收紧到 4s：12s 太长，「写完一笔立刻关文件」的用户根本等不到，
 * 而关闭时的兜底落盘一旦赶在视图销毁之后就注定失败（真机 0.4.1 的误报就出在这里）。
 * 4s 是「用户极少在 4 秒内完成落笔→关闭」与「不频繁重写 PDF」之间的折中；
 * 写盘本身有互斥 + 防抖，连续落笔不会叠加写盘次数。
 */
const AUTO_SAVE_IDLE_MS = 4000;

/** 擦除模式的展示名。 */
const ERASE_MODE_LABEL: Record<EraseMode, string> = {
	pixel: '像素擦除',
	stroke: '笔画擦除',
	select: '选区擦除',
};

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
	/** 每支笔的当前参数（颜色/粗细按笔独立记忆，0.2.0 起持久化到插件设置）。 */
	private readonly pens: PenSpec[];
	/** 当前擦除模式（仅橡皮笔生效，0.2.0 起持久化）。 */
	private eraserMode: EraseMode;
	/** 手写模式激活期间是否只允许笔输入（真机笔 vs 手指）。 */
	private readonly storage: InkStorage;
	/** 空闲自动落盘的防抖计时器（见 autoSave）。 */
	private autoSaveTimer: number | null = null;
	/** 写盘互斥：写回 PDF 是重操作，同一时刻只允许一个在跑。 */
	private saving = false;
	/** 本会话是否已提示过保存失败（自动保存的失败多为视图切换途中的一次性错误，避免刷屏）。 */
	private saveErrorNotified = false;

	constructor(
		private plugin: FleurPDFPlugin,
		private engine: InkEngine,
	) {
		this.storage = new InkStorage(plugin.app);
		this.pens = InkUI.loadPens(plugin);
		this.eraserMode = plugin.settings.inkEraserMode ?? 'stroke';
	}

	/* ============================ 设置持久化 ============================ */

	/**
	 * 从插件设置恢复笔参数。结构变化（笔数不符 / kind 对不上）时回落默认值，
	 * 保证旧数据或手改的 data.json 不会让笔盒坏掉。
	 */
	private static loadPens(plugin: FleurPDFPlugin): PenSpec[] {
		const saved = plugin.settings.inkPens;
		if (
			Array.isArray(saved) &&
			saved.length === DEFAULT_PENS.length &&
			saved.every((p, i) => p && p.kind === DEFAULT_PENS[i].kind)
		) {
			return saved.map((p, i) => ({
				kind: p.kind,
				color: String(p.color ?? ''),
				thickness: Number(p.thickness) || DEFAULT_PENS[i].thickness,
				opacity: Number.isFinite(Number(p.opacity)) ? Number(p.opacity) : 1,
			}));
		}
		return DEFAULT_PENS.map((p) => ({ ...p }));
	}

	/** 把笔参数与橡皮配置写回插件设置（每次改动后调用，静默失败不影响使用）。 */
	private persist(): void {
		this.plugin.settings.inkPens = this.pens.map((p) => ({ ...p }));
		this.plugin.settings.inkEraserMode = this.eraserMode;
		void this.plugin.saveSettings().catch(() => {
			/* 写盘失败仅影响下次会话的记忆，不打断当前使用 */
		});
	}

	/** 手指滚动开关（实时读设置，设置页改动即时生效，无需重建 InkUI）。 */
	private get fingerScroll(): boolean {
		return this.plugin.settings.inkFingerScroll !== false;
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

		// 第三段：批注列表（原「双态」扩为三态）。
		// 真机反馈「右侧边栏的批注窗口很难呼出」—— 此前只有 ribbon 图标与命令面板
		// 两个入口，而移动端 ribbon 要展开左侧栏才看得见，等于没有入口。
		// 挂到这颗常驻胶囊上，与手写/编辑同处一地，不进设置面板也能打开。
		const sideBtn = sw.createDiv('fleur-pdf-ink-switch-btn');
		setIcon(sideBtn, 'list');
		sideBtn.setAttribute('aria-label', '批注列表');
		sideBtn.addEventListener('click', (e) => {
			e.preventDefault();
			e.stopPropagation();
			void this.plugin.activateSidebar();
		});

		this.editSeg = editBtn;
		this.inkSeg = inkBtn;
		this.toggleBtn = sw;
		this.syncSwitcher();

		// 位置恢复（上次拖到哪就回到哪）+ 拖动换位 + 长按收起
		this.applySwitcherPos();
		sw.toggleClass('is-collapsed', this.plugin.settings.inkSwitcherCollapsed === true);
		this.attachSwitcherDrag(sw);

		document.body.addEventListener('click', this.onBodyClick, true);

		// ── 离开当前 PDF 前的兜底落盘（见 autoSave）──
		// 真机 0.4.0 反馈「手写批注之后关闭文件，重新回来全部批注都消失了」：
		// 批注此前只活在 pdf.js 的内存 AnnotationStorage 里，唯一出口是笔盒上的
		// 保存钮 —— 而「写完直接关文件」才是最自然的操作，于是必然丢。
		this.plugin.registerEvent(
			this.plugin.app.workspace.on('file-open', (file) => {
				void this.flushBeforeLeave(file?.path ?? null);
			}),
		);
		this.plugin.registerEvent(
			this.plugin.app.workspace.on('layout-change', () => {
				const path = this.plugin.app.workspace.getActiveFile()?.path ?? null;
				void this.flushBeforeLeave(path);
			}),
		);

		// ── 切后台 / 页面卸载前的兜底落盘 ──
		// 「写完直接杀掉 App」在移动端是高频操作。杀进程前一般会先切后台
		// （iOS 上滑 / Android Home 键），visibilitychange → hidden 是最后一班
		// 可靠的车；pagehide 再兜一层（部分 WebView 只派发它）。
		this.onHiddenFlush = () => {
			if (this.active) void this.autoSave(true);
		};
		document.addEventListener('visibilitychange', this.onHiddenFlush);
		window.addEventListener('pagehide', this.onHiddenFlush);

		// M3-A：首次挂载给一条指引入口在哪（只在本会话第一次出现）。
		// 带上版本号：真机排查时「到底装没装上这一版」是最先要确认的事，
		// 之前就吃过 BRAT 未更新却在排查已修问题的亏。
		if (!InkUI.mountHintShown) {
			InkUI.mountHintShown = true;
			new Notice(
				`FleurPDF 手写批注已就绪 v${ this.plugin.manifest.version }：点击右下角的“手写”按钮开始批注`,
			);
		}
	}

	/** 同步切换器的高亮（编辑段 / 手写段互斥）。 */
	private syncSwitcher(): void {
		this.editSeg?.toggleClass('is-active', !this.active);
		this.inkSeg?.toggleClass('is-active', this.active);
	}

	/* ==================== 悬浮切换器：拖动 / 收起 ==================== */

	/**
	 * 把胶囊放到设置里记住的位置。
	 *
	 * y 存的是**视口比例**而不是像素：换设备、转屏、改分辨率后像素值会落到屏幕外，
	 * 比例不会。`translateY(-50%)` 让 top 百分比落在胶囊中心而不是顶边。
	 */
	private applySwitcherPos(): void {
		const sw = this.toggleBtn;
		if (!sw) return;
		const side = this.plugin.settings.inkSwitcherSide ?? 'right';
		const y = Math.min(1, Math.max(0, this.plugin.settings.inkSwitcherY ?? 0.78));
		sw.setCssStyles({
			left: side === 'left' ? '12px' : 'auto',
			right: side === 'right' ? '12px' : 'auto',
			top: `${Math.round(y * 100)}%`,
			bottom: 'auto',
			transform: 'translateY(-50%)',
		});
	}

	/**
	 * 拖动换位 + 长按收起。
	 *
	 * 三段按钮仍是点击语义，所以必须把「拖动」与「点击」分开：位移小于 6px 一律当点击
	 * （交给按钮自己的 click），超过才进入拖动。拖动结束后再用一次捕获态 click 把紧随其后的
	 * 误点吞掉 —— 否则松手会顺手触发按钮动作（例如误入手写模式）。
	 */
	private attachSwitcherDrag(sw: HTMLElement): void {
		let dragging = false;
		let moved = false;
		let startX = 0;
		let startY = 0;
		let originLeft = 0;
		let originTop = 0;
		let longPress: number | null = null;

		const clearLongPress = () => {
			if (longPress !== null) {
				window.clearTimeout(longPress);
				longPress = null;
			}
		};

		sw.addEventListener('pointerdown', (e) => {
			if (e.pointerType === 'mouse' && e.button !== 0) return;
			dragging = true;
			moved = false;
			startX = e.clientX;
			startY = e.clientY;
			const r = sw.getBoundingClientRect();
			originLeft = r.left;
			originTop = r.top;
			// 立刻换算成「绝对定位 + 无 transform」的等价表述：拖动时位移才是线性的，
			// 否则 translateY(-50%) 与 top 会互相打架，胶囊会跳。
			sw.setCssStyles({
				left: `${originLeft}px`,
				right: 'auto',
				top: `${originTop}px`,
				bottom: 'auto',
				transform: 'none',
			});
			// 捕获指针：手指滑出胶囊边界后 move 事件仍派发到这里。
			// 没有它，触摸拖动只要偏出元素几像素就收不到 move（触摸的隐式捕获
			// 只在浏览器不接管手势时存在，而真机手指面积大、极易滑出）。
			try {
				(sw as HTMLElement).setPointerCapture(e.pointerId);
			} catch {
				/* 某些 WebView 对已释放指针抛错，忽略 */
			}
			clearLongPress();
			// 长按 650ms = 收起（短于它都当点击，避免误收）
			longPress = window.setTimeout(() => {
				longPress = null;
				if (moved) return;
				dragging = false;
				this.setSwitcherCollapsed(true);
			}, 650);
		}, true);

		sw.addEventListener('pointermove', (e) => {
			if (!dragging) return;
			// 触摸拖动期间阻止浏览器把这套手势再解释成滚动/缩放（双保险，
			// 第一道是 CSS touch-action: none）
			if (e.pointerType !== 'mouse') e.preventDefault();
			const dx = e.clientX - startX;
			const dy = e.clientY - startY;
			if (!moved) {
				if (Math.hypot(dx, dy) < 6) return;
				moved = true;
				clearLongPress();
				sw.addClass('is-dragging');
			}
			sw.setCssStyles({ left: `${originLeft + dx}px`, top: `${originTop + dy}px` });
		});

		const finish = (e: PointerEvent) => {
			if (!dragging) return;
			dragging = false;
			try {
				(sw as HTMLElement).releasePointerCapture?.(e.pointerId);
			} catch {
				/* 忽略 */
			}
			clearLongPress();
			if (!moved) {
				// 只点没拖：把 pointerdown 里改过的定位还原回去
				sw.removeClass('is-dragging');
				this.applySwitcherPos();
				return;
			}
			sw.removeClass('is-dragging');
			// 吞掉紧随其后的一次 click（拖动松手不应触发按钮动作）
			sw.addEventListener('click', (ev) => {
				ev.stopPropagation();
				ev.preventDefault();
			}, { capture: true, once: true });

			// 吸附到最近的边；垂直位置夹在可视区内，避免被安全区/顶栏切掉
			const r = sw.getBoundingClientRect();
			const side: 'left' | 'right' = r.left + r.width / 2 < window.innerWidth / 2 ? 'left' : 'right';
			const half = r.height / 2;
			const centerY = Math.min(window.innerHeight - half - 8, Math.max(half + 8, r.top + r.height / 2));
			this.plugin.settings.inkSwitcherSide = side;
			this.plugin.settings.inkSwitcherY = centerY / window.innerHeight;
			void this.plugin.saveSettings().catch(() => undefined);
			this.applySwitcherPos();
		};
		sw.addEventListener('pointerup', (e) => finish(e as PointerEvent));
		sw.addEventListener('pointercancel', (e) => finish(e as PointerEvent));

		// 收起态下点一下把手即恢复（那时没有按钮可点，click 落在容器自己身上）
		sw.addEventListener('click', (e) => {
			if (this.plugin.settings.inkSwitcherCollapsed !== true) return;
			e.preventDefault();
			e.stopPropagation();
			this.setSwitcherCollapsed(false);
		}, true);
	}

	/** 收起 / 展开悬浮胶囊，状态持久化。 */
	private setSwitcherCollapsed(collapsed: boolean): void {
		this.plugin.settings.inkSwitcherCollapsed = collapsed;
		void this.plugin.saveSettings().catch(() => undefined);
		this.toggleBtn?.toggleClass('is-collapsed', collapsed);
		if (collapsed) {
			new Notice('悬浮按钮已收起：点侧边的小把手即可恢复，也可用命令面板的「显示/收起手写批注悬浮按钮」');
		}
	}

	/** 供命令面板调用：显示 / 收起悬浮胶囊（用户彻底找不到入口时的兜底）。 */
	toggleSwitcher(): void {
		this.setSwitcherCollapsed(this.plugin.settings.inkSwitcherCollapsed !== true);
	}

	unmount(): void {
		document.body.removeEventListener('click', this.onBodyClick, true);
		document.removeEventListener('visibilitychange', this.onHiddenFlush);
		window.removeEventListener('pagehide', this.onHiddenFlush);
		// 卸载前尽力落盘（异步发起，不阻塞卸载流程）
		if (this.active) void this.exitInk();
		this.cancelAutoSave();
		this.hideLassoBox();
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

	/** 切后台 / 页面卸载前的兜底落盘（见 mount 里的 visibilitychange 注册）。 */
	private onHiddenFlush: () => void = () => undefined;

	/* ============================ 模式切换 ============================ */

	async enterInk(): Promise<void> {
		// 手写模式下选不出文本，文本批注面板留着只会挡住落笔区域
		this.plugin.patcher?.closeFloatingMenu();

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
		// 0.4.0 起 enterInk 是异步的：NONE → INK 触发 pdf.js 的重路径（updater 要等所有页
		// pagerendered），applyActivePen 必须等模式真落盘，否则 UIManager 拿不到。
		const pen = this.pens[this.penIndex];
		const res = pen.kind === 'marker' ? await this.engine.enterMarker() : await this.engine.enterInk();
		if (!res.ok) {
			new Notice(`手写模式不可用：${res.error ?? '未知原因'}`);
			return;
		}

		await this.applyActivePen();

		this.active = true;
		document.body.addClass('fleur-pdf-ink-active');
		this.syncSwitcher();
		this.buildPenBar();
		this.attachGestureShield();
		this.attachTouchRouter();
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
			// 固有笔迹播种：重开文件后，写回过的笔迹是文件里的 /Ink 注释，
			// 正常应由 pdf.js 在进入编辑模式时转成编辑器（真机 0.4.2 实测这条
			// 转换在移动端没有生效 —— 表现为历史笔迹擦不掉、套索圈不中）。
			// 这里主动补建，只补缺失的，pdf.js 已转成功的会被去重跳过。
			window.setTimeout(() => {
				if (this.active) void this.seedExistingInkEditors();
			}, 450);
		}
	}

	/**
	 * 把文件固有的手写笔迹补建为编辑器（擦除 / 套索 / 移动都以编辑器为操作对象）。
	 *
	 * 复用 pdf.js 自己的转换链路：注释层 getEditableAnnotations() →
	 * 编辑器层 deserialize()（内部就是 InkEditor.deserialize 对 InkAnnotationElement
	 * 的那条路，与 enable() 的原生转换一字不差）。任何一页失败都不影响其余页。
	 */
	private async seedExistingInkEditors(): Promise<void> {
		try {
			const um = this.engine.getUIManager();
			if (!um) return;
			let seeded = 0;
			for (let pi = 0; pi < this.engine.pageCount; pi++) {
				const editorLayer = this.engine.getLayer(pi);
				const annLayer = this.engine.getAnnotationLayer(pi);
				if (!editorLayer || !annLayer?.getEditableAnnotations) continue;

				// 去重：pdf.js 原生转换已建过的编辑器带 annotationElementId，
				// 与固有注释的 data.id 一一对应，出现即说明该注释已可编辑。
				const have = new Set(
					this.engine
						.getEditors(pi)
						.map((e: any) => e?.annotationElementId)
						.filter(Boolean),
				);

				for (const el of annLayer.getEditableAnnotations()) {
					const data = el?.data;
					if (!data || data.subtype !== 'Ink' || !data.id) continue;
					if (have.has(data.id)) continue;
					let editor: any = null;
					try {
						// 编辑器层公开方法，内部即 InkEditor.deserialize(el, layer, um)
						editor = await (editorLayer as any).deserialize(el);
					} catch {
						continue;
					}
					if (!editor) continue;
					try {
						(editorLayer as any).add(editor);
						editor.enableEditing?.();
						seeded++;
					} catch {
						try {
							um.addEditor(editor);
							seeded++;
						} catch {
							/* 单个失败不影响其余 */
						}
					}
				}
			}
			if (seeded > 0) {
				console.log(`[FleurPDF Ink] 固有手写笔迹已补建为可编辑对象：${seeded} 条`);
			}
		} catch (err) {
			console.warn('[FleurPDF Ink] 固有笔迹播种失败（不影响书写）:', err);
		}
	}

	async exitInk(): Promise<void> {
		// 退出即落盘。点「完成」的用户语义是「我写完了」，此时把批注留在内存里
		// 等于让他在下次打开文件时发现全没了（真机 0.4.0 的主诉）。
		// 没有未保存内容时 autoSave 直接跳过，不会白白重写文件。
		this.cancelAutoSave();
		await this.autoSave(false);

		// 先提交：supportMultipleDrawings=true 时 pointerup 不会生成编辑器，
		// 必须显式提交（或切模式，这里两者都做），否则最后一笔会丢。
		await this.engine.commit();
		await this.engine.exit();

		this.clearLasso();
		this.clearEraseRect();

		this.active = false;
		document.body.removeClass('fleur-pdf-ink-active');
		this.syncSwitcher();
		this.detachPenInput();
		this.detachGestureShield();
		this.detachTouchRouter();
		this.penBar?.remove();
		this.penBar = null;
		// 退出时把当前笔参数落盘（下次进入原样恢复）
		this.persist();
	}

	/** 笔盒上的保存钮：显式写回 PDF。 */
	private async save(): Promise<void> {
		this.cancelAutoSave();
		const wrote = await this.autoSave(false);
		// 文件已被改写：退出编辑态，避免继续在旧的内存文档上落墨
		if (wrote) await this.exitInk();
	}

	/* ============================ 自动落盘 ============================ */

	/**
	 * 把内存中的手写批注写回 PDF。
	 *
	 * 真机 0.4.0 的「批注之后关闭文件、重新回来全没了」就出在这里：
	 * 批注此前只存在于 pdf.js 的 AnnotationStorage（纯内存），唯一出口是笔盒上的
	 * 保存钮 —— 而「写完直接关文件」才是最自然的用法，所以必然丢数据。
	 *
	 * 三层保障：
	 *   ① 每次落笔 / 擦除 / 套索改动后，空闲 AUTO_SAVE_IDLE_MS 静默写回 ——
	 *      兜住「不点保存直接杀掉 App」；
	 *   ② 退出手写模式（点 ✓）时立刻写回（exitInk）；
	 *   ③ 切换文件 / 工作区布局变化时兜底写回（flushBeforeLeave）。
	 *
	 * @param silent 静默模式：无内容可存时不提示，成功也不提示（失败仍会提示）。
	 * @returns 是否真的写回了文件。
	 */
	private async autoSave(silent: boolean): Promise<boolean> {
		if (this.saving) {
			// 写盘进行中：静默模式下直接跳过（下一次改动会重新排队），
			// 显式点保存则要告诉用户「不是没保存，是正在保存」
			if (!silent) new Notice('正在保存手写批注，请稍候');
			return false;
		}
		this.saving = true;
		try {
			// 视图已被销毁（关闭文件 / 切标签页）→ 没有可写回的目标了。
			// 此时必须静默复位：真机 0.4.1 的误报「手写批注保存失败：没有可写回的
			// 手写批注」就是拿已销毁的 handle 继续导出造成的。顺带把 active 复位，
			// 否则后续每次 file-open / layout-change 都会再撞一次同样的墙。
			if (!this.engine.isHandleAlive) {
				this.resetInkStateIfDead();
				return false;
			}

			// 提交当前绘制会话，否则最后一笔还不在存储里
			this.engine.commit();
			// commit() 是同步接口，但落进 AnnotationStorage 要等一拍（见 ink-engine 陷阱 4）
			await new Promise((r) => window.setTimeout(r, 60));

			if (!this.engine.hasUnsaved) {
				if (!silent) new Notice('当前没有需要保存的手写批注');
				return false;
			}
			const file = this.engine.getFile();
			if (!file) {
				new Notice('找不到对应的 PDF 文件，无法保存手写批注');
				return false;
			}

			const out = await this.storage.saveAnnotated(this.engine, file);
			if (out.ok) {
				if (!silent) new Notice(`已写入手写批注（${Math.round((out.bytes ?? 0) / 1024)} KB）`);
				// 写回改动了 vault 里的文件，Obsidian 可能随即重载 PDF 视图（旧 handle
				// 被销毁）。若不重连，用户继续画的每一笔都落在死 handle 上 —— 重开
				// 文件时全部丢失，只剩这一次写回的内容（真机 0.4.2 的「只存开头几笔」）。
				void this.reattachIfReloaded();
				return true;
			}
			// 没有内容可写回 = 正常路径（视图刚被销毁、或本来就还没落墨），不提示。
			// 这条曾经是「关闭文件后弹一堆保存失败」的元凶：正常情况被当成错误报了。
			if (out.reason === 'empty') return false;

			// 真失败（IO / 文件被占用）必须让用户知道 —— 静默失败会变成「批注又没了」。
			// 但自动保存的失败多半是「视图正在切换途中」这类一次性的，
			// 每次都弹会变成噪音，所以每个会话只提示一次。
			if (!silent || !this.saveErrorNotified) {
				this.saveErrorNotified = true;
				new Notice(`手写批注保存失败：${out.error ?? '未知原因'}`);
			}
			return false;
		} finally {
			this.saving = false;
		}
	}

	/**
	 * PDF 视图已被销毁时的状态复位。
	 *
	 * 关闭文件不会走 exitInk（用户没点「完成」），于是 active 一直留在 true、
	 * engine 也还攥着旧 handle。复位后悬浮切换器回到「编辑」态、笔盒收起，
	 * 后续的 file-open / layout-change 不会再拿幽灵 handle 去做无意义的导出。
	 */
	/**
	 * 视图被 Obsidian 重载后的「热重连」。
	 *
	 * 背景：autoSave 写回 PDF 后，Obsidian 检测到文件变化可能销毁并重建 PDF 视图。
	 * 此时 engine 的 handle 指向死对象 —— 用户的手指还在屏幕上，但输入路由、
	 * 笔盒都挂在旧 DOM 上，之后画的每一笔都不会进入新文档。
	 *
	 * 处理：按 enterInk 的同一条路径重新 resolve → 进编辑模式 → 重挂输入。
	 * handle 还活着（Obsidian 没重载）时什么都不做，零开销。
	 */
	private async reattachIfReloaded(): Promise<void> {
		if (!this.active) return;
		if (this.engine.isHandleAlive) return;

		// 旧 DOM 的绑定全部摘掉（旧节点已不在文档上，留着只是泄漏）
		this.detachPenInput();
		this.detachGestureShield();
		this.detachTouchRouter();
		this.penBar?.remove();
		this.penBar = null;
		this.clearLasso();
		this.clearEraseRect();
		try {
			await this.engine.exit();
		} catch {
			/* 旧 handle 已死，exit 只是形式 */
		}

		await this.enterInk();
		if (this.active) new Notice('手写批注已保存');
	}

	private resetInkStateIfDead(): void {
		if (!this.active) return;
		this.cancelAutoSave();
		this.clearLasso();
		this.clearEraseRect();
		this.active = false;
		document.body.removeClass('fleur-pdf-ink-active');
		this.syncSwitcher();
		this.detachPenInput();
		this.detachGestureShield();
		this.detachTouchRouter();
		this.penBar?.remove();
		this.penBar = null;
	}

	/** 安排一次空闲落盘（每次改动后调用，重复调用只保留最后一次）。 */
	private scheduleAutoSave(): void {
		if (this.autoSaveTimer !== null) window.clearTimeout(this.autoSaveTimer);
		this.autoSaveTimer = window.setTimeout(() => {
			this.autoSaveTimer = null;
			void this.autoSave(true);
		}, AUTO_SAVE_IDLE_MS);
	}

	private cancelAutoSave(): void {
		if (this.autoSaveTimer !== null) {
			window.clearTimeout(this.autoSaveTimer);
			this.autoSaveTimer = null;
		}
	}

	/**
	 * 要离开当前 PDF 了（切文件 / 布局变化）→ 兜底落盘。
	 *
	 * 只在「手写模式开着」且「当前 PDF 确实换了」时才动手：
	 * layout-change 在许多无关场合（开侧边栏、拖分屏）都会触发，
	 * 不加这两道闸会在用户只是调个界面时反复重写文件。
	 */
	private async flushBeforeLeave(nextPath: string | null): Promise<void> {
		if (!this.active) return;
		const cur = this.engine.pdfFilePath;
		if (!cur) return;
		if (nextPath && nextPath === cur) return;
		this.cancelAutoSave();
		await this.autoSave(true);
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

		// ── 粗细（钢笔 / 荧光笔）──
		// 橡皮不单独占「大小」图标：它的模式与大小一起并进橡皮自己的设置弹层，
		// 笔盒少一个图标，也少一处「这个图标是干嘛的」的困惑（0.3.0 真机反馈）。
		const pen = this.pens[this.penIndex];
		const isEraser = pen.kind === 'eraser';
		if (!isEraser) {
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
		} else {
			// 橡皮设置弹层（像素 / 笔画 / 选区 + 大小）常驻笔盒，
			// 由「再次点击橡皮图标」展开 —— 见 selectPen 末尾。
			bar.appendChild(this.buildEraserPop());
		}

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

	/**
	 * 大小滑块（钢笔 / 荧光笔 / 橡皮共用，0.3.0 起替代固定档位圆点）。
	 *
	 * 拖动过程只改内存值 + 实时下发参数，**不重建笔盒**（重建会让滑块在手指下消失）；
	 * 松手（change）时才落盘。橡皮不吃引擎参数 —— 它的 thickness 就是命中半径，
	 * 由 eraseAtPoint 实时读取，所以拖动即时生效。
	 */
	private buildSizeSlider(): HTMLElement {
		const pen = this.pens[this.penIndex];
		const [min, max, step] = SIZE_RANGE[pen.kind];
		const row = createDiv('fleur-pdf-ink-slider-row');

		const input = row.createEl('input', { cls: 'fleur-pdf-ink-slider' });
		input.type = 'range';
		input.min = String(min);
		input.max = String(max);
		input.step = String(step);
		input.value = String(pen.thickness);

		const value = row.createDiv('fleur-pdf-ink-slider-val');
		value.setText(String(pen.thickness));

		// 滑块自己吃掉指针事件，避免冒泡到 body 的「点空白收起面板」逻辑
		for (const ev of ['pointerdown', 'touchstart', 'click']) {
			input.addEventListener(ev, (e) => e.stopPropagation());
		}

		input.addEventListener('input', () => {
			const v = Number(input.value);
			const cur = this.pens[this.penIndex];
			cur.thickness = v;
			value.setText(String(v));
			// 0.4.0 起 applyPen 是异步的（要等 UIManager），拖动过程是连续的，
			// 同一帧多次 in-flight 调用没问题：applyPenAsync 内部会按顺序串接 commit / unselectAll。
			if (cur.kind === 'pen' || cur.kind === 'marker') void this.engine.applyPenAsync(cur);
		});
		input.addEventListener('change', () => this.persist());

		return row;
	}

	/** 粗细弹层（单根滑块）。 */
	private buildSizePop(): HTMLElement {
		const pop = createDiv('fleur-pdf-ink-pop fleur-pdf-ink-sizes');
		pop.appendChild(this.buildSizeSlider());
		return pop;
	}

	/**
	 * 橡皮设置弹层：擦除模式（像素 / 笔画 / 选区）+ 大小滑块。
	 *
	 * 0.3.0 起并入橡皮图标本身（再次点击已选中的橡皮图标即展开），
	 * 不再单独占一个 `box-select` 图标 —— 真机反馈「多出来那个图标不知道是干什么的」。
	 */
	private buildEraserPop(): HTMLElement {
		const pop = createDiv('fleur-pdf-ink-pop fleur-pdf-ink-eraser-pop');
		const modes: EraseMode[] = ['pixel', 'stroke', 'select'];
		const modeRow = pop.createDiv('fleur-pdf-ink-modes');
		for (const m of modes) {
			const item = modeRow.createDiv('fleur-pdf-ink-mode');
			item.setText(ERASE_MODE_LABEL[m]);
			if (m === this.eraserMode) item.addClass('is-active');
			item.addEventListener('click', (e) => {
				e.stopPropagation();
				this.setEraseMode(m);
			});
		}
		pop.appendChild(this.buildSizeSlider());
		return pop;
	}

	/* ============================ 笔操作 ============================ */

	private async selectPen(i: number): Promise<void> {
		// 记录「点的就是当前已选中的那支」——橡皮要靠它判断是否展开设置弹层
		const wasSame = this.penIndex === i;
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
			if (!this.engine.getMode()) await this.engine.enterInk();
			this.setPenInputMode('lasso');
		} else {
			// 钢笔与荧光笔同走墨迹通道（0.2.0 起）；切换时会按笔重下发参数
			await this.engine.enterInk();
			this.setPenInputMode('draw');
		}
		this.persist();
		this.refreshPenBar();
		// 再次点击橡皮图标 → 展开橡皮设置（擦除模式 + 大小）。
		// 让「擦除模式」并入橡皮图标，而不是另占一个图标。
		if (pen.kind === 'eraser' && wasSame) this.openEraserPop();
	}

	/** 展开橡皮设置弹层（像素 / 笔画 / 选区 + 大小）。 */
	private openEraserPop(): void {
		const pop = this.penBar?.querySelector<HTMLElement>('.fleur-pdf-ink-eraser-pop');
		if (!pop) return;
		const willOpen = !pop.hasClass('is-open');
		this.closePops(pop);
		pop.toggleClass('is-open', willOpen);
	}

	private async setColor(color: string): Promise<void> {
		this.pens[this.penIndex].color = color;
		await this.applyActivePen();
		this.persist();
		this.refreshPenBar();
	}

	/**
	 * 切换擦除模式（仅橡皮生效；随切换写回设置）。
	 *
	 * 注意：这里**不重建笔盒**。模式选项就挂在橡皮设置弹层里，
	 * 重建会把用户刚展开的面板一起销毁。只翻转面板内的选中态即可。
	 */
	private setEraseMode(mode: EraseMode): void {
		this.eraserMode = mode;
		this.clearEraseRect();
		this.persist();
		const modes: EraseMode[] = ['pixel', 'stroke', 'select'];
		this.penBar
			?.findAll('.fleur-pdf-ink-eraser-pop .fleur-pdf-ink-mode')
			.forEach((el, idx) => el.toggleClass('is-active', modes[idx] === mode));
	}

	private async applyActivePen(): Promise<void> {
		const pen = this.pens[this.penIndex];
		// 橡皮 / 套索没有「笔参数」可下发（橡皮是输入层接管，套索不落墨）
		if (pen.kind === 'eraser' || pen.kind === 'lasso') return;
		// 0.4.0 起走异步版：UIManager 可能在 setMode 的异步 updater 跑完前还拿不到，
		// 同步版本会立即失败静默返回；异步版会轮询等到 um 可用再下发参数。
		await this.engine.applyPenAsync(pen);
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
		this.detachDrawSettle();
		if (mode === 'eraser') this.attachEraser();
		else if (mode === 'lasso') this.attachLasso();
		else this.attachDrawSettle();
	}

	/* ---------------- 落笔收尾：让笔迹保持「未选中」 ----------------
	 * pdf.js 在 INK 模式下每画一笔都会把新编辑器留在 #selectedEditors 里
	 * （`unselectAll()` 在 mode !== NONE 时不清选择集，见 ink-engine.releaseSelection）。
	 * 不处理的话每一笔都带选中描边 —— 真机表现就是「一片选区框把几笔串起来」，
	 * 而且后续任何一次改参数都有可能顺着选择集改到历史笔迹。
	 * 用户明确要求手写时不得出现选区框，所以每次落笔后立刻把它释放掉。
	 */
	private drawSettleDetach: (() => void) | null = null;

	private attachDrawSettle(): void {
		if (this.drawSettleDetach) return;
		const onUp = (e: PointerEvent): void => {
			if (!this.active || !this.isInPdfArea(e.target)) return;
			// 延到下一宏任务：等 pdf.js 完成本次绘制收尾（编辑器此刻才真正诞生）
			window.setTimeout(() => {
				if (!this.active) return;
				this.engine.releaseSelection();
				// 落笔即排一次空闲落盘（见 autoSave 的三层保障）
				this.scheduleAutoSave();
			}, 0);
		};
		window.addEventListener('pointerup', onUp, { capture: true });
		window.addEventListener('pointercancel', onUp, { capture: true });
		this.drawSettleDetach = () => {
			window.removeEventListener('pointerup', onUp, { capture: true });
			window.removeEventListener('pointercancel', onUp, { capture: true });
		};
	}

	private detachDrawSettle(): void {
		this.drawSettleDetach?.();
		this.drawSettleDetach = null;
	}

	private attachEraser(): void {
		const host = this.scrollHost ?? document.body;

		const onDown = (e: PointerEvent) => {
			// 双指手势优先给滚动逻辑（它在捕获阶段、注册更早，正常会先于这里被处理）
			if (e.isPrimary === false) return;
			if (this.eraserMode === 'select') {
				// 选区擦除：起手记起点，拖出虚线矩形
				this.eraseRectStart = { x: e.clientX, y: e.clientY };
				this.ensureEraseRect();
				this.updateEraseRect(e.clientX, e.clientY);
			} else {
				this.eraserDown = true;
				this.lastErasePt = null;
				void this.eraseAt(e.clientX, e.clientY);
			}
			e.preventDefault();
			e.stopPropagation();
		};
		const onMove = (e: PointerEvent) => {
			if (this.eraserMode === 'select') {
				if (!this.eraseRectEl) return;
				e.preventDefault();
				e.stopPropagation();
				this.updateEraseRect(e.clientX, e.clientY);
				return;
			}
			if (!this.eraserDown) return;
			e.preventDefault();
			e.stopPropagation();
			void this.eraseAt(e.clientX, e.clientY);
		};
		const onUp = (e: PointerEvent) => {
			if (this.eraserMode === 'select') {
				if (!this.eraseRectEl) return;
				const start = this.eraseRectStart;
				const end = { x: e.clientX, y: e.clientY };
				this.clearEraseRect();
				void this.finishEraseRect(start, end);
				return;
			}
			this.eraserDown = false;
			this.lastErasePt = null;
			// 一次擦除手势结束 → 排一次空闲落盘
			this.scheduleAutoSave();
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

	/* ---------------- 橡皮擦除调度（像素 / 笔画） ----------------
	 * 灵敏度的三个来源（0.1.0 真机实测「不太灵敏」后继续修正）：
	 *  1. 快速拖动时 pointermove 事件之间有间距 —— 沿「上一点 → 当前点」
	 *     线段按步长插值补点；
	 *  2. 每次命中都涉及 serialize/deserialize 重建，异步 —— 忙队列进行中
	 *     只记最新坐标会漏掉中间点（快速画 Z 字时中段漏擦）。0.2.0 改为
	 *     待办点队列：进行中把所有经过的点按序攒下，结束后逐点补擦；
	 *  3. 一次命中只擦一笔 —— 现在一次调用擦掉半径内**全部**笔画
	 *     （见 ink-erase.eraseAtPoint），拖过多笔时不再需要反复经过。
	 */
	private eraserDown = false;
	private eraserBusy = false;
	private pendingErasePts: Array<{ x: number; y: number }> = [];
	private lastErasePt: { x: number; y: number } | null = null;

	private async eraseAt(clientX: number, clientY: number): Promise<void> {
		if (this.eraserBusy) {
			this.pendingErasePts.push({ x: clientX, y: clientY });
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
			// 按序补擦攒下的待办点（不再只取最后一个）
			const queue = this.pendingErasePts;
			this.pendingErasePts = [];
			if (queue.length && this.eraserDown) {
				void (async () => {
					for (const p of queue) {
						if (!this.eraserDown) break;
						await this.eraseAt(p.x, p.y);
					}
				})();
			}
		}
	}

	/** 在单个视口坐标点按当前模式擦一次。 */
	private async eraseSingle(clientX: number, clientY: number): Promise<void> {
		const pageEl = (document.elementFromPoint(clientX, clientY) as HTMLElement | null)?.closest<HTMLElement>('.page');
		const pageNumber = Number(pageEl?.dataset.pageNumber ?? '1');
		if (!Number.isFinite(pageNumber) || pageNumber < 1) return;

		const point = toPdfPoint(this.engine, clientX, clientY, pageNumber);
		if (!point) return;

		await eraseAtPoint(this.engine, point, {
			radius: this.pens[this.penIndex].thickness,
			mode: this.eraserMode === 'pixel' ? 'pixel' : 'stroke',
		});
	}

	/* ---------------- 选区擦除（矩形拖选） ---------------- */

	private eraseRectEl: HTMLElement | null = null;
	private eraseRectStart: { x: number; y: number } = { x: 0, y: 0 };

	private ensureEraseRect(): void {
		if (this.eraseRectEl?.isConnected) return;
		const el = document.body.createDiv('fleur-pdf-erase-rect');
		this.eraseRectEl = el;
	}

	private updateEraseRect(x: number, y: number): void {
		const el = this.eraseRectEl;
		if (!el) return;
		const s = this.eraseRectStart;
		const minX = Math.min(s.x, x);
		const minY = Math.min(s.y, y);
		el.setCssStyles({
			left: `${minX}px`,
			top: `${minY}px`,
			width: `${Math.abs(x - s.x)}px`,
			height: `${Math.abs(y - s.y)}px`,
			display: 'block',
		});
	}

	private clearEraseRect(): void {
		this.eraseRectEl?.remove();
		this.eraseRectEl = null;
	}

	/** 选区擦除收尾：矩形换算到起始页的 PDF 坐标，删除相交笔画。 */
	private async finishEraseRect(
		start: { x: number; y: number },
		end: { x: number; y: number },
	): Promise<void> {
		// 拖动距离过小视为误触
		if (Math.hypot(end.x - start.x, end.y - start.y) < 10) return;

		// 以起点所在页为准（v1 约束：选区不跨页）
		const pageEl = (document.elementFromPoint(start.x, start.y) as HTMLElement | null)?.closest<HTMLElement>('.page');
		const pageNumber = Number(pageEl?.dataset.pageNumber ?? '1');
		if (!Number.isFinite(pageNumber) || pageNumber < 1) return;

		const p1 = toPdfPoint(this.engine, start.x, start.y, pageNumber);
		const p2 = toPdfPoint(this.engine, end.x, end.y, pageNumber);
		if (!p1 || !p2 || p1.pageIndex !== p2.pageIndex) return;

		const r = await eraseInRect(this.engine, p1.pageIndex, {
			minX: Math.min(p1.x, p2.x),
			minY: Math.min(p1.y, p2.y),
			maxX: Math.max(p1.x, p2.x),
			maxY: Math.max(p1.y, p2.y),
		});
		if (r.changed) {
			this.engine.commit();
			this.scheduleAutoSave();
			new Notice(`已擦除 ${r.removedStrokes} 笔`);
		}
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
	/**
	 * 圈选完成后**保留**的选区虚线边界（GoodNotes 语义）。
	 *
	 * 为什么要自绘而不是用 pdf.js 原生选中态：0.3.0 为满足「手写时不得出现选区框」
	 * （真机反复要求）给编辑层加了全局 CSS
	 * `.annotationEditorLayer .inkEditor { border/outline: none !important }`，
	 * 连带把套索的选中视觉也一并抹平了 —— 0.4.0 真机反馈「套索圈住了，
	 * 但看不到圈的是哪一块」正是这个根因。
	 * 给原生选中态开例外会让每一笔各自描边，与 GoodNotes「整组一个框」不符，
	 * 所以自绘一个包住整个选择集的虚线框。
	 */
	private lassoBoxEl: HTMLElement | null = null;
	/** 滚动 / 缩放时重算边界框的监听卸载器。 */
	private lassoBoxDetach: (() => void) | null = null;

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
				// 虚线边界与笔迹用同一个 transform 跟手，拖动过程中不会脱节
				if (this.lassoBoxEl) this.lassoBoxEl.style.transform = `translate(${dx}px, ${dy}px)`;
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
			new Notice('圈内没有笔迹（本页的笔迹须已在手写模式下加载）');
			return;
		}
		const r = this.engine.selectMany(hits);
		this.lassoSelection = hits;
		this.lassoPageNumber = pageNumber;
		if (!r.ok) new Notice(`圈选完成，但部分笔画未能入选（${r.failed} 个）`);
		// 圈中即画出「这块被选中了」的虚线边界（GoodNotes 同款语义）
		this.showLassoBox();
	}

	/** 移动收尾：撤掉 transform，按最终位移做契约重建（删旧建新）。 */
	private finishLassoMove(endPt: ScreenPoint): void {
		const dxPx = endPt.x - this.lassoStart.x;
		const dyPx = endPt.y - this.lassoStart.y;
		const selection = this.lassoSelection;
		this.clearLassoPath();

		// 位移太小当作误触：还原 transform 即可。
		// ⚠️ 这里必须把 lassoSelection 放回去 —— 选择集本身没变，只是没拖动，
		// 清空会让虚线边界就此消失（用户得重新圈一次）。
		const scale = this.engine.getScaleFactor() || 1;
		if (Math.hypot(dxPx, dyPx) < 4) {
			for (const editor of selection) {
				const div: HTMLElement | null = editor?.div ?? null;
				if (div) div.style.transform = '';
			}
			if (this.lassoBoxEl) this.lassoBoxEl.style.transform = '';
			this.lassoSelection = selection;
			return;
		}

		this.lassoSelection = [];

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
				// 重建换了新的 DOM 节点，边界框必须按新位置重算
				if (this.lassoBoxEl) this.lassoBoxEl.style.transform = '';
				this.showLassoBox();
			} else {
				this.hideLassoBox();
			}
			this.engine.commit();
			this.scheduleAutoSave();
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
			this.scheduleAutoSave();
			this.refreshPenBar();
		} else {
			new Notice(`删除失败：${r.error ?? '未知原因'}`);
		}
	}

	private clearLassoSelectionOnly(): void {
		this.lassoSelection = [];
		this.hideLassoBox();
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
		this.hideLassoBox();
	}

	/* ---- 圈选完成后的选区虚线边界（GoodNotes 式常驻边框） ---- */

	/** 按当前选择集的屏幕位置画出 / 更新虚线边界；选择集为空则收起。 */
	private showLassoBox(): void {
		const box = screenBBoxOfEditors(this.lassoSelection);
		if (!box) {
			this.hideLassoBox();
			return;
		}
		if (!this.lassoBoxEl?.isConnected) {
			this.hideLassoBox();
			this.lassoBoxEl = document.body.createDiv('fleur-pdf-lasso-box');
			this.attachLassoBoxTracking();
		}
		// 走到这里说明不是拖动中（拖动只改 transform），先把上一轮的位移清掉
		this.lassoBoxEl.style.transform = '';
		this.syncLassoBoxRect(box);
	}

	/** 把边界框摆到给定屏幕包围盒上（外扩 6px 呼吸边距）。 */
	private syncLassoBoxRect(box: { minX: number; minY: number; maxX: number; maxY: number }): void {
		const el = this.lassoBoxEl;
		if (!el) return;
		const pad = 6;
		el.setCssStyles({
			left: `${box.minX - pad}px`,
			top: `${box.minY - pad}px`,
			width: `${Math.max(0, box.maxX - box.minX + pad * 2)}px`,
			height: `${Math.max(0, box.maxY - box.minY + pad * 2)}px`,
		});
	}

	/**
	 * 页面滚动 / 窗口尺寸变化后重算边界框位置。
	 * 不做这件事的话，滚动后框会停在原处与笔迹脱节 —— 比不画框更让人困惑。
	 */
	private attachLassoBoxTracking(): void {
		this.lassoBoxDetach?.();
		const update = (): void => {
			if (!this.lassoSelection.length) return;
			const box = screenBBoxOfEditors(this.lassoSelection);
			if (box) this.syncLassoBoxRect(box);
		};
		const host = this.scrollHost;
		host?.addEventListener('scroll', update, { passive: true });
		window.addEventListener('resize', update);
		// pdf.js 缩放（捏合）后页面尺寸变化，ResizeObserver 比 resize 更可靠
		let ro: ResizeObserver | null = null;
		if (typeof ResizeObserver === 'function' && host) {
			ro = new ResizeObserver(update);
			ro.observe(host);
		}
		this.lassoBoxDetach = () => {
			host?.removeEventListener('scroll', update);
			window.removeEventListener('resize', update);
			ro?.disconnect();
		};
	}

	private hideLassoBox(): void {
		this.lassoBoxDetach?.();
		this.lassoBoxDetach = null;
		this.lassoBoxEl?.remove();
		this.lassoBoxEl = null;
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

	/* ============================ 触摸层（R9 → 0.2.0 重构） ============================
	 *
	 * 两层配合，解决两件事：
	 *
	 * A. 手势盾（attachGestureShield）—— 0.1.0 真机反馈：书写时左右滑动会呼出
	 *    Obsidian 的功能区 / 侧边栏。根因：Obsidian 的边缘滑手势监听 document 级
	 *    touch 事件，而书写通道（pdf.js 的 pointer、橡皮/套索的自建 pointer）都
	 *    拦不住 touch。盾在 **window 捕获阶段** 拦 touch：window 比 document 更靠
	 *    传播路径上游，stopPropagation 后手势识别器再也收不到事件。
	 *    pointer 事件由输入系统独立派发，不受影响 —— pdf.js 书写照常。
	 *
	 * B. 触摸路由（attachTouchRouter）—— GoodNotes 式防误触：手写模式下
	 *    手指（pointerType=touch）滚动页面，笔（pointerType=pen）才落墨。
	 *    手指的 pointerdown 在 host 捕获阶段被拦下（pdf.js 看不到，自然不画），
	 *    然后自己驱动 scrollTop/scrollLeft。可在设置里关掉（关掉后恢复 0.1.0
	 *    的「触摸绘制 + 双指滚动」语义）。
	 */

	/** 手势盾的卸载器。 */
	private gestureShieldDetach: (() => void) | null = null;

	/**
	 * 目标是否落在 PDF 滚动区域内。
	 * 笔盒与模式切换器挂在 document.body 下（不在 scrollHost 内），天然被排除 ——
	 * 这是「只在 PDF 区域接管触摸」的唯一依据。
	 */
	private isInPdfArea(target: EventTarget | null): boolean {
		const el = target as HTMLElement | null;
		return !!el && !!this.scrollHost && (el === this.scrollHost || this.scrollHost.contains(el));
	}

	private attachGestureShield(): void {
		if (this.gestureShieldDetach) return;

		const onTouchStart = (e: TouchEvent): void => {
			if (!this.active || !this.isInPdfArea(e.target)) return;
			// 阻断 Obsidian 的边缘滑动 / 手势识别（document 级监听全部收不到）
			e.stopPropagation();
		};
		const onTouchMove = (e: TouchEvent): void => {
			if (!this.active || !this.isInPdfArea(e.target)) return;
			e.stopPropagation();
			// 阻掉 WebKit 原生滚动与回弹 —— 滚动由触摸路由自己驱动
			e.preventDefault();
		};
		const onTouchEnd = (e: TouchEvent): void => {
			if (!this.active || !this.isInPdfArea(e.target)) return;
			e.stopPropagation();
		};

		window.addEventListener('touchstart', onTouchStart, { capture: true, passive: true });
		window.addEventListener('touchmove', onTouchMove, { capture: true, passive: false });
		window.addEventListener('touchend', onTouchEnd, { capture: true, passive: true });
		window.addEventListener('touchcancel', onTouchEnd, { capture: true, passive: true });

		this.gestureShieldDetach = () => {
			window.removeEventListener('touchstart', onTouchStart, { capture: true });
			window.removeEventListener('touchmove', onTouchMove, { capture: true });
			window.removeEventListener('touchend', onTouchEnd, { capture: true });
			window.removeEventListener('touchcancel', onTouchEnd, { capture: true });
		};
	}

	private detachGestureShield(): void {
		this.gestureShieldDetach?.();
		this.gestureShieldDetach = null;
	}

	/* ---- 触摸路由 ---- */

	private touchRouterDetach: (() => void) | null = null;
	private readonly touchPointers = new Map<number, { x: number; y: number }>();
	private touchScrolling = false;
	private touchStartY = 0;
	private touchStartX = 0;
	private touchStartScrollTop = 0;
	private touchStartScrollLeft = 0;

	private touchCenterY(): number {
		let sum = 0;
		for (const p of this.touchPointers.values()) sum += p.y;
		return this.touchPointers.size ? sum / this.touchPointers.size : 0;
	}

	private touchCenterX(): number {
		let sum = 0;
		for (const p of this.touchPointers.values()) sum += p.x;
		return this.touchPointers.size ? sum / this.touchPointers.size : 0;
	}

	private beginTouchScroll(): void {
		const host = this.scrollHost;
		if (!host) return;
		this.touchScrolling = true;
		this.touchStartY = this.touchCenterY();
		this.touchStartX = this.touchCenterX();
		this.touchStartScrollTop = host.scrollTop;
		this.touchStartScrollLeft = host.scrollLeft;
	}

	/** 剩余触点继续滚动时重设基准，避免跳动。 */
	private rebaseTouchScroll(): void {
		const host = this.scrollHost;
		if (!host || !this.touchScrolling) return;
		this.touchStartY = this.touchCenterY();
		this.touchStartX = this.touchCenterX();
		this.touchStartScrollTop = host.scrollTop;
		this.touchStartScrollLeft = host.scrollLeft;
	}

	/** 让 pdf.js 放弃已经开始的那一笔（第二触点出现时调用）。 */
	private cancelInkStroke(): void {
		const host = this.scrollHost;
		if (!host) return;
		const layerDiv = host.querySelector('.annotationEditorLayer');
		for (const id of this.touchPointers.keys()) {
			try {
				layerDiv?.dispatchEvent(
					new PointerEvent('pointercancel', { pointerId: id, bubbles: true, cancelable: true }),
				);
			} catch {
				/* 老 WebView 不支持 PointerEvent 构造时忽略 */
			}
		}
	}

	/**
	 * 解析真正的滚动容器。
	 *
	 * 从 PDF 页面元素向上找第一个「overflow 可滚动」的祖先，优先返回内容确实溢出
	 * （scrollHeight/clientHeight 不等）的那一个；找不到溢出的就退化为第一个可滚动的；
	 * 都没有才回落到类名候选。这样不依赖 Obsidian 的 DOM 层级细节 ——
	 * 那个层级在桌面 / 移动 / 不同版本之间并不一致。
	 */
	private resolveScrollHost(): HTMLElement | null {
		const inner =
			(document.querySelector('.pdfViewer .page') as HTMLElement | null) ??
			this.engine.getPageElement(1);
		let fallback: HTMLElement | null = null;
		let el: HTMLElement | null = inner?.parentElement ?? null;
		while (el && el !== document.body) {
			const cs = getComputedStyle(el);
			if (/(auto|scroll)/.test(`${ cs.overflowY } ${ cs.overflowX }`)) {
				if (!fallback) fallback = el;
				const overflows =
					el.scrollHeight > el.clientHeight + 1 || el.scrollWidth > el.clientWidth + 1;
				if (overflows) return el;
			}
			el = el.parentElement;
		}
		return fallback ?? (document.querySelector(SCROLL_SELECTOR) as HTMLElement | null);
	}

	private attachTouchRouter(): void {
		if (this.touchRouterDetach) return;

		this.scrollHost = this.resolveScrollHost();
		if (!this.scrollHost) return;

		/** 触点是否落在 PDF 区域内（笔盒 / 侧边栏等自绘 UI 不在此范围内）。 */
		const inPdfArea = (target: EventTarget | null): boolean => {
			const el = target as HTMLElement | null;
			return !!el?.closest?.('.pdf-viewer-container, .pdfViewer, .pdf-container');
		};

		const onDown = (e: PointerEvent): void => {
			if (e.pointerType !== 'touch') return;
			if (!inPdfArea(e.target)) return;
			// 视图可能被重建（切换文件 / 重新打开），宿主失连时重新探测
			if (!this.scrollHost?.isConnected) {
				this.scrollHost = this.resolveScrollHost();
				if (!this.scrollHost) return;
			}
			this.touchPointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

			if (!this.fingerScroll) {
				// 关闭手指滚动：维持 0.1.0 语义 —— 触摸绘制，双指接管滚动
				if (this.touchPointers.size === 2) {
					this.beginTouchScroll();
					// 第一个触点可能已经落墨，让 pdf.js 放弃本笔
					this.cancelInkStroke();
					e.stopPropagation();
					e.preventDefault();
				}
				return;
			}

			// 手指滚动（GoodNotes 式防误触）：手指不再落墨，改为驱动滚动。
			// stopPropagation 让 pdf.js 的编辑层收不到这个 pointerdown —— 手指画不出笔迹。
			if (this.touchPointers.size === 1) {
				this.beginTouchScroll();
			}
			e.stopPropagation();
			e.preventDefault();
		};

		const onMove = (e: PointerEvent): void => {
			if (!this.touchPointers.has(e.pointerId)) return;
			this.touchPointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
			if (!this.touchScrolling) return;
			const host = this.scrollHost;
			if (!host) return;
			e.stopPropagation();
			e.preventDefault();
			host.scrollTop = this.touchStartScrollTop - (this.touchCenterY() - this.touchStartY);
			host.scrollLeft = this.touchStartScrollLeft - (this.touchCenterX() - this.touchStartX);
		};

		const onUp = (e: PointerEvent): void => {
			if (!this.touchPointers.has(e.pointerId)) return;
			this.touchPointers.delete(e.pointerId);
			if (this.touchPointers.size === 0) {
				this.touchScrolling = false;
			} else if (this.touchScrolling) {
				this.rebaseTouchScroll();
			}
		};

		// 全部挂在 window 捕获阶段：滚动宿主可能因视图重建而更换，
		// 挂死在某个元素上会在更换后失效（手指划不动的隐性成因之一）。
		window.addEventListener('pointerdown', onDown, { capture: true, passive: false });
		window.addEventListener('pointermove', onMove, { capture: true, passive: false });
		window.addEventListener('pointerup', onUp, { capture: true });
		window.addEventListener('pointercancel', onUp, { capture: true });

		this.touchRouterDetach = () => {
			window.removeEventListener('pointerdown', onDown, { capture: true });
			window.removeEventListener('pointermove', onMove, { capture: true });
			window.removeEventListener('pointerup', onUp, { capture: true });
			window.removeEventListener('pointercancel', onUp, { capture: true });
			this.touchPointers.clear();
			this.touchScrolling = false;
			this.scrollHost = null;
		};
	}

	private detachTouchRouter(): void {
		this.touchRouterDetach?.();
		this.touchRouterDetach = null;
	}

	/** 卸载橡皮 / 套索 / 落笔收尾的输入接管（退出手写模式时调用，避免监听器跨模式残留）。 */
	private detachPenInput(): void {
		this.eraserDetach?.();
		this.eraserDetach = null;
		this.lassoDetach?.();
		this.lassoDetach = null;
		this.detachDrawSettle();
	}
}
