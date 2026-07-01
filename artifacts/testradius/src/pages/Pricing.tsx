import { motion } from "framer-motion";
import { CheckCircle2, ArrowRight } from "lucide-react";
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
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { Layout } from "@/components/Layout";
import { PRICING_TIERS, FAQ_ITEMS } from "@/data/pricing";

const fadeInUp = {
  hidden: { opacity: 0, y: 20 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.6 } },
};

const stagger = {
  hidden: { opacity: 0 },
  visible: {
    opacity: 1,
    transition: { staggerChildren: 0.15 },
  },
};

const GUARANTEE_BADGE_TEXT = "30-day money-back guarantee on all paid plans.";

export function Pricing() {
  return (
    <Layout>
      <main className="pt-16">
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
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-primary opacity-75"></span>
                  <span className="relative inline-flex rounded-full h-2 w-2 bg-primary"></span>
                </span>
                Simple, transparent pricing
              </motion.div>

              <motion.h1
                variants={fadeInUp}
                className="text-4xl sm:text-5xl lg:text-6xl font-extrabold tracking-tight leading-[1.1] mb-6 text-foreground"
              >
                Right-sized plans for{" "}
                <span className="text-transparent bg-clip-text bg-gradient-to-r from-primary to-[#3daa9a]">
                  every team
                </span>
              </motion.h1>

              <motion.p
                variants={fadeInUp}
                className="text-lg text-muted-foreground mb-6 max-w-2xl mx-auto"
              >
                Start with free shadow mode to prove value. Upgrade when your
                team is ready to eliminate flaky test noise and cut CI time by
                up to 94%.
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

        <section className="pb-24">
          <div className="max-w-7xl mx-auto px-6">
            <motion.div
              initial="hidden"
              whileInView="visible"
              viewport={{ once: true, margin: "-100px" }}
              variants={stagger}
              className="grid lg:grid-cols-3 gap-8 items-start"
            >
              {PRICING_TIERS.map((tier) => (
                <motion.div
                  key={tier.name}
                  variants={fadeInUp}
                  className="relative"
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
                          {tier.price}
                        </span>
                        {tier.period && (
                          <span className="text-muted-foreground ml-1 text-sm">
                            /{tier.period}
                          </span>
                        )}
                      </div>
                      {tier.seatMinimum && (
                        <p className="text-xs text-muted-foreground mt-1">
                          {tier.seatMinimum}
                        </p>
                      )}
                      <CardDescription className="text-sm mt-3 px-2">
                        {tier.description}
                      </CardDescription>
                    </CardHeader>

                    <CardContent className="flex-1 px-8 pb-6">
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

                    <CardFooter className="px-8 pb-8 pt-0">
                      <Button
                        variant={tier.ctaVariant}
                        size="lg"
                        className={`w-full h-12 text-base font-medium ${
                          tier.highlighted
                            ? "shadow-md hover:shadow-lg transition-all"
                            : ""
                        }`}
                        style={
                          tier.highlighted
                            ? {
                                background:
                                  "linear-gradient(135deg, #3daa9a, #34d399)",
                                color: "white",
                              }
                            : {}
                        }
                        onClick={() => {
                          document
                            .getElementById("early-access-form")
                            ?.scrollIntoView({ behavior: "smooth" });
                        }}
                      >
                        {tier.cta}
                        <ArrowRight className="ml-2 h-4 w-4" />
                      </Button>
                    </CardFooter>
                  </Card>
                </motion.div>
              ))}
            </motion.div>
          </div>
        </section>

        <section className="py-24 bg-muted/30">
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
