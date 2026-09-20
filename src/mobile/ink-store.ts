// 手写笔迹的 sidecar 存储（v0.5 方案 C 的真相源）。
//
// ⚠️ **本文件是「历史笔迹擦不掉」与「关闭重开掉笔迹」两个顽疾的架构性解法，改动前务必读完。**
//
// 架构定调：
//   笔迹的**唯一真相源**是这里 —— 插件自己的 JSON，**不是** PDF 文件。
//   pdf.js 的编辑器只当画布（复用它的压感、平滑与外观流），不再把笔迹写回 PDF。
//
// 为什么必须这样 —— 0.4.0 → 0.4.4 连续五轮修复都没能解决的真机问题，
// 根因是「写回 PDF」这条路线自带三个连锁缺陷：
//
//   ① 写回触发视图重载：vault.modifyBinary 让 Obsidian 销毁并重建 PDF 视图，
//      内存里**其余未写回的**笔迹全部蒸发 —— 真机反馈的「只存开头几笔」。
//   ② 写回过的笔迹变成「文件固有注释」：要擦它得先等 pdf.js 把注释转成可编辑对象，
//      而转换入口 AnnotationLayer.getEditableAnnotations() 依赖注释层**已渲染完**，
//      时机不可控（0.4.4 的播种只跑一次、450ms 就放弃）。
//   ③ 固有编辑器的 serialize() **恒返回 null**：
//        if (this.annotationElementId && !hasElementChanged(o)) return null;
//      而 hasElementChanged 只比 color / thickness / opacity / pageIndex / 位移，
//      **不比笔画**。于是擦除遍历时读不到任何几何数据，历史笔迹静默擦不掉。
//
// 改成插件自管之后，两个问题同时消失：
//   · 重开时从 JSON 重建的编辑器**不带 annotationElementId** ⇒ serialize() 永远正常返回
//     ⇒ 不论何时、不论是否重开过，历史笔迹都能擦、能套索、能移动。
//   · 写 JSON **不触碰 PDF 文件** ⇒ 不会触发视图重载 ⇒ 内存里的笔迹不会丢。
//
// 代价（已与用户确认接受）：笔迹默认不再进 PDF 文件本体，换别的阅读器看不到。
// 需要给外部阅读器看时，走「导出到 PDF」（把笔迹烧进 PDF 副本），不覆盖原文件。

import { App, TFile, normalizePath } from 'obsidian';

/** 笔迹数据目录（vault 内相对路径）。点开头 → 不进 Obsidian 文件索引，不污染图谱与搜索。 */
export const INK_DATA_DIR = '.fleur-pdf/ink';

/**
 * 数据格式版本。
 * 结构不兼容变更时递增；读到更高版本的数据按「无法识别」处理（跳过，不猜）。
 */
export const INK_DATA_VERSION = 1;

/**
 * 单条笔迹 = 一个 pdf.js `InkEditor` 的完整快照。
 *
 * `data` 直接沿用 `InkEditor.serialize(true)` 的产出（`annotationType` / `color` /
 * `thickness` / `opacity` / `paths.lines` / `paths.points` / `rect` / `rotation` /
 * `pageIndex`），这样重建时能原样喂回 `AnnotationEditorLayer.deserialize()`，
 * 不需要我们自己维护一套坐标与外观的映射表。
 *
 * 但必须**剔除**三个字段（见 `stripInkIdentity`）：
 *   · `id` / `annotationElementId` —— 留着就会被 pdf.js 当成「文件固有注释」，
 *     serialize() 重新开始返回 null，擦除立刻失效（正是本次要根治的坑）。
 *   · `isCopy` —— serialize(true) 会带上，留着会让 DrawingEditor.render() 走
 *     `_moveAfterPaste` 把重建的笔迹再挪一次，落点偏掉。
 */
export interface InkEntry {
	/** 0 基页码。 */
	page: number;
	/** 已剔除身份字段的序列化快照。 */
	data: Record<string, unknown>;
	/**
	 * 这条笔迹**原本**对应的 PDF 注释 id（若是从文件固有注释接管过来的）。
	 *
	 * 用途：PDF 里那条原件依然存在（我们不写回、不删它，否则要改写用户文件并
	 * 触发视图重载）。为了不出现「原件 + 我们重建的编辑器」双影，每次恢复时按
	 * 这个 id 把原件 `hide()` 掉。hide 只影响当前会话的 DOM —— 用户禁用插件或
	 * 换别的阅读器打开，原件照常显示，不会丢东西。
	 *
	 * 新画的笔迹没有对应的 PDF 注释，此字段为空。
	 */
	sourceId?: string;
}

export interface InkSidecar {
	version: number;
	/** 对应的 PDF 在 vault 内的相对路径，便于人工核对与排障。 */
	file: string;
	/** 最后写入时间（Unix 毫秒）。 */
	updated: number;
	entries: InkEntry[];
	/**
	 * **曾经**从 PDF 固有注释接管过来的注释 id 全集（只增不减）。
	 *
	 * 与 `InkEntry.sourceId` 的区别是这个字段**不受擦除影响**，而它必须如此：
	 * 擦掉一条接管来的笔迹后，PDF 里的原件仍在（我们不改写用户文件），只是被
	 * `hide()` 挡着。如果这里不单独记一笔，下次进入时该注释会被重新「接管」回来 ——
	 * 用户的感受就是「擦掉的笔迹又自己长回来了」。
	 */
	claimedIds?: string[];
}

