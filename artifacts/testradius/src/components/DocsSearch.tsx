import React, { useEffect, useState, useCallback, useRef } from "react";
import { useLocation } from "wouter";
import { getAllDocPages, DocPage, slugToContentPath } from "@/lib/docs";
import { Search, Command, X } from "lucide-react";

interface SearchResult {
  page: DocPage;
  contentSnippet?: string;
}

export function DocsSearch() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [, setLocation] = useLocation();
  const inputRef = useRef<HTMLInputElement>(null);
  const allPages = getAllDocPages();

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setOpen(true);
      }
      if (e.key === "Escape") {
        setOpen(false);
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, []);

  useEffect(() => {
    if (open && inputRef.current) {
      inputRef.current.focus();
    }
  }, [open]);

  const search = useCallback(
    async (q: string) => {
      if (!q.trim()) {
        setResults(allPages.map((p) => ({ page: p })));
        return;
      }
      const lower = q.toLowerCase();
      setResults(
        allPages.filter((p) => {
          return (
            p.title.toLowerCase().includes(lower) ||
            p.href.toLowerCase().includes(lower)
          );
        }).map((p) => ({ page: p })),
      );
    },
    [allPages],
  );

  useEffect(() => {
    search(query);
  }, [query, search]);

  useEffect(() => {
    setSelectedIndex(0);
  }, [results]);

  const navigate = useCallback(
    (href: string) => {
      setOpen(false);
      setQuery("");
      setLocation(href);
    },
    [setLocation],
  );

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelectedIndex((i) => Math.min(i + 1, results.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelectedIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter" && results[selectedIndex]) {
      navigate(results[selectedIndex].page.href);
    }
  };

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[100] flex items-start justify-center pt-[15vh]"
      onClick={() => setOpen(false)}
    >
      <div className="fixed inset-0 bg-black/50 backdrop-blur-sm" />
      <div
        className="relative w-full max-w-lg bg-background border border-border rounded-xl shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 px-4 py-3 border-b border-border">
          <Search className="h-4 w-4 text-muted-foreground shrink-0" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Search documentation..."
            className="flex-1 bg-transparent outline-none text-sm placeholder:text-muted-foreground"
          />
          <kbd className="hidden sm:inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-mono text-muted-foreground bg-muted rounded border">
            <Command className="h-2.5 w-2.5" />K
          </kbd>
          <button onClick={() => setOpen(false)} className="text-muted-foreground hover:text-foreground">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="max-h-80 overflow-y-auto">
          {results.length === 0 ? (
            <div className="px-4 py-8 text-center text-sm text-muted-foreground">
              No results found
            </div>
          ) : (
            results.map((result, i) => (
              <button
                key={result.page.href}
                className={`w-full text-left px-4 py-2.5 flex items-center gap-3 transition-colors ${
                  i === selectedIndex
                    ? "bg-primary/10 text-primary"
                    : "hover:bg-accent/50"
                }`}
                onClick={() => navigate(result.page.href)}
                onMouseEnter={() => setSelectedIndex(i)}
              >
                <Search className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium truncate">
                    {result.page.title}
                  </div>
                  <div className="text-xs text-muted-foreground truncate">
                    {result.page.href}
                  </div>
                </div>
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
