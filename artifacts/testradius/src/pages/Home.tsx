import { useState } from "react";
import { motion } from "framer-motion";
import {
  ArrowRight,
  CheckCircle2,
  ShieldCheck,
  AlertCircle,
  Bug,
  Layers,
  Fingerprint,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Link } from "wouter";
import { LatestArticlesSection } from "@/components/LatestArticlesSection";
import { EarlyAccessForm } from "@/components/EarlyAccessForm";
import { Layout } from "@/components/Layout";

export function Home() {
  const scrollToForm = () => {
    document
      .getElementById("early-access-form")
      ?.scrollIntoView({ behavior: "smooth" });
  };

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

  return (
    <Layout scrollToForm={scrollToForm}>
      <main className="pt-16">
        {/* Hero Section */}
        <section className="relative pt-24 pb-32 overflow-hidden">
          <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_top_left,_var(--tw-gradient-stops))] from-primary/12 via-[#3daa9a]/6 to-background -z-10" />

          <div className="max-w-7xl mx-auto px-6 grid lg:grid-cols-2 gap-16 items-center">
            <motion.div
              initial="hidden"
              animate="visible"
              variants={stagger}
              className="max-w-2xl"
            >
              <motion.div
                variants={fadeInUp}
                className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-primary/10 text-primary text-sm font-medium mb-6"
              >
                <span className="relative flex h-2 w-2">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-primary opacity-75"></span>
                  <span className="relative inline-flex rounded-full h-2 w-2 bg-primary"></span>
                </span>
                Currently in private beta
              </motion.div>

              <motion.h1
                variants={fadeInUp}
                className="text-5xl sm:text-6xl lg:text-7xl font-extrabold tracking-tight leading-[1.1] mb-6 text-foreground"
              >
                Stop flaky tests. <br />
                <span className="text-transparent bg-clip-text bg-gradient-to-r from-primary to-[#3daa9a]">
                  Ship with confidence.
                </span>
              </motion.h1>

              <motion.p
                variants={fadeInUp}
                className="text-lg sm:text-xl text-muted-foreground mb-8 leading-relaxed max-w-xl"
              >
                TestRadius runs only the tests impacted by your code changes –
                so you stop debugging false failures and start shipping faster.
              </motion.p>

              <motion.div
                variants={fadeInUp}
                className="flex flex-col sm:flex-row gap-4"
              >
                <Button
                  size="lg"
                  className="h-14 px-8 text-base font-medium"
                  onClick={scrollToForm}
                >
                  Get Early Access <ArrowRight className="ml-2 h-5 w-5" />
                </Button>
                <Button
                  size="lg"
                  variant="outline"
                  className="h-14 px-8 text-base font-medium"
                  onClick={scrollToForm}
                >
                  Join the Pilot
                </Button>
              </motion.div>
            </motion.div>

            <motion.div
              initial={{ opacity: 0, x: 20 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ duration: 0.8, delay: 0.2 }}
              className="relative"
            >
              <div className="rounded-xl border border-border bg-card shadow-2xl overflow-hidden relative z-10 transform sm:rotate-2 hover:rotate-0 transition-transform duration-500">
                <div className="flex items-center gap-2 px-4 py-3 bg-muted/50 border-b border-border">
                  <div className="flex gap-1.5">
                    <div className="w-3 h-3 rounded-full bg-red-500/80"></div>
                    <div className="w-3 h-3 rounded-full bg-yellow-500/80"></div>
                    <div className="w-3 h-3 rounded-full bg-green-500/80"></div>
                  </div>
                  <div className="mx-auto text-xs text-muted-foreground font-mono">
                    testradius run --pr 492
                  </div>
                </div>
                <div className="p-6 font-mono text-sm leading-relaxed">
                  <div className="text-muted-foreground mb-2">
                    $ testradius analyze --commit HEAD
                  </div>
                  <div className="text-primary mb-4 flex items-center gap-2">
                    <CheckCircle2 size={16} /> AST mapped. 3 files changed.
                  </div>
                  <div className="text-foreground mb-4">
                    Analyzing dependency graph...
                    <br />
                    Found <span className="text-primary font-bold">
                      42
                    </span>{" "}
                    impacted tests out of 735.
                  </div>
                  <div className="text-muted-foreground mb-2">
                    $ pytest $(testradius list)
                  </div>
                  <div className="text-green-500 mb-4">
                    ================ test session starts ================
                    <br />
                    collected 42 items
                    <br />
                    <br />
                    tests/api/test_users.py .................... [ 47%]
                    <br />
                    tests/core/test_auth.py ...................... [100%]
                    <br />
                    <br />
                    ================ 42 passed in 1.24s =================
                  </div>
                  <div className="border-t border-border/50 pt-4 flex justify-between items-center text-xs">
                    <span className="text-muted-foreground">
                      Time saved:{" "}
                      <span className="text-foreground font-bold">28m 45s</span>
                    </span>
                    <span className="text-primary font-bold px-2 py-1 bg-primary/10 rounded-md">
                      Shipped
                    </span>
                  </div>
                </div>
              </div>
              <div className="absolute -inset-4 bg-gradient-to-r from-primary/20 to-[#3daa9a]/30 blur-2xl -z-10 rounded-full opacity-50"></div>
            </motion.div>
          </div>
        </section>

        {/* Problem Section */}
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
                Running the whole suite is breaking your team.
              </h2>
              <p className="text-lg text-muted-foreground">
                Engineering teams run entire test suites on every PR because
                they lack confidence in skipping tests. The result is a broken
                developer experience.
              </p>
            </motion.div>

            <motion.div
              initial="hidden"
              whileInView="visible"
              viewport={{ once: true, margin: "-100px" }}
              variants={stagger}
              className="grid md:grid-cols-3 gap-8"
            >
              <motion.div variants={fadeInUp}>
                <Card className="h-full border-border/50 shadow-sm hover:shadow-md transition-all">
                  <CardContent className="p-8">
                    <div className="w-12 h-12 rounded-lg bg-red-100 dark:bg-red-900/30 text-red-600 dark:text-red-400 flex items-center justify-center mb-6">
                      <AlertCircle size={24} />
                    </div>
                    <h2 className="text-xl font-bold mb-3">
                      Slow CI Pipelines
                    </h2>
                    <p className="text-muted-foreground">
                      Developers waste hours re-running pipelines. A 30-60
                      minute wait per PR destroys momentum and context context
                      switching.
                    </p>
                  </CardContent>
                </Card>
              </motion.div>

              <motion.div variants={fadeInUp}>
                <Card className="h-full border-border/50 shadow-sm hover:shadow-md transition-all">
                  <CardContent className="p-8">
                    <div className="w-12 h-12 rounded-lg bg-orange-100 dark:bg-orange-900/30 text-orange-600 dark:text-orange-400 flex items-center justify-center mb-6">
                      <Bug size={24} />
                    </div>
                    <h3 className="text-xl font-bold mb-3">Flaky Test Noise</h3>
                    <p className="text-muted-foreground">
                      When tests fail for no reason, engineers learn to ignore
                      them. Real bugs slip through the cracks because the
                      signal-to-noise ratio is zero.
                    </p>
                  </CardContent>
                </Card>
              </motion.div>

              <motion.div variants={fadeInUp}>
                <Card className="h-full border-border/50 shadow-sm hover:shadow-md transition-all">
                  <CardContent className="p-8">
                    <div className="w-12 h-12 rounded-lg bg-blue-100 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400 flex items-center justify-center mb-6">
                      <Layers size={24} />
                    </div>
                    <h3 className="text-xl font-bold mb-3">
                      Release Bottlenecks
                    </h3>
                    <p className="text-muted-foreground">
                      End-of-day merges queue up. Hotfixes take hours to deploy.
                      The larger your codebase gets, the slower your entire
                      engineering org moves.
                    </p>
                  </CardContent>
                </Card>
              </motion.div>
            </motion.div>
          </div>
        </section>

        {/* Solution Section */}
        <section className="py-32">
          <div className="max-w-7xl mx-auto px-6">
            <motion.div
              initial="hidden"
              whileInView="visible"
              viewport={{ once: true, margin: "-100px" }}
              variants={fadeInUp}
              className="text-center max-w-3xl mx-auto mb-20"
            >
              <h2 className="text-3xl sm:text-4xl font-bold mb-6">
                Surgical precision, zero magic.
              </h2>
              <p className="text-lg text-muted-foreground">
                TestRadius is a deterministic decision layer. We analyze your
                code and tell your CI exactly what to run. Explainable,
                lightweight, and fast.
              </p>
            </motion.div>

            <div className="grid md:grid-cols-3 gap-12 relative">
              <div className="hidden md:block absolute top-1/2 left-[10%] right-[10%] h-0.5 bg-gradient-to-r from-primary/20 via-[#3daa9a]/40 to-primary/20 -translate-y-1/2 -z-10"></div>

              <motion.div
                initial="hidden"
                whileInView="visible"
                viewport={{ once: true }}
                variants={stagger}
                className="flex flex-col items-center text-center relative bg-background px-4"
              >
                <div className="w-16 h-16 rounded-full bg-primary text-primary-foreground flex items-center justify-center mb-6 shadow-lg shadow-primary/20 font-bold text-xl ring-8 ring-background">
                  1
                </div>
                <h3 className="text-xl font-bold mb-3">Map Code Changes</h3>
                <p className="text-muted-foreground">
                  We parse your AST and map your project's dependency graph in
                  seconds. We know exactly which files your commit touches.
                </p>
              </motion.div>

              <motion.div
                initial="hidden"
                whileInView="visible"
                viewport={{ once: true }}
                variants={stagger}
                className="flex flex-col items-center text-center relative bg-background px-4"
              >
                <div className="w-16 h-16 rounded-full bg-[#3daa9a] text-white flex items-center justify-center mb-6 shadow-lg shadow-[#3daa9a]/30 font-bold text-xl ring-8 ring-background">
                  2
                </div>
                <h3 className="text-xl font-bold mb-3">
                  Select Impacted Tests
                </h3>
                <p className="text-muted-foreground">
                  Using the dependency graph, we trace your changes to the
                  specific tests that exercise those code paths. Nothing more.
                </p>
              </motion.div>

              <motion.div
                initial="hidden"
                whileInView="visible"
                viewport={{ once: true }}
                variants={stagger}
                className="flex flex-col items-center text-center relative bg-background px-4"
              >
                <div className="w-16 h-16 rounded-full bg-primary text-primary-foreground flex items-center justify-center mb-6 shadow-lg shadow-primary/20 font-bold text-xl ring-8 ring-background">
                  3
                </div>
                <h3 className="text-xl font-bold mb-3">Eliminate Noise</h3>
                <p className="text-muted-foreground">
                  Your CI runs a fraction of the suite. False positives from
                  unrelated flaky tests disappear. You get green builds in
                  minutes.
                </p>
              </motion.div>
            </div>
          </div>
        </section>

        {/* Differentiation */}
        <section className="py-24 bg-foreground text-background">
          <div className="max-w-7xl mx-auto px-6">
            <motion.div
              initial="hidden"
              whileInView="visible"
              viewport={{ once: true, margin: "-100px" }}
              variants={fadeInUp}
              className="max-w-3xl mb-16"
            >
              <h2 className="text-3xl sm:text-4xl font-bold mb-6 text-background">
                Why not just use...
              </h2>
              <p className="text-lg text-muted-foreground/80">
                Other approaches sound good until you actually try to deploy
                them to a 50-engineer team. TestRadius is built for reality.
              </p>
            </motion.div>

            <motion.div
              initial="hidden"
              whileInView="visible"
              viewport={{ once: true, margin: "-100px" }}
              variants={stagger}
              className="grid md:grid-cols-3 gap-6"
            >
              <Card className="bg-foreground border-muted-foreground/20 text-background">
                <CardContent className="p-8">
                  <h3 className="text-xl font-bold mb-3 text-red-400 line-through decoration-red-400/50">
                    Running everything
                  </h3>
                  <p className="text-muted-foreground/70 mb-4">
                    "We'll just buy faster CI runners."
                  </p>
                  <p className="text-sm">
                    Compute costs scale linearly. Developer wait times still
                    increase as the codebase grows. Flaky tests still randomly
                    break builds.
                  </p>
                </CardContent>
              </Card>

              <Card className="bg-foreground border-muted-foreground/20 text-background">
                <CardContent className="p-8">
                  <h3 className="text-xl font-bold mb-3 text-red-400 line-through decoration-red-400/50">
                    Black-box AI
                  </h3>
                  <p className="text-muted-foreground/70 mb-4">
                    "AI will guess which tests to run."
                  </p>
                  <p className="text-sm">
                    Non-deterministic. When it misses a test and ships a bug,
                    you can't explain why. Engineers don't trust systems they
                    can't verify.
                  </p>
                </CardContent>
              </Card>

              <Card className="bg-foreground border-muted-foreground/20 text-background relative overflow-hidden">
                <div className="absolute top-0 left-0 w-1 h-full bg-[#3daa9a]"></div>
                <CardContent className="p-8">
                  <h3 className="text-xl font-bold mb-3 text-[#3daa9a]">
                    TestRadius
                  </h3>
                  <p className="text-muted-foreground/70 mb-4">
                    "Run what changed based on the AST."
                  </p>
                  <p className="text-sm">
                    Deterministic. Explainable. If a test is skipped, you can
                    query the graph to see exactly why. Built for engineer
                    trust.
                  </p>
                </CardContent>
              </Card>
            </motion.div>
          </div>
        </section>

        {/* Proof / Social Proof */}
        <section className="py-32">
          <div className="max-w-7xl mx-auto px-6">
            <div className="grid lg:grid-cols-2 gap-16 items-center">
              <motion.div
                initial="hidden"
                whileInView="visible"
                viewport={{ once: true }}
                variants={fadeInUp}
              >
                <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-muted text-muted-foreground text-sm font-medium mb-6">
                  <ShieldCheck size={16} /> Real Validation
                </div>
                <h2 className="text-3xl sm:text-4xl font-bold mb-6">
                  We tested it on massive codebases.
                </h2>
                <p className="text-lg text-muted-foreground mb-8">
                  In a real-world validation on a mature Django monolith,
                  TestRadius safely reduced the required test runs by over 94%
                  without missing a single relevant failure.
                </p>

                <div className="flex gap-8 mb-8">
                  <div>
                    <div className="text-4xl font-extrabold text-foreground mb-1">
                      735
                    </div>
                    <div className="text-sm text-muted-foreground font-medium uppercase tracking-wider">
                      Default Run
                    </div>
                  </div>
                  <div className="flex items-center text-muted-foreground">
                    <ArrowRight strokeWidth={1} />
                  </div>
                  <div>
                    <div className="text-4xl font-extrabold text-[#3daa9a] mb-1">
                      42
                    </div>
                    <div
                      className="text-sm font-medium uppercase tracking-wider"
                      style={{ color: "#3daa9a99" }}
                    >
                      TestRadius
                    </div>
                  </div>
                </div>

                <p className="text-sm text-muted-foreground italic border-l-2 border-[#3daa9a]/50 pl-4">
                  "Coming soon: A detailed technical teardown of our open-source
                  validation results."
                </p>
              </motion.div>

              <motion.div
                initial={{ opacity: 0, scale: 0.95 }}
                whileInView={{ opacity: 1, scale: 1 }}
                viewport={{ once: true }}
                transition={{ duration: 0.6 }}
                className="bg-card border border-border rounded-2xl p-8 shadow-xl relative"
              >
                <div className="absolute -top-4 -right-4 w-24 h-24 bg-[#3daa9a]/15 rounded-full blur-xl"></div>
                <div className="absolute -bottom-8 -left-8 w-32 h-32 bg-primary/10 rounded-full blur-xl"></div>

                <div className="flex flex-col gap-6 relative z-10">
                  <div className="bg-muted/50 p-6 rounded-xl border border-border/50">
                    <div className="flex items-center gap-4 mb-4">
                      <div className="w-10 h-10 rounded-full bg-primary/20 text-primary flex items-center justify-center font-bold">
                        EM
                      </div>
                      <div>
                        <div className="font-bold text-foreground">
                          Engineering Manager
                        </div>
                        <div className="text-xs text-muted-foreground">
                          Series B SaaS Company
                        </div>
                      </div>
                    </div>
                    <p className="text-foreground/80 italic">
                      "We were about to hire a dedicated devops engineer just to
                      manage our test flake. TestRadius gave us our CI back. The
                      explainability is what sold my staff engineers."
                    </p>
                  </div>

                  <div className="bg-muted/50 p-6 rounded-xl border border-border/50">
                    <div className="flex items-center gap-4 mb-4">
                      <div className="w-10 h-10 rounded-full bg-[#3daa9a]/20 text-[#3daa9a] flex items-center justify-center font-bold">
                        SL
                      </div>
                      <div>
                        <div className="font-bold text-foreground">
                          Staff Software Engineer
                        </div>
                        <div className="text-xs text-muted-foreground">
                          Fintech Startup
                        </div>
                      </div>
                    </div>
                    <p className="text-foreground/80 italic">
                      "I love that it's just an AST and dependency graph. No AI
                      guessing. It just accurately calculates the impact radius
                      of my PR."
                    </p>
                  </div>
                </div>
              </motion.div>
            </div>
          </div>
        </section>

        <LatestArticlesSection />
      </main>
    </Layout>
  );
  /* testradius-trigger */
}
