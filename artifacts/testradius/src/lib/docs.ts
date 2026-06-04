export interface DocPage {
  title: string;
  href: string;
}

export interface DocGroup {
  title: string;
  href?: string;
  pages: DocPage[];
}

export const docsSidebar: DocGroup[] = [
  { title: "Intro", href: "/docs", pages: [] },
  { title: "Architecture", href: "/docs/architecture", pages: [] },
  {
    title: "Usage",
    pages: [
      { title: "Test Impact Analysis", href: "/docs/usage/tia" },
      { title: "Instrumentation", href: "/docs/usage/instrumentation" },
      { title: "Test Execution", href: "/docs/usage/test-execution" },
      { title: "Dashboard", href: "/docs/usage/dashboard" },
      { title: "API Usage", href: "/docs/usage/api" },
      { title: "GitHub App", href: "/docs/usage/github-app" },
    ],
  },
  {
    title: "Deploy",
    pages: [
      { title: "Docker", href: "/docs/deploy/docker" },
      { title: "Configuration", href: "/docs/deploy/configuration" },
      { title: "Integrations", href: "/docs/deploy/integrations" },
    ],
  },
  {
    title: "Develop",
    pages: [
      { title: "Setup", href: "/docs/develop/setup" },
      { title: "Testing", href: "/docs/develop/testing" },
      { title: "API Reference", href: "/docs/develop/api-ref" },
      { title: "Contributing", href: "/docs/develop/contributing" },
    ],
  },
  { title: "Troubleshooting", href: "/docs/troubleshooting", pages: [] },
];

export function getAllDocPages(): DocPage[] {
  const pages: DocPage[] = [];
  for (const group of docsSidebar) {
    if (group.href) {
      pages.push({ title: group.title, href: group.href });
    }
    if (group.pages) {
      for (const page of group.pages) {
        pages.push(page);
      }
    }
  }
  return pages;
}

export function slugToContentPath(slug: string): string {
  if (!slug || slug === "") return "../docs-content/index.md";
  if (slug === "architecture") return "../docs-content/architecture.md";
  if (slug === "troubleshooting") return "../docs-content/troubleshooting.md";
  const parts = slug.split("/");
  if (parts.length === 2) {
    return `../docs-content/${parts[0]}/${parts[1]}.md`;
  }
  return `../docs-content/${slug}.md`;
}

export function activeGroup(href: string): string | null {
  for (const group of docsSidebar) {
    if (group.href === href) return group.title;
    for (const page of group.pages) {
      if (page.href === href) return group.title;
    }
  }
  return null;
}
