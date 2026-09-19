import { readFileSync, writeFileSync } from 'fs';

const targetVersion = process.env.npm_package_version;

// ⚠️ 守卫：npm_package_version 只在 `npm version <x.y.z>` 触发本脚本时才由 npm 注入。
// 如果直接 `node version-bump.mjs`（或 npm version 中途失败），它是 undefined ——
// 而 `manifest.version = undefined` 在 JSON.stringify 里会被**直接丢弃**，
// 结果是 manifest.json 的 version 字段整个消失（Obsidian 认为插件无版本，
// CI 的 tag/manifest 一致性守卫也会拒绝发版）。这是静默失败，必须硬中断。
if (!targetVersion) {
	console.error(
		'拒绝执行：npm_package_version 为空。\n' +
			'请用 `npm version <x.y.z> --no-git-tag-version` 触发本脚本，不要直接 node version-bump.mjs。',
	);
	process.exit(1);
}
if (!/^\d+\.\d+\.\d+$/.test(targetVersion)) {
	console.error(`拒绝执行：版本号格式非法（${ targetVersion }），应为 x.y.z。`);
	process.exit(1);
}

// read minAppVersion from manifest.json and bump version to targetVersion
const manifest = JSON.parse(readFileSync('manifest.json', 'utf8'));
const { minAppVersion } = manifest;
manifest.version = targetVersion;
writeFileSync('manifest.json', JSON.stringify(manifest, null, '\t'));

// update versions.json with target version and minAppVersion from manifest.json
const versions = JSON.parse(readFileSync('versions.json', 'utf8'));
// 清掉历史误写（旧版脚本无守卫时可能留下 "undefined" 键）
delete versions.undefined;
versions[targetVersion] = minAppVersion;
writeFileSync('versions.json', JSON.stringify(versions, null, '\t'));

console.log(`已同步版本 ${ targetVersion } 到 manifest.json 与 versions.json`);
