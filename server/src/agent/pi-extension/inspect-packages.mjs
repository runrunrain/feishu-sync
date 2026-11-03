// 使用当前Pi安装的原生包解析器；只解析资源，不加载扩展工厂。
// argv: <pi包根> <agentDir> [mode]
// mode 省略/'resources'：resolve() 全量解析资源（PiPluginService 既有语义）。
// mode 'list'：只读包清单——listConfiguredPackages() + settings 载入错误，
//   不调用 resolve()（resolve 会对缺失的 npm/git 声明自动补装，见
//   package-manager resolvePackageSources 的 installMissing 分支；只读
//   发现不得触发安装/写全局，PI_OFFLINE 只是兜底而非依据）。
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const [root, agentDir, mode] = process.argv.slice(2);
const load = (name) => import(pathToFileURL(path.join(root, 'dist/core', name + '.js')).href);
const { SettingsManager } = await load('settings-manager');
const { DefaultPackageManager } = await load('package-manager');
const settings = SettingsManager.create(agentDir, agentDir);
const manager = new DefaultPackageManager({ cwd: agentDir, agentDir, settingsManager: settings });
if (mode === 'list') {
  const settingsErrors = (settings.errors ?? []).map((error) => ({
    scope: error.scope,
    path: error.path ?? null,
    message: error.error instanceof Error ? error.error.message : String(error.error),
  }));
  console.log('FEISHU_PACKAGES_JSON=' + JSON.stringify({ packages: manager.listConfiguredPackages(), settingsErrors }));
} else {
  const resources = await manager.resolve();
  console.log('FEISHU_PACKAGES_JSON=' + JSON.stringify({ packages: manager.listConfiguredPackages(), resources }));
}
