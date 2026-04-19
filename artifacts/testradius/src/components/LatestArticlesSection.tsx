import React, { useEffect, useState } from "react";
import { motion } from "framer-motion";
import { Link } from "wouter";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ArrowRight } from "lucide-react";

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

export function LatestArticlesSection() {
  const [latestPosts, setLatestPosts] = useState<BlogPostMeta[]>([]);

  useEffect(() => {
    async function loadLatestPosts() {
      const modules = import.meta.glob("../blog/*.md", { as: "raw" });
      const loadedPosts: BlogPostMeta[] = [];

      for (const path in modules) {
        const content = await modules[path]();
        const slug = path.replace("../blog/", "").replace(".md", "");

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

      loadedPosts.sort(
        (a, b) => new Date(b.date).getTime() - new Date(a.date).getTime(),
      );
      setLatestPosts(loadedPosts.slice(0, 3)); // Show top 3 latest posts
    }
    loadLatestPosts();
  }, []);

  return (
    <section className="py-24 bg-muted/30">
      <div className="max-w-7xl mx-auto px-6">
        <motion.div
          initial="hidden"
          whileInView="visible"
          viewport={{ once: true, margin: "-100px" }}
          variants={fadeInUp}
          className="text-center max-w-3xl mx-auto mb-16"
        >
          <h2 className="text-3xl sm:text-4xl font-bold mb-6">
            Latest Articles
          </h2>
          <p className="text-lg text-muted-foreground">
            Stay up-to-date with our latest insights and product updates.
          </p>
        </motion.div>

        <motion.div
          initial="hidden"
          whileInView="visible"
          viewport={{ once: true, margin: "-100px" }}
          variants={stagger}
          className="grid md:grid-cols-2 lg:grid-cols-3 gap-8"
        >
          {latestPosts.map((post) => (
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
                    <p className="text-muted-foreground line-clamp-3">
                      {post.description}
                    </p>
                  </CardContent>
                </Card>
              </Link>
            </motion.div>
          ))}
          {latestPosts.length === 0 && (
            <div className="col-span-full text-center text-muted-foreground text-lg">
              No blog posts yet. Check back soon!
            </div>
          )}
        </motion.div>
        {latestPosts.length > 0 && (
          <motion.div
            variants={fadeInUp}
            initial="hidden"
            animate="visible"
            className="text-center mt-12"
          >
            <Link href="/blog">
              <Button size="lg" variant="outline">
                View All Articles <ArrowRight className="ml-2 h-5 w-5" />
              </Button>
            </Link>
          </motion.div>
        )}
      </div>
    </section>
  );
}
