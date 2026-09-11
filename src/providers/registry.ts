export type WireFormat = 'openai' | 'anthropic';

export type ProviderGroup = 'recommended' | 'frontier' | 'open' | 'gateway' | 'local' | 'custom';

export interface Provider {
  id: string;
  name: string;
  format: WireFormat;
  baseUrl: string;
  modelsPath: string;
  chatPath: string;
  needsKey: boolean;
  group: ProviderGroup;
  keyEnv?: string;
  keyUrl?: string;
  defaultModels: string[];
  note?: string;
}

export const PROVIDERS: Provider[] = [
  {
    id: 'command-code',
    name: 'Command Code',
    format: 'anthropic',
    baseUrl: 'https://api.commandcode.ai/provider/v1',
    modelsPath: '/models',
    chatPath: '/messages',
    needsKey: true,
    group: 'recommended',
    keyEnv: 'COMMANDCODE_API_KEY',
    keyUrl: 'https://commandcode.ai',
    defaultModels: ['claude-sonnet-4-6', 'deepseek-chat'],
  },
  {
    id: 'opencode',
    name: 'OpenCode Zen',
    format: 'openai',
    baseUrl: 'https://opencode.ai/zen/v1',
    modelsPath: '/models',
    chatPath: '/chat/completions',
    needsKey: true,
    group: 'recommended',
    keyEnv: 'OPENCODE_API_KEY',
    keyUrl: 'https://opencode.ai/auth',
    defaultModels: [],
  },
  {
    id: 'opencode-go',
    name: 'OpenCode Go',
    format: 'openai',
    baseUrl: 'https://opencode.ai/zen/go/v1',
    modelsPath: '/models',
    chatPath: '/chat/completions',
    needsKey: true,
    group: 'recommended',
    keyEnv: 'OPENCODE_GO_API_KEY',
    keyUrl: 'https://opencode.ai/auth',
    defaultModels: [],
  },
  {
    id: 'anthropic',
    name: 'Claude (Anthropic)',
    format: 'anthropic',
    baseUrl: 'https://api.anthropic.com/v1',
    modelsPath: '/models',
    chatPath: '/messages',
    needsKey: true,
    group: 'recommended',
    keyEnv: 'ANTHROPIC_API_KEY',
    keyUrl: 'https://console.anthropic.com/settings/keys',
    defaultModels: ['claude-sonnet-4-6', 'claude-haiku-4-5'],
  },

  {
    id: 'openai',
    name: 'OpenAI',
    format: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    modelsPath: '/models',
    chatPath: '/chat/completions',
    needsKey: true,
    group: 'frontier',
    keyEnv: 'OPENAI_API_KEY',
    keyUrl: 'https://platform.openai.com/api-keys',
    defaultModels: ['gpt-4.1', 'gpt-4.1-mini'],
  },
  {
    id: 'google',
    name: 'Google Gemini',
    format: 'openai',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    modelsPath: '/models',
    chatPath: '/chat/completions',
    needsKey: true,
    group: 'frontier',
    keyEnv: 'GEMINI_API_KEY',
    keyUrl: 'https://aistudio.google.com/apikey',
    defaultModels: ['gemini-2.5-flash', 'gemini-2.5-pro'],
  },
  {
    id: 'xai',
    name: 'xAI (Grok)',
    format: 'openai',
    baseUrl: 'https://api.x.ai/v1',
    modelsPath: '/models',
    chatPath: '/chat/completions',
    needsKey: true,
    group: 'frontier',
    keyEnv: 'XAI_API_KEY',
    keyUrl: 'https://console.x.ai',
    defaultModels: ['grok-4', 'grok-3-mini'],
  },
  {
    id: 'mistral',
    name: 'Mistral',
    format: 'openai',
    baseUrl: 'https://api.mistral.ai/v1',
    modelsPath: '/models',
    chatPath: '/chat/completions',
    needsKey: true,
    group: 'frontier',
    keyEnv: 'MISTRAL_API_KEY',
    keyUrl: 'https://console.mistral.ai/api-keys',
    defaultModels: [],
  },
  {
    id: 'perplexity',
    name: 'Perplexity',
    format: 'openai',
    baseUrl: 'https://api.perplexity.ai',
    modelsPath: '/models',
    chatPath: '/chat/completions',
    needsKey: true,
    group: 'frontier',
    keyEnv: 'PERPLEXITY_API_KEY',
    keyUrl: 'https://www.perplexity.ai/settings/api',
    defaultModels: [],
  },

  {
    id: 'deepseek',
    name: 'DeepSeek',
    format: 'openai',
    baseUrl: 'https://api.deepseek.com/v1',
    modelsPath: '/models',
    chatPath: '/chat/completions',
    needsKey: true,
    group: 'open',
    keyEnv: 'DEEPSEEK_API_KEY',
    keyUrl: 'https://platform.deepseek.com/api_keys',
    defaultModels: ['deepseek-chat', 'deepseek-reasoner'],
  },
  {
    id: 'moonshot',
    name: 'Kimi (Moonshot)',
    format: 'openai',
    baseUrl: 'https://api.moonshot.ai/v1',
    modelsPath: '/models',
    chatPath: '/chat/completions',
    needsKey: true,
    group: 'open',
    keyEnv: 'MOONSHOT_API_KEY',
    keyUrl: 'https://platform.moonshot.ai/console/api-keys',
    defaultModels: ['kimi-k2-0905-preview'],
  },
  {
    id: 'groq',
    name: 'Groq (fast)',
    format: 'openai',
    baseUrl: 'https://api.groq.com/openai/v1',
    modelsPath: '/models',
    chatPath: '/chat/completions',
    needsKey: true,
    group: 'open',
    keyEnv: 'GROQ_API_KEY',
    keyUrl: 'https://console.groq.com/keys',
    defaultModels: [],
  },
  {
    id: 'together',
    name: 'Together AI',
    format: 'openai',
    baseUrl: 'https://api.together.xyz/v1',
    modelsPath: '/models',
    chatPath: '/chat/completions',
    needsKey: true,
    group: 'open',
    keyEnv: 'TOGETHER_API_KEY',
    keyUrl: 'https://api.together.xyz/settings/api-keys',
    defaultModels: [],
  },
  {
    id: 'fireworks',
    name: 'Fireworks AI',
    format: 'openai',
    baseUrl: 'https://api.fireworks.ai/inference/v1',
    modelsPath: '/models',
    chatPath: '/chat/completions',
    needsKey: true,
    group: 'open',
    keyEnv: 'FIREWORKS_API_KEY',
    keyUrl: 'https://fireworks.ai/account/api-keys',
    defaultModels: [],
  },
  {
    id: 'cerebras',
    name: 'Cerebras',
    format: 'openai',
    baseUrl: 'https://api.cerebras.ai/v1',
    modelsPath: '/models',
    chatPath: '/chat/completions',
    needsKey: true,
    group: 'open',
    keyEnv: 'CEREBRAS_API_KEY',
    keyUrl: 'https://cloud.cerebras.ai',
    defaultModels: [],
  },
  {
    id: 'deepinfra',
    name: 'DeepInfra',
    format: 'openai',
    baseUrl: 'https://api.deepinfra.com/v1/openai',
    modelsPath: '/models',
    chatPath: '/chat/completions',
    needsKey: true,
    group: 'open',
    keyEnv: 'DEEPINFRA_API_KEY',
    keyUrl: 'https://deepinfra.com/dash/api_keys',
    defaultModels: [],
  },
  {
    id: 'siliconflow',
    name: 'SiliconFlow',
    format: 'openai',
    baseUrl: 'https://api.siliconflow.cn/v1',
    modelsPath: '/models',
    chatPath: '/chat/completions',
    needsKey: true,
    group: 'open',
    keyEnv: 'SILICONFLOW_API_KEY',
    keyUrl: 'https://cloud.siliconflow.cn/account/ak',
    defaultModels: [],
  },
  {
    id: 'zai',
    name: 'Z.ai (GLM)',
    format: 'openai',
    baseUrl: 'https://api.z.ai/api/paas/v4',
    modelsPath: '/models',
    chatPath: '/chat/completions',
    needsKey: true,
    group: 'open',
    keyEnv: 'ZAI_API_KEY',
    keyUrl: 'https://z.ai/manage-apikey/apikey-list',
    defaultModels: [],
  },
  {
    id: 'dashscope',
    name: 'Alibaba DashScope (Qwen)',
    format: 'openai',
    baseUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
    modelsPath: '/models',
    chatPath: '/chat/completions',
    needsKey: true,
    group: 'open',
    keyEnv: 'DASHSCOPE_API_KEY',
    keyUrl: 'https://bailian.console.alibabacloud.com',
    defaultModels: [],
  },

  {
    id: 'openrouter',
    name: 'OpenRouter (200+ models)',
    format: 'openai',
    baseUrl: 'https://openrouter.ai/api/v1',
    modelsPath: '/models',
    chatPath: '/chat/completions',
    needsKey: true,
    group: 'gateway',
    keyEnv: 'OPENROUTER_API_KEY',
    keyUrl: 'https://openrouter.ai/keys',
    defaultModels: [],
  },
  {
    id: 'vercel',
    name: 'Vercel AI Gateway',
    format: 'openai',
    baseUrl: 'https://ai-gateway.vercel.sh/v1',
    modelsPath: '/models',
    chatPath: '/chat/completions',
    needsKey: true,
    group: 'gateway',
    keyEnv: 'AI_GATEWAY_API_KEY',
    keyUrl: 'https://vercel.com/dashboard',
    defaultModels: [],
  },
  {
    id: 'litellm',
    name: 'LiteLLM (your own proxy)',
    format: 'openai',
    baseUrl: 'http://localhost:4000/v1',
    modelsPath: '/models',
    chatPath: '/chat/completions',
    needsKey: false,
    group: 'gateway',
    keyEnv: 'LITELLM_API_KEY',
    defaultModels: [],
    note: 'routes to 100+ providers behind one URL',
  },

  {
    id: 'ollama',
    name: 'Ollama',
    format: 'openai',
    baseUrl: 'http://127.0.0.1:11434/v1',
    modelsPath: '/models',
    chatPath: '/chat/completions',
    needsKey: false,
    group: 'local',
    defaultModels: [],
    note: 'runs on your machine',
  },
  {
    id: 'lmstudio',
    name: 'LM Studio',
    format: 'openai',
    baseUrl: 'http://127.0.0.1:1234/v1',
    modelsPath: '/models',
    chatPath: '/chat/completions',
    needsKey: false,
    group: 'local',
    defaultModels: [],
    note: 'runs on your machine',
  },
  {
    id: 'vllm',
    name: 'vLLM (your own server)',
    format: 'openai',
    baseUrl: 'http://localhost:8000/v1',
    modelsPath: '/models',
    chatPath: '/chat/completions',
    needsKey: false,
    group: 'local',
    defaultModels: [],
    note: 'self-hosted OpenAI-compatible server',
  },

  {
    id: 'custom',
    name: 'Custom endpoint',
    format: 'openai',
    baseUrl: '',
    modelsPath: '/models',
    chatPath: '/chat/completions',
    needsKey: true,
    group: 'custom',
    defaultModels: [],
    note: 'you give the name, base URL, format and key',
  },
];

