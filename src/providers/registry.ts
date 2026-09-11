export type WireFormat = 'openai' | 'anthropic';

export interface Provider {
  id: string;
  name: string;
  format: WireFormat;
  baseUrl: string;
  modelsPath: string;
  chatPath: string;
  needsKey: boolean;
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
    keyEnv: 'OPENAI_API_KEY',
    keyUrl: 'https://platform.openai.com/api-keys',
    defaultModels: ['gpt-4.1', 'gpt-4.1-mini'],
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    format: 'openai',
    baseUrl: 'https://api.deepseek.com/v1',
    modelsPath: '/models',
    chatPath: '/chat/completions',
    needsKey: true,
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
    keyEnv: 'MOONSHOT_API_KEY',
    keyUrl: 'https://platform.moonshot.ai/console/api-keys',
    defaultModels: ['kimi-k2-0905-preview', 'moonshot-v1-128k'],
  },
  {
    id: 'google',
    name: 'Google Gemini',
    format: 'openai',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    modelsPath: '/models',
    chatPath: '/chat/completions',
    needsKey: true,
    keyEnv: 'GEMINI_API_KEY',
    keyUrl: 'https://aistudio.google.com/apikey',
    defaultModels: ['gemini-2.5-flash', 'gemini-2.5-pro'],
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    format: 'openai',
    baseUrl: 'https://openrouter.ai/api/v1',
    modelsPath: '/models',
    chatPath: '/chat/completions',
    needsKey: true,
    keyEnv: 'OPENROUTER_API_KEY',
    keyUrl: 'https://openrouter.ai/keys',
    defaultModels: [],
  },
  {
    id: 'groq',
    name: 'Groq',
    format: 'openai',
    baseUrl: 'https://api.groq.com/openai/v1',
    modelsPath: '/models',
    chatPath: '/chat/completions',
    needsKey: true,
    keyEnv: 'GROQ_API_KEY',
    keyUrl: 'https://console.groq.com/keys',
    defaultModels: [],
  },
  {
    id: 'xai',
    name: 'xAI (Grok)',
    format: 'openai',
    baseUrl: 'https://api.x.ai/v1',
    modelsPath: '/models',
    chatPath: '/chat/completions',
    needsKey: true,
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
    keyEnv: 'MISTRAL_API_KEY',
    keyUrl: 'https://console.mistral.ai/api-keys',
    defaultModels: [],
  },
  {
    id: 'ollama',
    name: 'Ollama (local)',
    format: 'openai',
    baseUrl: 'http://127.0.0.1:11434/v1',
    modelsPath: '/models',
    chatPath: '/chat/completions',
    needsKey: false,
    defaultModels: [],
    note: 'runs on your machine, no key needed',
  },
  {
    id: 'lmstudio',
    name: 'LM Studio (local)',
    format: 'openai',
    baseUrl: 'http://127.0.0.1:1234/v1',
    modelsPath: '/models',
    chatPath: '/chat/completions',
    needsKey: false,
    defaultModels: [],
    note: 'runs on your machine, no key needed',
  },
  {
    id: 'custom',
    name: 'Custom (any OpenAI-compatible URL)',
    format: 'openai',
    baseUrl: '',
    modelsPath: '/models',
    chatPath: '/chat/completions',
    needsKey: true,
    defaultModels: [],
    note: 'you provide the base URL',
  },
];

export interface CustomProviderDef {
  id: string;
  name: string;
  format: WireFormat;
  baseUrl: string;
}

export function customToProvider(def: CustomProviderDef): Provider {
  return {
    id: def.id,
    name: def.name || def.id,
    format: def.format,
    baseUrl: def.baseUrl,
    modelsPath: '/models',
    chatPath: def.format === 'anthropic' ? '/messages' : '/chat/completions',
    needsKey: true,
    defaultModels: [],
  };
}

export function allProviders(customs: CustomProviderDef[] = []): Provider[] {
  const builtinIds = new Set(PROVIDERS.map((p) => p.id));
  return [...PROVIDERS, ...customs.filter((c) => !builtinIds.has(c.id)).map(customToProvider)];
}

export function getProvider(id: string, customs: CustomProviderDef[] = []): Provider | undefined {
  return allProviders(customs).find((p) => p.id === id);
}
