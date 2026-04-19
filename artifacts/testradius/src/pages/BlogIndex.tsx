import React, { useEffect, useState } from "react";
import { Link } from "wouter";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { motion } from "framer-motion";
import { Layout } from "@/components/Layout";

interface BlogPostMeta {
  slug: string;
  title: string;
  date: string;
  description: string;
  imageUrl?: string;
}

const fadeInUp = {
  hidden: { opacity: 0, y: 20 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.6 } },
};

const stagger = {
  hidden: { opacity: 0 },
  visible: {
    opacity: 1,
    transition: {
      staggerChildren: 0.2,
    },
  },
};

export function BlogIndex() {
  const [posts, setPosts] = useState<BlogPostMeta[]>([]);

  useEffect(() => {
    async function loadPosts() {
      const modules = import.meta.glob("../blog/*.md", { as: "raw" });
      const loadedPosts: BlogPostMeta[] = [];

      for (const path in modules) {
        const content = await modules[path]();
        const slug = path.replace("../blog/", "").replace(".md", "");

        // Simple frontmatter parsing (assumes title and description are on first few lines)
        const lines = content.split("\n");
        const titleLine = lines.find((line) => line.startsWith("title:"));
        const dateLine = lines.find((line) => line.startsWith("date:"));
        const descriptionLine = lines.find((line) =>
          line.startsWith("description:"),
        );
        const imageUrlLine = lines.find((line) => line.startsWith("imageUrl:"));

        const title = titleLine
          ? titleLine.replace("title:", "").trim()
          : "No Title";
        const date = dateLine
          ? new Date(dateLine.replace("date:", "").trim()).toLocaleDateString()
          : "No Date";
        const description = descriptionLine
          ? descriptionLine.replace("description:", "").trim()
          : "No Description";
        const imageUrl = imageUrlLine
          ? imageUrlLine.replace("imageUrl:", "").trim()
          : undefined;

        loadedPosts.push({ slug, title, date, description, imageUrl });
      }

      // Sort posts by date, newest first
      loadedPosts.sort(
        (a, b) => new Date(b.date).getTime() - new Date(a.date).getTime(),
      );
      setPosts(loadedPosts);
    }
    loadPosts();
  }, []);

  return (
    <Layout>
      <header className="max-w-7xl mx-auto px-6 py-16 text-center">
        <motion.h1
          variants={fadeInUp}
          initial="hidden"
          animate="visible"
          className="text-5xl sm:text-6xl lg:text-7xl font-extrabold tracking-tight leading-[1.1] mb-6 text-foreground font-inter"
        >
          <span className="text-primary">Test</span>
          <span className="text-[#3daa9a]">Radius</span> Blog
        </motion.h1>
        <motion.p
          variants={fadeInUp}
          initial="hidden"
          animate="visible"
          className="text-lg sm:text-xl text-muted-foreground max-w-2xl mx-auto"
        >
          Insights, updates, and deep dives into testing, software quality, and
          developer experience.
        </motion.p>
      </header>

      <section className="max-w-7xl mx-auto px-6 pb-24">
        <motion.div
          variants={stagger}
          initial="hidden"
          animate="visible"
          className="grid md:grid-cols-2 lg:grid-cols-3 gap-8"
        >
          {posts.map((post) => (
            <motion.div key={post.slug} variants={fadeInUp}>
              <Link href={`/blog/${post.slug}`}>
                <Card className="h-full cursor-pointer hover:shadow-lg transition-shadow duration-300">
                  {post.imageUrl && (
                    <img
                      src={post.imageUrl}
                      alt={post.title}
                      className="w-full h-48 object-cover rounded-t-lg mb-4"
                    />
                  )}
                  <CardHeader>
                    <CardTitle className="text-2xl font-bold">
                      {post.title}
                    </CardTitle>
                    <p className="text-sm text-muted-foreground">{post.date}</p>
                  </CardHeader>
                  <CardContent>
                    <p className="text-muted-foreground">{post.description}</p>
                  </CardContent>
                </Card>
              </Link>
            </motion.div>
          ))}
          {posts.length === 0 && (
            <div className="col-span-full text-center text-muted-foreground text-lg">
              No blog posts yet. Check back soon!
            </div>
          )}
        </motion.div>
      </section>
    </Layout>
  );
}
