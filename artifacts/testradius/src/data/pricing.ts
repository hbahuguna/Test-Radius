import { Zap, Rocket, Shield, BarChart3, Building2 } from "lucide-react";

export interface PricingTier {
  name: string;
  monthlyPrice: number | null;
  annualPrice: number | null;
  period: string;
  annualPeriod: string;
  devRange: string;
  description: string;
  features: string[];
  ctaLabel: string;
  ctaAction: "trial" | "contact-sales";
  highlighted: boolean;
  badge?: string;
  icon: React.ElementType;
}

export const PRICING_TIERS: PricingTier[] = [
  {
    name: "Free",
    monthlyPrice: 0,
    annualPrice: 0,
    period: "month",
    annualPeriod: "month",
    devRange: "Unlimited",
    description:
      "Get started with zero commitment — full shadow mode analysis, no credit card needed.",
    features: [
      "Full shadow mode analysis",
      "Unlimited PRs",
      "GitHub Actions integration",
      "Community support",
    ],
    ctaLabel: "Get Started Free",
    ctaAction: "trial",
    highlighted: false,
    icon: Zap,
  },
  {
    name: "Starter",
    monthlyPrice: 79,
    annualPrice: 790,
    period: "month",
    annualPeriod: "year",
    devRange: "Up to 5",
    description:
      "Perfect for solo founders and tiny teams getting started with automated test selection.",
    features: [
      "Up to 5 developers",
      "All Free features",
      "Automated test selection",
      "Email support",
    ],
    ctaLabel: "Start Trial",
    ctaAction: "trial",
    highlighted: false,
    icon: Rocket,
  },
  {
    name: "Growth",
    monthlyPrice: 25,
    annualPrice: 250,
    period: "developer / month",
    annualPeriod: "developer / year",
    devRange: "6\u201325",
    description:
      "For growing SaaS teams and Series A startups scaling their test infrastructure.",
    features: [
      "6\u201325 developers",
      "All Starter features",
      "Explainability dashboard",
      "Slack integration",
      "Priority email support",
    ],
    ctaLabel: "Start Trial",
    ctaAction: "trial",
    highlighted: true,
    badge: "Most Popular",
    icon: Shield,
  },
  {
    name: "Scale",
    monthlyPrice: 19,
    annualPrice: 190,
    period: "developer / month",
    annualPeriod: "developer / year",
    devRange: "26\u201375",
    description:
      "For mid-size engineering organisations with growing test suites.",
    features: [
      "26\u201375 developers",
      "All Growth features",
      "Team dashboard",
      "Dedicated support",
      "Advanced analytics",
    ],
    ctaLabel: "Start Trial",
    ctaAction: "trial",
    highlighted: false,
    icon: BarChart3,
  },
  {
    name: "Enterprise",
    monthlyPrice: 1499,
    annualPrice: 1499,
    period: "month",
    annualPeriod: "month",
    devRange: "75+",
    description:
      "For large teams with compliance needs, SSO, audit logs, and dedicated support.",
    features: [
      "75+ developers",
      "All Scale features",
      "SSO & compliance",
      "Dedicated account manager",
      "SLA & priority support",
      "Custom onboarding",
    ],
    ctaLabel: "Contact Sales",
    ctaAction: "contact-sales",
    highlighted: false,
    icon: Building2,
  },
];

export interface ComparisonRow {
  feature: string;
  testRadius: string;
  launchable: string;
  diyScripts: string;
}

export const COMPARISON_ROWS: ComparisonRow[] = [
  {
    feature: "Explainable AI",
    testRadius: "\u2713",
    launchable: "\u2717 Black-box",
    diyScripts: "\u2717",
  },
  {
    feature: "Transparent pricing",
    testRadius: "\u2713 From $79/mo",
    launchable: "\u2717 Contact us",
    diyScripts: "\u2713 Free (but costly)",
  },
  {
    feature: "Shadow mode trial",
    testRadius: "\u2713 Risk-free",
    launchable: "\u2717 No",
    diyScripts: "\u2717 N/A",
  },
  {
    feature: "Volume discounts",
    testRadius: "\u2713 As you grow",
    launchable: "\u2717 Opaque",
    diyScripts: "\u2713 N/A",
  },
  {
    feature: "Flaky test reduction",
    testRadius: "\u2713 Built-in",
    launchable: "\u2713 Limited",
    diyScripts: "\u2717 Manual",
  },
];

export const FAQ_ITEMS = [
  {
    question: "Can I start with the Free plan and upgrade later?",
    answer:
      "Absolutely. The Free plan is yours forever with full shadow mode analysis and unlimited PRs. When you're ready to scale, upgrade to Starter or Growth to unlock automated test selection, explainability dashboards, and team features.",
  },
  {
    question: "How does annual billing work?",
    answer:
      "Annual billing gives you the equivalent of 2 months free on every paid plan. For example, Starter is $79/month or $790/year \u2014 saving you $158. All annual subscriptions are billed upfront and include a 30-day money-back guarantee.",
  },
  {
    question: "Can I switch from monthly to annual billing?",
    answer:
      "Yes, anytime. If you're on monthly billing and want to switch to annual, we'll prorate your current month and bill the annual rate. Contact support or manage this from your account settings.",
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