/**
 * 路径 → 稳定短哈希（djb2）。
 * 用途：把可能很长的 vault 相对路径压成定长后缀，避免文件名超长
 * （多数文件系统限 255 字节）与中文/特殊字符在部分同步服务上的转义问题。
 */
function shortHash(s: string): string {
	let h = 5381;
	for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
	return (h >>> 0).toString(36);
}

export class InkStore {
	constructor(private app: App) {}

	/** 该 PDF 对应的 sidecar 路径：`<原文件名>.<路径哈希>.json`（保留原名便于肉眼定位）。 */
	pathFor(file: TFile): string {
		const base = file.name
			.replace(/\.pdf$/i, '')
			// 去掉在各平台/同步服务上会出问题的字符
			.replace(/[\\/:*?"<>|]/g, '_')
			.slice(0, 60);
		return normalizePath(`${INK_DATA_DIR}/${base}.${shortHash(file.path)}.json`);
	}

	/** 确保数据目录存在。 */
	private async ensureDir(): Promise<boolean> {
		const adapter = this.app.vault.adapter;
		const dir = normalizePath(INK_DATA_DIR);
		try {
			if (await adapter.exists(dir)) return true;
			await adapter.mkdir(dir);
			return true;
		} catch {
			// 并发创建时 mkdir 可能抛「已存在」，再确认一次即可
			try {
				return await adapter.exists(dir);
			} catch {
				return false;
			}
		}
	}

	/**
	 * 读取该 PDF 的笔迹数据。
	 *
	 * 任何异常（文件不存在 / JSON 损坏 / 版本不认识）都返回 null —— 调用方据此
	 * 走「当作还没有笔迹」的正常路径。这里**不能抛**：它跑在打开文件的入口上，
	 * 抛出去会让整个手写模块挂不上，而「读不到笔迹」本身不该是致命错误。
	 */
	async load(file: TFile): Promise<InkSidecar | null> {
		const adapter = this.app.vault.adapter;
		const path = this.pathFor(file);
		try {
			if (!(await adapter.exists(path))) return null;
			const raw = await adapter.read(path);
			const parsed = JSON.parse(raw) as InkSidecar;
			if (!parsed || typeof parsed !== 'object') return null;
			if (parsed.version !== INK_DATA_VERSION) return null;
			if (!Array.isArray(parsed.entries)) return null;
			// 逐条过滤掉结构不完整的项：宁可少几个笔画，也不能让一条坏数据
			// 把整份文件的重建流程打断（重建是逐条 try/catch 的，但这里先挡一道）。
			const entries = parsed.entries.filter(
				(e) =>
					e &&
					typeof e.page === 'number' &&
					e.data &&
					typeof e.data === 'object' &&
					(e.data as any).paths,
			);
			const claimedIds = Array.isArray(parsed.claimedIds)
				? parsed.claimedIds.filter((x): x is string => typeof x === 'string')
				: [];
			return { ...parsed, entries, claimedIds };
		} catch {
			return null;
		}
	}

	/**
	 * 写入笔迹数据（覆盖）。
	 *
	 * 「笔迹全被擦光」时才删文件 —— 判据必须同时看 entries 与 claimedIds：
	 * 用户把接管来的笔迹全擦了，entries 会变空，但 PDF 里的原件仍在，claimedIds
	 * 一旦丢掉，下次进入就会把它们全部重新接管回来。
	 */
	async save(file: TFile, entries: InkEntry[], claimedIds: string[] = []): Promise<void> {
		const claimed = Array.from(new Set(claimedIds));
		if (!entries.length && !claimed.length) {
			await this.remove(file);
			return;
		}
		if (!(await this.ensureDir())) throw new Error('无法创建笔迹数据目录');
		const payload: InkSidecar = {
			version: INK_DATA_VERSION,
			file: file.path,
			updated: Date.now(),
			entries,
			claimedIds: claimed,
		};
		await this.app.vault.adapter.write(this.pathFor(file), JSON.stringify(payload));
	}

	/** 删除该 PDF 的笔迹数据（笔迹被全部擦掉时调用）。 */
	async remove(file: TFile): Promise<void> {
		const adapter = this.app.vault.adapter;
		const path = this.pathFor(file);
		try {
			if (await adapter.exists(path)) await adapter.remove(path);
		} catch {
			/* 删不掉不影响使用，下次 save 会覆盖 */
		}
	}
}

/**
 * 剔除会改变 pdf.js 身份判定的字段。
 *
 * 抽成导出函数而不是私有方法：ink-erase / ink-lasso 的重建路径也要用同一套规则，
 * 两边各写一份迟早会漂移 —— 而这里的字段漏掉任何一个，症状都是「擦完就擦不动了」。
 */
export function stripInkIdentity(data: Record<string, unknown>): Record<string, unknown> {
	const out: Record<string, unknown> = { ...data };
	delete out.id;
	delete out.annotationElementId;
	delete out.isCopy;
	delete out.deleted;
	delete out.popupRef;
	delete out.structTreeParentId;
	return out;
}
