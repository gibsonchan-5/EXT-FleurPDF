// 数据存储层
import { App, normalizePath } from 'obsidian';
import type { Annotation, PDFAnnotationData, AIResult } from './types';

/**
 * EXT 测试版专用：批注数据目录固定指向主插件。
 *
 * 测试版 id 是 `fleur-pdf-mobile`，若按 id 推导，数据会落在
 * `plugins/fleur-pdf-mobile/data/`，iPad 上打开任何老 PDF 都是空的 ——
 * 而「手写批注与已有批注共存」恰恰是本次要验证的核心场景。
 * 因此这里让测试版仍读写 `plugins/fleur-pdf/data/`。
 *
 * ⚠️ 毕业合并回主仓库时，id 会改回 `fleur-pdf`，本分支随之自动退化为原始行为，
 * 这段常量与判断可一并删除。
 */
export const SHARED_DATA_PLUGIN_ID = 'fleur-pdf';

export class AnnotationStore {
  private baseDir: string;

  constructor(private app: App, private pluginId: string) {
    const dataPluginId = pluginId === 'fleur-pdf-mobile' ? SHARED_DATA_PLUGIN_ID : pluginId;
    this.baseDir = `${app.vault.configDir}/plugins/${dataPluginId}/data`;
  }

  private getFilePath(pdfPath: string): string {
    const hash = this.hashPath(pdfPath);
    return normalizePath(`${this.baseDir}/${hash}.json`);
  }

  private hashPath(path: string): string {
    return path.replace(/[^a-zA-Z0-9]/g, '_');
  }

  async ensureDir(): Promise<void> {
    if (!(await this.app.vault.adapter.exists(this.baseDir))) {
      await this.app.vault.adapter.mkdir(this.baseDir);
    }
  }

  async load(pdfPath: string): Promise<PDFAnnotationData> {
    await this.ensureDir();
    const filePath = this.getFilePath(pdfPath);

    try {
      if (await this.app.vault.adapter.exists(filePath)) {
        const content = await this.app.vault.adapter.read(filePath);
        return JSON.parse(content) as PDFAnnotationData;
      }
    } catch {
      // 加载失败时返回空数据
    }

    return { fileId: pdfPath, annotations: [] };
  }

  async save(data: PDFAnnotationData): Promise<void> {
    await this.ensureDir();
    const filePath = this.getFilePath(data.fileId);
    await this.app.vault.adapter.write(filePath, JSON.stringify(data, null, 2));
  }

  async addAnnotation(pdfPath: string, annotation: Annotation): Promise<void> {
    const data = await this.load(pdfPath);
    // 防止重复：检查是否已存在相同 id 的批注
    const exists = data.annotations.some(a => a.id === annotation.id);
    if (!exists) {
      data.annotations.push(annotation);
      await this.save(data);
    }
  }

  async removeAnnotation(pdfPath: string, annotationId: string): Promise<void> {
    const data = await this.load(pdfPath);
    data.annotations = data.annotations.filter(a => a.id !== annotationId);
    await this.save(data);
  }

  // AI 缓存相关方法
  async addAIResult(pdfPath: string, result: AIResult): Promise<void> {
    const data = await this.load(pdfPath);
    if (!data.aiResults) {
      data.aiResults = [];
    }
    data.aiResults.push(result);
    await this.save(data);
  }

  async getAIResults(pdfPath: string): Promise<AIResult[]> {
    const data = await this.load(pdfPath);
    const results: AIResult[] = data.aiResults ?? [];
    return results;
  }

  async removeAIResult(pdfPath: string, resultId: string): Promise<void> {
    const data = await this.load(pdfPath);
    if (data.aiResults) {
      data.aiResults = data.aiResults.filter(r => r.id !== resultId);
      await this.save(data);
    }
  }
}
