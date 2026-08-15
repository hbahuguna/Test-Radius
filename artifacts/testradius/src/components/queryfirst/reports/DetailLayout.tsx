import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { ArrowLeft } from "lucide-react";

export function DetailLayout({
  title,
  onBack,
  children,
}: {
  title: string;
  onBack: () => void;
  children: ReactNode;
}) {
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="sm" className="text-xs h-7" onClick={onBack}>
          <ArrowLeft className="size-3.5 mr-1" /> Back
        </Button>
        <h2 className="text-sm font-semibold truncate">{title}</h2>
      </div>
      {children}
    </div>
  );
}
