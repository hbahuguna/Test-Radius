import React, { useState } from "react";
import { Link, useLocation } from "wouter";
import { docsSidebar, activeGroup, DocGroup } from "@/lib/docs";
import { ChevronDown, ChevronRight } from "lucide-react";

function SidebarGroup({ group, currentPath }: { group: DocGroup; currentPath: string }) {
  const [open, setOpen] = useState(() => activeGroup(currentPath) === group.title);
  const isGroupActive = group.href === currentPath;

  if (group.pages.length === 0 && group.href) {
    return (
      <li>
        <Link
          href={group.href}
          className={`block px-3 py-1.5 rounded-md text-sm transition-colors ${
            isGroupActive
              ? "bg-primary/10 text-primary font-medium"
              : "text-muted-foreground hover:text-foreground hover:bg-accent/50"
          }`}
        >
          {group.title}
        </Link>
      </li>
    );
  }

  const hasActiveChild = group.pages.some((p) => p.href === currentPath);

  return (
    <li>
      <button
        onClick={() => setOpen(!open)}
        className={`flex items-center w-full px-3 py-1.5 rounded-md text-sm transition-colors ${
          isGroupActive || hasActiveChild
            ? "bg-primary/10 text-primary font-medium"
            : "text-muted-foreground hover:text-foreground hover:bg-accent/50"
        }`}
      >
        {open ? (
          <ChevronDown className="h-3.5 w-3.5 mr-1.5 shrink-0" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 mr-1.5 shrink-0" />
        )}
        {group.title}
      </button>
      {open && (
        <ul className="ml-4 space-y-0.5 mt-0.5 border-l border-border pl-2">
          {group.pages.map((page) => (
            <li key={page.href}>
              <Link
                href={page.href}
                className={`block px-3 py-1 rounded-md text-sm transition-colors ${
                  page.href === currentPath
                    ? "bg-primary/10 text-primary font-medium"
                    : "text-muted-foreground hover:text-foreground hover:bg-accent/50"
                }`}
              >
                {page.title}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

interface DocsSidebarProps {
  onNavigate?: () => void;
}

export function DocsSidebar({ onNavigate }: DocsSidebarProps) {
  const [location] = useLocation();

  return (
    <nav className="w-full">
      <ul className="space-y-0.5">
        {docsSidebar.map((group) => (
          <SidebarGroup
            key={group.title}
            group={group}
            currentPath={location}
          />
        ))}
      </ul>
    </nav>
  );
}
