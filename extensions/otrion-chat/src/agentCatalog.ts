/* Copyright (c) Otrion contributors. Licensed under the MIT License. */

interface AgentProfile {
	name: string;
	binary: string;
	description: string;
	website: string;
	npm?: { package: string; version: string; entry: string };
	args?: string[];
	env?: Record<string, string>;
	loginArgs?: string[];
	keyEnv?: string;
	platforms?: readonly string[];
}

const nativePlatforms = ['darwin-x64', 'darwin-arm64', 'linux-x64', 'linux-arm64', 'win32-x64', 'win32-arm64'];

// These IDs also identify saved chat sessions. Keep them stable across display-name changes.
const catalog = {
	antigravity: {
		name: 'Antigravity', binary: 'agy',
		description: 'Google’s coding agent, available through the agy CLI.',
		website: 'https://antigravity.google/docs/getting-started?tab=cli',
		args: ['acp'],
		loginArgs: ['acp', '--login'],
		keyEnv: 'GEMINI_API_KEY',
		platforms: nativePlatforms,
	},
	claude: {
		name: 'Claude Code', binary: 'claude-agent-acp',
		description: 'Anthropic’s coding agent for Claude.',
		website: 'https://github.com/agentclientprotocol/claude-agent-acp',
		npm: { package: '@agentclientprotocol/claude-agent-acp', version: '0.108.0', entry: 'dist/index.js' },
	},
	cline: {
		name: 'Cline', binary: 'cline',
		description: 'Coding agent with support for cloud and local models.',
		website: 'https://github.com/cline/cline/blob/main/docs/getting-started/authorizing-with-cline.mdx',
		npm: { package: 'cline', version: '3.0.74', entry: 'bin/cline' },
		platforms: nativePlatforms,
		args: ['--acp'],
		loginArgs: ['auth'],
		keyEnv: 'CLINE_API_KEY',
	},
	codex: {
		name: 'Codex', binary: 'codex-acp',
		description: 'OpenAI’s coding agent for your workspace.',
		website: 'https://github.com/agentclientprotocol/codex-acp',
		npm: { package: '@agentclientprotocol/codex-acp', version: '2.7.0', entry: 'dist/index.js' },
	},
	'github-copilot-cli': {
		name: 'GitHub Copilot', binary: 'copilot',
		description: 'GitHub’s Copilot coding agent for the terminal.',
		website: 'https://docs.github.com/en/copilot/how-tos/copilot-cli/set-up-copilot-cli/authenticate-copilot-cli',
		npm: { package: '@github/copilot', version: '1.0.114', entry: 'npm-loader.js' },
		platforms: nativePlatforms,
		args: ['--acp'],
		loginArgs: ['login'],
	},
	grok: {
		name: 'Grok Build', binary: 'grok',
		description: 'xAI’s terminal coding agent for Grok.',
		website: 'https://docs.x.ai/build/overview',
		npm: { package: '@xai-official/grok', version: '1.0.93', entry: 'bin/grok' },
		platforms: nativePlatforms,
		args: ['agent', 'stdio'],
		loginArgs: ['login'],
		keyEnv: 'XAI_API_KEY',
	},
	kilo: {
		name: 'Kilo', binary: 'kilo',
		description: 'Open-source coding agent with a choice of model providers.',
		website: 'https://kilo.ai/docs/code-with-ai/platforms/cli-reference',
		npm: { package: '@kilocode/cli', version: '7.8.32', entry: 'bin/kilo' },
		platforms: nativePlatforms,
		args: ['acp'],
		loginArgs: ['auth', 'login'],
	},
	'kimi-code': {
		name: 'Kimi Code', binary: 'kimi',
		description: 'Moonshot AI’s coding agent for Kimi models.',
		website: 'https://moonshotai.github.io/kimi-code/en/reference/kimi-command.html',
		npm: { package: '@moonshot-ai/kimi-code', version: '2.7.2', entry: 'dist/main.mjs' },
		args: ['acp'],
		loginArgs: ['login'],
	},
	opencode: {
		name: 'OpenCode', binary: 'opencode',
		description: 'Terminal coding agent that connects to your model provider.',
		website: 'https://opencode.ai/docs/cli/acp/',
		npm: { package: '@opencode/cli', version: '2.3.2', entry: 'bin/opencode.exe' },
		platforms: nativePlatforms,
		args: ['acp'],
	},
	'qwen-code': {
		name: 'Qwen Code', binary: 'qwen',
		description: 'Qwen’s open-source coding agent.',
		website: 'https://qwenlm.github.io/qwen-code-docs/en/users/overview',
		npm: { package: '@qwen-code/qwen-code', version: '0.28.0', entry: 'cli-entry.js' },
		args: ['--acp', '--experimental-skills'],
		loginArgs: [],
	},
} satisfies Record<string, AgentProfile>;

export type AgentId = keyof typeof catalog;
export const agents: Record<AgentId, AgentProfile> = catalog;
export const agentIds = Object.keys(agents) as AgentId[];
export function isAgent(id: unknown): id is AgentId {
	return typeof id === 'string' && Object.hasOwn(agents, id);
}
