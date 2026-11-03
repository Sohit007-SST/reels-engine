/**
 * Canonical agent definitions live in agents/<name>.md (frontmatter + instructions).
 * `npm run agents:sync` renders .claude/agents/<name>.md from them (for the owner to chat
 * with the agents in Claude Code); tests/agents/sync.test.ts fails when the copies drift.
 */
import { promises as fs, readFileSync } from 'node:fs';
import path from 'node:path';
import { PROJECT_ROOT } from '../config';
import { AGENT_NAMES, type AgentName } from '../schemas';

export const AGENTS_DIR = path.join(PROJECT_ROOT, 'agents');
export const CLAUDE_AGENTS_DIR = path.join(PROJECT_ROOT, '.claude', 'agents');

/** Tools that are never given to any agent (no code execution, no file writes, no delegation). */
export const FORBIDDEN_AGENT_TOOLS = [
  'Bash',
  'Edit',
  'Write',
  'MultiEdit',
  'NotebookEdit',
  'Agent',
  'Task',
  'KillShell',
  'BashOutput',
] as const;

export interface AgentDefinition {
  name: AgentName;
  description: string;
  /** e.g. "script-writer@1" — recorded in every AgentRunRecord and ReelSpec. */
  promptVersion: string;
  tools: string[];
  /** Model alias (e.g. "sonnet", "haiku"); CLAUDE_MODEL or an explicit option overrides it. */
  model: string;
  maxTurns: number;
  /** Instruction body (markdown, without frontmatter). */
  body: string;
  sourcePath: string;
}

export class AgentDefinitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentDefinitionError';
  }
}

