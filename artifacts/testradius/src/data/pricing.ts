import { CheckCircle2, HelpCircle, Zap, Shield, Building2 } from "lucide-react";

export interface PricingTier {
  name: string;
  price: string;
  period: string;
  description: string;
  cta: string;
  ctaVariant: "default" | "outline";
  highlighted?: boolean;
  badge?: string;
  icon: React.ElementType;
  seatMinimum?: string;
  features: string[];
  limitations?: string[];
}

export const PRICING_TIERS: PricingTier[] = [
  {
    name: "Shadow Mode",
    price: "$0",
    period: "forever",
    description:
      "Get started with no commitment. See exactly which tests your PRs impact before you buy.",
    cta: "Get Started Free",
    ctaVariant: "outline",
    icon: Zap,
    features: [
      "Free shadow-mode analysis",
      "PR comments showing impacted tests",
      "5 analyses per month",
      "Community support",
    ],
  },
  {
    name: "Team",
    price: "$29",
    period: "per seat / month",
    description:
      "Scale confidently with automated test selection and full explainability across your team.",
    cta: "Start Free Trial",
    ctaVariant: "default",
    highlighted: true,
    badge: "Most Popular",
    icon: Shield,
    seatMinimum: "5 seat minimum",
    features: [
      "Unlimited shadow-mode analyses",
      "Automated test selection",
      "Explainability dashboard",
      "Slack integration",
      "Email support",
    ],
  },
  {
    name: "Enterprise",
    price: "Custom",
    period: "starting ~$1,000/mo",
    description:
      "For large teams with compliance needs. SSO, audit logs, dedicated support, and custom CI integrations.",
    cta: "Contact Sales",
    ctaVariant: "outline",
    icon: Building2,
    features: [
      "All Team features",
      "SSO & SAML",
      "Audit logs",
      "Priority support",
      "Custom CI integrations",
      "Dedicated account manager",
    ],
  },
];

export const FAQ_ITEMS = [
  {
    question: "Why a 5-seat minimum on the Team plan?",
    answer:
      "We serve engineering teams, not individuals. The 5-seat minimum ensures you get the full value of TestRadius — dependency-aware test selection only works when a team's full codebase is mapped. For smaller teams or individuals, our free Shadow Mode is a great starting point.",
  },
  {
    question: "Can I start with Shadow Mode and upgrade later?",
    answer:
      "Absolutely. Shadow Mode is free forever with 5 analyses per month. When you're ready to scale, upgrade to Team and unlock unlimited analyses, automated test selection, and Slack integration.",
  },
  {
    question: "What forms of payment do you accept?",
    answer:
      "We accept all major credit cards (Visa, Mastercard, Amex) via Stripe. Enterprise customers can also pay by invoice with net-30 terms.",
  },
  {
    question: "Can I cancel anytime?",
    answer:
      "Yes. All paid plans have no long-term contracts. Cancel anytime, and you'll retain access through the end of your billing period. We also offer a 30-day money-back guarantee on all paid plans.",
  },
  {
    question: "What happens to my data if I cancel?",
    answer:
      "Your analysis history and configuration are retained for 90 days after cancellation. If you re-subscribe within that window, everything is restored. After 90 days, data is permanently deleted.",
  },
  {
    question: "Do you offer discounts for startups or non-profits?",
    answer:
      "Yes. We offer a 50% discount for early-stage startups (< 20 employees) and verified non-profits. Contact us for details.",
  },
];
