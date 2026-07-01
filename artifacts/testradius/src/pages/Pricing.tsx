import { useState } from "react";
import { motion } from "framer-motion";
import { CheckCircle2, ArrowRight, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Slider } from "@/components/ui/slider";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Layout } from "@/components/Layout";
import { PRICING_TIERS, FAQ_ITEMS, COMPARISON_ROWS } from "@/data/pricing";

const fadeInUp = {
  hidden: { opacity: 0, y: 20 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.6 } },
};

const stagger = {
  hidden: { opacity: 0 },
  visible: {
    opacity: 1,
    transition: { staggerChildren: 0.1 },
  },
};

const GUARANTEE_BADGE_TEXT = "30-day money-back guarantee on all paid plans.";

function getEffectiveMonthly(
  tier: (typeof PRICING_TIERS)[0],
  devCount: number,
  isAnnual: boolean,
): number | null {
  if (tier.name === "Free") return 0;
  if (tier.name === "Enterprise") {
    if (devCount >= 75) return isAnnual ? tier.annualPrice! : tier.monthlyPrice!;
    return null;
  }
  if (tier.name === "Starter") {
    if (devCount <= 5) return isAnnual ? tier.annualPrice! / 12 : tier.monthlyPrice!;
    return null;
  }
  if (tier.name === "Growth") {
    if (devCount >= 6 && devCount <= 25) {
      return isAnnual
        ? (tier.annualPrice! * devCount) / 12
        : tier.monthlyPrice! * devCount;
    }
    return null;
  }
  if (tier.name === "Scale") {
    if (devCount >= 26 && devCount <= 75) {
      return isAnnual
        ? (tier.annualPrice! * devCount) / 12
        : tier.monthlyPrice! * devCount;
    }
    return null;
  }
  return null;
}

function getBestTierName(devCount: number): string | null {
  if (devCount <= 5) return "Starter";
  if (devCount <= 25) return "Growth";
  if (devCount <= 78) return "Scale";
  return "Enterprise";
}

