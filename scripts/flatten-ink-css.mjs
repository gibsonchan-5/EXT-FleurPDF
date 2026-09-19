// 一次性转换：把 ink-css.ts（原生 CSS 嵌套 + light-dark()）降级为
// 「全平铺选择器 + 明暗两份静态颜色」的生成文件 ink-css.flat.ts。
//
// 为什么必须做：移动端 WebView（iOS WKWebView / Android WebView）版本不可控，
//   · 原生 CSS 嵌套（无 & 前缀）需要 Safari 17.2+ / Chromium 120+；
//   · light-dark() 需要 Safari 17.5+ / Chromium 123+。
// 任一不满足 → pdf.js editToolbar 的图标/底色规则被整块丢弃或算成透明，
// 表现就是「白色工具条 + 几乎不可见的图标」。
//
// 用法（仅在需要重新生成产物时执行，构建期/CI 不依赖本脚本）：
//   npm i -D postcss postcss-nesting        # 两个一次性开发依赖
//   node scripts/flatten-ink-css.mjs
//   git checkout package.json package-lock.json   # 生成后可按需还原依赖声明
//
// 产物 ink-css.flat.ts 已提交进仓库，构建期不依赖 postcss（CI 不受影响）。

import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';

const require = createRequire(import.meta.url);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// 依赖一律按「脚本所在仓库」解析，绝不写死本机绝对路径。
function loadDep(name) {
	try {
		return require.resolve(name, { paths: [ROOT] });
	} catch {
		console.error(
			`\n缺少依赖「${ name }」。请先在仓库根目录执行：\n` +
			`  npm i -D postcss postcss-nesting\n` +
			`然后重新运行本脚本。\n`,
		);
		process.exit(1);
	}
}

const esbuild = await import(pathToFileURL(loadDep('esbuild')).href);
const postcss = await import(pathToFileURL(loadDep('postcss')).href);
const nesting = await import(pathToFileURL(loadDep('postcss-nesting')).href);

const SRC = join(ROOT, 'src/mobile/ink-css.ts');
const OUT = join(ROOT, 'src/mobile/ink-css.flat.ts');

// ── 1. 用 esbuild 把 TS 转成 JS，拿到三条 CSS 常量 ──
const tmp = mkdtempSync(join(tmpdir(), 'inkcss-'));
const jsFile = join(tmp, 'ink-css.js');
await esbuild.default.build({
	entryPoints: [SRC],
	outfile: jsFile,
	format: 'esm',
	charset: 'utf8',
});
const mod = await import(pathToFileURL(jsFile).href);
const cssAll = [mod.LAYER_BASE_CSS, mod.DRAW_LAYER_CSS, mod.EDITOR_LAYER_CSS].join('\n');

// ── 2. 展开原生嵌套 → 平铺选择器 ──
const flatten = nesting.default ?? nesting;
const flattened = await (postcss.default ?? postcss)([flatten()])
	.process(cssAll, { from: undefined })
	.then((r) => r.css);

// ── 3. light-dark(L, D) → 明色落进主流，暗色收集为 body.theme-dark 覆盖 ──
const darkOverrides = []; // { selector, prop, dark }
const root = (postcss.default ?? postcss).parse(flattened);

function splitLightDark(value) {
	// 只处理顶层（非嵌套括号内）的 light-dark(...)；pdf.js 表中没有嵌套用法
	const m = value.match(/light-dark\(\s*([^,]+?)\s*,\s*([^)]+?)\s*\)/);
	if (!m) return null;
	return { light: m[1], dark: m[2], whole: m[0] };
}

const nestedPrefix = 'body.theme-dark ';
root.walkDecls((decl) => {
	const parts = splitLightDark(decl.value);
	if (!parts) return;
	decl.value = decl.value.split(parts.whole).join(parts.light);
	// 收集所在规则链（父选择器串）
	const sels = [];
	let node = decl.parent;
	while (node && node.type !== 'root') {
		if (node.type === 'rule' || node.type === 'atrule') sels.unshift(node);
		node = node.parent;
	}
	// at-rule（@media 等）里的不提升，直接跳过：light-dark 在 @media 中的
	// 仅 forced-colors 分支使用系统色，不随主题变化，可安全取 light 值
	if (sels.some((n) => n.type === 'atrule')) return;
	const selector = sels.filter((n) => n.type === 'rule').map((n) => n.selector).join(' ');
	darkOverrides.push({ selector, prop: decl.prop, dark: parts.dark });
});

// 生成暗色覆盖块（按 selector 分组）
const bySel = new Map();
for (const o of darkOverrides) {
	if (!bySel.has(o.selector)) bySel.set(o.selector, []);
	bySel.get(o.selector).push(`${ o.prop }: ${ o.dark };`);
}
let darkCss = '\n/* ==== 以下由 light-dark() 拆分生成：暗色主题覆盖（Obsidian body.theme-dark）==== */\n';
for (const [sel, decls] of bySel) {
	darkCss += `${nestedPrefix}${sel} {\n  ${decls.join('\n  ')}\n}\n`;
}

// ── 4. 校验：平铺后不允许再出现嵌套特征与 light-dark ──
const problems = [];
if (/light-dark\(/.test(root.toString())) problems.push('仍残留 light-dark()');
if (/(^|[{\s;])&/.test(root.toString())) problems.push('仍残留嵌套 &');

const finalCss = root.toString() + darkCss;
if (problems.length) {
	console.error('校验失败:', problems);
	process.exit(1);
}

// ── 5. 生成 TS ──
const ts = `// ⚠️ 本文件由 scripts/flatten-ink-css.mjs 生成，请勿手改。
// 源文件：src/mobile/ink-css.ts（嵌套 + light-dark 原始版，保留作对照）。
// 生成内容：全部选择器平铺 + light-dark() 拆为明/暗静态值（暗色由 body.theme-dark 前缀覆盖），
// 兼容不支持原生 CSS 嵌套 / light-dark() 的旧移动端 WebView（Safari < 17.5 / Chromium < 120）。
// 图标仍为 url(images/…) 占位，运行时由 ink-icons.inlineIconUrls 换成 data URI。

export const INK_EDITOR_CSS_FLAT = ${JSON.stringify(finalCss)};
`;
writeFileSync(OUT, ts);
console.log('OK 已生成', OUT.replace(ROOT + '/', ''));
console.log('  平铺后长度:', finalCss.length, '字符');
console.log('  暗色覆盖块:', bySel.size, '组 /', darkOverrides.length, '条声明');
