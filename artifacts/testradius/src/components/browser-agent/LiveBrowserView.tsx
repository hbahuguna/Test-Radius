import { useState, useRef, useEffect } from "react";
import { Loader2, Monitor } from "lucide-react";

interface LiveBrowserViewProps {
  screenshot: string | null;
  status: "idle" | "running" | "completed" | "failed" | "stopped";
  url?: string | null;
  title?: string | null;
}

function isValidDataUrl(s: string | null): boolean {
  return !!s && s.startsWith("data:image/") && s.includes(",") && s.length > 300;
}

export function LiveBrowserView({
  screenshot,
  status,
  url,
  title,
}: LiveBrowserViewProps) {
  const [imgError, setImgError] = useState(false);
  const prevScreenshotRef = useRef(screenshot);

  useEffect(() => {
    if (prevScreenshotRef.current !== screenshot) {
      prevScreenshotRef.current = screenshot;
      setImgError(false);
    }
  }, [screenshot]);

  const showImage = isValidDataUrl(screenshot) && !imgError;

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Browser chrome */}
      <div className="flex items-center gap-2 px-4 py-2 bg-muted/50 border-b border-border">
        <div className="flex gap-1.5">
          <div className="h-3 w-3 rounded-full bg-red-400" />
          <div className="h-3 w-3 rounded-full bg-yellow-400" />
          <div className="h-3 w-3 rounded-full bg-green-400" />
        </div>
        <div className="flex-1 mx-2">
          <div className="bg-background rounded-md px-3 py-1 text-xs text-muted-foreground truncate">
            {url || "about:blank"}
          </div>
        </div>
      </div>

      {/* Browser viewport */}
      <div className="flex-1 min-h-0 relative bg-background overflow-hidden">
        {showImage ? (
          <img
            src={screenshot!}
            alt="Live browser view"
            className="absolute inset-0 w-full h-full object-contain"
            onError={() => setImgError(true)}
          />
        ) : status === "running" ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-muted-foreground">
            <Loader2 className="h-8 w-8 animate-spin" />
            <span className="text-sm">Loading page...</span>
          </div>
        ) : (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-muted-foreground">
            <Monitor className="h-12 w-12 opacity-50" />
            <span className="text-sm">No preview</span>
            <span className="text-xs text-muted-foreground/70">
              Start a run to see the live browser
            </span>
          </div>
        )}

        {/* Status indicator */}
        {status === "running" && showImage && (
          <div className="absolute top-2 right-2 flex items-center gap-1.5 bg-background/80 backdrop-blur-sm rounded-full px-2 py-1">
            <div className="h-2 w-2 rounded-full bg-green-500 animate-pulse" />
            <span className="text-[10px] text-muted-foreground">Live</span>
          </div>
        )}
      </div>

      {/* Page title */}
      {title && (
        <div className="px-4 py-1.5 border-t border-border bg-muted/30">
          <span className="text-xs text-muted-foreground truncate block">
            {title}
          </span>
        </div>
      )}
    </div>
  );
}
