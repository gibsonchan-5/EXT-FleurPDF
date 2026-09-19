// 手写批注的落盘与备份。
//
// 存储策略（与 v0.3 方案文档第 11 节的定论一致）：
//   · 主存储 = PDF 文件本身。R1 实测证明 pdf.js 的 saveDocument 产出的是标准
//     `/Subtype /Ink` + `/InkList` 注释，Adobe / PDF Expert / 系统预览都能看到。
//     因此手写批注不是插件私有产物，没有第二套 sidecar 数据库需要维护。
//   · 伴生 = vault 内的显式目录，只放「写回前的原文件备份」，作为可撤销的中间态。
//
// 为什么备份不可省：写回是原地改写用户的原文件。同步（Obsidian Sync / remotely-save）
// 与多端并发下存在覆盖风险，出了问题必须能从备份恢复。

import { App, TFile, normalizePath } from 'obsidian';
import type { InkEngine } from './ink-engine';

/** 备份目录（vault 内相对路径）。点开头 → 不进 Obsidian 的文件索引，不污染用户的图谱与搜索。 */
export const INK_BACKUP_DIR = '.fleur-pdf/ink-backup';

/** 每个 PDF 最多保留的备份份数，超出后从最旧的开始删。 */
export const INK_BACKUP_KEEP = 5;

export interface SaveOutcome {
	ok: boolean;
	error?: string;
	/**
	 * 未写盘的原因。
	 * `empty` = 没有可写回的内容（视图已销毁、或本来就还没落墨）—— 属正常情况，
	 * 调用方**不应**把它当失败弹提示。真机 0.4.1 那条「保存失败：没有可写回的手写
	 * 批注」的误报，正是因为这条正常路径被当成错误报了出来。
	 * `error` = 真的写入失败（IO / 文件被占用等）。
	 */
	reason?: 'empty' | 'error';
	/** 本次备份的路径（失败为空）。 */
	backupPath?: string;
	/** 写回的字节数。 */
	bytes?: number;
	/** 写回前检测到文件被外部改动。 */
	staleWarning?: boolean;
}

/** 备份文件名：原名 + 时间戳，保留 .pdf 后缀便于直接用阅读器打开核对。 */
function backupNameFor(file: TFile, stamp: string): string {
	const base = file.name.replace(/\.pdf$/i, '');
	return normalizePath(`${INK_BACKUP_DIR}/${base}.${stamp}.pdf`);
}

/** 时间戳：YYYYMMDD-HHmmss，字典序即时间序，便于清理排序。 */
function stamp(d: Date = new Date()): string {
	const p = (n: number) => String(n).padStart(2, '0');
	return (
		`${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
		`-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
	);
}

export class InkStorage {
	constructor(private app: App) {}

	/** 确保备份目录存在。 */
	private async ensureDir(): Promise<boolean> {
		const { vault } = this.app;
		const path = normalizePath(INK_BACKUP_DIR);
		if (vault.getAbstractFileByPath(path)) return true;
		try {
			// 逐级创建，getAbstractFileByPath 只认完整路径
			await vault.createFolder(path);
			return true;
		} catch {
			try {
				return !!vault.getAbstractFileByPath(path);
			} catch {
				return false;
			}
		}
	}

	/** 把当前文件内容另存一份到备份目录。返回备份路径，失败返回 null。 */
	async backup(file: TFile): Promise<string | null> {
		if (!(await this.ensureDir())) return null;
		try {
			const data = await this.app.vault.readBinary(file);
			const path = backupNameFor(file, stamp());
			await this.app.vault.createBinary(path, data);
			return path;
		} catch {
			return null;
		}
	}

	/** 清理旧备份，只保留最近 keep 份。返回删除数量。 */
	async pruneBackups(file: TFile, keep = INK_BACKUP_KEEP): Promise<number> {
		const { vault } = this.app;
		const dir = vault.getAbstractFileByPath(normalizePath(INK_BACKUP_DIR));
		if (!dir) return 0;
		const base = file.name.replace(/\.pdf$/i, '');
		const prefix = `${base}.`;

		const mine = vault
			.getFiles()
			.filter((f) => f.path.startsWith(`${normalizePath(INK_BACKUP_DIR)}/`) && f.name.startsWith(prefix))
			.sort((a, b) => a.name.localeCompare(b.name)); // 名字含时间戳，字典序即时间序

		let removed = 0;
		const excess = mine.length - keep;
		for (let i = 0; i < excess; i++) {
			try {
				await vault.delete(mine[i]);
				removed++;
			} catch {
				/* 单个删除失败不影响其余 */
			}
		}
		return removed;
	}

	/**
	 * 把内存中的手写批注写回 PDF。
	 *
	 * 流程：生成字节 → 备份原文件 → 原地写回 → 清理旧备份。
	 * 任何一步失败都保证「原文件要么是旧的、要么是新的」，不会写坏。
	 */
	async saveAnnotated(engine: InkEngine, file: TFile): Promise<SaveOutcome> {
		const bytes = await engine.exportAnnotatedBytes();
		if (!bytes || bytes.length === 0) {
			// 「导不出内容」不是失败：多数场合是视图已被销毁（关闭文件 / 切标签页），
			// 此时既没东西可写、也不该惊动用户。用 reason 把它与真 IO 错误区分开。
			return { ok: false, reason: 'empty', error: '没有可写回的手写批注' };
		}

		// 先备份：备份失败仍允许继续（但会把这一情况告诉调用方）。
		const backupPath = await this.backup(file);

		try {
			await this.app.vault.modifyBinary(file, bytes);
		} catch (err) {
			return {
				ok: false,
				reason: 'error',
				backupPath: backupPath ?? undefined,
				error: err instanceof Error ? err.message : String(err),
			};
		}

		engine.markSaved();
		void this.pruneBackups(file).catch(() => undefined);

		return { ok: true, backupPath: backupPath ?? undefined, bytes: bytes.length };
	}

	/** 备份目录里该文件的备份列表（最新在后）。 */
	listBackups(file: TFile): TFile[] {
		const base = file.name.replace(/\.pdf$/i, '');
		const prefix = `${base}.`;
		return this.app.vault
			.getFiles()
			.filter(
				(f) => f.path.startsWith(`${normalizePath(INK_BACKUP_DIR)}/`) && f.name.startsWith(prefix),
			)
			.sort((a, b) => a.name.localeCompare(b.name));
	}
}
