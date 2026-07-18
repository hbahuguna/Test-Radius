import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { type UserApiKey } from "@/lib/agentic-api";

export interface ProviderModel {
  id: string;
  label: string;
}

export const PROVIDERS: { id: string; label: string }[] = [
  { id: "opencode", label: "Opencode (OpenCode Zen key)" },
  { id: "openai", label: "OpenAI key" },
  { id: "anthropic", label: "Anthropic key" },
  { id: "google", label: "Google key" },
];

// Curated model lists per provider. The first entry is the default.
export const PROVIDER_MODELS: Record<string, ProviderModel[]> = {
  opencode: [
    { id: "hy3-free", label: "hy3-free" },
    { id: "claude-3-5-sonnet", label: "Claude 3.5 Sonnet" },
    { id: "gpt-4o", label: "GPT-4o" },
  ],
  openai: [
    { id: "gpt-4o-mini", label: "GPT-4o mini" },
    { id: "gpt-4o", label: "GPT-4o" },
    { id: "gpt-4-turbo", label: "GPT-4 Turbo" },
    { id: "o3-mini", label: "o3-mini" },
    { id: "gpt-4.1", label: "GPT-4.1" },
  ],
  anthropic: [
    { id: "claude-3-5-sonnet-latest", label: "Claude 3.5 Sonnet" },
    { id: "claude-3-5-haiku-latest", label: "Claude 3.5 Haiku" },
    { id: "claude-3-opus-latest", label: "Claude 3 Opus" },
    { id: "claude-sonnet-4", label: "Claude Sonnet 4" },
  ],
  google: [
    { id: "gemini-2.5-flash", label: "Gemini 2.5 Flash" },
    { id: "gemini-2.5-flash-lite", label: "Gemini 2.5 Flash-Lite" },
    { id: "gemini-2.5-pro", label: "Gemini 2.5 Pro" },
  ],
};

export function defaultModelFor(provider: string): string {
  return PROVIDER_MODELS[provider]?.[0]?.id ?? "";
}

interface ModelSelectorProps {
  provider: string;
  modelId: string;
  onProviderChange: (provider: string) => void;
  onModelIdChange: (modelId: string) => void;
  keys: UserApiKey[];
}

export function ModelSelector({
  provider,
  modelId,
  onProviderChange,
  onModelIdChange,
  keys,
}: ModelSelectorProps) {
  const hasKey = (p: string) => keys.some((k) => k.provider === p);
  const models = PROVIDER_MODELS[provider] ?? [];

  return (
    <div className="space-y-3">
      <RadioGroup value={provider} onValueChange={onProviderChange}>
        {PROVIDERS.map((p) => (
          <div key={p.id} className="flex items-center gap-2">
            <RadioGroupItem value={p.id} id={`m-${p.id}`} />
            <Label htmlFor={`m-${p.id}`} className="font-normal cursor-pointer">
              {p.label}
            </Label>
            {provider === p.id && !hasKey(p.id) && (
              <a href="/settings" className="text-xs text-primary underline">
                Add key in Settings
              </a>
            )}
          </div>
        ))}
      </RadioGroup>

      {models.length > 0 && (
        <div className="space-y-1.5 pl-6">
          <Label className="text-xs text-muted-foreground">Model</Label>
          <Select value={modelId} onValueChange={onModelIdChange}>
            <SelectTrigger className="w-full">
              <SelectValue placeholder="Select a model" />
            </SelectTrigger>
            <SelectContent>
              {models.map((m) => (
                <SelectItem key={m.id} value={m.id}>
                  {m.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}

      <p className="text-xs text-muted-foreground">
        Bring your own provider key. Each run uses 1 TestRadius credit.
      </p>
    </div>
  );
}
