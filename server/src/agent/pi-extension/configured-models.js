/** Read-only local Pi bridge. Share only configured chat models, never the builtin catalog. */
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export async function loadConfiguredModels({ piRoot, sharedHome, appHome }) {
  const load = (name) => import(pathToFileURL(path.join(piRoot, 'dist/core', `${name}.js`)).href);
  const { ModelRuntime } = await load('model-runtime');
  const { ReadOnlyAuthStorage } = await load('auth-storage');
  const credentials = new ReadOnlyAuthStorage(path.join(sharedHome, 'auth.json'));
  const runtime = await ModelRuntime.create({
    credentials,
    modelsPath: path.join(sharedHome, 'models.json'),
    modelsStorePath: path.join(appHome, 'shared-models-store.json'),
    allowModelNetwork: false,
    refreshOnCreate: false,
  });
  if (runtime.getError()) throw new Error('本地 Pi 模型配置无效，请检查 models.json');
  const available = await runtime.getAvailable();
  const groups = new Map();
  for (const model of available) {
    if (model.type && model.type !== 'chat') continue;
    const credential = await credentials.read(model.provider);
    // The shared store cannot persist OAuth refreshes. Reauthenticate in Pi first.
    if (credential?.type === 'oauth' && (!credential.access || credential.expires <= Date.now())) continue;
    if (!runtime.getProviderAuthStatus(model.provider).configured) continue;
    const group = groups.get(model.provider) ?? [];
    group.push(model); groups.set(model.provider, group);
  }
  return { runtime, groups };
}

export async function registerConfiguredModels(pi, options) {
  const { runtime, groups } = await loadConfiguredModels(options);

  for (const [id, models] of groups) {
    const provider = runtime.getProvider(id);
    pi.registerProvider({
      ...provider,
      getModels: () => models,
      // Auth is resolved against the read-only shared store, not the app's empty auth.json.
      auth: { apiKey: {
        name: 'Local Pi configuration',
        check: ({ signal }) => runtime.checkAuth(id, { signal }),
        resolve: ({ signal }) => runtime.getAuth(id, { signal }),
      } },
      stream: (model, context, options) => runtime.stream(model, context, options),
    });
  }
}
