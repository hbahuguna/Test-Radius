export const BLOG_SLUGS = [
  "building-AI-native-testing-system-1",
  "building-AI-native-testing-system-2",
  "building-AI-native-testing-system-3",
  "building-AI-native-testing-system-4",
  "siamese-network-training-for-test-impact-analysis",
  "lessons-from-one-person-ai-agent-businesses-for-tia",
  "code-coverage-tia-article",
  "build-testradius-github-app",
  "sdet-model-journey",
] as const;

export const ROUTES = {
  HOME: "/",
  BLOG: "/blog",
  PRICING: "/pricing",
  CAREERS: "/jobs",
  CAREERS_ALT: "/careers",
} as const;

export const NAV_LABELS = {
  BLOG: "Blog",
  PRICING: "Pricing",
  CAREERS: "Careers",
  JOIN_PILOT: "Join Pilot",
  GET_EARLY_ACCESS: "Get Early Access",
} as const;

export const FORM_DATA = {
  validEarlyAccess: {
    email: "engineer@company.com",
    company: "Acme Corp",
    role: "Engineering Manager",
  },
  validCareerApp: {
    role: "Freelance Full-Stack Developer",
    firstName: "Jane",
    lastName: "Doe",
    email: "jane@example.com",
    portfolio: "https://github.com/janedoe",
    coverLetter: "I am excited about this role.",
    resume: "https://drive.google.com/resume.pdf",
  },
} as const;

export const WEB3FORMS_URL = "https://api.web3forms.com/submit";
export const FORMSPREE_URL = "https://formspree.io/f/mgoqdago";