/** Parse "---\nkey: value\n---\nbody". Only flat `key: value` pairs are supported. */
export function parseFrontmatter(text: string): { meta: Record<string, string>; body: string } {
  const normalized = text.replace(/\r\n/g, '\n');
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(normalized);
  if (!m) throw new AgentDefinitionError('missing frontmatter block');
  const meta: Record<string, string> = {};
  for (const line of (m[1] ?? '').split('\n')) {
    if (!line.trim()) continue;
    const idx = line.indexOf(':');
    if (idx <= 0) throw new AgentDefinitionError(`bad frontmatter line: ${line}`);
    meta[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  return { meta, body: (m[2] ?? '').trim() + '\n' };
}

function parseTools(raw: string | undefined): string[] {
  if (!raw || raw === 'none' || raw === '[]') return [];
  return raw
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);
}

export function parseAgentDefinition(text: string, sourcePath: string): AgentDefinition {
  const { meta, body } = parseFrontmatter(text);
  const name = meta.name;
  if (!name || !(AGENT_NAMES as readonly string[]).includes(name)) {
    throw new AgentDefinitionError(`${sourcePath}: unknown agent name "${name ?? ''}"`);
  }
  const promptVersion = meta.promptVersion ?? '';
  if (!new RegExp(`^${name}@\\d+$`).test(promptVersion)) {
    throw new AgentDefinitionError(`${sourcePath}: promptVersion must look like ${name}@<n>`);
  }
  const description = meta.description ?? '';
  if (!description) throw new AgentDefinitionError(`${sourcePath}: description is required`);
  const tools = parseTools(meta.tools);
  const bad = tools.filter((t) => (FORBIDDEN_AGENT_TOOLS as readonly string[]).includes(t));
  if (bad.length) throw new AgentDefinitionError(`${sourcePath}: forbidden tools ${bad.join(', ')}`);
  const maxTurns = Number(meta.maxTurns ?? '3');
  // Structured output (--json-schema) uses one turn for the final answer, so 2 is the floor (T0.4).
  if (!Number.isInteger(maxTurns) || maxTurns < 2 || maxTurns > 30) {
    throw new AgentDefinitionError(`${sourcePath}: maxTurns must be an integer 2..30`);
  }
  return {
    name: name as AgentName,
    description,
    promptVersion,
    tools,
    model: meta.model || 'sonnet',
    maxTurns,
    body,
    sourcePath,
  };
}

const cache = new Map<string, AgentDefinition>();

/** Load agents/<name>.md (cached per directory). */
export function loadAgentDefinition(name: AgentName, dir = AGENTS_DIR): AgentDefinition {
  const file = path.join(dir, `${name}.md`);
  const hit = cache.get(file);
  if (hit) return hit;
  const def = parseAgentDefinition(readFileSync(file, 'utf8'), file);
  if (def.name !== name) throw new AgentDefinitionError(`${file}: name "${def.name}" != file name`);
  cache.set(file, def);
  return def;
}

export function loadAllAgentDefinitions(dir = AGENTS_DIR): AgentDefinition[] {
  return AGENT_NAMES.map((n) => loadAgentDefinition(n, dir));
}

/** Tools denied in the generated Claude Code subagent (everything that writes, runs code or delegates). */
function subagentDenyList(def: AgentDefinition): string[] {
  const deny: string[] = [...FORBIDDEN_AGENT_TOOLS];
  for (const t of ['WebSearch', 'WebFetch', 'Read', 'Glob', 'Grep']) {
    if (!def.tools.includes(t)) deny.push(t);
  }
  return deny;
}

/**
 * Render the .claude/agents/<name>.md copy. Claude Code has no "zero tools" subagent setting
 * (an omitted `tools` inherits everything), so no-tool agents get an explicit deny list and the
 * smallest read-only allowlist; the headless pipeline itself runs them with `--tools ""`.
 */
export function renderClaudeAgentFile(def: AgentDefinition): string {
  const tools = def.tools.length ? def.tools : ['Read'];
  const rel = path.relative(PROJECT_ROOT, def.sourcePath).split(path.sep).join('/');
  return [
    '---',
    `name: ${def.name}`,
    `description: ${def.description}`,
    `tools: ${tools.join(', ')}`,
    `disallowedTools: ${subagentDenyList(def).join(', ')}`,
    `model: ${def.model}`,
    `maxTurns: ${def.maxTurns}`,
    'permissionMode: dontAsk',
    '---',
    '',
    `<!-- GENERATED by \`npm run agents:sync\` from ${rel} (${def.promptVersion}). Do not edit by hand. -->`,
    '',
    def.tools.length === 0
      ? 'You have no tools for this job: do not call any tool. Answer from the conversation only.\n'
      : '',
    def.body,
  ]
    .filter((l, i, arr) => !(l === '' && arr[i - 1] === '' && i > 0))
    .join('\n');
}

export interface SyncResult {
  written: string[];
  unchanged: string[];
  /** Files present in .claude/agents/ that have no canonical source. */
  orphans: string[];
}

/** Compare (check=true) or write the generated copies. */
export async function syncAgents(opts: {
  sourceDir?: string;
  targetDir?: string;
  check?: boolean;
}): Promise<SyncResult & { drifted: string[] }> {
  const sourceDir = opts.sourceDir ?? AGENTS_DIR;
  const targetDir = opts.targetDir ?? CLAUDE_AGENTS_DIR;
  const result: SyncResult & { drifted: string[] } = { written: [], unchanged: [], orphans: [], drifted: [] };
  cache.clear();
  const defs = loadAllAgentDefinitions(sourceDir);
  if (!opts.check) await fs.mkdir(targetDir, { recursive: true });
  for (const def of defs) {
    const target = path.join(targetDir, `${def.name}.md`);
    const want = renderClaudeAgentFile(def);
    let have: string | null;
    try {
      have = await fs.readFile(target, 'utf8');
    } catch {
      have = null;
    }
    if (have === want) {
      result.unchanged.push(target);
      continue;
    }
    result.drifted.push(target);
    if (!opts.check) {
      await fs.writeFile(target, want, 'utf8');
      result.written.push(target);
    }
  }
  try {
    const known = new Set(defs.map((d) => `${d.name}.md`));
    for (const f of await fs.readdir(targetDir)) {
      if (f.endsWith('.md') && !known.has(f)) result.orphans.push(path.join(targetDir, f));
    }
  } catch {
    /* target dir missing in check mode */
  }
  return result;
}
