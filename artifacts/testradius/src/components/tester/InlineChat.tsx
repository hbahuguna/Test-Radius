import { useState, useRef, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Loader2, Send, MessageSquare } from "lucide-react";
import { streamChat, type ChatMessage } from "@/lib/agentic-api";

interface InlineChatProps {
  goal: string;
  url: string;
  steps: Array<{ name: string; args: Record<string, any>; result?: string }>;
  thoughts: string[];
  runError: string | null;
  modelProvider: string;
  modelId: string;
}

export function InlineChat({
  goal,
  url,
  steps,
  thoughts,
  runError,
  modelProvider,
  modelId,
}: InlineChatProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo(0, scrollRef.current.scrollHeight);
  }, [messages]);

  const handleSend = async () => {
    const text = input.trim();
    if (!text || loading) return;

    const userMsg: ChatMessage = { role: "user", content: text };
    setMessages((prev) => [...prev, userMsg]);
    setInput("");
    setLoading(true);

    // Build context from the run
    const runContext = [
      `GOAL: ${goal}`,
      `URL: ${url}`,
      runError ? `RUN FAILED: ${runError}` : "",
      `STEPS TAKEN:\n${steps.map((s, i) => `${i + 1}. ${s.name}(${JSON.stringify(s.args)})`).join("\n")}`,
      `THOUGHTS:\n${thoughts.slice(-10).join("\n")}`,
    ]
      .filter(Boolean)
      .join("\n\n");

    try {
      let assistantContent = "";
      const assistantMsg: ChatMessage = { role: "assistant", content: "" };
      setMessages((prev) => [...prev, assistantMsg]);

      await streamChat(
        {
          message: text,
          context: runContext,
          url: url,
          model_provider: modelProvider,
          model: modelId,
        },
        {
          onToken: (token) => {
            assistantContent += token;
            setMessages((prev) => {
              const updated = [...prev];
              updated[updated.length - 1] = { role: "assistant", content: assistantContent };
              return updated;
            });
          },
        },
      );
    } catch (e: any) {
      setMessages((prev) => {
        const updated = [...prev];
        updated[updated.length - 1] = {
          role: "assistant",
          content: `Error: ${e?.message || "Failed to get response"}`,
        };
        return updated;
      });
    } finally {
      setLoading(false);
      inputRef.current?.focus();
    }
  };

  return (
    <Card className="rounded-xl border-border shadow-lg">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <MessageSquare className="h-4 w-4" />
          Chat with Agent
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div
          ref={scrollRef}
          className="max-h-[300px] overflow-y-auto space-y-3 mb-3 p-2"
        >
          {messages.length === 0 && (
            <p className="text-sm text-muted-foreground text-center py-4">
              Ask the agent about what happened, give feedback, or ask it to try a different approach.
            </p>
          )}
          {messages.map((msg, i) => (
            <div
              key={i}
              className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}
            >
              <div
                className={`max-w-[85%] rounded-lg px-3 py-2 text-sm whitespace-pre-wrap ${
                  msg.role === "user"
                    ? "bg-primary text-primary-foreground"
                    : "bg-muted"
                }`}
              >
                {msg.content || (loading && i === messages.length - 1 ? (
                  <Loader2 className="h-3 w-3 animate-spin inline" />
                ) : null)}
              </div>
            </div>
          ))}
        </div>
        <div className="flex gap-2">
          <Input
            ref={inputRef}
            placeholder="e.g. 'You clicked the wrong link — try the venv one instead'"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && !e.shiftKey && handleSend()}
            disabled={loading}
          />
          <Button
            size="icon"
            onClick={handleSend}
            disabled={!input.trim() || loading}
          >
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
