// 使用当前Pi安装的原生包解析器；只解析资源，不加载扩展工厂。
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const [root, agentDir] = process.argv.slice(2);
const load = (name) => import(pathToFileURL(path.join(root, 'dist/core', name + '.js')).href);
const { SettingsManager } = await load('settings-manager');
const { DefaultPackageManager } = await load('package-manager');
const settings = SettingsManager.create(agentDir, agentDir);
const manager = new DefaultPackageManager({ cwd: agentDir, agentDir, settingsManager: settings });
const resources = await manager.resolve();
console.log('FEISHU_PACKAGES_JSON=' + JSON.stringify({ packages: manager.listConfiguredPackages(), resources }));
