import React, { useEffect, useState, useMemo } from "react";
import { useLocation } from "wouter";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { motion } from "framer-motion";
import { Header } from "@/components/Header";
import { Footer } from "@/components/Footer";
import { DocsSidebar } from "@/components/DocsSidebar";
import { DocsTOC } from "@/components/DocsTOC";
import { DocsSearch } from "@/components/DocsSearch";
import { slugToContentPath } from "@/lib/docs";
import { Menu, X, Calendar, Github, MessageCircle } from "lucide-react";

const fadeInUp = {
  hidden: { opacity: 0, y: 20 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.6 } },
};

interface DocsPageProps {
  slug?: string;
}

export function DocsPage({ slug = "" }: DocsPageProps) {
  const [, setLocation] = useLocation();
  const [markdown, setMarkdown] = useState("");
  const [title, setTitle] = useState("Loading...");
  const [description, setDescription] = useState("");
  const [lastUpdated, setLastUpdated] = useState("");
  const [error, setError] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);

  const contentPath = slugToContentPath(slug);

  useEffect(() => {
    async function loadDoc() {
      try {
        setError(false);
        setMarkdown("");
        setTitle("Loading...");
        setDescription("");
        setLastUpdated("");

        const modules = import.meta.glob("../docs-content/**/*.md", { as: "raw" });
        const matchKey = Object.keys(modules).find((k) =>
          k.includes(contentPath.replace("../", "")),
        );

        if (!matchKey) {
          setError(true);
          setTitle("Page Not Found");
          setMarkdown("The requested documentation page could not be found.");
          return;
        }

        const loader = modules[matchKey];
        const rawContent = (await loader()) as { default?: string };
        const content = rawContent.default || (rawContent as unknown as string);

        const lines = content.split("\n");
        let bodyStartIndex = 0;
        const meta: { [key: string]: string } = {};

        for (let i = 0; i < lines.length; i++) {
          if (lines[i].trim() === "---") {
            bodyStartIndex = i + 1;
            break;
          } else if (lines[i].includes(":")) {
            const [key, ...valueParts] = lines[i].split(":");
            meta[key.trim()] = valueParts.join(":").trim();
          }
        }

        setTitle(meta.title || "Untitled");
        setDescription(meta.description || "");
        setLastUpdated(meta.lastUpdated || "");
        setMarkdown(lines.slice(bodyStartIndex).join("\n"));
      } catch (err) {
        console.error("Failed to load doc page:", err);
        setError(true);
        setTitle("Page Not Found");
        setMarkdown("The requested documentation page could not be found.");
      }
    }
    loadDoc();
  }, [slug, contentPath]);

  const markdownComponents = useMemo(
    () => ({
      h1: ({ children, ...props }: any) => {
        const text = children as string;
        const id = text
          ?.toString()
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/(^-|-$)/g, "");
        return (
          <h1 id={id} className="scroll-mt-20 text-3xl font-bold tracking-tight mb-4 mt-0" {...props}>
            {children}
          </h1>
        );
      },
      h2: ({ children, ...props }: any) => {
        const text = children as string;
        const id = text
          ?.toString()
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/(^-|-$)/g, "");
        return (
          <h2 id={id} className="scroll-mt-20 text-xl font-semibold tracking-tight mt-10 mb-3 pb-1 border-b border-border/40" {...props}>
            {children}
          </h2>
        );
      },
      h3: ({ children, ...props }: any) => {
        const text = children as string;
        const id = text
          ?.toString()
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/(^-|-$)/g, "");
        return (
          <h3 id={id} className="scroll-mt-20 text-base font-semibold mt-6 mb-2" {...props}>
            {children}
          </h3>
        );
      },
      p: ({ children }: any) => (
        <p className="text-base leading-relaxed mb-4 text-foreground/85">{children}</p>
      ),
      ul: ({ children }: any) => (
        <ul className="list-disc pl-6 mb-4 space-y-1.5 text-foreground/85">{children}</ul>
      ),
      ol: ({ children }: any) => (
        <ol className="list-decimal pl-6 mb-4 space-y-1.5 text-foreground/85">{children}</ol>
      ),
      li: ({ children }: any) => <li className="text-base leading-relaxed">{children}</li>,
      a: ({ href, children }: any) => {
        const url = href || "";
        const isExternal = url.startsWith("http");
        return (
          <a
            href={url}
            className="text-primary font-medium hover:underline"
            target={isExternal ? "_blank" : undefined}
            rel={isExternal ? "noopener noreferrer" : undefined}
          >
            {children}
          </a>
        );
      },
      code: ({ inline, className, children, ...props }: any) => {
        if (inline) {
          return (
            <code
              className="px-1.5 py-0.5 rounded bg-muted text-sm font-mono text-foreground"
              {...props}
            >
              {children}
            </code>
          );
        }
        const lang = className?.replace("language-", "") || "";
        return (
          <pre className="overflow-x-auto rounded-lg border border-border bg-muted/50 p-4 mb-4 text-sm font-mono">
            <code className={`language-${lang}`} {...props}>
              {children}
            </code>
          </pre>
        );
      },
      table: ({ children }: any) => (
        <div className="overflow-x-auto mb-4">
          <table className="w-full border-collapse text-sm">{children}</table>
        </div>
      ),
      thead: ({ children }: any) => <thead className="bg-muted/50">{children}</thead>,
      th: ({ children }: any) => (
        <th className="border border-border px-3 py-2 text-left font-semibold">{children}</th>
      ),
      td: ({ children }: any) => (
        <td className="border border-border px-3 py-2 text-foreground/85">{children}</td>
      ),
      hr: () => <hr className="my-8 border-border" />,
      blockquote: ({ children }: any) => (
        <blockquote className="border-l-4 border-primary/30 pl-4 py-1 mb-4 text-muted-foreground italic">
          {children}
        </blockquote>
      ),
    }),
    [],
  );

  const scrollToForm = () => {
    document
      .getElementById("early-access-form")
      ?.scrollIntoView({ behavior: "smooth" });
  };

  if (error) {
    return (
      <div className="min-h-screen bg-background text-foreground">
        <Header scrollToForm={scrollToForm} />
        <div className="max-w-3xl mx-auto px-6 py-24 text-center">
          <h1 className="text-4xl font-bold mb-4">Page Not Found</h1>
          <p className="text-lg text-muted-foreground mb-8">
            The requested documentation page could not be found.
          </p>
          <a href="/docs" className="text-primary hover:underline font-medium">
            &larr; Back to Docs
          </a>
        </div>
        <Footer />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background text-foreground selection:bg-primary/20">
      <DocsSearch />
      <Header scrollToForm={scrollToForm} />

      {/* Mobile sidebar toggle */}
      <button
        onClick={() => setSidebarOpen(!sidebarOpen)}
        className="fixed bottom-4 right-4 z-50 lg:hidden bg-primary text-primary-foreground p-3 rounded-full shadow-lg"
        aria-label={sidebarOpen ? "Close sidebar" : "Open sidebar"}
      >
        {sidebarOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
      </button>

      {/* Mobile sidebar overlay */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/50 lg:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* Mobile sidebar drawer */}
      <div
        className={`fixed top-16 left-0 bottom-0 z-40 w-72 bg-background border-r border-border overflow-y-auto transform transition-transform duration-200 lg:hidden ${
          sidebarOpen ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        <div className="p-4">
          <DocsSidebar onNavigate={() => setSidebarOpen(false)} />
        </div>
      </div>

      <div className="max-w-7xl mx-auto">
        <div className="flex">
          {/* Desktop sidebar */}
          <aside className="hidden lg:block w-64 shrink-0 border-r border-border min-h-[calc(100vh-4rem)]">
            <div className="sticky top-16 overflow-y-auto p-4 max-h-[calc(100vh-4rem)]">
              <DocsSidebar />
            </div>
          </aside>

          {/* Main content */}
          <main className="flex-1 min-w-0 px-6 py-8 lg:px-10 xl:px-12">
            <motion.article
              variants={fadeInUp}
              initial="hidden"
              animate="visible"
              className="max-w-3xl"
            >
              {/* Meta */}
              {lastUpdated && (
                <div className="flex items-center gap-3 text-xs text-muted-foreground mb-6">
                  <span className="flex items-center gap-1">
                    <Calendar className="h-3 w-3" />
                    Last updated: {new Date(lastUpdated).toLocaleDateString()}
                  </span>
                </div>
              )}

              {/* Title */}
              <h1 className="text-3xl lg:text-4xl font-extrabold tracking-tight mb-2">
                <span className="text-transparent bg-clip-text bg-gradient-to-r from-primary to-[#3daa9a]">
                  {title}
                </span>
              </h1>

              {description && (
                <p className="text-lg text-muted-foreground mb-8">{description}</p>
              )}

              {/* Markdown content */}
              <div className="doc-content">
                <ReactMarkdown
                  remarkPlugins={[remarkGfm]}
                  components={markdownComponents}
                >
                  {markdown}
                </ReactMarkdown>
              </div>

              {/* Footer links */}
              <div className="mt-16 pt-6 border-t border-border flex items-center justify-between text-sm text-muted-foreground">
                <a
                  href="https://github.com/hbahuguna/Test-Radius"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-1.5 hover:text-foreground transition-colors"
                >
                  <Github className="h-4 w-4" />
                  Edit this page
                </a>
                <a
                  href="https://github.com/hbahuguna/Test-Radius/issues/new"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-1.5 hover:text-foreground transition-colors"
                >
                  <MessageCircle className="h-4 w-4" />
                  Found a bug?
                </a>
              </div>
            </motion.article>
          </main>

          {/* Right TOC sidebar */}
          <aside className="hidden xl:block w-56 shrink-0 self-start sticky top-16 max-h-[calc(100vh-4rem)] overflow-y-auto">
            <div className="p-4">
              <DocsTOC content={markdown} />
            </div>
          </aside>
        </div>
      </div>

      <Footer />
    </div>
  );
}
