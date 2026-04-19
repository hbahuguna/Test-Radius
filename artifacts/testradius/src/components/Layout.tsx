import React from "react";
import { Header } from "./Header";
import { Footer } from "./Footer";
import { EarlyAccessForm } from "./EarlyAccessForm";
import { motion } from "framer-motion";
import { Card, CardContent } from "@/components/ui/card";
import { ArrowRight } from "lucide-react";

const fadeInUp = {
  hidden: { opacity: 0, y: 20 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.6 } },
};

interface LayoutProps {
  children: React.ReactNode;
  scrollToForm?: () => void; // Optional for pages that don't need it
}

export function Layout({ children, scrollToForm }: LayoutProps) {
  const handleScrollToForm =
    scrollToForm ||
    (() => {
      document
        .getElementById("early-access-form")
        ?.scrollIntoView({ behavior: "smooth" });
    });

  return (
    <div className="min-h-[100dvh] w-full bg-background text-foreground selection:bg-primary/20">
      <Header scrollToForm={handleScrollToForm} />
      {children}

      {/* Pricing / CTA Section */}
      <section
        id="early-access-form"
        className="py-32 bg-gradient-to-br from-primary/5 via-background to-[#3daa9a]/5 relative overflow-hidden"
      >
        <div className="absolute top-0 left-1/2 -translate-x-1/2 w-full max-w-3xl h-[300px] bg-gradient-to-r from-primary/15 to-[#3daa9a]/15 blur-[100px] rounded-full pointer-events-none"></div>

        <div className="max-w-3xl mx-auto px-6 relative z-10">
          <motion.div
            initial="hidden"
            whileInView="visible"
            viewport={{ once: true }}
            variants={fadeInUp}
            className="text-center mb-12"
          >
            <h2 className="text-3xl sm:text-4xl font-bold mb-4">
              Ready to ship faster?
            </h2>
            <p className="text-lg text-muted-foreground mb-6">
              Simple per-seat pricing starting at{" "}
              <span className="font-bold text-foreground">$29/user/month</span>.
              No surprises. Cancel anytime.
            </p>
            <p className="text-sm font-medium" style={{ color: "#3daa9a" }}>
              Join the private beta today to lock in early pricing.
            </p>
          </motion.div>

          <motion.div
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            transition={{ duration: 0.5, delay: 0.2 }}
          >
            <Card className="shadow-2xl border-primary/20 overflow-hidden">
              <CardContent className="p-8 sm:p-10">
                <EarlyAccessForm />
              </CardContent>
            </Card>
          </motion.div>
        </div>
      </section>

      <Footer />
    </div>
  );
}
