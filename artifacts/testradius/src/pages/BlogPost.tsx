import React, { useEffect, useState } from "react";
import { useParams } from "wouter";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { motion } from "framer-motion";
import { Layout } from "@/components/Layout";

const fadeInUp = {
  hidden: { opacity: 0, y: 20 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.6 } },
};

const YoutubeEmbed = ({ url }: { url: string }) => {
  const videoIdMatch = url.match(
    /(?:https?:\/\/)?(?:www\.)?(?:youtube\.com\/watch\?v=|youtu\.be\/)([a-zA-Z0-9_-]{11})/,
  );
  const videoId = videoIdMatch ? videoIdMatch[1] : null;

  if (!videoId) return <a href={url}>{url}</a>;

  return (
    <div className="aspect-video w-full my-12 group relative">
      <div className="absolute -inset-2 bg-gradient-to-r from-primary/10 to-[#3daa9a]/10 rounded-2xl blur-lg opacity-0 group-hover:opacity-100 transition-opacity" />
      <iframe
        className="w-full h-full rounded-xl shadow-2xl relative z-10"
        src={`https://www.youtube.com/embed/${videoId}`}
        title="YouTube video player"
        frameBorder="0"
        allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
        allowFullScreen
      ></iframe>
    </div>
  );
};

export function BlogPost() {
  const { slug } = useParams<{ slug: string }>();
  // ... rest of state remain same
  const [markdown, setMarkdown] = useState("");
  const [title, setTitle] = useState("Loading...");
  const [date, setDate] = useState("");
  const [description, setDescription] = useState("");
  const [imageUrl, setImageUrl] = useState<string | undefined>();
  const [error, setError] = useState(false);

  useEffect(() => {
    // ... loadPost implementation remains same
    async function loadPost() {
      try {
        const rawContent = await import(`../blog/${slug}.md?raw`);
        const content = rawContent.default;

        // Extract frontmatter (simple parsing)
        const lines = content.split("\n");
        let bodyStartIndex = 0;
        const meta: { [key: string]: string } = {};

        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          if (line.trim() === "---") {
            // End of frontmatter (if using YAML frontmatter convention)
            bodyStartIndex = i + 1;
            break;
          } else if (line.includes(":")) {
            const [key, ...valueParts] = line.split(":");
            meta[key.trim()] = valueParts.join(":").trim();
          }
        }

        setTitle(meta.title || "Untitled Article");
        setDate(meta.date ? new Date(meta.date).toLocaleDateString() : "");
        setDescription(meta.description || "");
        setImageUrl(meta.imageUrl);

        setMarkdown(lines.slice(bodyStartIndex).join("\n"));
      } catch (err) {
        console.error("Failed to load blog post:", err);
        setError(true);
        setTitle("Article Not Found");
        setMarkdown("The requested blog post could not be found.");
      }
    }
    loadPost();
  }, [slug]);

  if (error) {
    return (
      <Layout>
        <div className="min-h-[100dvh] pt-16 bg-background text-foreground text-center py-24">
          <h1 className="text-4xl font-bold mb-4">Article Not Found</h1>
          <p className="text-lg text-muted-foreground">
            The requested blog post could not be found.
          </p>
          <motion.div
            variants={fadeInUp}
            initial="hidden"
            animate="visible"
            className="mt-8"
          >
            <a href="/blog" className="text-primary hover:underline">
              Back to Blog Index
            </a>
          </motion.div>
        </div>
      </Layout>
    );
  }

  const markdownComponents = {
    a: ({ href, children }: any) => {
      const url = href || "";
      const isYoutube = /youtube\.com|youtu\.be/.test(url);
      
      // If it's a YouTube link, check if it should be embedded
      // We look for links where the text is the URL itself or just "YouTube"
      const childrenText = React.Children.toArray(children).join("").trim();
      const isEmbedCandidate = isYoutube && (
        childrenText === url || 
        url.includes(childrenText) || 
        childrenText === "" ||
        childrenText.toLowerCase() === "youtube"
      );

      if (isEmbedCandidate) {
        return <YoutubeEmbed url={url} />;
      }

      return (
        <a href={url} className="text-primary font-medium hover:underline" target="_blank" rel="noopener noreferrer">
          {children}
        </a>
      );
    },
  };

  return (
    <Layout>
      <article className="max-w-3xl mx-auto px-6 py-16 prose dark:prose-invert prose-p:leading-relaxed prose-a:text-primary prose-headings:font-bold prose-headings:text-foreground">
        <motion.header
          variants={fadeInUp}
          initial="hidden"
          animate="visible"
          className="mb-12 text-center"
        >
          {imageUrl && (
            <img
              src={imageUrl}
              alt={title}
              className="w-full h-64 sm:h-96 object-cover rounded-xl mb-8 shadow-2xl"
            />
          )}
          <h1 className="text-4xl sm:text-5xl lg:text-6xl font-extrabold tracking-tight leading-[1.1] mb-6 text-foreground">
            <span className="text-transparent bg-clip-text bg-gradient-to-r from-primary to-[#3daa9a]">
              {title}
            </span>
          </h1>
          <p className="text-lg text-primary/80 font-medium mb-4 italic">
            {date}
          </p>
          {description && (
            <p className="text-xl text-muted-foreground max-w-2xl mx-auto leading-relaxed">
              {description}
            </p>
          )}
        </motion.header>
        <motion.div
          variants={fadeInUp}
          initial="hidden"
          animate="visible"
          className="markdown-content"
        >
          <ReactMarkdown 
            remarkPlugins={[remarkGfm]}
            components={markdownComponents}
          >
            {markdown}
          </ReactMarkdown>
        </motion.div>
        <motion.div
          variants={fadeInUp}
          initial="hidden"
          animate="visible"
          className="mt-16 pt-8 border-t border-border text-center"
        >
          <a href="/blog" className="inline-flex items-center text-primary font-semibold hover:underline">
            &larr; Back to Blog Index
          </a>
        </motion.div>
      </article>
    </Layout>
  );
}
