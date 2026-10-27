/** In-memory process compatibility key; credentials are hashed and never exposed. */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Config } from '../types/index.js';

export function modelRevision(config: Config): string {
  const hash = crypto.createHash('sha256');
  hash.update(JSON.stringify({ runtime: config.agent.runtime, model: config.agent.model,
    llm: config.agent.model.source === 'app-llm' ? config.llm : null }));
  if (config.agent.model.source === 'pi-agent-dir') {
    const home = path.resolve(process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), '.pi', 'agent'));
    hash.update(home);
    for (const name of ['models.json', 'auth.json']) {
      hash.update(name);
      try { hash.update(fs.readFileSync(path.join(home, name))); } catch { hash.update('unreadable'); }
    }
  }
  return hash.digest('hex');
}