export interface CustomProviderDef {
  id: string;
  name: string;
  format: WireFormat;
  baseUrl: string;
}

export const GROUP_ORDER: ProviderGroup[] = ['recommended', 'frontier', 'open', 'gateway', 'local', 'custom'];

export const GROUP_LABELS: Record<ProviderGroup, string> = {
  recommended: 'recommended',
  frontier: 'frontier models',
  open: 'open models (fast + cheap)',
  gateway: 'gateways / routers',
  local: 'local (no key, runs on your machine)',
  custom: 'something else',
};

export function customToProvider(def: CustomProviderDef): Provider {
  return {
    id: def.id,
    name: def.name || def.id,
    format: def.format,
    baseUrl: def.baseUrl,
    modelsPath: '/models',
    chatPath: def.format === 'anthropic' ? '/messages' : '/chat/completions',
    needsKey: true,
    group: 'custom',
    defaultModels: [],
  };
}

export function allProviders(customs: CustomProviderDef[] = []): Provider[] {
  const builtinIds = new Set(PROVIDERS.map((p) => p.id));
  return [...PROVIDERS, ...customs.filter((c) => !builtinIds.has(c.id)).map(customToProvider)];
}

export function orderedProviders(customs: CustomProviderDef[] = []): Provider[] {
  const list = allProviders(customs);
  return GROUP_ORDER.flatMap((group) => list.filter((p) => p.group === group));
}

export function getProvider(id: string, customs: CustomProviderDef[] = []): Provider | undefined {
  return allProviders(customs).find((p) => p.id === id);
}