export function Pricing() {
  const [isAnnual, setIsAnnual] = useState(false);
  const [devCount, setDevCount] = useState(10);

  const paidTiers = PRICING_TIERS.filter((t) => t.name !== "Free");
  const bestTierName = getBestTierName(devCount);

  const handleCta = (action: "trial" | "contact-sales") => {
    if (action === "contact-sales") {
      window.location.href = "mailto:sales@testradius.dev";
    } else {
      document
        .getElementById("early-access-form")
        ?.scrollIntoView({ behavior: "smooth" });
    }
  };

  function formatPrice(tier: (typeof PRICING_TIERS)[0]): string {
    if (tier.name === "Free") return "$0";
    if (tier.name === "Enterprise") return "From $1,499";
    const price = isAnnual ? tier.annualPrice! : tier.monthlyPrice!;
    return `$${price.toLocaleString()}`;
  }

  function formatPeriod(tier: (typeof PRICING_TIERS)[0]): string {
    if (tier.name === "Free") return "/month";
    if (tier.name === "Enterprise") return "/month";
    if (tier.name === "Starter") return isAnnual ? "/year" : "/month";
    return isAnnual ? "/dev / year" : "/dev / month";
  }

  return (
    <Layout>
      <main className="pt-16">
        {/* Hero */}
        <section className="relative pt-24 pb-16 overflow-hidden">
          <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_top_left,_var(--tw-gradient-stops))] from-primary/12 via-[#3daa9a]/6 to-background -z-10" />

          <div className="max-w-7xl mx-auto px-6 text-center">
            <motion.div
              initial="hidden"
              animate="visible"
              variants={stagger}
            >
              <motion.div
                variants={fadeInUp}
                className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-primary/10 text-primary text-sm font-medium mb-6"
              >
                <span className="relative flex h-2 w-2">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-primary opacity-75" />
                  <span className="relative inline-flex rounded-full h-2 w-2 bg-primary" />
                </span>
                Launch pricing — valid until Dec 31, 2026
              </motion.div>

              <motion.h1
                variants={fadeInUp}
                className="text-4xl sm:text-5xl lg:text-6xl font-extrabold tracking-tight leading-[1.1] mb-6 text-foreground"
              >
                Simple, transparent pricing for{" "}
                <span className="text-transparent bg-clip-text bg-gradient-to-r from-primary to-[#3daa9a]">
                  teams of every size
                </span>
              </motion.h1>

              <motion.p
                variants={fadeInUp}
                className="text-lg text-muted-foreground mb-6 max-w-2xl mx-auto"
              >
                Stop wasting time on flaky tests. Start with free shadow mode
                trial — no credit card required.
              </motion.p>

              <motion.div
                variants={fadeInUp}
                className="inline-flex items-center gap-2 text-sm"
                style={{ color: "#3daa9a" }}
              >
                <CheckCircle2 size={16} />
                {GUARANTEE_BADGE_TEXT}
              </motion.div>
            </motion.div>
          </div>
        </section>

        {/* Billing Toggle */}
        <div className="max-w-7xl mx-auto px-6 mb-8">
          <div className="flex items-center justify-center gap-3">
            <span
              className={`text-sm font-medium ${
                !isAnnual ? "text-foreground" : "text-muted-foreground"
              }`}
            >
              Pay monthly
            </span>
            <Switch checked={isAnnual} onCheckedChange={setIsAnnual} />
            <span
              className={`text-sm font-medium ${
                isAnnual ? "text-foreground" : "text-muted-foreground"
              }`}
            >
              Pay annually
            </span>
            <Badge
              className="ml-1 text-xs font-semibold"
              style={{
                background: "linear-gradient(135deg, #3daa9a, #34d399)",
              }}
            >
              Save 17%
            </Badge>
          </div>
        </div>

        {/* Pricing Cards */}
        <section className="pb-16">
          <div className="max-w-7xl mx-auto px-6">
            <motion.div
              initial="hidden"
              whileInView="visible"
              viewport={{ once: true, margin: "-100px" }}
              variants={stagger}
              className="grid md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5 gap-4 items-start"
            >
              {PRICING_TIERS.map((tier) => (
                <motion.div
                  key={tier.name}
                  variants={fadeInUp}
                  className="relative"
                  data-tier={tier.name.toLowerCase()}
                >
                  <Card
                    className={`h-full flex flex-col ${
                      tier.highlighted
                        ? "border-[#3daa9a]/40 shadow-xl shadow-[#3daa9a]/5 scale-[1.02] lg:scale-105 relative z-10"
                        : "border-border/60 shadow-md"
                    }`}
                  >
                    {tier.badge && (
                      <Badge
                        className="absolute -top-3 left-1/2 -translate-x-1/2 px-4 py-1 text-sm font-semibold whitespace-nowrap"
                        style={{
                          background:
                            "linear-gradient(135deg, #3daa9a, #34d399)",
                        }}
                      >
                        {tier.badge}
                      </Badge>
                    )}

                    <CardHeader className="text-center pt-8 pb-6">
                      <div
                        className={`mx-auto w-12 h-12 rounded-xl flex items-center justify-center mb-4 ${
                          tier.highlighted
                            ? "bg-[#3daa9a]/15 text-[#3daa9a]"
                            : "bg-muted text-muted-foreground"
                        }`}
                      >
                        <tier.icon size={24} />
                      </div>
                      <CardTitle className="text-2xl font-bold">
                        {tier.name}
                      </CardTitle>
                      <div className="mt-3">
                        <span className="text-4xl font-extrabold text-foreground">
                          {formatPrice(tier)}
                        </span>
                        <span className="text-muted-foreground ml-1 text-sm">
                          {formatPeriod(tier)}
                        </span>
                        {isAnnual &&
                          tier.name !== "Free" &&
                          tier.name !== "Enterprise" && (
                            <div
                              className="text-xs font-semibold mt-1"
                              style={{ color: "#3daa9a" }}
                            >
                              2 months free
                            </div>
                          )}
                        {!isAnnual &&
                          tier.name !== "Free" &&
                          tier.name !== "Enterprise" && (
                            <div className="text-xs text-muted-foreground mt-1">
                              or ${tier.annualPrice!.toLocaleString()}
                              /year billed annually
                            </div>
                          )}
                      </div>
                      <p className="text-xs text-muted-foreground mt-2">
                        {tier.devRange} developers
                      </p>
                      <CardDescription className="text-sm mt-3 px-2">
                        {tier.description}
                      </CardDescription>
                    </CardHeader>

                    <CardContent className="flex-1 px-6 pb-6">
                      <ul className="space-y-3">
                        {tier.features.map((feature) => (
                          <li key={feature} className="flex items-start gap-3">
                            <CheckCircle2
                              size={18}
                              className="mt-0.5 shrink-0"
                              style={{
                                color: tier.highlighted
                                  ? "#3daa9a"
                                  : "var(--color-muted-foreground)",
                              }}
                            />
                            <span className="text-sm">{feature}</span>
                          </li>
                        ))}
                      </ul>
                    </CardContent>

                    <CardFooter className="px-6 pb-8 pt-0">
                      <Button
                        variant={tier.highlighted ? "default" : "outline"}
                        size="lg"
                        className={`w-full h-12 text-base font-medium ${
                          tier.highlighted
                            ? "shadow-md hover:shadow-lg transition-all text-white border-0"
                            : ""
                        }`}
                        style={
                          tier.highlighted
                            ? {
                                background:
                                  "linear-gradient(135deg, #3daa9a, #34d399)",
                              }
                            : {}
                        }
                        onClick={() => handleCta(tier.ctaAction)}
                      >
                        {tier.ctaLabel}
                        <ArrowRight className="ml-2 h-4 w-4" />
                      </Button>
                    </CardFooter>
                  </Card>
                </motion.div>
              ))}
            </motion.div>
          </div>
        </section>

        {/* Comparison Table */}
        <section className="py-16 bg-muted/30">
          <div className="max-w-5xl mx-auto px-6">
            <motion.div
              initial="hidden"
              whileInView="visible"
              viewport={{ once: true, margin: "-100px" }}
              variants={fadeInUp}
              className="text-center mb-12"
            >
              <h2 className="text-3xl sm:text-4xl font-bold mb-4">
                How TestRadius compares
              </h2>
              <p className="text-lg text-muted-foreground">
                See why teams choose TestRadius over the alternatives.
              </p>
            </motion.div>

            <motion.div
              initial="hidden"
              whileInView="visible"
              viewport={{ once: true, margin: "-100px" }}
              variants={fadeInUp}
            >
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-1/4" />
                    <TableHead className="w-1/4 font-bold text-foreground">
                      TestRadius
                    </TableHead>
                    <TableHead className="w-1/4 font-bold text-foreground">
                      Launchable
                    </TableHead>
                    <TableHead className="w-1/4 font-bold text-foreground">
                      DIY Scripts
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {COMPARISON_ROWS.map((row) => (
                    <TableRow key={row.feature}>
                      <TableCell className="font-medium">
                        {row.feature}
                      </TableCell>
                      <TableCell
                        className={
                          row.testRadius.startsWith("\u2713")
                            ? "text-emerald-600"
                            : "text-red-500"
                        }
                      >
                        {row.testRadius}
                      </TableCell>
                      <TableCell
                        className={
                          row.launchable.startsWith("\u2713")
                            ? "text-emerald-600"
                            : "text-red-500"
                        }
                      >
                        {row.launchable}
                      </TableCell>
                      <TableCell
                        className={
                          row.diyScripts.startsWith("\u2713")
                            ? "text-emerald-600"
                            : "text-red-500"
                        }
                      >
                        {row.diyScripts}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </motion.div>
          </div>
        </section>

        {/* Team Cost Calculator */}
        <section className="py-16">
          <div className="max-w-3xl mx-auto px-6">
            <motion.div
              initial="hidden"
              whileInView="visible"
              viewport={{ once: true, margin: "-100px" }}
              variants={fadeInUp}
              className="text-center mb-10"
            >
              <div className="inline-flex items-center justify-center w-12 h-12 rounded-xl bg-[#3daa9a]/15 text-[#3daa9a] mb-4">
                <Users size={24} />
              </div>
              <h2 className="text-3xl sm:text-4xl font-bold mb-4">
                Team Cost Calculator
              </h2>
              <p className="text-lg text-muted-foreground">
                Drag to see exactly what your team will pay.
              </p>
            </motion.div>

            <motion.div
              initial="hidden"
              whileInView="visible"
              viewport={{ once: true, margin: "-100px" }}
              variants={fadeInUp}
              className="bg-card border border-border/60 rounded-xl p-6 shadow-sm"
            >
              <div className="flex items-center gap-4 mb-6">
                <span className="text-sm font-medium text-muted-foreground shrink-0">
                  Developer count:
                </span>
                <Slider
                  value={[devCount]}
                  onValueChange={([v]) => setDevCount(v)}
                  min={1}
                  max={100}
                  step={1}
                  className="flex-1"
                />
                <span className="text-2xl font-bold text-foreground min-w-[3ch] text-right">
                  {devCount}
                </span>
              </div>

              <div className="space-y-3">
                {paidTiers.map((tier) => {
                  const cost = getEffectiveMonthly(
                    tier,
                    devCount,
                    isAnnual,
                  );
                  const isAvailable = cost !== null;
                  const isBest = tier.name === bestTierName;

                  return (
                    <div
                      key={tier.name}
                      data-calculator-tier={tier.name.toLowerCase()}
                      className={`flex items-center justify-between p-4 rounded-lg border ${
                        isBest
                          ? "border-[#3daa9a]/40 bg-[#3daa9a]/5"
                          : "border-border/60"
                      } ${!isAvailable ? "opacity-40" : ""}`}
                    >
                      <div className="flex items-center gap-3">
                        <tier.icon
                          size={20}
                          className="text-muted-foreground"
                        />
                        <div>
                          <span className="font-semibold">{tier.name}</span>
                          <span className="text-sm text-muted-foreground ml-2">
                            {tier.devRange} devs
                          </span>
                        </div>
                      </div>
                      <div className="flex items-center gap-3">
                        {isAvailable ? (
                          <>
                            <span className="font-bold text-lg">
                              ${cost!.toFixed(0)}
                              <span className="text-sm font-normal text-muted-foreground">
                                /mo
                              </span>
                            </span>
                            {isBest && (
                              <Badge
                                className="shrink-0"
                                style={{
                                  background:
                                    "linear-gradient(135deg, #3daa9a, #34d399)",
                                }}
                              >
                                Best Value
                              </Badge>
                            )}
                          </>
                        ) : (
                          <span className="text-sm text-muted-foreground">
                            Not in range
                          </span>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </motion.div>
          </div>
        </section>

        {/* FAQ */}
        <section className="py-16 bg-muted/30">
          <div className="max-w-3xl mx-auto px-6">
            <motion.div
              initial="hidden"
              whileInView="visible"
              viewport={{ once: true, margin: "-100px" }}
              variants={fadeInUp}
              className="text-center mb-16"
            >
              <h2 className="text-3xl sm:text-4xl font-bold mb-4">
                Frequently asked questions
              </h2>
              <p className="text-lg text-muted-foreground">
                Everything you need to know about TestRadius pricing.
              </p>
            </motion.div>

            <motion.div
              initial="hidden"
              whileInView="visible"
              viewport={{ once: true, margin: "-100px" }}
              variants={fadeInUp}
            >
              <Accordion type="single" collapsible className="w-full">
                {FAQ_ITEMS.map((item, index) => (
                  <AccordionItem key={index} value={`item-${index}`}>
                    <AccordionTrigger className="text-left font-semibold text-base">
                      {item.question}
                    </AccordionTrigger>
                    <AccordionContent className="text-muted-foreground leading-relaxed">
                      {item.answer}
                    </AccordionContent>
                  </AccordionItem>
                ))}
              </Accordion>
            </motion.div>
          </div>
        </section>
      </main>
    </Layout>
  );
}
