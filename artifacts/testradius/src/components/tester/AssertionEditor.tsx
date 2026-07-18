import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Plus, Trash2 } from "lucide-react";
import { type Assertion } from "@/lib/agentic-api";

interface AssertionEditorProps {
  assertions: Assertion[];
  onChange: (assertions: Assertion[]) => void;
}

export function AssertionEditor({ assertions, onChange }: AssertionEditorProps) {
  const update = (idx: number, patch: Partial<Assertion>) => {
    onChange(assertions.map((a, i) => (i === idx ? { ...a, ...patch } : a)));
  };

  const add = () => {
    onChange([...assertions, { type: "visibility", target: "" }]);
  };

  const remove = (idx: number) => {
    onChange(assertions.filter((_, i) => i !== idx));
  };

  return (
    <div className="space-y-2">
      {assertions.map((a, idx) => (
        <div key={idx} className="flex items-center gap-2">
          <Select value={a.type} onValueChange={(v) => update(idx, { type: v as Assertion["type"] })}>
            <SelectTrigger className="w-32">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="visibility">visibility</SelectItem>
              <SelectItem value="text">text</SelectItem>
              <SelectItem value="url">url</SelectItem>
            </SelectContent>
          </Select>
          {a.type === "url" ? (
            <Input
              placeholder="pattern e.g. /dashboard"
              value={a.pattern ?? ""}
              onChange={(e) => update(idx, { pattern: e.target.value })}
            />
          ) : (
            <Input
              placeholder={a.type === "text" ? "expected text" : "element / text to see"}
              value={a.target ?? a.expected ?? ""}
              onChange={(e) =>
                update(idx, a.type === "text" ? { expected: e.target.value } : { target: e.target.value })
              }
            />
          )}
          <Button variant="ghost" size="icon" onClick={() => remove(idx)} aria-label="Remove assertion">
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      ))}
      <Button variant="outline" size="sm" className="gap-1" onClick={add}>
        <Plus className="h-4 w-4" /> Add assertion
      </Button>
    </div>
  );
}
